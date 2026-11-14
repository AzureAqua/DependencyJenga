"""Dependency Jenga backend: GET /api/analyze?url=<git repo url>, plus static frontend."""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import analyzer
from .repo import AnalysisError

log = logging.getLogger("jenga")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(ROOT, "frontend")

app = FastAPI(title="Dependency Jenga")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])


@app.exception_handler(AnalysisError)
async def _analysis_error(_, exc: AnalysisError):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status)


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/analyze")
async def analyze(url: str = Query("", description="git repository URL (http/https)")):
    try:
        return await analyzer.analyze(url)
    except AnalysisError:
        raise
    except Exception as e:  # never leak a stack trace to the client
        log.exception("analysis failed")
        return JSONResponse({"detail": f"Internal error while analysing the repository: {type(e).__name__}"},
                            status_code=500)


# Mounted last so API routes win.  check_dir=False: frontend/ may not exist yet at import time.
app.mount("/", StaticFiles(directory=FRONTEND, html=True, check_dir=False), name="frontend")
