"""npm / yarn / pnpm manifests and lockfiles."""
from __future__ import annotations

import json
import re

from ..models import Dep
from ..util import clean_version

DEP_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies")
LOCAL_PREFIXES = ("workspace:", "file:", "link:", "portal:")


def parse_package_lock(data: dict) -> dict:
    """name -> {'version', 'deps': set(names)}"""
    out: dict = {}

    def add(name, version, deps):
        e = out.setdefault(name, {"version": version, "deps": set()})
        e["deps"].update(deps)

    pk = data.get("packages")
    if isinstance(pk, dict):
        for path, e in pk.items():
            if not path or e.get("link") or "node_modules/" not in path:
                continue
            name = e.get("name") or path.rsplit("node_modules/", 1)[1]
            add(name, e.get("version"),
                list(e.get("dependencies", {})) + list(e.get("optionalDependencies", {})))
    elif isinstance(data.get("dependencies"), dict):
        def rec(deps):
            for name, e in deps.items():
                add(name, e.get("version"), list((e.get("requires") or {}).keys()))
                if isinstance(e.get("dependencies"), dict):
                    rec(e["dependencies"])
        rec(data["dependencies"])
    return out


def _spec_name(spec: str) -> str:
    spec = spec.strip().strip('"').strip("'")
    i = spec.rfind("@")
    return spec[:i] if i > 0 else spec


def parse_yarn_lock(text: str) -> dict:
    out: dict = {}
    names: list = []
    section = None
    version = None
    deps: set = set()

    def flush():
        for n in names:
            e = out.setdefault(n, {"version": version, "deps": set()})
            e["deps"].update(deps)
            if e["version"] is None:
                e["version"] = version

    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" "):
            flush()
            header = line.rstrip().rstrip(":")
            names = list({_spec_name(s) for s in header.split(",") if s.strip()})
            if "@workspace:" in header or header.strip('"') == "__metadata":
                names = []
            section, version, deps = None, None, set()
            continue
        indent = len(line) - len(line.lstrip())
        s = line.strip()
        if indent == 2:
            m = re.match(r'version:?\s+"?([^"\s]+)"?', s)
            if m:
                version = m.group(1)
            section = "deps" if s.rstrip(":") in ("dependencies", "optionalDependencies") else None
        elif indent >= 4 and section == "deps":
            m = re.match(r'"?([^"\s:]+)"?', s)
            if m:
                deps.add(m.group(1))
    flush()
    return out


def parse_pnpm_lock(text: str) -> dict:
    out: dict = {}
    lines = text.splitlines()
    # prefer v9 "snapshots" (has edges); otherwise "packages"
    target = "snapshots:" if any(l.startswith("snapshots:") for l in lines) else "packages:"
    in_sec = False
    cur = None
    sub = None
    for line in lines:
        if line and not line.startswith(" "):
            in_sec = line.startswith(target)
            cur = None
            continue
        if not in_sec or not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        s = line.strip()
        if indent == 2 and s.endswith(":"):
            key = s[:-1].strip("'\"").lstrip("/")
            key = re.sub(r"\(.*$", "", key)
            i = key.rfind("@")
            if i <= 0:
                cur = None
                continue
            name, ver = key[:i], key[i + 1:]
            cur = out.setdefault(name, {"version": ver, "deps": set()})
            sub = None
        elif cur is not None and indent == 4 and s.endswith(":"):
            sub = s[:-1] in ("dependencies", "optionalDependencies")
        elif cur is not None and indent == 6 and sub:
            m = re.match(r"['\"]?(@?[^'\":]+)['\"]?:", s)
            if m:
                cur["deps"].add(m.group(1))
    return out


def _load(rf, f):
    txt = rf.read(f)
    try:
        data = json.loads(txt) if txt else None
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def scan(rf) -> tuple[list[Dep], dict]:
    manifests = rf.named("package.json")
    direct: dict = {}
    local: set = set()
    scripts: list = []
    parsed_manifests = [(f, _load(rf, f)) for f in manifests]
    for f, data in parsed_manifests:
        if not data:
            continue
        if data.get("name"):
            local.add(data["name"])
        if isinstance(data.get("scripts"), dict):
            scripts.extend(str(v) for v in data["scripts"].values())
    for f, data in parsed_manifests:
        if not data:
            continue
        for sec in DEP_SECTIONS:
            block = data.get(sec)
            if not isinstance(block, dict):
                continue
            for n, spec in block.items():
                if n in local or (isinstance(spec, str) and spec.startswith(LOCAL_PREFIXES)):
                    continue
                direct.setdefault(n, (clean_version(spec), f))

    locked: dict = {}
    lock_file = None
    for f in rf.named("package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"):
        txt = rf.read(f, 30_000_000)
        if not txt:
            continue
        base = f.rsplit("/", 1)[-1]
        try:
            if base.endswith(".json"):
                parsed = parse_package_lock(json.loads(txt))
            elif base == "yarn.lock":
                parsed = parse_yarn_lock(txt)
            else:
                parsed = parse_pnpm_lock(txt)
        except Exception:
            continue
        for n, e in parsed.items():
            cur = locked.setdefault(n, {"version": e["version"], "deps": set(), "file": f})
            cur["deps"].update(e["deps"])
        lock_file = lock_file or f

    deps: list[Dep] = []
    for name in sorted(set(direct) | set(locked)):
        if name in local:
            continue
        is_direct = name in direct
        lk = locked.get(name)
        spec, mf = direct.get(name, (None, None))
        d = Dep(ecosystem="npm", name=name, direct=is_direct,
                version=(lk["version"] if lk and lk["version"] else spec),
                source_file=mf if is_direct else (lk["file"] if lk else None))
        if lk is not None:
            d.edges = {f"npm:{x}" for x in lk["deps"] if x not in local}
        d.extra["script_mentions"] = sum(
            1 for s in scripts if re.search(r"(?<![\w@/-])" + re.escape(name) + r"(?![\w-])", s))
        deps.append(d)
    return deps, {"manifests": manifests, "lock": lock_file, "local": local,
                  "parsed": {f: d for f, d in parsed_manifests if d}}
