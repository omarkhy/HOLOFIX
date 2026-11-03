"""
meta_client.py — the ONLY file that talks to the Meta Model API.

Three public functions, used by every pipeline step:
  chat(messages)                      plain answer (text)
  web_research(question)              grounded answer + the source URLs it used
  structured(prompt, PydanticModel)   answer forced into a schema, validated, retried on error

Design choices (interview material):
- Raw HTTP with httpx, not an SDK: we see exactly what is sent and received, and the request
  shapes are the ones we confirmed with scripts/test_meta_api.py.
- Disk cache: identical request -> identical stored answer. Saves money, makes the demo
  deterministic and lets the evaluation be re-run. Delete data/cache/llm/ to refresh.
- Web search and JSON-schema output are two separate calls. We confirmed each works on its
  own; combining them in one call is unconfirmed, so we don't depend on it.
- structured() validates with Pydantic and, on failure, sends the exact validation errors
  back to the model once or twice ("repair loop"). Most LLM JSON mistakes are fixed that way.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from backend import config

T = TypeVar("T", bound=BaseModel)

_client = httpx.Client(
    base_url=config.META_API_BASE,
    headers={"Authorization": f"Bearer {config.META_API_KEY}", "Content-Type": "application/json"},
    timeout=300,   # extraction answers are long; web search can take a minute or two
)


class MetaAPIError(RuntimeError):
    """Raised with the full HTTP status and body, so errors can be pasted and debugged."""


# ---------- low level: one POST, with cache ----------

def _post(path: str, body: dict) -> dict:
    if not config.META_API_KEY:
        raise MetaAPIError("META_API_KEY is missing: check .env at the repo root.")
    if config.META_REASONING and "reasoning_effort" not in body:
        body = {**body, "reasoning_effort": config.META_REASONING}

    key = hashlib.sha256(json.dumps([path, body], sort_keys=True).encode()).hexdigest()[:24]
    cache_file = config.CACHE_DIR / f"{key}.json"
    if config.CACHE_ENABLED and cache_file.exists():
        return json.loads(cache_file.read_text())

    started = time.time()
    r = _client.post(path, json=body)
    if r.status_code != 200:
        raise MetaAPIError(f"{path} -> HTTP {r.status_code}\n{r.text[:3000]}")
    data = r.json()
    data["_holofix"] = {"seconds": round(time.time() - started, 1)}   # timing, for the README

    if config.CACHE_ENABLED:
        config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(data, indent=2))
    return data


# ---------- 1. plain chat ----------

def chat(messages: list[dict], **extra: Any) -> str:
    body = {"model": config.META_MODEL, "messages": messages, **extra}
    data = _post("/chat/completions", body)
    return data["choices"][0]["message"]["content"]


# ---------- 2. grounded web research ----------

URL_RE = re.compile(r"https?://[^\s)\]>\"'}]+")


def web_research(question: str) -> tuple[str, list[str]]:
    """Ask with the web_search tool. Returns (final answer text, source URLs).

    The Responses API returns a list of output items: reasoning, web_search_call, message...
    The model narrates between searches ("I'll search..."), so only the LAST message is the
    answer. URLs are collected from citation annotations, from search-call items, and as a
    fallback from the text itself — whichever the API actually provides.
    """
    body = {"model": config.META_MODEL, "input": question, "tools": [{"type": "web_search"}]}
    data = _post("/responses", body)
    items = data.get("output", [])

    messages = [i for i in items if i.get("type") == "message"]
    text, urls = "", []
    if messages:
        for part in messages[-1].get("content", []):
            text += part.get("text", "")
            for ann in part.get("annotations", []) or []:
                if ann.get("url"):
                    urls.append(ann["url"])
    for item in items:                                   # sources listed on search calls
        if item.get("type") == "web_search_call":
            for src in (item.get("action") or {}).get("sources", []) or []:
                if isinstance(src, dict) and src.get("url"):
                    urls.append(src["url"])
    urls += URL_RE.findall(text)

    clean = list(dict.fromkeys(u.rstrip(".,;") for u in urls))   # de-duplicate, keep order
    return text.strip(), clean


# ---------- 3. structured output ----------

def _inline_refs(schema: dict) -> dict:
    """Pydantic puts nested models under $defs and points to them with $ref. Some JSON-schema
    implementations don't follow $ref, so we inline them: a self-contained schema is safer."""
    defs = schema.get("$defs", {})

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].split("/")[-1]])
            return {k: walk(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(schema)


def structured(prompt: str, model: type[T], system: str | None = None, retries: int = 2) -> T:
    """Get an answer that validates against `model`. On validation failure, the errors are
    sent back to Muse Spark and it gets `retries` chances to fix its own output."""
    schema = _inline_refs(model.model_json_schema())
    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    response_format = {
        "type": "json_schema",
        # strict=False: Pydantic schemas use optional fields and free-form dicts, which strict
        # mode can reject. Pydantic does the strict checking on our side instead.
        "json_schema": {"name": model.__name__, "schema": schema, "strict": False},
    }

    last_error = ""
    for attempt in range(retries + 1):
        content = chat(messages, response_format=response_format)
        try:
            return model.model_validate_json(content)
        except ValidationError as e:
            last_error = str(e)
            messages += [
                {"role": "assistant", "content": content},
                {"role": "user", "content": f"Your JSON failed validation:\n{last_error}\nReturn the corrected JSON only."},
            ]
    raise MetaAPIError(f"{model.__name__}: still invalid after {retries} repairs.\n{last_error}")
