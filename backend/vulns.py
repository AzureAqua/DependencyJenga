"""Known vulnerabilities (CVEs / advisories) for pinned package versions, via OSV.dev.

One ``querybatch`` call finds the advisory ids affecting every pinned dependency, then each advisory is fetched
once for its aliases (CVE ids), summary and CVSS vector.  The CVSS base score is computed locally for v3.x and
v2 vectors; for anything else (e.g. v4-only advisories) the advisory's severity label is mapped to a typical
score and flagged as estimated.  Every failure degrades to "no vulnerability data".
"""
from __future__ import annotations

import asyncio
import math
import re
import time

import httpx

from .metrics import Ctx, _q
from .models import Dep

OSV = "https://api.osv.dev/v1"
BUDGET = 25.0
CACHE_TTL = 6 * 3600
_DETAIL_CACHE: dict = {}   # osv id -> (timestamp, detail)

# our ecosystem -> OSV ecosystem
ECOSYSTEMS = {
    "npm": "npm", "pypi": "PyPI", "cargo": "crates.io", "go": "Go", "maven": "Maven",
    "rubygems": "RubyGems", "packagist": "Packagist",
}
_CONCRETE = re.compile(r"\d+(?:\.\d+)*(?:[-+.][0-9A-Za-z][0-9A-Za-z.\-+_]*)?")
LABEL_SCORES = {"LOW": 3.0, "MODERATE": 5.5, "MEDIUM": 5.5, "HIGH": 7.5, "CRITICAL": 9.5}


def _pinned(dep: Dep) -> str | None:
    """The exact installed version, or None for ranges / tags (querying those would give false positives)."""
    v = (dep.version or "").strip()
    if v.startswith("=="):
        v = v[2:].strip()
    if v[:1] == "v":  # Go module versions (and the odd npm one) carry a "v"; OSV wants it without
        v = v[1:]
    return v if _CONCRETE.fullmatch(v) else None


# --------------------------------------------------------------------------- CVSS
def _roundup(x: float) -> float:
    i = round(x * 100000)
    return i / 100000.0 if i % 10000 == 0 else (math.floor(i / 10000) + 1) / 10.0


def _parse_vector(vec: str) -> dict:
    out = {}
    for part in vec.split("/"):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k] = v
    return out


def cvss3_score(vec: str) -> float | None:
    m = _parse_vector(vec)
    try:
        scope_changed = m["S"] == "C"
        av = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}[m["AV"]]
        ac = {"L": 0.77, "H": 0.44}[m["AC"]]
        pr = {"N": 0.85, "L": 0.68 if scope_changed else 0.62, "H": 0.5 if scope_changed else 0.27}[m["PR"]]
        ui = {"N": 0.85, "R": 0.62}[m["UI"]]
        c, i, a = ({"H": 0.56, "L": 0.22, "N": 0.0}[m[k]] for k in ("C", "I", "A"))
    except KeyError:
        return None
    iss = 1 - (1 - c) * (1 - i) * (1 - a)
    impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 if scope_changed else 6.42 * iss
    if impact <= 0:
        return 0.0
    expl = 8.22 * av * ac * pr * ui
    return _roundup(min((1.08 if scope_changed else 1.0) * (impact + expl), 10.0))


def cvss2_score(vec: str) -> float | None:
    m = _parse_vector(vec)
    try:
        av = {"L": 0.395, "A": 0.646, "N": 1.0}[m["AV"]]
        ac = {"H": 0.35, "M": 0.61, "L": 0.71}[m["AC"]]
        au = {"M": 0.45, "S": 0.56, "N": 0.704}[m["Au"]]
        c, i, a = ({"N": 0.0, "P": 0.275, "C": 0.66}[m[k]] for k in ("C", "I", "A"))
    except KeyError:
        return None
    impact = 10.41 * (1 - (1 - c) * (1 - i) * (1 - a))
    expl = 20 * av * ac * au
    return round(((0.6 * impact) + (0.4 * expl) - 1.5) * (0 if impact == 0 else 1.176), 1)


def severity_label(score: float | None) -> str:
    if score is None:
        return "UNKNOWN"
    if score >= 9.0:
        return "CRITICAL"
    if score >= 7.0:
        return "HIGH"
    if score >= 4.0:
        return "MEDIUM"
    return "LOW" if score > 0 else "NONE"


def _score(osv: dict) -> tuple[float | None, str | None, bool]:
    """(score, vector, estimated) from an OSV record."""
    sev = osv.get("severity") or []
    for kind, fn in (("CVSS_V3", cvss3_score), ("CVSS_V2", cvss2_score)):
        for s in sev:
            if s.get("type") == kind and isinstance(s.get("score"), str):
                sc = fn(s["score"])
                if sc is not None:
                    return sc, s["score"], False
    labels = [(osv.get("database_specific") or {}).get("severity")]
    for aff in osv.get("affected") or []:
        labels.append((aff.get("ecosystem_specific") or {}).get("severity"))
        labels.append((aff.get("database_specific") or {}).get("severity"))
    for lab in labels:
        if isinstance(lab, str) and lab.upper() in LABEL_SCORES:
            vec = next((s.get("score") for s in sev if isinstance(s.get("score"), str)), None)
            return LABEL_SCORES[lab.upper()], vec, True
    return None, None, True


def _detail(osv: dict) -> dict | None:
    if osv.get("withdrawn"):
        return None
    oid = osv.get("id")
    aliases = [a for a in osv.get("aliases") or [] if isinstance(a, str)]
    cves = sorted({a for a in aliases + [oid] if a and a.startswith("CVE-")})
    score, vector, estimated = _score(osv)
    summary = osv.get("summary") or (osv.get("details") or "").strip().split("\n")[0]
    return {
        "id": cves[0] if cves else oid, "osv_id": oid, "cves": cves, "ids": sorted({oid, *aliases}),
        "summary": (summary or "")[:240], "cvss": score, "cvss_estimated": estimated, "vector": vector,
        "severity": severity_label(score), "url": f"https://osv.dev/vulnerability/{oid}",
    }


# --------------------------------------------------------------------------- fetching
async def _querybatch(ctx: Ctx, queries: list[dict]) -> list[list[str]] | None:
    try:
        async with ctx.sem:
            r = await ctx.client.post(f"{OSV}/querybatch", json={"queries": queries}, timeout=20.0)
        if r.status_code != 200:
            return None
        results = r.json().get("results") or []
    except (httpx.HTTPError, ValueError):
        return None
    return [[v["id"] for v in (res or {}).get("vulns") or [] if v.get("id")] for res in results]


async def _fetch_detail(ctx: Ctx, oid: str) -> dict | None:
    hit = _DETAIL_CACHE.get(oid)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    data = await ctx.get(f"{OSV}/vulns/{_q(oid)}")
    if not data:
        return None
    det = _detail(data)
    _DETAIL_CACHE[oid] = (time.time(), det)
    return det


def _dedupe(details: list[dict]) -> list[dict]:
    """OSV often lists the same issue under several databases (GHSA + PYSEC ...): keep one per alias group."""
    out, seen = [], set()
    for d in sorted(details, key=lambda d: (-(d["cvss"] or 0), d["cvss_estimated"], d["osv_id"])):
        if seen.isdisjoint(d["ids"]):
            out.append(d)
        seen.update(d["ids"])
    return out


async def scan(deps: list[Dep], budget: float = BUDGET) -> list[str]:
    """Fill ``dep.vulns`` and the max_cvss / vuln_count metrics in place.  Returns warnings."""
    targets = [(d, _pinned(d)) for d in deps if d.ecosystem in ECOSYSTEMS and d.kind == "package"]
    unpinned = sum(1 for _, v in targets if v is None)
    targets = [(d, v) for d, v in targets if v is not None]
    warnings: list[str] = []
    if not targets:
        return warnings
    ctx = Ctx(time.monotonic() + budget)
    try:
        queries = [{"package": {"name": d.name, "ecosystem": ECOSYSTEMS[d.ecosystem]}, "version": v} for d, v in targets]
        ids = await _querybatch(ctx, queries)
        if ids is None or len(ids) != len(targets):
            return ["Vulnerability lookup via OSV.dev failed; CVEs are not shown."]
        unique = sorted({i for lst in ids for i in lst})
        details = await asyncio.gather(*(_fetch_detail(ctx, i) for i in unique))
        by_id = {i: d for i, d in zip(unique, details) if d}
        missing = sum(1 for i in unique if i not in by_id)
        for (dep, _), lst in zip(targets, ids):
            found = _dedupe([by_id[i] for i in lst if i in by_id])
            dep.vulns = found
            dep.metrics["vuln_count"] = len(found)
            scores = [v["cvss"] for v in found if v["cvss"] is not None]
            dep.metrics["max_cvss"] = max(scores) if scores else None
        vulnerable = sum(1 for d, _ in targets if d.vulns)
        if missing:
            warnings.append(f"Details for {missing} advisories could not be fetched from OSV.dev; they are not shown.")
        if vulnerable:
            warnings.append(f"{vulnerable} dependenc{'y has' if vulnerable == 1 else 'ies have'} known vulnerabilities "
                            "(OSV.dev).")
    finally:
        await ctx.client.aclose()
    if unpinned:
        warnings.append(f"{unpinned} package{' has' if unpinned == 1 else 's have'} no pinned version (no lockfile), "
                        "so they were not checked for CVEs.")
    return warnings
