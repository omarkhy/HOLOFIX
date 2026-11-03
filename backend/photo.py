"""
photo.py — photo diagnosis: a picture of the problem -> what is visibly wrong, outlined by SAM 3.1,
turned into a symptom the diagnosis engine can use.

Three Meta models, each doing what it is best at:
  1. Muse Spark (vision)   looks at the photo: what device area is shown, what visible damage there
                           is, and the short noun phrase that names it ("cracked screen", "keyboard").
  2. Muse Spark (schema)   turns those notes into a validated PhotoReading (structured output).
  3. SAM 3.1               segments that noun phrase in the photo: box + pixel mask, with confidence.
The outline is drawn over the photo in the UI, and the observation feeds diagnosis.py.

SAM request shape and output markers were confirmed with scripts/test_sam.py. Masks are decoded
with Meta's own parser (meta-sam-parser); if that fails we fall back to the boxes (regex).
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field

from backend import meta_client, progress


class PhotoReading(BaseModel):
    device_area: str = Field(..., description="What part of the device the photo shows, e.g. 'keyboard and palm rest'")
    observation: str = Field(..., description="One or two sentences: what is visibly wrong, or 'no visible damage'")
    noun_phrase: str = Field(..., description="2-4 words naming the damaged thing for segmentation, e.g. 'cracked screen'")
    symptom: str = Field(..., description="The problem as a user would say it, e.g. 'my screen is cracked'")
    visible_damage: bool


class Region(BaseModel):
    left: float
    top: float
    right: float
    bottom: float
    confidence: float | None = None
    path: str | None = Field(None, description="SVG path of the mask, in image pixels (None = box only)")


class PhotoResult(BaseModel):
    reading: PhotoReading
    width: int | None = None
    height: int | None = None
    regions: list[Region] = []


LOOK_PROMPT = """This photo was taken by the owner of a {model}, who wants to repair it.
Describe precisely: which area of the device is visible, and any visible damage or anomaly (cracks, dead
pixels, lines, swelling, gaps, missing or stuck keys, burn marks, corrosion, bent pins, liquid traces…).
Then name the damaged thing in 2-4 words (or the main visible component if nothing is damaged).
Be honest: if nothing looks wrong, say so."""


def _vision(prompt: str, data_url: str, model: str | None = None) -> str:
    body = {"input": [{"role": "user", "content": [
        {"type": "input_text", "text": prompt}, {"type": "input_image", "image_url": data_url}]}]}
    if model:
        body["model"] = model
    else:
        body["model"] = meta_client.config.META_MODEL
    s = progress.step("Muse Spark", "Looking at your photo…")
    data = meta_client._post("/responses", body)
    progress.done(s, "Looked at your photo")
    msgs = [o for o in data.get("output", []) if o.get("type") == "message"]
    return "".join(c.get("text", "") for c in (msgs[-1].get("content", []) if msgs else [])) or data.get("output_text", "")


def segment(data_url: str, phrase: str) -> tuple[list[Region], int | None, int | None]:
    """SAM 3.1: regions matching `phrase` in the image."""
    body = {"model": "sam-3.1", "metadata": {"include_confidence": "true"},
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": phrase}, {"type": "input_image", "image_url": data_url}]}]}
    s = progress.step("SAM 3.1", f"Outlining “{phrase}” on your photo…")
    data = meta_client._post("/responses", body)
    text = data.get("output_text") or "".join(
        c.get("text", "") for o in data.get("output", []) if o.get("type") == "message" for c in o.get("content", []))

    w = h = None
    size = re.search(r"w=(\d+);h=(\d+)", text)
    if size:
        w, h = int(size.group(1)), int(size.group(2))

    regions: list[Region] = []
    try:   # exact masks, decoded with Meta's parser
        import meta_sam_parser as sam
        parser = sam.image_segmentation_format().create_parser()
        parser.push(text)
        for rec in parser.finish(sam.CompletedOutcome()).result.records:
            if isinstance(rec, sam.SegmentationMaskRecord):
                b, m = rec.bounds, rec.mask
                path = sam.decode_mask_to_svg_path(m)
                # The mask is a small raster covering the box: scale it onto the box, in image pixels.
                sx, sy = (b.right - b.left) / m.width, (b.bottom - b.top) / m.height
                regions.append(Region(left=b.left, top=b.top, right=b.right, bottom=b.bottom, confidence=rec.confidence,
                                      path=f'<path transform="translate({b.left} {b.top}) scale({sx} {sy})" d="{path}"/>'))
    except Exception as e:   # parser missing or format surprise: keep going with boxes
        print(f"[photo] mask decoding skipped: {type(e).__name__}: {str(e)[:150]}")

    if not regions:          # boxes from the raw markers
        for m in re.finditer(r"<\|box;x1=([\d.]+);y1=([\d.]+);x2=([\d.]+);y2=([\d.]+)[^|]*?(?:;c=([\d.]+))?\|>", text):
            x1, y1, x2, y2 = map(float, m.group(1, 2, 3, 4))
            regions.append(Region(left=x1, top=y1, right=x2, bottom=y2, confidence=float(m.group(5)) if m.group(5) else None))
    best = max((r.confidence or 0 for r in regions), default=0)
    progress.done(s, f"Outlined “{phrase}”: {len(regions)} region{'s' if len(regions) != 1 else ''}"
                     + (f", {round(best * 100)}% confident" if best else "") if regions else f"Found no “{phrase}” in the photo")
    return regions, w, h


def read_photo(model_name: str, data_url: str) -> PhotoResult:
    notes = _vision(LOOK_PROMPT.format(model=model_name), data_url)
    reading = meta_client.structured(
        f"Device: {model_name}. Turn these observations of a photo into the JSON schema.\n\nObservations:\n{notes}",
        PhotoReading, label="Describing what is visibly wrong…")
    regions, w, h = segment(data_url, reading.noun_phrase)
    return PhotoResult(reading=reading, width=w, height=h, regions=regions)
