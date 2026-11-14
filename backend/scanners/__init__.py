"""Scan a cloned repository for every kind of dependency."""
from __future__ import annotations

from dataclasses import dataclass, field

from ..models import Dep
from . import cargo, go, misc, npm, pypi
from .files import RepoFiles
from .imports import count_imports, import_count_for
from .system import scan_system


@dataclass
class ScanResult:
    deps: list = field(default_factory=list)
    warnings: list = field(default_factory=list)


def _merge(into: dict, deps):
    for d in deps:
        cur = into.get(d.id)
        if cur is None:
            into[d.id] = d
            continue
        if d.direct and not cur.direct:
            cur.direct = True
            cur.source_file = d.source_file
        if d.edges:
            cur.edges = (cur.edges or set()) | d.edges
        if not cur.version and d.version:
            cur.version = d.version


def scan_repo(root: str) -> ScanResult:
    res = ScanResult()
    rf = RepoFiles(root)
    if rf.truncated:
        res.warnings.append("Repository is very large; only the first files were scanned.")
    merged: dict = {}
    metas: dict = {}

    for key, fn in (("npm", npm.scan), ("pypi", pypi.scan), ("cargo", cargo.scan), ("go", go.scan)):
        try:
            deps, meta = fn(rf)
        except Exception as e:  # a broken manifest must not sink the analysis
            res.warnings.append(f"Failed to parse {key} manifests: {type(e).__name__}")
            continue
        metas[key] = meta
        _merge(merged, deps)
        if meta.get("manifests") and not meta.get("lock") and key in ("npm", "pypi", "cargo"):
            res.warnings.append(f"No {key} lockfile found: only direct dependencies are listed for it.")
    for key, fn in (("rubygems", misc.scan_ruby), ("packagist", misc.scan_php), ("maven", misc.scan_jvm)):
        try:
            deps, meta = fn(rf)
        except Exception as e:
            res.warnings.append(f"Failed to parse {key} manifests: {type(e).__name__}")
            continue
        metas[key + "_manifests"] = meta.get("manifests")
        _merge(merged, deps)

    stats = count_imports(rf)
    for d in merged.values():
        d.metrics["import_count"] = import_count_for(d, stats)

    try:
        sysdeps = scan_system(rf, metas, stats)
    except Exception as e:
        res.warnings.append(f"System dependency detection failed: {type(e).__name__}")
        sysdeps = []
    _merge(merged, sysdeps)

    # dependents_in_tree from lockfile edges (re-computed after registry data in metrics stage)
    res.deps = list(merged.values())
    if not any(d.ecosystem not in ("system", "docker", "github-actions") for d in res.deps):
        res.warnings.append("No package manifests (npm, PyPI, Cargo, Go, ...) were recognised in this repository.")
    return res
