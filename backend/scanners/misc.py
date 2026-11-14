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


def scan_jvm(rf):
    found: dict = {}
    manifests = rf.named("pom.xml", "build.gradle", "build.gradle.kts")
    for f in manifests:
        txt = rf.read(f) or ""
        if f.endswith("pom.xml"):
            for m in re.finditer(r"<dependency>\s*<groupId>([^<$]+)</groupId>\s*<artifactId>([^<$]+)</artifactId>"
                                 r"(?:\s*<version>([^<]+)</version>)?", txt):
                v = m.group(3)
                found.setdefault(f"{m.group(1).strip()}:{m.group(2).strip()}",
                                 (v.strip() if v and "$" not in v else None, f))
        else:
            for m in re.finditer(r"""(?:implementation|api|compile|compileOnly|runtimeOnly|testImplementation|"""
                                 r"""annotationProcessor|kapt)\s*\(?\s*['"]([\w.\-]+):([\w.\-]+)(?::([^'"$]+))?['"]""", txt):
                found.setdefault(f"{m.group(1)}:{m.group(2)}", (m.group(3), f))
    out = [Dep(ecosystem="maven", name=n, version=v, direct=True, source_file=f)
           for n, (v, f) in sorted(found.items())]
    return out, {"manifests": manifests}
