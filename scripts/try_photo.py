"""
try_photo.py — photo diagnosis from the terminal: Muse Spark reads the photo, SAM 3.1 outlines it.

From the repo root:
    python -m scripts.try_photo ~/Downloads/keyboard.jpg "MacBook Air (M1, 2020)"
"""

import base64
import mimetypes
import sys
from pathlib import Path

from backend.photo import read_photo

img = Path(sys.argv[1])
model = sys.argv[2] if len(sys.argv) > 2 else "laptop"
url = f"data:{mimetypes.guess_type(img.name)[0] or 'image/jpeg'};base64,{base64.b64encode(img.read_bytes()).decode()}"
r = read_photo(model, url)
print(r.reading.model_dump_json(indent=2))
print(f"image {r.width}x{r.height}, regions: {len(r.regions)}")
for g in r.regions:
    kind = f"mask outline ({len(g.path)} chars)" if g.path else "box only"
    print(f"   [{g.left:.0f},{g.top:.0f} -> {g.right:.0f},{g.bottom:.0f}] conf {g.confidence}  {kind}")
