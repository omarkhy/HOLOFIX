"""
test_meta_api.py — confirm the Meta Model API format before building on it.

Run from the repo root:   python scripts/test_meta_api.py

Four independent tests. Each prints PASS/FAIL and, on failure, the full
HTTP status + response body so we can fix the request shape.
  1. GET  /models                  -> which models does my key see? (SAM 3D? Muse Image?)
  2. POST /chat/completions        -> plain Muse Spark call
  3. POST /responses + web_search  -> does grounded web search work?
  4. POST /chat/completions + response_format json_schema -> strict JSON output?

Nothing here is HOLOFIX logic; it's a throwaway probe. Raw httpx (not an SDK)
on purpose: we see exactly what is sent and what comes back.
"""

import json
import os
import sys

import httpx
from dotenv import load_dotenv

load_dotenv()  # reads .env in the current directory

API_KEY = os.getenv("META_API_KEY")
BASE_URL = os.getenv("META_API_BASE", "https://api.meta.ai/v1")
MODEL = os.getenv("META_MODEL", "muse-spark-1.3")

if not API_KEY:
    sys.exit("META_API_KEY missing: check your .env file (run from the repo root).")

HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
client = httpx.Client(base_url=BASE_URL, headers=HEADERS, timeout=120)


def show_failure(r: httpx.Response) -> None:
    print(f"   HTTP {r.status_code}")
    print("   body:", r.text[:2000])


def test_list_models() -> None:
    print("\n[1] GET /models")
    r = client.get("/models")
    if r.status_code != 200:
        print("   FAIL"); show_failure(r); return
    data = r.json()
    ids = sorted(m.get("id", "?") for m in data.get("data", []))
    print(f"   PASS: {len(ids)} models visible to this key:")
    for i in ids:
        print("    -", i)
    for keyword in ("sam", "3d", "image"):
        hits = [i for i in ids if keyword in i.lower()]
        print(f"   models containing '{keyword}': {hits or 'none'}")


def test_chat() -> None:
    print(f"\n[2] POST /chat/completions  model={MODEL}")
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Reply with exactly: HOLOFIX online"}],
    }
    r = client.post("/chat/completions", json=body)
    if r.status_code != 200:
        print("   FAIL"); show_failure(r); return
    data = r.json()
    print("   PASS. reply:", data["choices"][0]["message"]["content"])
    print("   usage:", data.get("usage"))


def test_web_search() -> None:
    print("\n[3] POST /responses with web_search tool")
    body = {
        "model": MODEL,
        "input": "Using web search: are the RAM and SSD soldered on the M1 MacBook Air (2020)? "
                 "Answer in 2 sentences and give the source URLs.",
        "tools": [{"type": "web_search"}],
    }
    r = client.post("/responses", json=body)
    if r.status_code != 200:
        print("   FAIL"); show_failure(r); return
    data = r.json()
    # Responses API: the text lives in output[] items of type "message".
    # Print the raw item types so we learn the real structure.
    print("   PASS. output item types:", [item.get("type") for item in data.get("output", [])])
    text = data.get("output_text")
    if not text:
        for item in data.get("output", []):
            if item.get("type") == "message":
                for c in item.get("content", []):
                    text = (text or "") + c.get("text", "")
    print("   answer:", text)
    print("   (raw JSON saved to data/cache/test_web_search.json)")
    os.makedirs("data/cache", exist_ok=True)
    with open("data/cache/test_web_search.json", "w") as f:
        json.dump(data, f, indent=2)


def test_json_schema() -> None:
    print("\n[4] POST /chat/completions with response_format json_schema")
    schema = {
        "type": "object",
        "properties": {
            "part": {"type": "string"},
            "replaceable": {"type": "boolean"},
        },
        "required": ["part", "replaceable"],
        "additionalProperties": False,
    }
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Is the battery of an M1 MacBook Air replaceable?"}],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "part_check", "schema": schema, "strict": True},
        },
    }
    r = client.post("/chat/completions", json=body)
    if r.status_code != 200:
        print("   FAIL"); show_failure(r); return
    content = r.json()["choices"][0]["message"]["content"]
    try:
        print("   PASS. parsed JSON:", json.loads(content))
    except json.JSONDecodeError:
        print("   PARTIAL: request accepted but content is not valid JSON:\n  ", content)


if __name__ == "__main__":
    print(f"Base URL: {BASE_URL}   Model: {MODEL}")
    for test in (test_list_models, test_chat, test_web_search, test_json_schema):
        try:
            test()
        except Exception as e:  # network errors, unexpected JSON shapes...
            print(f"   ERROR in {test.__name__}: {type(e).__name__}: {e}")
