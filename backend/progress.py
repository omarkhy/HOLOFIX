"""
progress.py — live "what is the AI doing right now" steps, shown to the user while a job runs.

Every long request (identify, extract, diagnose, photo, guide) runs as a background JOB. While it runs,
the pipeline reports steps such as
    Muse Spark · Searching the web for "MacBook Air 2020"…        (running)
    Muse Spark · Read 6 sources: ifixit.com, apple.com, …         (done, 31.2 s)
    SAM 3.1    · Outlining "cracked screen" on your photo…        (running)
and the browser polls GET /api/jobs/{id} to draw them. The steps are real: they are emitted by the
code that calls each model, and the website names come from the sources actually returned.

The current job is carried by a ContextVar, so pipeline code just calls step()/done() and never needs
to know about jobs. Outside a job (scripts, evaluation) the calls do nothing.
"""

from __future__ import annotations

import contextvars
import threading
import time
import uuid
from typing import Any, Callable, Optional
from urllib.parse import urlparse

_current: contextvars.ContextVar[Optional["Job"]] = contextvars.ContextVar("holofix_job", default=None)
_jobs: dict[str, "Job"] = {}
_lock = threading.Lock()


class Job:
    def __init__(self):
        self.id = uuid.uuid4().hex[:12]
        self.started = time.time()
        self.steps: list[dict] = []
        self.status = "running"
        self.result: Any = None
        self.error: Optional[str] = None

    def view(self) -> dict:
        now = time.time()
        steps = [{**s, "seconds": round((s.get("ended") or now) - s["t0"], 1)} for s in self.steps]
        return {"id": self.id, "status": self.status, "seconds": round(now - self.started, 1),
                "steps": [{k: v for k, v in s.items() if k not in ("t0", "ended")} for s in steps],
                "result": self.result, "error": self.error}


def start(fn: Callable[[], Any]) -> Job:
    """Run fn() in a background thread as a job; returns immediately."""
    job = Job()
    with _lock:
        for k in [k for k, j in _jobs.items() if time.time() - j.started > 3600]:   # forget jobs after 1 h
            del _jobs[k]
        _jobs[job.id] = job

    def run():
        _current.set(job)
        try:
            job.result = fn()
            job.status = "done"
        except Exception as e:                       # shown to the user, so keep it readable
            job.error = getattr(e, "detail", None) or str(e)
            job.status = "error"
            for s in job.steps:
                if s["state"] == "running":
                    s.update(state="error", ended=time.time())

    threading.Thread(target=run, daemon=True).start()
    return job


def get(job_id: str) -> Optional[Job]:
    return _jobs.get(job_id)


def step(model: str, text: str) -> Optional[dict]:
    job = _current.get()
    if job is None:
        return None
    s = {"model": model, "text": text, "state": "running", "t0": time.time(), "ended": None}
    job.steps.append(s)
    return s


def done(s: Optional[dict], text: Optional[str] = None, state: str = "done") -> None:
    if s is None:
        return
    if text:
        s["text"] = text
    s.update(state=state, ended=time.time())


def update(s: Optional[dict], text: str) -> None:
    if s is not None:
        s["text"] = text


def hosts(urls: list[str], n: int = 4) -> str:
    """'ifixit.com, apple.com, everymac.com' — site names only, never full URLs."""
    names = []
    for u in urls:
        h = urlparse(u).hostname or ""
        h = h.removeprefix("www.")
        parts = h.split(".")
        short = ".".join(parts[-3:]) if len(parts) > 2 and parts[-2] in ("co", "com", "org") else ".".join(parts[-2:])
        if short and short not in names:
            names.append(short)
    more = f" +{len(names) - n}" if len(names) > n else ""
    return ", ".join(names[:n]) + more


def copy_context_run(fn, *args):
    """For worker threads started INSIDE a job (parallel research): keep reporting to the same job."""
    ctx = contextvars.copy_context()
    return lambda: ctx.run(fn, *args)
