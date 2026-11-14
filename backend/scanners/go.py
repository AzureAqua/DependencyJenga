"""Go: go.mod."""
from __future__ import annotations

import re

from ..models import Dep


def scan(rf) -> tuple[list[Dep], dict]:
    mods = rf.named("go.mod")
    parsed = []
    local: set = set()
    go_version = None
    for f in mods:
        txt = rf.read(f) or ""
        m = re.search(r"(?m)^module\s+(\S+)", txt)
        if m:
            local.add(m.group(1).strip('"'))
        m = re.search(r"(?m)^go\s+(\d[\w.]*)", txt)
        if m and not go_version:
            go_version = m.group(1)
        parsed.append((f, txt))
    found: dict = {}
    for f, txt in parsed:
        in_block = False
        for raw in txt.splitlines():
            line = raw.strip()
            if in_block:
                if line.startswith(")"):
                    in_block = False
                    continue
                spec = line
            elif re.match(r"^require\s*\($", line) or line == "require(":
                in_block = True
                continue
            elif line.startswith("require "):
                spec = line[len("require "):].strip()
            else:
                continue
            indirect = "// indirect" in spec
            spec = spec.split("//")[0].split()
            if len(spec) < 2 or spec[0] in local:
                continue
            path, ver = spec[0].strip('"'), spec[1]
            prev = found.get(path)
            direct = not indirect
            if prev is None or (direct and not prev[1]):
                found[path] = (ver, direct, f)
    out = [Dep(ecosystem="go", name=p, version=v, direct=d, source_file=f)
           for p, (v, d, f) in sorted(found.items())]
    return out, {"manifests": mods, "go_version": go_version, "local": local}
