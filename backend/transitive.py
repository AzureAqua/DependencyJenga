"""Transitive dependency expansion through deps.dev for ecosystems without a lockfile.

Verified against the live API (see README of this change): the ``:dependencies`` endpoint returns the
resolved graph (``nodes`` + ``edges``) for maven, npm, pypi and cargo.  It answers 404 for go and rubygems,
so those ecosystems are not wired up.  Every failure degrades to "no expansion for that root".
"""
from __future__ import annotations

import asyncio
import re

from .metrics import DD, Ctx, _q
from .models import Dep
from .scanners.pypi import norm as pypi_norm

# our ecosystem -> deps.dev system
SYSTEMS = {"maven": "maven", "npm": "npm", "pypi": "pypi", "cargo": "cargo"}
MAX_ROOTS = 60
_CONCRETE = re.compile(r"v?\d+(?:\.\d+)*(?:[-+.][0-9A-Za-z][0-9A-Za-z.\-+_]*)?")
_LOW_PRIORITY_SCOPES = {"test", "dev", "build"}


def _node_name(eco: str, name: str) -> str:
    return pypi_norm(name) if eco == "pypi" else name


def _concrete(eco: str, version: str | None) -> str | None:
    if not version:
        return None
    v = version.strip()
    if eco == "pypi" and v.startswith("=="):
        v = v[2:].strip()
    return v if _CONCRETE.fullmatch(v) else None


async def _default_version(ctx: Ctx, system: str, name: str) -> str | None:
    data = await ctx.get(f"{DD}/v3/systems/{system}/packages/{_q(name)}")
    if not data:
        return None
    vs = data.get("versions") or []
    default = [v for v in vs if v.get("isDefault")]
    pick = default[-1] if default else None
    return pick["versionKey"]["version"] if pick else None


async def _graph(ctx: Ctx, system: str, name: str, version: str) -> dict | None:
    data = await ctx.get(f"{DD}/v3/systems/{system}/packages/{_q(name)}/versions/{_q(version)}:dependencies")
    if data and data.get("nodes"):
        data["edges"] = data.get("edges") or []   # leaf packages come back without an "edges" key
        return data
    return None


async def _resolve_root(ctx: Ctx, root: Dep) -> dict | None:
    system = SYSTEMS[root.ecosystem]
    version = _concrete(root.ecosystem, root.version)
    graph = await _graph(ctx, system, root.name, version) if version else None
    if graph is None:
        default = await _default_version(ctx, system, root.name)
        if default and default != version:
            graph = await _graph(ctx, system, root.name, default)
    return graph


def _roots_priority(d: Dep):
    scope = d.extra.get("scope")
    return (1 if scope in _LOW_PRIORITY_SCOPES else 0, d.name)


async def expand_transitives(ctx: Ctx, deps: list[Dep]) -> list[str]:
    """Add transitive deps (direct=False) and fill ``edges`` in place.  Returns warnings."""
    warnings: list[str] = []
    by_id: dict = {d.id: d for d in deps}

    eco_has_lock = {eco: any(d.ecosystem == eco and not d.direct for d in deps) for eco in SYSTEMS}
    candidates = [d for d in deps if d.ecosystem in SYSTEMS and d.direct and not eco_has_lock[d.ecosystem]
                  and d.kind == "package"]
    if not candidates:
        return warnings
    candidates.sort(key=_roots_priority)
    roots = candidates[:MAX_ROOTS]
    skipped = len(candidates) - len(roots)

    results = await asyncio.gather(*(_resolve_root(ctx, r) for r in roots), return_exceptions=True)

    expanded_ecos: set = set()
    failed = 0
    added: set = set()
    for root, graph in zip(roots, results):
        if not isinstance(graph, dict):
            failed += 1
            continue
        eco = root.ecosystem
        nodes = graph["nodes"]
        ids: list = []
        for n in nodes:
            vk = n.get("versionKey") or {}
            name = vk.get("name")
            if not name:
                ids.append(None)
                continue
            name = _node_name(eco, name)
            did = f"{eco}:{name}"
            ids.append(did)
            if n.get("relation") == "SELF":
                continue
            if did not in by_id:
                nd = Dep(ecosystem=eco, name=name, version=vk.get("version"), direct=False,
                         source_file=root.source_file)
                by_id[did] = nd
                deps.append(nd)
                added.add(did)
        # SELF node: map to the root's own id (names may differ in case/normalisation)
        for i, n in enumerate(nodes):
            if n.get("relation") == "SELF":
                ids[i] = root.id
        for did in ids:
            if did and did in by_id and by_id[did].edges is None:
                by_id[did].edges = set()
        for e in graph["edges"]:
            try:
                a, b = ids[e["fromNode"]], ids[e["toNode"]]
            except (KeyError, IndexError, TypeError):
                continue
            if a and b and a != b and a in by_id and b in by_id:
                by_id[a].edges.add(b)
        expanded_ecos.add(eco)

    if added or expanded_ecos:
        names = ", ".join(sorted(expanded_ecos))
        warnings.append(f"Transitive dependencies resolved via deps.dev (no lockfile) for {names}: "
                        f"{len(added)} indirect dependencies added.")
    if failed or skipped:
        bits = []
        if failed:
            bits.append(f"{failed} direct dependenc{'y' if failed == 1 else 'ies'} could not be resolved")
        if skipped:
            bits.append(f"{skipped} were not expanded (limit of {MAX_ROOTS} per analysis)")
        warnings.append("Transitive resolution via deps.dev is incomplete: " + "; ".join(bits) + ".")
    return warnings
