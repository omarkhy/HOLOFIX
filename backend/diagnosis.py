"""
diagnosis.py — symptom -> ranked suspect parts + ONE best follow-up question + tiered fixes.

Akinator-style narrowing: each turn the model sees the symptom, the parts graph and every
question already answered, re-ranks the causes, and asks the single question that best splits
the remaining causes (or none, if it is confident).

Two modes, compared in the evaluation (eval/):
  grounded=False  Muse Spark reasons from the parts graph alone.
  grounded=True   Muse Spark first searches repair guides/forums for this model + symptom, and
                  reasons from those notes too (sources are returned and shown).

Code-side guarantees (not left to the model):
  - suspects must be real part ids of this device; likelihoods are normalised;
  - safety.py hard stops: dangerous symptom words, or a hazardous suspect part -> every fix is
    "red / see a professional" with no steps;
  - no precise specs (screw lengths, torques): fixes are short, and the prompt forbids numbers
    that the notes do not source.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from backend import meta_client, safety
from backend.schemas import PartsGraph


class Tier(str, Enum):
    green = "green"    # do it at home
    yellow = "yellow"  # needs tools / care
    red = "red"        # technician only


class Suspect(BaseModel):
    part_id: str
    likelihood: float = Field(..., ge=0, le=1)
    why: str = Field(..., description="One sentence linking the symptom to this part")


class Question(BaseModel):
    text: str = Field(..., description="ONE question the user can answer by looking or trying")
    options: list[str] = Field(..., min_length=2, max_length=4, description="Short answers, e.g. ['Yes', 'No', 'Not sure']")


class Fix(BaseModel):
    title: str
    tier: Tier
    steps: list[str] = Field(default_factory=list, description="2 to 5 short steps; empty for red")
    part_ids: list[str] = Field(default_factory=list)


class Diagnosis(BaseModel):
    summary: str = Field(..., description="One or two sentences: what is most likely going on")
    suspects: list[Suspect] = Field(..., description="Most likely first, 1 to 5 items")
    next_question: Optional[Question] = Field(None, description="Null when confident enough")
    fixes: list[Fix] = Field(default_factory=list)
    safety_stop: Optional[str] = None
    sources: list[str] = Field(default_factory=list)


class Turn(BaseModel):
    question: str
    answer: str


SYSTEM = """You are a careful repair diagnostician. You only blame parts that exist in the given parts list,
and you explain your reasoning in plain language for a non-expert. Fix tiers:
green = safe at home without opening the device or with basic steps (restart, reset, cleaning, settings, external checks);
yellow = needs tools or opening the device; red = technician only (board-level, soldered parts, safety risks).
Never give precise screw lengths, torques or voltages unless the research notes state them."""

PROMPT = """Device: {model} — configuration: {config}

Parts (id | name | function | serviceability | hazard):
{parts}

Symptom described by the user: "{symptom}"

Questions already answered:
{history}

{notes}
Task:
1. Rank the 1–5 most likely culprit parts (part_id from the list ONLY), likelihoods summing to at most 1.
2. If the top cause is below 0.7, ask the ONE question that best separates the remaining causes
   (something the user can check by looking, listening or trying). Otherwise next_question = null.
   Never repeat a question already answered.
3. Give 1–4 fixes, cheapest and safest first, each with a tier and 2–5 short steps (no steps for red).
4. summary: one or two sentences."""


def _parts_table(graph: PartsGraph) -> str:
    return "\n".join(f"{p.id} | {p.name} | {p.function} | {p.serviceability.value} | {p.hazard.value if p.hazard else '-'}"
                     for p in graph.parts)


def diagnose(graph: PartsGraph, symptom: str, history: list[Turn], grounded: bool = True) -> Diagnosis:
    notes_block, urls = "", []
    if grounded:
        notes, urls = meta_client.web_research(
            f"{graph.device.model_name}: a user reports \"{symptom}\". Search repair guides (iFixit), the maker's "
            "support pages and repair forums for this model or very close ones. List the most common causes, how "
            "to tell them apart, and the usual fixes. Cite source URLs.")
        notes_block = f"Research notes from repair sources:\n{notes}\n"

    config = ", ".join(f"{k}: {v}" for k, v in graph.device.configuration.items()) or "unknown"
    history_text = "\n".join(f"- Q: {t.question}  A: {t.answer}" for t in history) or "(none yet)"
    result = meta_client.structured(
        PROMPT.format(model=graph.device.model_name, config=config, parts=_parts_table(graph),
                      symptom=symptom, history=history_text, notes=notes_block),
        Diagnosis, system=SYSTEM, retries=2,
    )
    return post_check(result, graph, symptom, history, urls)


def post_check(d: Diagnosis, graph: PartsGraph, symptom: str, history: list[Turn], urls: list[str]) -> Diagnosis:
    parts = {p.id: p for p in graph.parts}

    # Only real parts, best first, likelihoods normalised so they never sum above 1.
    d.suspects = sorted([s for s in d.suspects if s.part_id in parts], key=lambda s: -s.likelihood)[:5]
    total = sum(s.likelihood for s in d.suspects)
    if total > 1:
        for s in d.suspects:
            s.likelihood = round(s.likelihood / total, 3)
    for f in d.fixes:
        f.part_ids = [i for i in f.part_ids if i in parts]

    # No repeated questions.
    asked = {t.question.strip().lower() for t in history}
    if d.next_question and d.next_question.text.strip().lower() in asked:
        d.next_question = None

    # Safety hard stops: the user's own words (all turns), or a hazardous top suspect.
    words = " ".join([symptom] + [t.answer for t in history])
    stop = safety.symptom_stop(words)
    top = parts[d.suspects[0].part_id] if d.suspects else None
    if not stop and top and top.hazard and d.suspects[0].likelihood >= 0.3:
        stop = safety.hazard_note(top.hazard.value)
    if stop:
        d.safety_stop = stop
        d.fixes = [Fix(title="See a repair professional", tier=Tier.red, steps=[],
                       part_ids=[s.part_id for s in d.suspects[:2]])]
    for f in d.fixes:
        if f.tier == Tier.red:
            f.steps = []                      # red = no instructions, by rule

    d.sources = [u for u in d.sources if u in urls] or urls
    return d
