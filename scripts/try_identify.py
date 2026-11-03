"""
try_identify.py — run identification from the terminal, without the website.

From the repo root:
    python -m scripts.try_identify "MacBook Air 2020"

Prints the variants as JSON. The raw API answers are cached in data/cache/llm/, so running
the same query twice is instant and free.
"""

import sys

from backend.pipeline.identify import identify

query = " ".join(sys.argv[1:]) or "MacBook Air 2020"
print(f"Identifying: {query!r} (web search + structuring, ~30-90 s the first time)…\n")
result = identify(query)
print(result.model_dump_json(indent=2))
