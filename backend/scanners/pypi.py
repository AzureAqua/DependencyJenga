"""Python: requirements*.txt, pyproject.toml, setup.py/cfg, Pipfile, poetry.lock, uv.lock."""
from __future__ import annotations

import re
import tomllib

from ..models import Dep

REQ_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([^;#]*)")


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_req(line: str):
    """-> (normalised name, version-or-None) or None"""
    line = line.strip()
    if not line or line.startswith(("-", "#", ".", "/", "git+", "http", "file:")):
        return None
    m = REQ_RE.match(line)
    if not m:
        return None
    name, spec = m.group(1), m.group(3).strip()
    ver = None
    if spec.startswith("=="):
        ver = spec[2:].split(",")[0].strip().rstrip("*").rstrip(".") or None
    elif spec and not spec.startswith("@"):
        ver = spec.replace(" ", "")
    return norm(name), ver


def _toml(rf, f):
    txt = rf.read(f)
    if not txt:
        return None
    try:
        return tomllib.loads(txt)
    except Exception:
        return None


def _str_list(v):
    out = []
    for x in v or []:
        if isinstance(x, str):
            out.append(x)
    return out


def scan(rf) -> tuple[list[Dep], dict]:
    direct: dict = {}   # name -> (version, file)
    local: set = set()
    manifests: list = []
    python_req: str | None = None
    lock_files: list = []

    def add(name, ver, f):
        if name and name != "python":
            direct.setdefault(norm(name), (ver, f))

    def add_req_strings(items, f):
        for s in items:
            r = parse_req(s)
            if r:
                add(r[0], r[1], f)

    def add_poetry_table(tbl, f):
        for n, spec in (tbl or {}).items():
            if n.lower() == "python":
                continue
            if isinstance(spec, dict):
                if "path" in spec and "version" not in spec:
                    continue
                spec = spec.get("version")
            add(n, None if spec in (None, "*") else str(spec), f)

    # requirements files
    for f in rf.matching(lambda b, p: (b.startswith("requirements") and b.endswith((".txt", ".in")))
                         or ("requirements/" in p and b.endswith((".txt", ".in")))
                         or (b.startswith("constraints") and b.endswith(".txt"))):
        txt = rf.read(f)
        if txt is None:
            continue
        manifests.append(f)
        for line in txt.splitlines():
            r = parse_req(line)
            if r:
                add(r[0], r[1], f)

    # pyproject
    for f in rf.named("pyproject.toml"):
        data = _toml(rf, f)
        if not data:
            continue
        manifests.append(f)
        proj = data.get("project") or {}
        if proj.get("name"):
            local.add(norm(proj["name"]))
        if proj.get("requires-python"):
            python_req = python_req or proj["requires-python"]
        add_req_strings(_str_list(proj.get("dependencies")), f)
        for grp in (proj.get("optional-dependencies") or {}).values():
            add_req_strings(_str_list(grp), f)
        for grp in (data.get("dependency-groups") or {}).values():
            add_req_strings(_str_list(grp), f)
        add_req_strings(_str_list((data.get("build-system") or {}).get("requires")), f)
        tool = data.get("tool") or {}
        poetry = tool.get("poetry") or {}
        if poetry.get("name"):
            local.add(norm(poetry["name"]))
        pdeps = poetry.get("dependencies") or {}
        if isinstance(pdeps.get("python"), str):
            python_req = python_req or pdeps["python"]
        add_poetry_table(pdeps, f)
        add_poetry_table(poetry.get("dev-dependencies"), f)
        for g in (poetry.get("group") or {}).values():
            add_poetry_table((g or {}).get("dependencies"), f)
        add_req_strings(_str_list((tool.get("uv") or {}).get("dev-dependencies")), f)
        for grp in ((tool.get("pdm") or {}).get("dev-dependencies") or {}).values():
            add_req_strings(_str_list(grp), f)

    # Pipfile
    for f in rf.named("Pipfile"):
        data = _toml(rf, f)
        if not data:
            continue
        manifests.append(f)
        for sec in ("packages", "dev-packages"):
            for n, spec in (data.get(sec) or {}).items():
                if isinstance(spec, dict):
                    spec = spec.get("version")
                add(n, None if spec in (None, "*") else str(spec), f)
        pv = (data.get("requires") or {}).get("python_version")
        if pv:
            python_req = python_req or ">=" + str(pv)

    # setup.cfg / setup.py (best effort)
    for f in rf.named("setup.cfg"):
        txt = rf.read(f) or ""
        m = re.search(r"(?ms)^install_requires\s*=\s*\n?(.*?)(?=^\S|\Z)", txt)
        if m:
            manifests.append(f)
            for line in m.group(1).splitlines():
                r = parse_req(line)
                if r:
                    add(r[0], r[1], f)
        m = re.search(r"(?m)^python_requires\s*=\s*(.+)$", txt)
        if m:
            python_req = python_req or m.group(1).strip()
    for f in rf.named("setup.py"):
        txt = rf.read(f) or ""
        m = re.search(r"install_requires\s*=\s*\[(.*?)\]", txt, re.S)
        if m:
            manifests.append(f)
            for s in re.findall(r"""['"]([^'"]+)['"]""", m.group(1)):
                r = parse_req(s)
                if r:
                    add(r[0], r[1], f)
        m = re.search(r"python_requires\s*=\s*['\"]([^'\"]+)['\"]", txt)
        if m:
            python_req = python_req or m.group(1)

    # lockfiles
    locked: dict = {}
    for f in rf.named("poetry.lock", "uv.lock"):
        data = _toml(rf, f)
        if not data:
            continue
        lock_files.append(f)
        for p in data.get("package") or []:
            n = p.get("name")
            if not n:
                continue
            n = norm(n)
            src = p.get("source") or {}
            if isinstance(src, dict) and (src.get("editable") or src.get("virtual")):
                local.add(n)
                continue
            deps = p.get("dependencies") or {}
            if isinstance(deps, dict):
                names = [norm(x) for x in deps]
            else:
                names = [norm(x["name"]) for x in deps if isinstance(x, dict) and "name" in x]
            e = locked.setdefault(n, {"version": p.get("version"), "deps": set(), "file": f})
            e["deps"].update(names)

    out: list[Dep] = []
    for name in sorted(set(direct) | set(locked)):
        if name in local:
            continue
        is_direct = name in direct
        ver, mf = direct.get(name, (None, None))
        lk = locked.get(name)
        d = Dep(ecosystem="pypi", name=name, direct=is_direct,
                version=(lk["version"] if lk and lk.get("version") else ver),
                source_file=mf if is_direct else (lk["file"] if lk else None))
        if lk is not None:
            d.edges = {f"pypi:{x}" for x in lk["deps"] if x not in local}
        out.append(d)
    return out, {"manifests": manifests, "lock": lock_files[0] if lock_files else None,
                 "python_req": python_req, "local": local}
