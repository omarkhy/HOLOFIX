"""
main.py — the FastAPI server. Serves the website AND the API from one address, so the
browser never has cross-origin (CORS) issues.

Run from the repo root:
    uvicorn backend.main:app --reload --port 8000
Then open http://localhost:8000

Routes (the website calls them in this order):
  GET  /api/health          is the server up, which model is configured
  POST /api/identify        {"query": "MacBook Air 2020"}            -> variants to choose from
  POST /api/configure       {"variant": {...}}                      -> purchase options
  POST /api/extract         {"variant": {...}, "configuration": {}} -> {path} of the saved PartsGraph
  POST /api/photo           {"path": "...", "image": "data:image/jpeg;base64,..."} -> PhotoResult (Muse Spark + SAM 3.1)
  POST /api/guide           {"path": "...", "part_id": "...", "symptom": "..."} -> RepairGuide (printable)
  POST /api/jobs            {"kind": "identify|configure|extract|diagnose|photo|guide", "payload": {...}}
                            -> {"id"}; runs the same handler in the background, reporting live steps
  GET  /api/jobs/{id}       -> {"status", "steps": [{model, text, state, seconds}], "result", "error"}
  POST /api/diagnose        {"path": "/data/...json", "symptom": "...", "history": [...]} -> Diagnosis
  GET  /                    the website (frontend/)
  GET  /data/...            samples, templates, cached graphs
"""

import hashlib
import json

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import config, progress
from backend.diagnosis import Diagnosis, Turn, diagnose
from backend.guide import RepairGuide, make_guide
from backend.photo import PhotoResult, read_photo
from backend.schemas import PartsGraph
from backend.meta_client import MetaAPIError
from backend.pipeline.configure import ConfigOptions, configure
from backend.pipeline.extract import _graph_path, extract
from backend.pipeline.identify import IdentifyResult, Variant, identify

app = FastAPI(title="HOLOFIX")


@app.middleware("http")
async def no_stale_frontend(request, call_next):
    """The website's own files (JS, CSS, HTML) must never be served stale from the browser cache:
    a new home.js with an old cached library.js breaks the whole page. "no-cache" makes the browser
    re-check each file with the server (cheap: unchanged files answer 304 Not Modified)."""
    response = await call_next(request)
    if not request.url.path.startswith(("/api/", "/data/")):
        response.headers["Cache-Control"] = "no-cache"
    return response


class IdentifyRequest(BaseModel):
    query: str


class ConfigureRequest(BaseModel):
    variant: Variant


class ExtractRequest(BaseModel):
    variant: Variant
    configuration: dict[str, str] = {}


def _upstream(e: MetaAPIError):
    # 502 = the upstream AI service failed; the message is shown in the UI and in the terminal.
    return HTTPException(502, str(e))


@app.get("/api/health")
def health():
    return {"ok": True, "model": config.META_MODEL, "key_loaded": bool(config.META_API_KEY), "cache": config.CACHE_ENABLED}


@app.post("/api/identify", response_model=IdentifyResult)
def api_identify(req: IdentifyRequest):
    query = req.query.strip()
    if not query:
        raise HTTPException(400, "Type a device name, e.g. 'MacBook Air 2020'.")
    try:
        return identify(query)
    except MetaAPIError as e:
        raise _upstream(e)


@app.post("/api/configure", response_model=ConfigOptions)
def api_configure(req: ConfigureRequest):
    try:
        return configure(req.variant)
    except MetaAPIError as e:
        raise _upstream(e)


class ExtractResponse(BaseModel):
    path: str            # URL of the saved graph, e.g. /data/cache/graphs/<variant>__<config>.json
    provenance: str
    parts: int


@app.post("/api/extract", response_model=ExtractResponse)
def api_extract(req: ExtractRequest):
    # extract() never raises on API errors: it falls back to a labelled generic template.
    graph = extract(req.variant, req.configuration)
    rel = _graph_path(req.variant.variant_id, req.configuration).relative_to(config.DATA_DIR)
    return ExtractResponse(path=f"/data/{rel.as_posix()}", provenance=graph.provenance.value, parts=len(graph.parts))


def _load_graph(path: str) -> PartsGraph:
    # Only files inside data/ may be read (no path tricks like ../../.env).
    file = (config.DATA_DIR / path.removeprefix("/data/")).resolve()
    if config.DATA_DIR.resolve() not in file.parents or file.suffix != ".json" or not file.exists():
        raise HTTPException(400, "Unknown device file.")
    return PartsGraph.model_validate_json(file.read_text())


class PhotoRequest(BaseModel):
    path: str
    image: str           # data URL; the browser downsizes it to <= 1600 px JPEG first


@app.post("/api/photo", response_model=PhotoResult)
def api_photo(req: PhotoRequest):
    if not req.image.startswith("data:image/") or len(req.image) > 8_000_000:
        raise HTTPException(400, "Send a JPEG or PNG photo under about 6 MB.")
    graph = _load_graph(req.path)
    try:
        return read_photo(graph.device.model_name, req.image)
    except MetaAPIError as e:
        raise _upstream(e)


class GuideRequest(BaseModel):
    path: str
    part_id: str
    symptom: str | None = None


@app.post("/api/guide", response_model=RepairGuide)
def api_guide(req: GuideRequest):
    graph = _load_graph(req.path)
    # Finished guides are saved: reopening one (e.g. from the Diagnoses page) is instant and free.
    key = hashlib.sha256(json.dumps([req.path, req.part_id, req.symptom or ""]).encode()).hexdigest()[:16]
    saved = config.DATA_DIR / "cache" / "guides" / f"{key}.json"
    if config.CACHE_READ and saved.exists():
        return RepairGuide.model_validate_json(saved.read_text())
    try:
        guide = make_guide(graph, req.part_id, req.symptom)
        saved.parent.mkdir(parents=True, exist_ok=True)
        saved.write_text(guide.model_dump_json(indent=2))
        return guide
    except ValueError as e:
        raise HTTPException(400, str(e))
    except MetaAPIError as e:
        raise _upstream(e)


class DiagnoseRequest(BaseModel):
    path: str                     # the graph shown in the viewer, e.g. /data/featured/x.json
    symptom: str
    history: list[Turn] = []
    grounded: bool = True


@app.post("/api/diagnose", response_model=Diagnosis)
def api_diagnose(req: DiagnoseRequest):
    if not req.symptom.strip():
        raise HTTPException(400, "Describe what is wrong, e.g. 'lines on my screen'.")
    graph = _load_graph(req.path)
    try:
        return diagnose(graph, req.symptom.strip(), req.history, grounded=req.grounded)
    except MetaAPIError as e:
        raise _upstream(e)


# ---------- Background jobs with live progress (what the website uses) ----------

class JobRequest(BaseModel):
    kind: str
    payload: dict


def _handlers():
    return {
        "identify": (IdentifyRequest, api_identify), "configure": (ConfigureRequest, api_configure),
        "extract": (ExtractRequest, api_extract), "diagnose": (DiagnoseRequest, api_diagnose),
        "photo": (PhotoRequest, api_photo), "guide": (GuideRequest, api_guide),
    }


@app.post("/api/jobs")
def api_job_start(req: JobRequest):
    if req.kind not in _handlers():
        raise HTTPException(400, f"Unknown job kind {req.kind!r}.")
    model, handler = _handlers()[req.kind]
    payload = model(**req.payload)                  # validation errors surface immediately (422)

    def work():
        out = handler(payload)
        return out.model_dump(mode="json") if hasattr(out, "model_dump") else out

    return {"id": progress.start(work).id}


@app.get("/api/jobs/{job_id}")
def api_job_status(job_id: str):
    job = progress.get(job_id)
    if job is None:
        raise HTTPException(404, "This job is unknown or expired. Start it again.")
    return job.view()


# Static files last, so /api/* routes take priority.
app.mount("/data", StaticFiles(directory=config.DATA_DIR), name="data")
app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
