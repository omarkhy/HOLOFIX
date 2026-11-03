"""
try_extract.py — run the whole pipeline from the terminal: identify -> configure -> extract.

From the repo root:
    python -m scripts.try_extract "MacBook Air 2020"          # picks the first variant
    python -m scripts.try_extract "MacBook Air 2020" 2        # picks variant number 2

It uses each option's default configuration, prints a summary of the extracted parts graph,
and tells you the URL to open it in the 3D viewer (with the server running).
"""

import sys

from backend.pipeline.configure import configure
from backend.pipeline.extract import _graph_path, extract
from backend.pipeline.identify import identify

args = sys.argv[1:]
pick = int(args.pop()) if args and args[-1].isdigit() else 1
query = " ".join(args) or "MacBook Air 2020"

print(f"1/3 identify {query!r}…")
found = identify(query)
for i, v in enumerate(found.variants, 1):
    print(f"   {i}. {v.model_name}  [{', '.join(v.model_numbers)}]")
variant = found.variants[pick - 1]

print(f"2/3 configure {variant.model_name}…")
options = configure(variant)
configuration = {o.key: o.default for o in options.options}
for o in options.options:
    fixed = "" if o.upgradeable_later is not False else "  (fixed at purchase)"
    print(f"   {o.label}: {o.default}   choices: {', '.join(o.choices)}{fixed}")

print("3/3 extract parts graph (web research + structuring, 1-3 min the first time)…")
graph = extract(variant, configuration)

sourced = sum(1 for p in graph.parts if p.source_url)
print(f"\nprovenance: {graph.provenance.value}   parts: {len(graph.parts)}   with a source: {sourced}"
      f"   connections: {len(graph.connections)}   sources: {len(graph.sources)}")
print(f"dimensions: {graph.device.dimensions_mm}   colour: {graph.device.color}")
for p in sorted(graph.parts, key=lambda p: (p.assembly.value, p.layer)):
    print(f"   [{p.assembly.value} L{p.layer}] {p.name:<28} {p.shape.value:<12} {p.serviceability.value:<16} conf {p.confidence:.2f}")

path = _graph_path(variant.variant_id, configuration).relative_to(_graph_path("x", {}).parents[2])
print(f"\nOpen in the viewer (server running):  http://localhost:8000/?data=/data/{path.as_posix()}")
