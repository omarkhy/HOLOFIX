"""
extract.py — step 3, the heart of HOLOFIX: variant + configuration -> a validated PartsGraph
(the JSON the 3D viewer draws).

Pipeline:
  1. web_research   Muse Spark searches teardowns (iFixit…), repair guides and spec sheets, and
                    writes notes: dimensions, colours, key specs, every major part with its location,
                    what connects to what, what is soldered/glued, hazards. With source URLs.
  2. structured     The notes + our layout conventions are turned into a PartsGraph. Pydantic checks
                    it, including cross-references (every connection must point at real parts…);
                    errors go back to the model for repair (see meta_client.structured).
  2b. connections   If the graph came back with too few links between parts (the field is optional,
                    so the model may skip it), a second, focused call gets the final part ids + the
                    notes and returns only the connections. A small task is far more reliable.
  3. post-checks    Code, not the model, has the last word:
                    - device identity and configuration come from the user's choices, not the model;
                    - any source_url that did not come back from the search is removed and that
                      part's confidence is lowered (we never show an invented citation);
                    - provenance = "sourced" only if most parts carry a real source.
  4. fallback       If anything fails, a generic template for the category, labelled "generated".

Results are saved to data/cache/graphs/ so the Library can reopen them instantly.
"""

from __future__ import annotations

import hashlib
import json

from backend import config, meta_client, progress
from backend.pipeline.fallback import generic_graph
from backend.pipeline.identify import Variant
from pydantic import BaseModel

from backend.schemas import Connection, PartsGraph, Provenance

GRAPH_DIR = config.DATA_DIR / "cache" / "graphs"

RESEARCH_PROMPT = """Device: {model_name} (model numbers: {numbers}), configuration: {config}.

Research this exact device on the web: teardowns (iFixit first), repair guides, official tech specs.
Write detailed notes covering:
1. Official outer dimensions in mm (width, depth, thinnest and thickest height) and official colours.
2. Six headline specs (processor, graphics, display, battery, weight, release date).
3. EVERY major part (aim for 12 to 25): name, what it does, where it sits (front/back,
   left/right, under what), roughly how big relative to the device, and whether it is replaceable,
   glued, or soldered. {part_hint}
4. What connects to what (power, data, cables, thermal contact, what is screwed to what).
5. Hazards (lithium battery, mains voltage, high-voltage capacitors…).
Cite the source URL for each fact. Do not guess numbers you cannot source."""

SYSTEM = """You convert repair research into a strict JSON parts graph for a 3D exploded-view viewer.
Coordinates are coarse layout hints, not CAD. Follow the conventions exactly."""

STRUCTURE_PROMPT = """Build the PartsGraph for {model_name} (variant_id {variant_id}, category {category}).
Configuration chosen by the user: {config}

LAYOUT CONVENTIONS (the viewer depends on them):
- Two assemblies. "base": position.x 0..1 left->right, position.y 0..1 FRONT->BACK (front = edge near the user).
  "lid" (laptops only): position.y 0 = hinge, 1 = top edge of the screen.
- size.w and size.d are fractions of the device width and depth; size.h is a fraction of the local thickness.
- layer = stacking order inside the assembly. Base: 0 = bottom case; highest layer = top case/keyboard deck.
  Lid: 0 = outer back cover, 1 = display panel.
- Shapes: shell_base (bottom case, one only), shell_deck (top case with keyboard/trackpad openings, one only,
  highest base layer), keyboard, screen (display panel, in the lid), rounded_slab (battery, trackpad, lid cover),
  board (circuit boards), chip, cylinder (fans, speakers if round), cable, box, slab, frame, screw.
- finish: body = visible outer shell parts (bottom case, top case, lid cover, trackpad); keys = keyboard;
  screen = display panel; internal = everything else.
- Laptop layout reminders: battery usually spans the front half under the palm rest; the main board sits
  towards the back; the trackpad is front-centre; the keyboard is centre-back; parts must not all overlap.
- system_id groups: use short ids like enclosure, display, power, compute, storage, thermal, io, audio, input.

CONTENT RULES:
- specs: values for THIS configuration only (e.g. memory "8 GB"). Precise numbers only if the notes source them.
- source_url: a URL from the list below that supports this part, else null. Never invent a URL.
- confidence 0..1: how sure the notes make you about this part's existence AND details.
- hazard: lithium_battery for the battery; mains_voltage / hv_capacitor etc. where relevant; else null.
- connections: only real links named or clearly implied by the notes (battery -> board power, display cable…).
- repair_paths: [] (not needed now). provenance: "sourced".
- device.dimensions_mm, device.color (official name + an approximate hex), device.summary (one or two
  sentences, what makes this model notable), device.key_specs (about 6 entries) from the notes.

Research notes:
{notes}

URLs found:
{urls}"""


PART_HINTS = {
    "laptop": "Include the enclosure halves, display assembly, battery, main board, chips that matter for "
              "repair (CPU/SoC, RAM, storage), cooling, ports boards, speakers, microphones, camera, wireless card and antennas, input devices.",
    "car": "Work at SYSTEM level, as an owner would: body, chassis/floor, four wheels, engine, gearbox, 12 V "
           "battery, starter motor, alternator, engine-bay fuse/relay box and cabin fuse box (with their location "
           "from the owner's manual), engine ECU, radiator, fuel tank and pump, exhaust, brake system, airbags, "
           "headlights. For electric/hybrid versions, the high-voltage battery and its location.",
}

CAR_CONVENTIONS = """LAYOUT CONVENTIONS for a CAR (the viewer depends on them):
- One assembly only: "base". position.x 0..1 = left->right (seen from behind), position.y 0..1 = FRONT bumper -> REAR bumper.
- dimensions_mm: width = car width (without mirrors), depth = car LENGTH, height_min = height_max = car height.
- size.w / size.d are fractions of the car width / length; size.h a fraction of the car height.
- Shapes: car_body (the body shell, exactly one, highest layer, finish body); slab (chassis floor, radiator, exhaust);
  wheel (each of the 4 wheels: size.d = wheel diameter / car length (about 0.15), size.w = tyre width / car width
  (about 0.11); front wheels at position.y about 0.2, rear about 0.78; x about 0.09 and 0.91); box (engine, gearbox,
  battery, fuse boxes, fuel tank, airbags, lights); cylinder (starter, alternator); board (ECU).
- layer: 0 = floor, wheels, exhaust; 1 = engine, gearbox, fuel tank, brakes, radiator; 2 = battery, fuses, ECU,
  electrics, airbags, lights; highest = car_body.
- finish: body for the car_body only; internal for everything else.
- hazards: brakes -> brakes; airbags -> airbag; fuel tank/pump/lines -> fuel_system; high-voltage battery -> ev_high_voltage.
- system_id groups: body, chassis, engine, electrical, cooling, fuel, safety."""


def _conventions(category: str, prompt: str) -> str:
    """Swap the laptop layout block for the car one when needed."""
    if category != "car":
        return prompt
    start = prompt.index("LAYOUT CONVENTIONS")
    end = prompt.index("CONTENT RULES:")
    return prompt[:start] + CAR_CONVENTIONS + "\n\n" + prompt[end:]


def _graph_path(variant_id: str, configuration: dict[str, str]) -> "Path":
    tag = hashlib.sha256(json.dumps(configuration, sort_keys=True).encode()).hexdigest()[:8]
    return GRAPH_DIR / f"{variant_id}__{tag}.json"


def extract(variant: Variant, configuration: dict[str, str]) -> PartsGraph:
    path = _graph_path(variant.variant_id, configuration)
    if config.CACHE_READ and path.exists():
        return PartsGraph.model_validate_json(path.read_text())

    cfg = ", ".join(f"{k}: {v}" for k, v in configuration.items()) or "base model"
    try:
        hint = PART_HINTS.get(variant.category, PART_HINTS["laptop"])
        notes, urls = meta_client.web_research(RESEARCH_PROMPT.format(
            model_name=variant.model_name, numbers=", ".join(variant.model_numbers) or "unknown", config=cfg,
            part_hint=hint), label="Reading teardowns, repair guides and official specs…")
        graph = meta_client.structured(
            _conventions(variant.category, STRUCTURE_PROMPT.format(
                model_name=variant.model_name, variant_id=variant.variant_id,
                category=variant.category, config=cfg, notes=notes, urls="\n".join(urls) or "(none)")),
            PartsGraph, system=SYSTEM, retries=2, label="Building the parts graph: every part, where it sits, how it comes out…",
        )
        if len(graph.connections) < len(graph.parts) // 2:
            graph = add_connections(graph, notes)
        graph = post_check(graph, variant, configuration, urls)
    except meta_client.MetaAPIError as e:
        print(f"[extract] {variant.model_name}: falling back to the generic template: {str(e)[:300]}", flush=True)
        # Not cached: a fallback must never be served later as if it were the real extraction.
        return generic_graph(variant, configuration)

    GRAPH_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(graph.model_dump_json(indent=2))
    return graph


class ConnectionList(BaseModel):
    connections: list[Connection]


CONNECT_PROMPT = """These are the parts of {model_name}, as JSON (id, name, function):
{parts}

List the REAL physical links between these parts, using ONLY the ids above:
- power: battery -> main board, charging port board -> main board, …
- data: display cable, keyboard/trackpad flex cables, speaker cables, antenna cables, camera, …
- thermal: chip -> heat spreader / heatsink / fan
- mechanical: what is screwed or glued to what (main board to case, battery to top case, …)
Each link: source id, target id, kind, and a short label (e.g. "Battery connector", "eDP display flex").
Typically one or two links per part. Do not invent parts.

Research notes (for evidence):
{notes}"""


def add_connections(graph: PartsGraph, notes: str) -> PartsGraph:
    """Second, focused call: only the connections, constrained to the existing part ids."""
    parts = [{"id": p.id, "name": p.name, "function": p.function} for p in graph.parts]
    try:
        found = meta_client.structured(
            CONNECT_PROMPT.format(model_name=graph.device.model_name, parts=json.dumps(parts, indent=1), notes=notes),
            ConnectionList, retries=1, label="Linking the parts: power, data, heat, mounting…",
        )
    except meta_client.MetaAPIError as e:
        print(f"[extract] connections pass failed, keeping the graph without extra links: {str(e)[:200]}")
        return graph
    ids = {p.id for p in graph.parts}
    seen = {(c.source, c.target, c.kind) for c in graph.connections}
    for c in found.connections:
        # Code guard: drop links to unknown parts, self-links and duplicates.
        if c.source in ids and c.target in ids and c.source != c.target and (c.source, c.target, c.kind) not in seen:
            graph.connections.append(c)
            seen.add((c.source, c.target, c.kind))
    return PartsGraph.model_validate(graph.model_dump())   # re-run all cross-reference checks


def post_check(graph: PartsGraph, variant: Variant, configuration: dict[str, str], urls: list[str]) -> PartsGraph:
    """Code-side guarantees that do not depend on the model behaving."""
    s = progress.step("HOLOFIX", "Checking every cited source against the search results…")
    graph.device.model_name = variant.model_name
    graph.device.variant_id = variant.variant_id
    graph.device.category = variant.category
    graph.device.configuration = configuration

    allowed = set(urls)
    for part in graph.parts:
        if part.source_url and part.source_url not in allowed:
            part.source_url = None                       # invented or mangled citation: drop it
            part.confidence = round(part.confidence * 0.7, 2)
    for step in (s for rp in graph.repair_paths for s in rp.steps):
        if step.source_url and step.source_url not in allowed:
            step.source_url, step.fastener_detail = None, None   # no source -> no precise specs

    graph.sources = urls
    sourced = sum(1 for p in graph.parts if p.source_url)
    graph.provenance = Provenance.sourced if graph.parts and sourced / len(graph.parts) >= 0.5 else Provenance.generated
    progress.done(s, f"{sourced} of {len(graph.parts)} parts backed by a real source")
    return graph
