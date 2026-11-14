"""Rust: Cargo.toml / Cargo.lock."""
from __future__ import annotations

import re
import tomllib

from ..models import Dep

SECTIONS = ("dependencies", "dev-dependencies", "build-dependencies")


def _toml(rf, f):
    txt = rf.read(f, 20_000_000)
    if not txt:
        return None
    try:
        return tomllib.loads(txt)
    except Exception:
        return None


def scan(rf) -> tuple[list[Dep], dict]:
    direct: dict = {}
    local: set = set()
    manifests = rf.named("Cargo.toml")
    parsed = [(f, _toml(rf, f)) for f in manifests]
    rust_version = None
    for f, data in parsed:
        if data and isinstance(data.get("package"), dict):
            if data["package"].get("name"):
                local.add(data["package"]["name"])
            rv = data["package"].get("rust-version")
            if isinstance(rv, str):
                rust_version = rust_version or rv

    def add_table(tbl, f):
        if not isinstance(tbl, dict):
            return
        for key, spec in tbl.items():
            name, ver = key, None
            if isinstance(spec, dict):
                if "path" in spec and "version" not in spec:
                    continue
                name = spec.get("package", key)
                ver = spec.get("version")
            elif isinstance(spec, str):
                ver = spec
            if name in local:
                continue
            direct.setdefault(name, (ver, f))

    for f, data in parsed:
        if not data:
            continue
        for sec in SECTIONS:
            add_table(data.get(sec), f)
        add_table((data.get("workspace") or {}).get("dependencies"), f)
        for tgt in (data.get("target") or {}).values():
            if isinstance(tgt, dict):
                for sec in SECTIONS:
                    add_table(tgt.get(sec), f)

    locked: dict = {}
    lock_file = None
    for f in rf.named("Cargo.lock"):
        data = _toml(rf, f)
        if not data:
            continue
        lock_file = lock_file or f
        for p in data.get("package") or []:
            if not p.get("source"):  # local workspace crate
                continue
            n = p.get("name")
            e = locked.setdefault(n, {"version": p.get("version"), "deps": set(), "file": f})
            for dep in p.get("dependencies") or []:
                e["deps"].add(str(dep).split()[0])

    out: list[Dep] = []
    for name in sorted(set(direct) | set(locked)):
        if name in local:
            continue
        lk = locked.get(name)
        ver, mf = direct.get(name, (None, None))
        is_direct = name in direct
        d = Dep(ecosystem="cargo", name=name, direct=is_direct,
                version=(lk["version"] if lk else ver),
                source_file=mf if is_direct else (lk["file"] if lk else None))
        if lk is not None:
            d.edges = {f"cargo:{x}" for x in lk["deps"] if x not in local}
        out.append(d)
    return out, {"manifests": manifests, "lock": lock_file, "rust_version": rust_version, "local": local}
