"""
fallback.py — when extraction fails (API error, no sources, unrepairable JSON), we still show
something useful: a generic template for the device category, clearly labelled "generated"
(the UI shows "Unverified data"). Templates live in data/templates/<category>_generic.json.
"""

from __future__ import annotations

from backend import config
from backend.pipeline.identify import Variant
from backend.schemas import PartsGraph, Provenance

TEMPLATES = config.DATA_DIR / "templates"


def generic_graph(variant: Variant, configuration: dict[str, str]) -> PartsGraph:
    path = TEMPLATES / f"{variant.category}_generic.json"
    if not path.exists():
        path = TEMPLATES / "laptop_generic.json"         # the only template so far
    graph = PartsGraph.model_validate_json(path.read_text())
    graph.device.model_name = variant.model_name
    graph.device.variant_id = variant.variant_id
    graph.device.category = variant.category
    graph.device.configuration = configuration
    graph.device.summary = (f"Generic {variant.category} layout. We could not extract this model's "
                            "parts from sources, so this is a typical layout, not its real one.")
    graph.provenance = Provenance.generated
    return graph
