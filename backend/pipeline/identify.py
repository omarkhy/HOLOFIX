"""
identify.py — step 1 of the pipeline: free text ("MacBook Air 2020") -> the exact device variants.

Why a separate step: one name often covers several machines. "MacBook Air 2020" is an Intel
model (March 2020) AND the M1 model (November 2020), with different internals and repairability.
If we guessed, everything downstream (parts, diagnosis) could be about the wrong machine.

Two calls:
  1. web_research: Muse Spark searches and lists the distinct variants, with sources.
  2. structured:   those notes are turned into a validated list of Variant objects.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from backend import meta_client


class Variant(BaseModel):
    variant_id: str = Field(..., pattern=r"^[a-z0-9_]+$", description="e.g. macbook_air_m1_2020")
    model_name: str = Field(..., description="Official name, e.g. 'MacBook Air (M1, 2020)'")
    category: str = Field(..., description="laptop, phone, tablet, car, console, ...")
    released: str = Field(..., description="Month and year if known, e.g. 'November 2020'")
    how_to_tell_apart: str = Field(..., description="One line a user can check, e.g. 'Apple logo menu > About This Mac shows Chip: Apple M1'")
    model_numbers: list[str] = Field(default_factory=list, description="e.g. ['A2337']")
    confidence: float = Field(..., ge=0, le=1)


class IdentifyResult(BaseModel):
    query: str
    variants: list[Variant] = Field(..., description="Most likely first. One item if unambiguous.")
    needs_choice: bool = Field(..., description="True if the user must pick between variants")
    sources: list[str] = Field(default_factory=list)


RESEARCH_PROMPT = """A user typed this device name: "{query}"

Search the web and list every DISTINCT hardware variant this name could refer to
(different generation, chip, or model number — NOT different storage/colour options of the same machine).
For each: official name, release month/year, model numbers, and the simplest way a user can tell
which one they own. Cite your sources as URLs. If the name is unambiguous, say so."""

STRUCTURE_PROMPT = """Turn these research notes into the JSON schema.

User query: "{query}"
Rules:
- One variant per distinct machine; storage/RAM/colour options are NOT separate variants.
- variant_id: lowercase snake_case, brand-free is fine, e.g. macbook_air_m1_2020.
- needs_choice = true only if more than one variant is plausible.
- sources: the URLs from the notes only. Never invent a URL.

Research notes:
{notes}

URLs found:
{urls}"""


def identify(query: str) -> IdentifyResult:
    notes, urls = meta_client.web_research(RESEARCH_PROMPT.format(query=query), label=f"Searching the web for “{query}”…")
    result = meta_client.structured(
        STRUCTURE_PROMPT.format(query=query, notes=notes, urls="\n".join(urls) or "(none)"),
        IdentifyResult, label="Listing every machine sold under that name…",
    )
    # Keep only URLs that really came back from the search (guards against invented links).
    result.sources = [u for u in result.sources if u in urls] or urls
    result.query = query
    return result
