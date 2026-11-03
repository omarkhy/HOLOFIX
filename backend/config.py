"""
config.py — every setting in one place, read from .env (never hard-coded, never committed).

.env keys:
  META_API_KEY        required
  META_API_BASE       optional, default https://api.meta.ai/v1
  META_MODEL          optional, default muse-spark-1.3
  META_REASONING      optional: minimal | low | medium | high. Unset = the API's default.
                      Not yet confirmed by a test call, so it is off unless you set it.
  HOLOFIX_CACHE       optional: "off" disables the LLM cache (default: on)
"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent      # the repo root
load_dotenv(ROOT / ".env")

META_API_KEY = os.getenv("META_API_KEY", "")
META_API_BASE = os.getenv("META_API_BASE", "https://api.meta.ai/v1")
META_MODEL = os.getenv("META_MODEL", "muse-spark-1.3")
META_REASONING = os.getenv("META_REASONING") or None

CACHE_DIR = ROOT / "data" / "cache" / "llm"
CACHE_ENABLED = os.getenv("HOLOFIX_CACHE", "on").lower() != "off"

FRONTEND_DIR = ROOT / "frontend"
DATA_DIR = ROOT / "data"
