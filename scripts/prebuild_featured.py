"""
prebuild_featured.py — pre-extract a list of popular laptops so they open instantly on the home
page ("Popular laptops, ready to open") and the demo never waits on the API.

From the repo root:
    python -m scripts.prebuild_featured            # all devices, 3 at a time
    python -m scripts.prebuild_featured --jobs 1   # one at a time (if the API rate-limits)
    HOLOFIX_CACHE=refresh python -m scripts.prebuild_featured "MacBook Air M2 2022"
                                                   # retry only that one, ignoring its cached answers

Each device: identify -> first variant -> default configuration -> extract. Failures are
skipped and reported. Re-running is cheap: everything already done comes from the cache.
Results are COPIED to data/featured/ (committed to git, unlike data/cache/), with an index.json
the home page reads.
"""

import argparse
import json
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed

from backend import config
from backend.pipeline.configure import configure
from backend.pipeline.extract import _graph_path, extract
from backend.pipeline.identify import identify

# Popular, widely repaired laptops across brands. Framework is the right-to-repair reference.
FEATURED = [
    "MacBook Air M1 2020",
    "MacBook Air M2 2022",
    "MacBook Pro 14 M3 2023",
    "Dell XPS 13 9310",
    "Lenovo ThinkPad X1 Carbon Gen 11",
    "Lenovo ThinkPad T14 Gen 3",
    "HP Spectre x360 14 2022",
    "ASUS Zenbook 14 OLED UX3402",
    "Microsoft Surface Laptop 5",
    "Framework Laptop 13",
    "Renault Clio IV 2016",          # breadth demo: a car at system level
]

OUT = config.DATA_DIR / "featured"


def build(query: str) -> dict:
    variant = identify(query).variants[0]
    options = configure(variant)
    configuration = {o.key: o.default for o in options.options}
    graph = extract(variant, configuration)
    if graph.provenance.value != "sourced":
        # The fallback template is not this laptop: never feature it as if it were.
        raise RuntimeError("extraction fell back to the generic template; re-run later")
    src = _graph_path(variant.variant_id, configuration)
    dst = OUT / f"{variant.variant_id}.json"
    shutil.copyfile(src, dst)
    return {
        "query": query,
        "model_name": graph.device.model_name,
        "path": f"/data/featured/{dst.name}",
        "parts": len(graph.parts),
        "provenance": graph.provenance.value,
        "color": graph.device.color.hex if graph.device.color else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("names", nargs="*", help="only these devices (default: the whole list)")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    # Keep devices already built by earlier runs; only the requested ones are (re)built.
    index_file = OUT / "index.json"
    done = {d["query"]: d for d in json.loads(index_file.read_text())["devices"]} if index_file.exists() else {}
    todo = args.names or FEATURED
    failed = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(build, q): q for q in todo}
        for f in as_completed(futures):
            q = futures[f]
            try:
                done[q] = f.result()
                d = done[q]
                print(f"  ok   {q:<36} -> {d['model_name']} ({d['parts']} parts, {d['provenance']})")
            except Exception as e:   # one bad device must not stop the others
                failed.append(q)
                print(f"  FAIL {q:<36} {type(e).__name__}: {str(e)[:200]}")

    order = FEATURED + [q for q in done if q not in FEATURED]
    devices = [done[q] for q in order if q in done]       # keep the list order
    (OUT / "index.json").write_text(json.dumps({"devices": devices}, indent=2))
    print(f"\n{len(devices)} featured devices written to data/featured/ ({len(failed)} failed: {failed or 'none'})")


if __name__ == "__main__":
    main()
