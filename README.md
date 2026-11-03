```
    ████████████        ▀▀      ▀▀    ▀▀▀▀▀▀    ▀▀            ▀▀▀▀▀▀      ██████████  ██████  ██      ██
    ██████████▀▀        ▀▀      ▀▀  ▀▀      ▀▀  ▀▀          ▀▀      ▀▀    ██            ██    ██      ██
████████████▀▀▀▀        ▀▀      ▀▀  ▀▀      ▀▀  ▀▀          ▀▀      ▀▀    ██            ██      ██  ██
████████████▀▀▀▀        ▀▀▀▀▀▀▀▀▀▀  ▀▀      ▀▀  ▀▀          ▀▀      ▀▀    ████████      ██        ██
████████████▀▀▀▀        ▀▀      ▀▀  ▀▀      ▀▀  ▀▀          ▀▀      ▀▀    ██            ██      ██  ██
████████████▀▀          ▀▀      ▀▀  ▀▀      ▀▀  ▀▀          ▀▀      ▀▀    ██            ██    ██      ██
████████████            ▀▀      ▀▀    ▀▀▀▀▀▀    ▀▀▀▀▀▀▀▀▀▀    ▀▀▀▀▀▀      ██          ██████  ██      ██
                        see inside any device · repair what you can
```

# HOLOFIX

**Type any device. See inside it. Find what's broken. Fix it, or know exactly what to ask a repair shop.**

HOLOFIX turns a model name ("MacBook Air 2020", "ROG Strix G16 2025", "Renault Clio IV") into an explodable 3D
hologram built from real teardowns and spec sheets, diagnoses a problem from a sentence or a photo, and writes a
cited, priced repair guide. Built for the Meta Global AI Developer Hackathon 2026 (indie track).

**Why:** most broken devices are thrown away because people don't know what is wrong, whether it is fixable, or what
it would cost. Right to repair (the EU's repair rules, France's *indice de réparabilité / durabilité*) only helps if
repairing is understandable. HOLOFIX makes it visual and honest.

## What it does

| | |
|---|---|
| **Any device** | Muse Spark identifies the exact variant (asks when a name is ambiguous), its purchase options, then extracts 15–30 parts with positions, connections, what is soldered or glued, and a source for each. |
| **3D hologram** | Built procedurally in the browser from the official dimensions and the parts graph: real colours first, a scan line turns it into a hologram, then it explodes. Laptops and cars (system level). |
| **Diagnosis** | Describe the symptom, or add a photo. The likely parts glow on the model; HOLOFIX asks the one question that best narrows them down; fixes are tiered green / yellow / red. |
| **Photo** | Muse Spark (vision) describes the visible damage; SAM 3.1 outlines it on the photo. |
| **Repair guide** | Printable PDF: pictures of the part on *your* device, tools, cited steps, and real prices (do it yourself vs repair shop vs buy new). |
| **Live progress** | While the AI works, the user sees which model is doing what, and which sites it read. |

## Meta models used

| Model | Used for |
|---|---|
| **Muse Spark 1.3** | Web-grounded research (identify, configure, teardowns, repair guides, prices), structured output (every JSON is schema-constrained), vision (photo reading) |
| **SAM 3.1** | Segmenting the visible damage in user photos (box + pixel mask, decoded with Meta's `meta-sam-parser`) |

## Rules enforced in code (not in prompts)

- Every source shown must be a URL the search actually returned; invented links are deleted and confidence lowered.
- Screw types, sizes, counts and torques are kept only when the step cites a source.
- Every price must cite its page; totals are computed by code.
- Hard safety stops — diagnosis only, "see a professional", no steps — for swollen/damaged batteries, smoke, mains
  voltage, capacitors, airbags, brakes, fuel and EV high voltage (`backend/safety.py`).
- Suspect parts must exist in the device's parts graph; Pydantic validates every model answer and sends errors back for repair.
- If extraction fails, a generic layout is shown, labelled "Unverified".

## Results

The evaluation (`eval/`) measures diagnosis accuracy on documented symptom → cause cases, in two modes (Muse Spark
alone vs Muse Spark grounded in repair sources), safety-stop recall, and parts-extraction recall/precision against
hand-checked teardown part lists. The table below is written by the script, never by hand.

<!-- EVAL:START -->
*Not run yet: `python -m eval.run_eval`*
<!-- EVAL:END -->

## Architecture

```
browser (plain HTML + Three.js via import map, no build step)
  home.js     search -> variant -> configuration -> extraction      jobs.js  live progress (polls /api/jobs)
  viewer.js   3D build, explode, scan line, diagnosis, guide shots   shapes.js procedural geometry
  guide.html  printable repair guide                                 library.js devices + diagnoses (this browser)
        |
FastAPI (backend/main.py) — every long call runs as a background job with live steps (backend/progress.py)
  pipeline/identify.py  configure.py  extract.py (+ connections pass, source checks, fallback.py)
  diagnosis.py  safety.py  photo.py  guide.py (+ prices)
  meta_client.py — the only file that calls the Meta API: web research, structured output + repair loop, disk cache
  schemas.py — the PartsGraph schema (Pydantic), the contract between AI, code and 3D
```

## How to run

```bash
git clone https://github.com/omarkhy/HOLOFIX && cd HOLOFIX
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
echo "META_API_KEY=your_key" > .env
uvicorn backend.main:app --port 8000        # open http://localhost:8000
```

Optional: `python -m scripts.prebuild_featured` (pre-extracts the featured devices), `python -m eval.run_eval`
(evaluation). The featured devices in `data/featured/` open without any API call.

## Limitations

- Internal part positions are estimated from teardown text and photos: the outer shape is accurate, the inside approximate.
- The car body is a generic hatchback silhouette scaled to the real dimensions.
- Diagnosis is a starting point, not a guarantee; the evaluation cases are documented failure patterns, not field data.
- Devices and diagnoses are stored in the browser (no accounts).
- First extraction of a new device takes several minutes; everything is cached afterwards.

## Ethics and safety

HOLOFIX never gives instructions for dangerous repairs, shows its sources everywhere, labels unverified data, and
states plainly that AI-written guides can be wrong. Photos are sent to the Meta API only for the analysis requested.

## AI assistance

Code was written with the help of Claude (Anthropic) under the author's direction; design decisions, testing and
evaluation review by the author.

## License

MIT
