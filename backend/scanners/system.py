"""Non-package dependencies: languages, runtimes, package managers, build tools,
Docker base images, GitHub Actions, git, libc/OS."""
from __future__ import annotations

import json
import re

from ..models import Dep, empty_metrics
from ..tools import DOCKER_REPOS, make_tool

FROM_RE = re.compile(r"(?im)^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?")
USES_RE = re.compile(r"""(?m)^\s*-?\s*uses:\s*['"]?([^\s'"#]+)""")
COMPOSE_IMAGE_RE = re.compile(r"""(?m)^\s*image:\s*['"]?([^\s'"#]+)""")


def _first_line(rf, names, strip_v=True):
    for f in rf.named(*names):
        txt = (rf.read(f, 10_000) or "").strip().splitlines()
        if txt and txt[0].strip():
            v = txt[0].strip()
            return (v.lstrip("v") if strip_v else v), f
    return None, None


def _tool_versions(rf):
    out = {}
    for f in rf.named(".tool-versions"):
        for line in (rf.read(f, 10_000) or "").splitlines():
            parts = line.split()
            if len(parts) >= 2 and not line.startswith("#"):
                out.setdefault(parts[0], (parts[1], f))
    return out


def parse_docker_image(ref: str):
    """-> (name, tag, registry_is_hub) or None"""
    if ref.lower() == "scratch" or "$" in ref:
        return None
    ref = ref.split("@")[0]
    tag = None
    last = ref.rsplit("/", 1)[-1]
    if ":" in last:
        ref, tag = ref.rsplit(":", 1)
    first = ref.split("/")[0]
    hub = not ("." in first or ":" in first or first == "localhost") or len(ref.split("/")) == 1
    name = ref[len("docker.io/"):] if ref.startswith("docker.io/") else ref
    return name, tag, hub


def scan_system(rf, metas: dict, st) -> list[Dep]:
    deps: list[Dep] = []
    seen: set = set()

    def add(d: Dep):
        if d.id not in seen:
            seen.add(d.id)
            deps.append(d)

    tv = _tool_versions(rf)
    lc = rf.lang_counts
    npm_meta, py_meta, cargo_meta, go_meta = (metas.get(k) or {} for k in ("npm", "pypi", "cargo", "go"))
    has_node = bool(npm_meta.get("manifests")) or lc["javascript"] >= 3 or lc["typescript"] >= 3
    has_py = bool(py_meta.get("manifests")) or lc["python"] >= 3
    has_rust = bool(cargo_meta.get("manifests")) or lc["rust"] >= 3
    has_go = bool(go_meta.get("manifests")) or lc["go"] >= 3
    has_ruby = bool(metas.get("rubygems_manifests")) or lc["ruby"] >= 3
    has_java = bool(metas.get("maven_manifests")) or lc["java"] >= 3
    has_php = bool(metas.get("packagist_manifests")) or lc["php"] >= 3
    has_c = lc["c"] >= 3

    # ---------------- languages / runtimes ----------------
    if has_node:
        ver, src = _first_line(rf, [".nvmrc", ".node-version"])
        if not ver and "nodejs" in tv:
            ver, src = tv["nodejs"]
        if not ver:
            for f, data in (npm_meta.get("parsed") or {}).items():
                eng = (data.get("engines") or {}).get("node")
                if eng:
                    ver, src = eng, f
                    break
        n_js = lc["javascript"] + lc["typescript"]
        add(make_tool("javascript", source_file=None, uses=lc["javascript"] or n_js))
        if lc["typescript"] >= 1 or rf.named("tsconfig.json"):
            add(make_tool("typescript", uses=lc["typescript"]))
        add(make_tool("node", version=ver, source_file=src or (npm_meta["manifests"][0] if npm_meta.get("manifests") else None),
                      uses=st.node_builtin))
        add(make_tool("v8", uses=n_js))
        # package manager
        pm, pm_src = None, None
        for f, data in (npm_meta.get("parsed") or {}).items():
            pmf = data.get("packageManager")
            if isinstance(pmf, str) and "@" in pmf:
                pm, ver_pm = pmf.split("@", 1)
                pm_src = f
                pm = pm.strip()
                ver_pm = ver_pm.split("+")[0]
                break
        else:
            ver_pm = None
        if not pm:
            if rf.named("pnpm-lock.yaml"):
                pm = "pnpm"
            elif rf.named("yarn.lock"):
                pm = "yarn"
            elif rf.named("bun.lockb", "bun.lock"):
                pm = "bun"
            else:
                pm = "npm"
        n_manifests = len(npm_meta.get("manifests") or [])
        if pm in ("npm", "yarn", "pnpm", "bun"):
            add(make_tool(pm, version=ver_pm, source_file=pm_src or npm_meta.get("lock") or
                          (npm_meta["manifests"][0] if npm_meta.get("manifests") else None), uses=max(n_manifests, 1)))
    if has_py:
        ver = None
        src = None
        v, f = _first_line(rf, [".python-version", "runtime.txt"])
        if v:
            ver, src = v.replace("python-", ""), f
        elif "python" in tv:
            ver, src = tv["python"]
        elif py_meta.get("python_req"):
            ver, src = py_meta["python_req"], (py_meta.get("manifests") or [None])[0]
        n_py = lc["python"]
        add(make_tool("python", uses=n_py))
        add(make_tool("cpython", version=ver, source_file=src, uses=st.py_stdlib))
        n_man = max(len(py_meta.get("manifests") or []), 1)
        lock = py_meta.get("lock") or ""
        if lock.endswith("uv.lock") or rf.named("uv.lock"):
            pm = "uv"
        elif lock.endswith("poetry.lock") or rf.named("poetry.lock"):
            pm = "poetry"
        elif rf.named("Pipfile"):
            pm = "pipenv"
        else:
            pm = "pip"
        add(make_tool(pm, source_file=lock or (py_meta.get("manifests") or [None])[0], uses=n_man))
    if has_rust:
        ver, src = None, None
        for f in rf.named("rust-toolchain", "rust-toolchain.toml"):
            txt = rf.read(f, 10_000) or ""
            m = re.search(r'channel\s*=\s*"([^"]+)"', txt) or re.match(r"\s*([\w.\-]+)\s*$", txt)
            if m:
                ver, src = m.group(1), f
                break
        if not ver and cargo_meta.get("rust_version"):
            ver, src = cargo_meta["rust_version"], (cargo_meta.get("manifests") or [None])[0]
        if not ver and "rust" in tv:
            ver, src = tv["rust"]
        add(make_tool("rust", uses=lc["rust"]))
        add(make_tool("rustc", version=ver, source_file=src, uses=lc["rust"]))
        add(make_tool("llvm", uses=lc["rust"]))
        add(make_tool("cargo", source_file=cargo_meta.get("lock") or (cargo_meta.get("manifests") or [None])[0],
                      uses=max(len(cargo_meta.get("manifests") or []), 1)))
    if has_go:
        gv = go_meta.get("go_version") or (tv.get("golang") or (None,))[0]
        add(make_tool("go", version=gv, source_file=(go_meta.get("manifests") or [None])[0], uses=lc["go"]))
        if go_meta.get("manifests"):
            add(make_tool("gomod", source_file=go_meta["manifests"][0], uses=len(go_meta["manifests"])))
    if has_ruby:
        v, f = _first_line(rf, [".ruby-version"])
        add(make_tool("ruby", uses=lc["ruby"]))
        add(make_tool("cruby", version=v, source_file=f, uses=lc["ruby"]))
        if rf.named("Gemfile"):
            add(make_tool("bundler", source_file="Gemfile", uses=1))
    if has_java:
        add(make_tool("java", uses=lc["java"]))
        add(make_tool("jvm", uses=lc["java"]))
        if rf.named("pom.xml"):
            add(make_tool("maven", source_file=rf.named("pom.xml")[0], uses=len(rf.named("pom.xml"))))
        gr = rf.named("build.gradle", "build.gradle.kts")
        if gr:
            add(make_tool("gradle", source_file=gr[0], uses=len(gr)))
    if has_php:
        add(make_tool("php", uses=lc["php"]))
        add(make_tool("php-runtime", uses=lc["php"]))
        if rf.named("composer.json"):
            add(make_tool("composer", source_file="composer.json", uses=1))
    if has_c:
        add(make_tool("gcc", uses=lc["c"]))

    # ---------------- build tools ----------------
    mk = rf.named("Makefile", "makefile", "GNUmakefile")
    if mk:
        add(make_tool("make", source_file=mk[0], uses=len(mk)))
    cm = rf.named("CMakeLists.txt")
    if cm:
        add(make_tool("cmake", source_file=cm[0], uses=len(cm)))

    # ---------------- Docker ----------------
    dockerfiles = rf.matching(lambda b, p: b.lower().startswith("dockerfile") or b.lower().endswith(".dockerfile"))
    composes = rf.matching(lambda b, p: b.lower() in ("docker-compose.yml", "docker-compose.yaml",
                                                      "compose.yml", "compose.yaml"))
    images: dict = {}
    alpine = False
    for f in dockerfiles:
        txt = rf.read(f, 500_000) or ""
        stages = set()
        for m in FROM_RE.finditer(txt):
            ref, alias = m.group(1), m.group(2)
            if ref in stages:
                if alias:
                    stages.add(alias)
                continue
            if alias:
                stages.add(alias)
            p = parse_docker_image(ref)
            if p:
                key = p[0]
                alpine = alpine or "alpine" in (p[1] or "") or "alpine" in key
                e = images.setdefault(key, [p[1], p[2], f, 0])
                e[3] += 1
    for f in composes:
        for m in COMPOSE_IMAGE_RE.finditer(rf.read(f, 500_000) or ""):
            p = parse_docker_image(m.group(1))
            if p:
                e = images.setdefault(p[0], [p[1], p[2], f, 0])
                e[3] += 1
    if dockerfiles or composes:
        add(make_tool("docker", source_file=(dockerfiles or composes)[0], uses=len(dockerfiles) + len(composes)))
    for name, (tag, hub, f, n) in sorted(images.items()):
        d = Dep(ecosystem="docker", name=name, kind="container", version=tag, direct=True, source_file=f,
                metrics=empty_metrics())
        d.metrics["import_count"] = n
        d.extra["docker_hub"] = hub
        repo = DOCKER_REPOS.get(name)
        if repo:
            d.repo_url = f"https://github.com/{repo}"
        if not hub:
            d.extra["docker_hub"] = False
        add(d)

    # ---------------- GitHub Actions ----------------
    actions: dict = {}
    for f in rf.matching(lambda b, p: (p.startswith(".github/workflows/") and b.endswith((".yml", ".yaml")))
                         or (p.startswith(".github/actions/") and b in ("action.yml", "action.yaml"))):
        for m in USES_RE.finditer(rf.read(f, 500_000) or ""):
            ref = m.group(1)
            if ref.startswith(("./", "docker://", "${{")) or "@" not in ref:
                continue
            path, version = ref.split("@", 1)
            parts = path.split("/")
            if len(parts) < 2:
                continue
            key = f"{parts[0]}/{parts[1]}"
            e = actions.setdefault(key, [version, f, 0])
            e[2] += 1
    for key, (version, f, n) in sorted(actions.items()):
        d = Dep(ecosystem="github-actions", name=key, kind="ci", version=version, direct=True, source_file=f,
                repo_url=f"https://github.com/{key}", metrics=empty_metrics())
        d.metrics["import_count"] = n
        add(d)

    # ---------------- OS / libc / git ----------------
    any_runtime = has_node or has_py or has_rust or has_go or has_ruby or has_java or has_php or has_c
    add(make_tool("git", direct=True, source_file=".git", uses=1))
    if any_runtime or dockerfiles:
        add(make_tool("musl" if alpine else "glibc", direct=False, uses=None))
        add(make_tool("linux", direct=False, uses=None))
    return deps
