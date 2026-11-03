"""
main.py — the FastAPI server. Serves the website AND the API from one address, so the
browser never has cross-origin (CORS) issues.

Run from the repo root:
    uvicorn backend.main:app --reload --port 8000
Then open http://localhost:8000

Routes:
  GET  /                    the website (frontend/)
  GET  /data/...            sample and template JSON files
  GET  /api/health          is the server up, which model is configured
  POST /api/identify        {"query": "MacBook Air 2020"} -> variants to choose from
"""

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import config
from backend.meta_client import MetaAPIError
from backend.pipeline.identify import IdentifyResult, identify

app = FastAPI(title="HOLOFIX")


class IdentifyRequest(BaseModel):
    query: str


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
        # 502 = the upstream AI service failed; the message is shown in the UI and the terminal.
        raise HTTPException(502, str(e))


# Static files last, so /api/* routes take priority.
app.mount("/data", StaticFiles(directory=config.DATA_DIR), name="data")
app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
