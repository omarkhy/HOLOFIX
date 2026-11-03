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
  POST /api/diagnose        {"path": "/data/...json", "symptom": "...", "history": [...]} -> Diagnosis
  GET  /                    the website (frontend/)
  GET  /data/...            samples, templates, cached graphs
"""

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import config
from backend.diagnosis import Diagnosis, Turn, diagnose
from backend.schemas import PartsGraph
from backend.meta_client import MetaAPIError
from backend.pipeline.configure import ConfigOptions, configure
from backend.pipeline.extract import _graph_path, extract
from backend.pipeline.identify import IdentifyResult, Variant, identify

app = FastAPI(title="HOLOFIX")


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


class DiagnoseRequest(BaseModel):
    path: str                     # the graph shown in the viewer, e.g. /data/featured/x.json
    symptom: str
    history: list[Turn] = []
    grounded: bool = True


@app.post("/api/diagnose", response_model=Diagnosis)
def api_diagnose(req: DiagnoseRequest):
    if not req.symptom.strip():
        raise HTTPException(400, "Describe what is wrong, e.g. 'lines on my screen'.")
    # Only files inside data/ may be read (no path tricks like ../../.env).
    file = (config.DATA_DIR / req.path.removeprefix("/data/")).resolve()
    if config.DATA_DIR.resolve() not in file.parents or file.suffix != ".json" or not file.exists():
        raise HTTPException(400, "Unknown device file.")
    graph = PartsGraph.model_validate_json(file.read_text())
    try:
        return diagnose(graph, req.symptom.strip(), req.history, grounded=req.grounded)
    except MetaAPIError as e:
        raise _upstream(e)


# Static files last, so /api/* routes take priority.
app.mount("/data", StaticFiles(directory=config.DATA_DIR), name="data")
app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
