"""
test_sam.py — confirm how SAM 3.1 is called on our key, before building on it.

From the repo root (any photo works; a photo of a laptop keyboard is ideal):
    python -m scripts.test_sam path/to/photo.jpg "keyboard"

What we know from public write-ups (not yet confirmed on our key):
  - model "sam-3.1", served through the Responses API (/responses), bearer auth;
  - input = an image + a short noun phrase ("keyboard", "crack", "battery");
  - output = text with special markers, e.g. <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|> then a mask record.
This script tries the two most likely request shapes and prints what comes back, raw.
The full raw response is saved to data/cache/test_sam.json.
"""

import base64
import json
import mimetypes
import re
import sys
from pathlib import Path

import httpx

from backend import config

if len(sys.argv) < 3:
    sys.exit('usage: python -m scripts.test_sam photo.jpg "noun phrase"')
img, phrase = Path(sys.argv[1]), sys.argv[2]
mime = mimetypes.guess_type(img.name)[0] or "image/jpeg"
data_url = f"data:{mime};base64,{base64.b64encode(img.read_bytes()).decode()}"

client = httpx.Client(base_url=config.META_API_BASE, timeout=180,
                      headers={"Authorization": f"Bearer {config.META_API_KEY}", "Content-Type": "application/json"})

SHAPES = {
    "A: input_image as a string": [{"role": "user", "content": [
        {"type": "input_text", "text": phrase}, {"type": "input_image", "image_url": data_url}]}],
    "B: input_image as an object": [{"role": "user", "content": [
        {"type": "input_text", "text": phrase}, {"type": "input_image", "image_url": {"url": data_url}}]}],
}

for name, inp in SHAPES.items():
    print(f"\n=== Shape {name}")
    r = client.post("/responses", json={"model": "sam-3.1", "input": inp, "metadata": {"include_confidence": "true"}})
    if r.status_code != 200:
        print(f"   HTTP {r.status_code}\n   {r.text[:1500]}")
        continue
    data = r.json()
    Path("data/cache").mkdir(parents=True, exist_ok=True)
    Path("data/cache/test_sam.json").write_text(json.dumps(data, indent=2))
    text = data.get("output_text") or "".join(
        c.get("text", "") for o in data.get("output", []) if o.get("type") == "message" for c in o.get("content", []))
    print("   PASS. output item types:", [o.get("type") for o in data.get("output", [])])
    print("   text (first 1200 chars):", text[:1200])
    boxes = re.findall(r"<\|box;([^|]*)\|>", text)
    print(f"   boxes found: {len(boxes)}", boxes[:5])
    break
