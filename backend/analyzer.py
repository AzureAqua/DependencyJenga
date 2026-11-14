"""Orchestrates clone -> scan -> metrics -> JSON, with memory + disk caching."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from urllib.parse import urlparse

from . import metrics, repo
from .models import Dep
from .repo import AnalysisError
from .scanners import scan_repo

MAX_DEPS = 250
CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
MEM_TTL = 24 * 3600
DISK_TTL = 7 * 24 * 3600

_mem: dict = {}        # key -> (timestamp, result)
_inflight: dict = {}   # key -> asyncio.Task

KIND_ORDER = {"language": 0, "runtime": 1, "package_manager": 2, "build_tool": 3, "container": 4,
              "ci": 5, "system": 6, "package": 7}


def _disk_path(key: str) -> str:
    return os.path.join(CACHE_DIR, hashlib.sha1(key.encode()).hexdigest() + ".json")


def _load_cached(key: str):
    hit = _mem.get(key)
    if hit and time.time() - hit[0] < MEM_TTL:
        return hit[1]
    p = _disk_path(key)
    try:
        if os.path.exists(p) and time.time() - os.path.getmtime(p) < DISK_TTL:
            with open(p, "r", encoding="utf-8") as fh:
                res = json.load(fh)
            _mem[key] = (time.time(), res)
            return res
    except (OSError, ValueError):
        pass
    return None


def _store(key: str, result: dict):
    _mem[key] = (time.time(), result)
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(_disk_path(key), "w", encoding="utf-8") as fh:
            json.dump(result, fh)
    except OSError:
        pass


def cap_deps(deps: list[Dep], warnings: list[str]) -> list[Dep]:
    if len(deps) <= MAX_DEPS:
        return deps
    keep = [d for d in deps if d.kind != "package" or d.direct]
    rest = [d for d in deps if d.kind == "package" and not d.direct]
    room = max(MAX_DEPS - len(keep), 0)
    rest.sort(key=lambda d: (-(d.metrics.get("dependents_in_tree") or 0), d.name))
    dropped = len(rest) - min(room, len(rest)) + max(len(keep) - MAX_DEPS, 0)
    kept = keep[:MAX_DEPS] + rest[:room]
    warnings.append(f"Found {len(deps)} dependencies; showing the {len(kept)} most significant "
                    f"({dropped} dependencies omitted).")
    return kept


def _sort(deps: list[Dep]) -> list[Dep]:
    return sorted(deps, key=lambda d: (KIND_ORDER.get(d.kind, 9) if d.kind != "package" else 7,
                                       0 if d.direct else 1, -(d.metrics.get("dependents_in_tree") or 0), d.name))


async def _run(url: str, key: str) -> dict:
    tmp, root, commit = await repo.clone_repo(url)
    try:
        scan = await asyncio.to_thread(scan_repo, root)
    finally:
        await asyncio.to_thread(repo.cleanup, tmp)
    warnings = list(scan.warnings)
    deps = scan.deps
    metrics.compute_dependents(deps)
    deps = cap_deps(deps, warnings)
    warnings += await metrics.enrich(deps, budget=40.0)
    deps = _sort(deps)
    return {
        "repo": {"url": url, "name": repo.repo_name(url), "host": (urlparse(url).hostname or "").lower(),
                 "commit": commit},
        "dependencies": [d.to_json() for d in deps],
        "warnings": warnings,
    }


async def analyze(raw_url: str) -> dict:
    url = repo.validate_url(raw_url)
    key = repo.cache_key(url)
    cached = _load_cached(key)
    if cached is not None:
        return cached
    task = _inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(_run(url, key))
        _inflight[key] = task

        def _done(t, key=key):
            _inflight.pop(key, None)
            if not t.cancelled() and t.exception() is None:
                _store(key, t.result())
        task.add_done_callback(_done)
    try:
        return await asyncio.shield(task)
    except AnalysisError:
        raise
