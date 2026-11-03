"""
guide.py — a step-by-step repair guide for one part of one device, printable as a PDF.

Pipeline: web research (iFixit guides first, then the maker's service docs and repair forums)
-> structured RepairGuide -> code checks. The rules from the brief are enforced here, in code:
  - "Never invent precise specs": a screw type/size/length or a torque (fastener_detail) is kept only
    if its step cites a URL that really came back from the search. Otherwise it is removed and the step
    says to check the cited guide.
  - Every step's source must be a real search result, or it is dropped (set to None).
  - Hazardous or board-level parts (lithium battery, mains, airbags, brakes, fuel, soldered chips) get
    no steps at all: the guide explains why a professional is needed and what to tell them.
  - Prices: every cost line must cite a page that came back from the price search, or it is dropped.
    Totals (do it yourself / repair shop / buy new) are added up here in code, never by the model.

The steps research and the price research run in parallel (two threads), to halve the waiting time.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field

from backend import meta_client, progress, safety
from backend.diagnosis import Tier
from backend.schemas import PartsGraph


class Phase(str, Enum):
    prepare = "prepare"
    open = "open"            # get to the part
    replace = "replace"      # remove the old part, fit the new one
    reassemble = "reassemble"
    test = "test"


class Tool(BaseModel):
    name: str = Field(..., description="e.g. 'P5 pentalobe screwdriver', 'plastic opening pick'")
    why: Optional[str] = None


class Step(BaseModel):
    phase: Phase
    action: str = Field(..., description="One clear instruction")
    detail: Optional[str] = Field(None, description="How to do it safely, what to watch for")
    fastener_detail: Optional[str] = Field(None, description="Screw type/size/count or torque, ONLY if the source states it")
    tools: list[str] = Field(default_factory=list)
    source_url: Optional[str] = None


class Cost(BaseModel):
    item: str = Field(..., description="e.g. 'Replacement trackpad (iFixit)', 'Repair shop labour', 'New MacBook Air M1'")
    kind: Literal["part", "tool", "labour", "new_device"]
    low: float = Field(..., ge=0)
    high: float = Field(..., ge=0)
    currency: str = Field("EUR", description="ISO code as shown on the source page")
    source_url: Optional[str] = None


class CostSummary(BaseModel):
    currency: str
    diy: Optional[tuple[float, float]] = None     # parts + tools
    shop: Optional[tuple[float, float]] = None    # parts + labour, or a shop's all-in quote
    new: Optional[tuple[float, float]] = None     # buying the device new
    saving_vs_new: Optional[float] = None         # new (low) - best repair (high)


class Prices(BaseModel):
    costs: list[Cost]


class RepairGuide(BaseModel):
    title: str
    part_id: str
    tier: Tier
    time_estimate: Optional[str] = Field(None, description="Only if a source gives one")
    tools: list[Tool] = Field(default_factory=list)
    parts_needed: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    steps: list[Step] = Field(default_factory=list)
    professional_note: Optional[str] = Field(None, description="For red guides: why a pro, and what to tell them")
    sources: list[str] = Field(default_factory=list)
    unverified_steps: int = 0
    costs: list[Cost] = Field(default_factory=list)
    cost_summary: Optional[CostSummary] = None
    price_sources: list[str] = Field(default_factory=list)


RESEARCH = """Repair guide research for: {model} — replacing / repairing the "{part}" ({function}).
{symptom}
Find the iFixit guide for this exact model and part if it exists, otherwise the maker's service manual or a
reputable repair guide for this model. Report: difficulty, time, every tool (exact screwdriver bit types),
replacement parts, ALL steps in order from preparation to opening, removal, fitting the new part, reassembly
and testing, with the screw types, sizes and counts exactly as the guide states them, and every warning.
Quote numbers only as written in the source. Cite the URL for each step."""

STRUCTURE = """Turn this research into the RepairGuide JSON for {model}, part_id "{part_id}" ("{part}").
Rules:
- Steps in order, phases: prepare -> open -> replace -> reassemble -> test. 6 to 20 steps.
- fastener_detail ONLY when the notes state the screw type/size/count or torque; otherwise null.
- source_url for each step: one of the URLs below that supports it, else null. Never invent a URL.
- tier: green (no tools / external), yellow (tools, opening the device), red (technician only).
- time_estimate only if the notes give one.

Research notes:
{notes}

URLs found:
{urls}"""


PRICE_RESEARCH = """Prices, in euros where possible (France / EU sellers first), for repairing a {model}:
1. The replacement part "{part}" for this exact model: iFixit store, the maker's spare-parts store, reputable
   parts sellers (Amazon.fr, eBay new parts, specialist shops). Give low and high prices.
2. The tools needed if not common ({tools}).
3. What a repair shop typically charges to replace it (labour, or an all-in quote) for this model.
4. The price of this device new (official) or refurbished, for comparison.
Cite the URL of every price. Quote prices exactly as the pages show them."""

PRICE_STRUCTURE = """Turn this price research into the JSON. One line per item, low/high as numbers, currency as shown.
kind: part | tool | labour | new_device. source_url: one of the URLs below that shows this price, else null.
Do not estimate or invent prices: leave out anything the notes do not show.

Research notes:
{notes}

URLs found:
{urls}"""


def _prices(graph: PartsGraph, part, tools: str) -> tuple[list[Cost], list[str]]:
    notes, urls = meta_client.web_research(
        PRICE_RESEARCH.format(model=graph.device.model_name, part=part.name, tools=tools or "screwdrivers, opening tools"),
        label=f"Looking up prices: the part, a repair shop, and the {graph.device.model_name} new…")
    found = meta_client.structured(PRICE_STRUCTURE.format(notes=notes, urls="\n".join(urls) or "(none)"),
                                   Prices, retries=1, label="Reading the prices…")
    allowed = set(urls)
    costs = [c for c in found.costs if c.source_url in allowed and c.high >= c.low]   # every euro sourced
    return costs, urls


def summarise(costs: list[Cost]) -> Optional[CostSummary]:
    """Totals in code: only lines in the most common currency are added up."""
    if not costs:
        return None
    cur = max({c.currency for c in costs}, key=lambda k: sum(c.currency == k for c in costs))
    by = lambda kind: [c for c in costs if c.kind == kind and c.currency == cur]
    span = lambda items: (round(min(c.low for c in items)), round(max(c.high for c in items))) if items else None
    part, tool, labour, new = span(by("part")), span(by("tool")), span(by("labour")), span(by("new_device"))
    tools_total = (sum(c.low for c in by("tool")), sum(c.high for c in by("tool"))) if by("tool") else (0, 0)
    diy = (round(part[0] + tools_total[0]), round(part[1] + tools_total[1])) if part else None
    shop = (round((part[0] if part else 0) + labour[0]), round((part[1] if part else 0) + labour[1])) if labour else None
    best = min([x[1] for x in (diy, shop) if x], default=None)
    return CostSummary(currency=cur, diy=diy, shop=shop, new=new,
                       saving_vs_new=round(new[0] - best) if new and best is not None and new[0] > best else None)


def make_guide(graph: PartsGraph, part_id: str, symptom: str | None = None) -> RepairGuide:
    part = next((p for p in graph.parts if p.id == part_id), None)
    if part is None:
        raise ValueError(f"No part {part_id!r} on this device.")

    # Hazardous or board-level parts: no instructions, by rule (prices are still useful: shop vs new).
    stop = safety.hazard_note(part.hazard.value if part.hazard else None)
    if stop or part.serviceability.value in ("soldered",):
        reason = stop or ("This part is soldered to the main board. Replacing it needs board-level micro-soldering "
                          "equipment; in practice the whole board is usually replaced.")
        costs, price_urls = _prices(graph, part, "")
        return RepairGuide(
            title=f"{part.name}: technician repair", part_id=part.id, tier=Tier.red, warnings=[reason],
            professional_note=(f"Tell the repair shop: device {graph.device.model_name}"
                               f"{', configuration ' + ', '.join(graph.device.configuration.values()) if graph.device.configuration else ''}; "
                               f"suspected part: {part.name}{'; symptom: ' + symptom if symptom else ''}. "
                               "Ask for a quote before work starts, and whether a refurbished part is an option."),
            sources=[part.source_url] if part.source_url else [],
            costs=costs, cost_summary=summarise(costs), price_sources=price_urls)

    # Steps research and price research in parallel.
    with ThreadPoolExecutor(max_workers=2) as pool:
        steps_job = pool.submit(progress.copy_context_run(meta_client.web_research, RESEARCH.format(
            model=graph.device.model_name, part=part.name, function=part.function,
            symptom=f"The owner's problem: {symptom}" if symptom else ""),
            f"Reading the repair guide for the {part.name.lower()} (iFixit first)…"))
        price_job = pool.submit(progress.copy_context_run(_prices, graph, part, ""))
        notes, urls = steps_job.result()
        try:
            costs, price_urls = price_job.result()
        except meta_client.MetaAPIError:
            costs, price_urls = [], []          # a guide without prices is still useful

    guide = meta_client.structured(
        STRUCTURE.format(model=graph.device.model_name, part_id=part.id, part=part.name,
                         notes=notes, urls="\n".join(urls) or "(none)"),
        RepairGuide, retries=2, label="Writing your step-by-step guide…")

    # ---- code checks
    s = progress.step("HOLOFIX", "Checking every step, screw spec and price against its source…")
    allowed = set(urls)
    guide.part_id = part.id
    for st in guide.steps:
        if st.source_url not in allowed:
            st.source_url = None
        if st.fastener_detail and not st.source_url:
            st.fastener_detail = None          # never invent precise specs
    guide.unverified_steps = sum(1 for st in guide.steps if not st.source_url)
    if guide.tier == Tier.red:
        guide.steps = []
    guide.sources = urls
    guide.costs, guide.price_sources = costs, price_urls
    if part.hazard and part.hazard.value == "lithium_battery":
        guide.warnings.insert(0, safety.BATTERY_CAUTION)
    guide.cost_summary = summarise(costs)
    progress.done(s, f"{len(guide.steps) - guide.unverified_steps} of {len(guide.steps)} steps cited · {len(costs)} sourced prices")
    return guide
