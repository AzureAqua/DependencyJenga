"""Gather real-world metrics for each dependency.  Every failure degrades to null."""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx

from .models import Dep, iso, parse_iso
from .scanners.pypi import norm as pypi_norm, parse_req
from .util import forge_slug, normalize_repo_url

UA = "dependency-jenga/0.1"
NPM = "https://registry.npmjs.org"
DD = "https://api.deps.dev"
CACHE_TTL = 6 * 3600
_INFO_CACHE: dict = {}     # key -> (timestamp, info)
_REPO_CACHE: dict = {}


def _q(s: str) -> str:
    return quote(s, safe="")


class Ctx:
    def __init__(self, deadline: float):
        self.deadline = deadline
        self.token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or None
        self.sem = asyncio.Semaphore(24)
        self.crates_sem = asyncio.Semaphore(3)
        self.go_sem = asyncio.Semaphore(4)
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=6.0), follow_redirects=True,
            headers={"User-Agent": UA, "Accept": "application/json"},
            limits=httpx.Limits(max_connections=48, max_keepalive_connections=24),
        )
        self.now = datetime.now(timezone.utc)
        self.failures = 0

    def time_left(self) -> float:
        return self.deadline - time.monotonic()

    async def get(self, url, *, headers=None, sem=None):
        if self.time_left() <= 0:
            return None
        for attempt in (0, 1):
            try:
                async with (sem or self.sem):
                    r = await self.client.get(url, headers=headers)
                if r.status_code == 200:
                    return r.json()
                if r.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                    await asyncio.sleep(0.6)
                    continue
                if r.status_code != 404:
                    self.failures += 1
                return None
            except (httpx.HTTPError, ValueError):
                if attempt == 0:
                    await asyncio.sleep(0.3)
                    continue
                self.failures += 1
                return None
            except asyncio.CancelledError:
                raise
        return None


    async def raw(self, method, url, sem=None):
        """Plain request returning the httpx response or None."""
        if self.time_left() <= 0:
            return None
        try:
            async with (sem or self.sem):
                r = await self.client.request(method, url, headers={"Accept": "*/*"})
            return r if r.status_code == 200 else None
        except httpx.HTTPError:
            return None


# --------------------------------------------------------------------------- helpers
def _summ(times: list, now: datetime) -> dict:
    times = [t for t in times if t]
    if not times:
        return {}
    cutoff = now - timedelta(days=365)
    return {
        "first_release": iso(min(times)), "last_release": iso(max(times)),
        "releases_365": sum(1 for t in times if t >= cutoff),
    }


async def dd_package(ctx: Ctx, system: str, name: str) -> dict | None:
    data = await ctx.get(f"{DD}/v3/systems/{system}/packages/{_q(name)}")
    if not data or not data.get("versions"):
        return None
    vs = data["versions"]
    times = [parse_iso(v.get("publishedAt")) for v in vs]
    out = _summ(times, ctx.now)
    default = [v for v in vs if v.get("isDefault")]
    if default:
        out["latest"] = default[-1]["versionKey"]["version"]
    else:
        dated = [(t, v) for t, v in zip(times, vs) if t]
        if dated:
            out["latest"] = max(dated, key=lambda x: x[0])[1]["versionKey"]["version"]
    return out


async def dd_dependents(ctx: Ctx, system: str, name: str, version: str | None):
    if not version:
        return None
    data = await ctx.get(f"{DD}/v3alpha/systems/{system}/packages/{_q(name)}/versions/{_q(version)}:dependents")
    if data and isinstance(data.get("dependentCount"), int):
        return data["dependentCount"]
    return None


async def dd_repo(ctx: Ctx, system: str, name: str, version: str | None) -> str | None:
    if not version:
        return None
    data = await ctx.get(f"{DD}/v3/systems/{system}/packages/{_q(name)}/versions/{_q(version)}")
    if not data:
        return None
    for rp in data.get("relatedProjects") or []:
        if rp.get("relationType") == "SOURCE_REPO":
            return normalize_repo_url("https://" + rp["projectKey"]["id"])
    for l in data.get("links") or []:
        if l.get("label") == "SOURCE_REPO":
            return normalize_repo_url(l.get("url"))
    return None


# --------------------------------------------------------------------------- registries
async def fetch_npm(ctx: Ctx, name: str) -> dict:
    qn = quote(name, safe="@")
    latest, ddp = await asyncio.gather(ctx.get(f"{NPM}/{qn}/latest"), dd_package(ctx, "npm", name))
    info: dict = dict(ddp or {})
    if latest:
        size = (latest.get("dist") or {}).get("unpackedSize")
        info["size_bytes"] = size if isinstance(size, int) else None
        info["description"] = latest.get("description")
        repo = latest.get("repository")
        repo = repo.get("url") if isinstance(repo, dict) else repo
        info["repo_url"] = normalize_repo_url(repo) or normalize_repo_url(
            (latest.get("bugs") or {}).get("url", "").replace("/issues", "") if isinstance(latest.get("bugs"), dict) else None)
        info["requires"] = [f"npm:{n}" for n in (latest.get("dependencies") or {})]
        info["latest"] = latest.get("version") or info.get("latest")
    info["global_dependents"] = await dd_dependents(ctx, "npm", name, info.get("latest"))
    return info


PYPI_URL_KEYS = ("source", "source code", "repository", "code", "github", "homepage", "home", "issues",
                 "bug tracker", "tracker", "changelog", "documentation")


async def fetch_pypi(ctx: Ctx, name: str) -> dict:
    data = await ctx.get(f"https://pypi.org/pypi/{_q(name)}/json")
    info: dict = {}
    if data:
        meta = data.get("info") or {}
        info["description"] = meta.get("summary")
        info["latest"] = meta.get("version")
        urls = {(k or "").lower(): v for k, v in (meta.get("project_urls") or {}).items()}
        cands = [urls[k] for k in PYPI_URL_KEYS if k in urls] + [v for k, v in urls.items() if k not in PYPI_URL_KEYS]
        cands.append(meta.get("home_page"))
        for u in cands:
            if u and forge_slug(u):
                info["repo_url"] = normalize_repo_url(u)
                break
        times = []
        for ver, files in (data.get("releases") or {}).items():
            ts = [parse_iso(f.get("upload_time_iso_8601") or (f.get("upload_time") or "") ) for f in files]
            ts = [t for t in ts if t]
            if ts:
                times.append(min(ts))
        info.update(_summ(times, ctx.now))
        files = data.get("urls") or []
        wheels = [f for f in files if f.get("packagetype") == "bdist_wheel" and isinstance(f.get("size"), int)]
        pure = [f for f in wheels if str(f.get("filename", "")).endswith("-none-any.whl")]
        sdist = [f for f in files if f.get("packagetype") == "sdist" and isinstance(f.get("size"), int)]
        pick = (pure or wheels or sdist or [None])[0]
        if pick:
            info["size_bytes"] = pick["size"]
        reqs = []
        for r in meta.get("requires_dist") or []:
            if "extra ==" in r or "extra==" in r:
                continue
            p = parse_req(r)
            if p:
                reqs.append(f"pypi:{p[0]}")
        info["requires"] = reqs
    info["global_dependents"] = await dd_dependents(ctx, "pypi", pypi_norm(name), info.get("latest"))
    return info


async def fetch_cargo(ctx: Ctx, name: str) -> dict:
    data = await ctx.get(f"https://crates.io/api/v1/crates/{_q(name)}", sem=ctx.crates_sem)
    info: dict = {}
    if data and data.get("crate"):
        c = data["crate"]
        vs = data.get("versions") or []
        newest = c.get("max_stable_version") or c.get("newest_version")
        info["latest"] = newest
        info["description"] = c.get("description")
        info["repo_url"] = normalize_repo_url(c.get("repository"))
        times = [parse_iso(v.get("created_at")) for v in vs if not v.get("yanked")]
        info.update(_summ(times, ctx.now))
        created = parse_iso(c.get("created_at"))
        if created and (not info.get("first_release") or created < parse_iso(info["first_release"])):
            info["first_release"] = iso(created)
        for v in vs:
            if v.get("num") == newest and isinstance(v.get("crate_size"), int):
                info["size_bytes"] = v["crate_size"]
        if "size_bytes" not in info and vs and isinstance(vs[0].get("crate_size"), int):
            info["size_bytes"] = vs[0]["crate_size"]
    else:
        ddp = await dd_package(ctx, "cargo", name)
        if ddp:
            info.update(ddp)
    info["global_dependents"] = await dd_dependents(ctx, "cargo", name, info.get("latest"))
    if not info.get("repo_url"):
        info["repo_url"] = await dd_repo(ctx, "cargo", name, info.get("latest"))
    return info


GO_IMPORTERS_RE = re.compile(r"Known importing modules:</strong>\s*([\d,]+)")


async def go_extras(ctx: Ctx, name: str, version: str | None) -> dict:
    """Module zip size from the Go proxy; importer count scraped from pkg.go.dev (deps.dev has no Go dependents)."""
    out: dict = {}
    esc = re.sub(r"[A-Z]", lambda m: "!" + m.group(0).lower(), name)

    async def size():
        if version:
            r = await ctx.raw("HEAD", f"https://proxy.golang.org/{esc}/@v/{version}.zip")
            if r is not None and r.headers.get("content-length", "").isdigit():
                out["size_bytes"] = int(r.headers["content-length"])

    async def importers():
        r = await ctx.raw("GET", f"https://pkg.go.dev/{name}?tab=importedby", sem=ctx.go_sem)
        if r is not None:
            m = GO_IMPORTERS_RE.search(r.text)
            if m:
                out["global_dependents"] = int(m.group(1).replace(",", ""))

    await asyncio.gather(size(), importers())
    return out


async def fetch_deps_dev_only(ctx: Ctx, system: str, name: str) -> dict:
    info = await dd_package(ctx, system, name) or {}
    ver = info.get("latest")
    if system == "go" and name.startswith("github.com/"):
        info["repo_url"] = normalize_repo_url("https://" + "/".join(name.split("/")[:3]))
    gd, repo = await asyncio.gather(dd_dependents(ctx, system, name, ver),
                                    asyncio.sleep(0, None) if info.get("repo_url") else dd_repo(ctx, system, name, ver))
    info["global_dependents"] = gd
    if system == "go":
        info.update({k: v for k, v in (await go_extras(ctx, name, ver)).items() if v is not None})
    if repo:
        info["repo_url"] = repo
    return info


async def fetch_docker(ctx: Ctx, name: str, tag: str | None) -> dict:
    ns, repo = name.split("/", 1) if "/" in name else ("library", name)
    base = f"https://hub.docker.com/v2/repositories/{_q(ns)}/{_q(repo)}"
    meta, tagd = await asyncio.gather(ctx.get(base + "/"), ctx.get(f"{base}/tags/{_q(tag)}") if tag else asyncio.sleep(0, None))
    info: dict = {}
    if meta:
        info["description"] = meta.get("description")
        info["stars"] = meta.get("star_count")
        for src, dst in (("date_registered", "first_release"), ("last_updated", "last_release")):
            t = parse_iso(meta.get(src))
            if t:
                info[dst] = iso(t)
    if tagd and isinstance(tagd.get("full_size"), int):
        info["size_bytes"] = tagd["full_size"]
    return info


async def fetch_info(ctx: Ctx, dep: Dep) -> dict | None:
    eco = dep.ecosystem
    if eco == "npm":
        return await fetch_npm(ctx, dep.name)
    if eco == "pypi":
        return await fetch_pypi(ctx, dep.name)
    if eco == "cargo":
        return await fetch_cargo(ctx, dep.name)
    if eco in ("go", "maven", "rubygems"):
        return await fetch_deps_dev_only(ctx, {"go": "go", "maven": "maven", "rubygems": "rubygems"}[eco], dep.name)
    if eco == "docker" and dep.extra.get("docker_hub"):
        return await fetch_docker(ctx, dep.name, dep.version)
    return None


def apply_info(dep: Dep, info: dict):
    m = dep.metrics
    for k in ("size_bytes", "global_dependents", "stars"):
        if info.get(k) is not None and m.get(k) is None:
            m[k] = info[k]
    if info.get("first_release") and not m.get("first_release"):
        m["first_release"] = info["first_release"]
    if info.get("last_release"):
        m["last_release"] = info["last_release"]
    if info.get("repo_url") and not dep.repo_url:
        dep.repo_url = info["repo_url"]
    if info.get("description") and not dep.description:
        dep.description = str(info["description"]).strip()[:300]
    if info.get("requires") is not None:
        dep.extra["requires"] = info["requires"]
    if info.get("releases_365") is not None:
        dep.extra["releases_365"] = info["releases_365"]
        m["recent_commits"] = info["releases_365"]
        m["recent_commits_source"] = "releases"


async def stage1(ctx: Ctx, dep: Dep):
    key = f"{dep.id}@{dep.version}" if dep.ecosystem == "docker" else dep.id
    hit = _INFO_CACHE.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        apply_info(dep, hit[1])
        return
    try:
        info = await fetch_info(ctx, dep)
    except asyncio.CancelledError:
        raise
    except Exception:
        info = None
    if info:
        apply_info(dep, info)
        if info.get("first_release") or info.get("size_bytes") or info.get("repo_url"):
            _INFO_CACHE[key] = (time.time(), info)


# --------------------------------------------------------------------------- GitHub-ish repo metrics
SCORECARD_RE = re.compile(r"(\d+)\s+commit\(s\)")


async def repo_from_deps_dev(ctx: Ctx, host: str, slug: str) -> dict | None:
    data = await ctx.get(f"{DD}/v3/projects/{_q(host + '/' + slug)}")
    if not data:
        return None
    out = {"stars": data.get("starsCount"), "open_issues": data.get("openIssuesCount"),
           "description": data.get("description")}
    try:
        for c in data["scorecard"]["checks"]:
            if c.get("name") == "Maintained":
                m = SCORECARD_RE.search(c.get("reason") or "")
                if m:
                    out["commits_90d"] = int(m.group(1))
    except (KeyError, TypeError):
        pass
    return out


async def repos_from_graphql(ctx: Ctx, slugs: list[str]) -> dict:
    since = iso(ctx.now - timedelta(days=90))
    out: dict = {}
    batches = [slugs[i:i + 40] for i in range(0, len(slugs), 40)]

    async def run(batch):
        parts = []
        for i, s in enumerate(batch):
            owner, repo = s.split("/", 1)
            parts.append(
                f"r{i}: repository(owner:{json.dumps(owner)}, name:{json.dumps(repo)}) {{ stargazerCount createdAt description "
                f"issues(states:OPEN){{totalCount}} pullRequests(states:OPEN){{totalCount}} "
                f"defaultBranchRef{{target{{... on Commit{{history(since:\"{since}\"){{totalCount}}}}}}}} }}")
        try:
            r = await ctx.client.post("https://api.github.com/graphql", json={"query": "query{" + " ".join(parts) + "}"},
                                      headers={"Authorization": f"bearer {ctx.token}"}, timeout=25.0)
            data = r.json().get("data") or {}
        except (httpx.HTTPError, ValueError):
            return
        for i, s in enumerate(batch):
            n = data.get(f"r{i}")
            if not n:
                continue
            hist = (((n.get("defaultBranchRef") or {}).get("target") or {}).get("history") or {}).get("totalCount")
            out[s] = {"stars": n.get("stargazerCount"), "open_issues": (n.get("issues") or {}).get("totalCount"),
                      "open_prs": (n.get("pullRequests") or {}).get("totalCount"), "commits_gh": hist,
                      "description": n.get("description"), "created_at": n.get("createdAt")}

    await asyncio.gather(*(run(b) for b in batches))
    return out


async def stage2(ctx: Ctx, deps: list[Dep]):
    keys: dict = {}
    for d in deps:
        k = forge_slug(d.repo_url)
        if k:
            keys.setdefault(k, []).append(d)
    results: dict = {}
    todo = []
    for k in keys:
        hit = _REPO_CACHE.get(k)
        if hit and time.time() - hit[0] < CACHE_TTL:
            results[k] = hit[1]
        else:
            todo.append(k)

    def store(k, info):
        results[k] = info
        _REPO_CACHE[k] = (time.time(), info)

    async def one(k):
        info = await repo_from_deps_dev(ctx, k[0], k[1])
        if info:
            prev = results.get(k) or {}
            store(k, {**info, **{x: y for x, y in prev.items() if y is not None}})

    async def graphql_all():
        gh = [k for k in todo if k[0] == "github.com"]
        res = await repos_from_graphql(ctx, [k[1] for k in gh])
        for k in gh:
            if k[1] in res:
                results[k] = res[k[1]]
                _REPO_CACHE[k] = (time.time(), res[k[1]])

    if ctx.token and todo:
        try:
            await asyncio.wait_for(graphql_all(), timeout=max(ctx.time_left(), 1))
        except Exception:
            pass
        todo = [k for k in todo if k not in results]
    tasks = [asyncio.ensure_future(one(k)) for k in todo]
    if tasks:
        await asyncio.wait(tasks, timeout=max(ctx.time_left(), 0.5))
        for t in tasks:
            if not t.done():
                t.cancel()

    for k, ds in keys.items():
        info = results.get(k)
        if not info:
            continue
        for d in ds:
            m = d.metrics
            if info.get("stars") is not None:
                m["stars"] = info["stars"]
            if info.get("open_issues") is not None:
                m["open_issues"] = info["open_issues"]
            if info.get("open_prs") is not None:
                m["open_prs"] = info["open_prs"]
            if info.get("description") and not d.description:
                d.description = str(info["description"]).strip()[:300]
            if info.get("created_at") and not m.get("first_release"):
                m["first_release"] = info["created_at"]
            if info.get("commits_gh") is not None:
                m["recent_commits"], m["recent_commits_source"] = info["commits_gh"], "github"
            elif info.get("commits_90d") is not None:
                # OpenSSF Scorecard (via deps.dev) reports real commits in the last 90 days
                m["recent_commits"], m["recent_commits_source"] = info["commits_90d"], "github"


# --------------------------------------------------------------------------- orchestration
def compute_dependents(deps: list[Dep]):
    """dependents_in_tree from lockfile edges (deps whose edges are known)."""
    counts: dict = {}
    for d in deps:
        for t in (d.edges or ()):
            if t != d.id:
                counts[t] = counts.get(t, 0) + 1
    for d in deps:
        d.metrics["dependents_in_tree"] = counts.get(d.id, 0)


def registry_dependents(deps: list[Dep]):
    """For deps in ecosystems without lock edges, derive edges from registry 'requires'."""
    ids = {d.id for d in deps}
    counts: dict = {}
    for d in deps:
        if d.edges is None:
            for t in d.extra.get("requires") or ():
                if t in ids and t != d.id:
                    counts[t] = counts.get(t, 0) + 1
    for d in deps:
        if counts.get(d.id) and not d.metrics.get("dependents_in_tree"):
            d.metrics["dependents_in_tree"] = counts[d.id]


def finalize(deps: list[Dep], now: datetime):
    for d in deps:
        m = d.metrics
        fr = parse_iso(m.get("first_release"))
        if fr:
            m["age_days"] = max((now - fr).days, 0)


async def enrich(deps: list[Dep], budget: float = 40.0) -> list[str]:
    """Fill metrics in place.  Returns warnings."""
    warnings: list[str] = []
    start = time.monotonic()
    ctx = Ctx(start + budget)
    try:
        t1 = [asyncio.ensure_future(stage1(ctx, d)) for d in deps]
        done, pending = await asyncio.wait(t1, timeout=budget * 0.65)
        for t in pending:
            t.cancel()
        if pending:
            warnings.append(f"Registry lookups timed out for {len(pending)} dependencies; their metrics are partial.")
        await stage2(ctx, deps)
        if not ctx.token:
            warnings.append("recent_commits is derived from OpenSSF Scorecard commit counts (via deps.dev; capped at 30) or, "
                            "failing that, releases in the last 365 days; set GITHUB_TOKEN for exact GitHub commit counts.")
        if ctx.failures > max(10, len(deps) // 3):
            warnings.append("Many metric requests failed (rate limits or network); some metrics are null.")
    finally:
        await ctx.client.aclose()
    registry_dependents(deps)
    finalize(deps, ctx.now)
    return warnings
