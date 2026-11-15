"""Cheap best-effort scanners: Ruby (Gemfile), PHP (composer.json), JVM (pom.xml / build.gradle)."""
from __future__ import annotations

import json
import re

from ..models import Dep


def scan_ruby(rf):
    deps: dict = {}
    manifests = rf.named("Gemfile")
    for f in manifests:
        for m in re.finditer(r"""(?m)^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?""", rf.read(f) or ""):
            deps.setdefault(m.group(1), [m.group(2), True, f, None])
    for f in rf.named("Gemfile.lock"):
        in_specs, cur = False, None
        for line in (rf.read(f) or "").splitlines():
            if line.startswith("  specs:"):
                in_specs = True
                continue
            if line and not line.startswith(" "):
                in_specs = False
            if not in_specs:
                continue
            m = re.match(r"^    (\S+) \(([^)]+)\)", line)
            if m:
                cur = m.group(1)
                e = deps.setdefault(cur, [None, False, f, None])
                e[0] = m.group(2)
                e[3] = e[3] or set()
                continue
            m = re.match(r"^      (\S+)", line)
            if m and cur:
                deps[cur][3].add(f"rubygems:{m.group(1)}")
    out = []
    for n, (v, direct, f, edges) in sorted(deps.items()):
        d = Dep(ecosystem="rubygems", name=n, version=v, direct=direct, source_file=f)
        d.edges = edges
        out.append(d)
    return out, {"manifests": manifests}


def scan_php(rf):
    out, manifests = [], rf.named("composer.json")
    seen = set()
    for f in manifests:
        try:
            data = json.loads(rf.read(f) or "")
        except ValueError:
            continue
        for sec in ("require", "require-dev"):
            for n, v in (data.get(sec) or {}).items():
                if n == "php" or n.startswith(("ext-", "lib-")) or n in seen:
                    continue
                seen.add(n)
                out.append(Dep(ecosystem="packagist", name=n, version=str(v), direct=True, source_file=f))
    return out, {"manifests": manifests}


# --------------------------------------------------------------------------- JVM (Maven / Gradle)
_PROP_RE = re.compile(r"\$\{([^}]+)\}|\$([A-Za-z_][\w.]*)")
_GRADLE_CFG = (r"[A-Za-z]*(?:[Ii]mplementation|[Aa]pi|[Cc]ompileOnly(?:Api)?|[Rr]untimeOnly|[Cc]ompile|[Rr]untime|"
               r"[Aa]nnotationProcessor|[Pp]rovided|kapt|ksp|classpath)")
_GRADLE_DEP_RE = re.compile(
    r"(?<![\w.])(?P<cfg>" + _GRADLE_CFG + r")\s*\(?\s*(?:platform\(\s*|enforcedPlatform\(\s*)?"
    r"(?:"
    r"(?P<q>['\"])(?P<coord>[^'\"\s]+)(?P=q)"
    r"|(?:group\s*[:=]\s*['\"](?P<g>[^'\"]+)['\"]\s*,\s*name\s*[:=]\s*['\"](?P<n>[^'\"]+)['\"]"
    r"(?:\s*,\s*version\s*[:=]\s*['\"](?P<v>[^'\"]+)['\"])?)"
    r"|(?P<ref>libs\.[\w.]+)"
    r")")
_GRADLE_PLUGIN_RE = re.compile(
    r"""\bid\s*\(?\s*['"]([\w.\-]+)['"]\s*\)?\s*version\s*\(?\s*['"]([^'"$]+)['"]""")
_GRADLE_PLUGIN_REF_RE = re.compile(r"\balias\s*\(\s*(libs\.plugins\.[\w.]+)")
_ASSIGN_RE = re.compile(r"""(?m)(?:^|[{;])\s*(?:(?:def|val|var|final|String|ext\.|project\.ext\.|rootProject\.ext\.)\s*)?"""
                        r"""([A-Za-z_][\w.]*)\s*=\s*['"]([^'"$\n]+)['"]""")


def _strip_gradle_comments(txt: str) -> str:
    txt = re.sub(r"/\*.*?\*/", "", txt, flags=re.S)
    return re.sub(r"(?m)(?<![:\"'])//.*$", "", txt)


def _resolve_props(s: str | None, props: dict) -> str | None:
    """Substitute ${a} / $a from props; None if anything stays unresolved."""
    if s is None:
        return None
    for _ in range(5):
        if "$" not in s:
            return s.strip() or None

        def sub(m):
            k = (m.group(1) or m.group(2)).strip()
            for cand in (k, k.split(".", 1)[-1], k.rsplit(".", 1)[-1]):
                if cand in props:
                    return props[cand]
            return m.group(0)
        n = _PROP_RE.sub(sub, s)
        if n == s:
            return None
        s = n
    return None if "$" in s else s.strip() or None


def _clean_gradle_version(v: str | None) -> str | None:
    if not v:
        return None
    v = v.split("@")[0].strip()
    return v or None


def _gradle_props(texts: list, extra_props: str | None) -> dict:
    props: dict = {}
    if extra_props:
        for line in extra_props.splitlines():
            m = re.match(r"\s*([\w.\-]+)\s*[=:]\s*(.+?)\s*$", line)
            if m and not line.lstrip().startswith("#"):
                props.setdefault(m.group(1), m.group(2))
    for t in texts:
        for m in _ASSIGN_RE.finditer(t):
            props.setdefault(m.group(1), m.group(2))
    return props


def _catalog_key(alias: str) -> str:
    return re.sub(r"[-_]", ".", alias)


def _parse_catalog(txt: str) -> dict:
    """-> {"libs": {accessor: (name, version)}, "bundles": {accessor: [accessors]}, "plugins": {accessor: (id, version)}}"""
    import tomllib
    out = {"libs": {}, "bundles": {}, "plugins": {}}
    try:
        data = tomllib.loads(txt)
    except (tomllib.TOMLDecodeError, ValueError):
        return out
    versions: dict = {}
    for k, v in (data.get("versions") or {}).items():
        if isinstance(v, str):
            versions[k] = v
        elif isinstance(v, dict):
            versions[k] = v.get("strictly") or v.get("require") or v.get("prefer") or None

    def ver_of(v):
        if isinstance(v, str):
            return v
        if isinstance(v, dict):
            if v.get("ref"):
                return versions.get(v["ref"])
            return v.get("strictly") or v.get("require") or v.get("prefer")
        return None

    for alias, spec in (data.get("libraries") or {}).items():
        name = ver = None
        if isinstance(spec, str):
            parts = spec.split(":")
            if len(parts) >= 2:
                name, ver = f"{parts[0]}:{parts[1]}", (parts[2] if len(parts) > 2 else None)
        elif isinstance(spec, dict):
            if spec.get("module"):
                name = spec["module"]
            elif spec.get("group") and spec.get("name"):
                name = f"{spec['group']}:{spec['name']}"
            ver = ver_of(spec.get("version"))
        if name and ":" in name:
            out["libs"][_catalog_key(alias)] = (name, ver)
    for alias, members in (data.get("bundles") or {}).items():
        if isinstance(members, list):
            out["bundles"][_catalog_key(alias)] = [_catalog_key(m) for m in members if isinstance(m, str)]
    for alias, spec in (data.get("plugins") or {}).items():
        if isinstance(spec, str):
            pid, _, pv = spec.partition(":")
            out["plugins"][_catalog_key(alias)] = (pid, pv or None)
        elif isinstance(spec, dict) and spec.get("id"):
            out["plugins"][_catalog_key(alias)] = (spec["id"], ver_of(spec.get("version")))
    return out


def _lookup_prefix(table: dict, dotted: str):
    """Longest alias in table that prefixes the accessor chain (libs.foo.bar.get() etc.)."""
    parts = dotted.split(".")
    for n in range(len(parts), 0, -1):
        k = ".".join(parts[:n])
        if k in table:
            return k
    return None


def _scope_of(cfg: str) -> str:
    c = cfg.lower()
    if c == "classpath":
        return "build"
    if c.startswith(("test", "androidtest", "integrationtest")):
        return "test"
    if "runtime" in c:
        return "runtime"
    return "compile"


def _xml_local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _scan_pom(txt: str):
    """-> (props, managed [(g,a,v,scope,type)], deps [...]) or None when unparsable."""
    import xml.etree.ElementTree as ET
    if "<!ENTITY" in txt or "<!DOCTYPE" in txt:
        return None
    try:
        root = ET.fromstring(txt)
    except ET.ParseError:
        return None

    def child(el, name):
        for c in el:
            if _xml_local(c.tag) == name:
                return c
        return None

    def text(el, name):
        c = child(el, name)
        return (c.text or "").strip() if c is not None and c.text else None

    def kids(el):
        return list(el) if el is not None else []

    props: dict = {}
    for c in kids(child(root, "properties")):
        if c.text and c.text.strip():
            props[_xml_local(c.tag)] = c.text.strip()
    parent = child(root, "parent")
    gid, ver = text(root, "groupId"), text(root, "version")
    if parent is not None:
        gid = gid or text(parent, "groupId")
        ver = ver or text(parent, "version")
        if text(parent, "version"):
            props.setdefault("project.parent.version", text(parent, "version"))
        if text(parent, "groupId"):
            props.setdefault("project.parent.groupId", text(parent, "groupId"))
    if gid:
        props["project.groupId"] = gid
    if ver:
        props["project.version"] = ver
        props["version"] = ver

    def dep_of(el):
        g, a = text(el, "groupId"), text(el, "artifactId")
        return (g, a, text(el, "version"), text(el, "scope") or "compile", text(el, "type")) if g and a else None

    managed, deps = [], []
    for el in kids(child(child(root, "dependencyManagement"), "dependencies") if child(root, "dependencyManagement") is not None else None):
        d = dep_of(el)
        if d:
            managed.append(d)
    for el in kids(child(root, "dependencies")):
        d = dep_of(el)
        if d:
            deps.append(d)
    for prof in kids(child(root, "profiles")):
        for el in kids(child(prof, "dependencies")):
            d = dep_of(el)
            if d:
                deps.append(d)
    return props, managed, deps


def scan_jvm(rf):
    found: dict = {}   # name -> [version, file, scope]

    def add(name: str, ver: str | None, f: str, scope: str):
        cur = found.get(name)
        if cur is None:
            found[name] = [ver, f, scope]
            return
        if not cur[0] and ver:
            cur[0] = ver
        if cur[2] in ("test", "build") and scope not in ("test", "build"):
            cur[1], cur[2] = f, scope
            if ver:
                cur[0] = ver

    poms = rf.named("pom.xml")
    gradle_files = [f for f in rf.matching(lambda b, p: b.endswith((".gradle", ".gradle.kts")))
                    if f.rsplit("/", 1)[-1] not in ("settings.gradle", "settings.gradle.kts")]
    manifests = list(poms) + [f for f in gradle_files if f.rsplit("/", 1)[-1] in ("build.gradle", "build.gradle.kts")]
    catalogs = rf.named("libs.versions.toml")
    if not manifests and gradle_files:
        manifests = gradle_files[:1]

    # ---- Maven
    parsed = []
    for f in sorted(poms, key=lambda x: x.count("/")):
        res = _scan_pom(rf.read(f) or "")
        if res:
            parsed.append((f, res))
    all_props: dict = {}
    managed: dict = {}
    for f, (props, mg, _) in parsed:   # root-most poms first so they win
        for k, v in props.items():
            all_props.setdefault(k, v)
    for f, (props, mg, _) in parsed:
        local = {**all_props, **props}
        for g, a, v, sc, ty in mg:
            g, a = _resolve_props(g, local), _resolve_props(a, local)
            if g and a and v:
                managed.setdefault(f"{g}:{a}", _resolve_props(v, local))
    for f, (props, _, deps) in parsed:
        local = {**all_props, **props}
        for g, a, v, sc, ty in deps:
            g, a = _resolve_props(g, local), _resolve_props(a, local)
            if not g or not a:
                continue
            name = f"{g}:{a}"
            ver = _resolve_props(v, local) if v else managed.get(name)
            scope = {"test": "test", "runtime": "runtime"}.get(sc, "compile")
            add(name, ver, f, scope)

    # ---- Gradle
    gtexts = [(f, _strip_gradle_comments(rf.read(f) or "")) for f in gradle_files]
    gprops = _gradle_props([t for _, t in gtexts], "\n".join(rf.read(p) or "" for p in rf.named("gradle.properties")))
    catalog = {"libs": {}, "bundles": {}, "plugins": {}}
    catalog_file = catalogs[0] if catalogs else None
    for c in catalogs:
        part = _parse_catalog(rf.read(c) or "")
        for k in catalog:
            for kk, vv in part[k].items():
                catalog[k].setdefault(kk, vv)
    referenced = False
    for f, t in gtexts:
        for m in _GRADLE_DEP_RE.finditer(t):
            scope = _scope_of(m.group("cfg"))
            if m.group("coord"):
                parts = m.group("coord").split(":")
                if len(parts) < 2 or not re.match(r"^[\w.\-${}]+$", parts[0]) or not parts[1]:
                    continue
                g, a = _resolve_props(parts[0], gprops), _resolve_props(parts[1], gprops)
                ver = _resolve_props(_clean_gradle_version(parts[2]) if len(parts) > 2 else None, gprops)
                if g and a:
                    add(f"{g}:{a}", ver, f, scope)
            elif m.group("g"):
                add(f"{m.group('g')}:{m.group('n')}", _resolve_props(m.group("v"), gprops), f, scope)
            elif m.group("ref"):
                ref = m.group("ref")[len("libs."):]
                if ref.startswith("bundles."):
                    k = _lookup_prefix(catalog["bundles"], ref[len("bundles."):])
                    for member in (catalog["bundles"].get(k) or []) if k else []:
                        nv = catalog["libs"].get(member)
                        if nv:
                            referenced = True
                            add(nv[0], nv[1], catalog_file or f, scope)
                elif not ref.startswith(("versions.", "plugins.")):
                    k = _lookup_prefix(catalog["libs"], ref)
                    if k:
                        referenced = True
                        nv = catalog["libs"][k]
                        add(nv[0], nv[1], catalog_file or f, scope)
        for pid, pv in _GRADLE_PLUGIN_RE.findall(t):
            add(f"{pid}:{pid}.gradle.plugin", pv, f, "build")
        for m in _GRADLE_PLUGIN_REF_RE.finditer(t):
            k = _lookup_prefix(catalog["plugins"], m.group(1)[len("libs.plugins."):])
            if k:
                pid, pv = catalog["plugins"][k]
                add(f"{pid}:{pid}.gradle.plugin", pv, catalog_file or f, "build")
    if catalog_file and not referenced:
        # references may live in convention plugins we cannot see: list the whole catalog instead
        for name, ver in catalog["libs"].values():
            add(name, ver, catalog_file, "compile")
    if catalog_file and not manifests:
        manifests = [catalog_file]

    out = []
    for n, (v, f, scope) in sorted(found.items()):
        d = Dep(ecosystem="maven", name=n, version=v, direct=True, source_file=f)
        d.extra["scope"] = scope
        out.append(d)
    return out, {"manifests": manifests}
