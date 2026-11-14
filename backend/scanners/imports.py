"""Count import/require/use statements per module across the repo's source files."""
from __future__ import annotations

import os
import re
import sys
from collections import Counter

JS_EXT = {".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"}
JS_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]""")
PY_RE = re.compile(r"(?m)^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b|import[ \t]+([A-Za-z_][\w., \t]*))")
RS_RE = re.compile(r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:use[ \t]+(?:::)?(\w+)\b|extern[ \t]+crate[ \t]+(\w+))")
GO_BLOCK_RE = re.compile(r"(?ms)^import\s*\((.*?)\)")
GO_LINE_RE = re.compile(r'(?m)^import\s+(?:[\w.]+\s+)?"([^"]+)"')
GO_PATH_RE = re.compile(r'"([^"]+)"')
RB_RE = re.compile(r"""(?m)^\s*require(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]""")

NODE_BUILTINS = {
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
    "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector",
    "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
    "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm",
    "wasi", "worker_threads", "zlib", "test",
}
PY_STDLIB = set(getattr(sys, "stdlib_module_names", ())) | {"__future__"}
RS_SKIP = {"std", "core", "alloc", "crate", "self", "super", "proc_macro", "test"}

MAX_FILE_BYTES = 400_000
MAX_FILES_PER_LANG = 6000


class ImportStats:
    def __init__(self):
        self.js, self.py, self.rs, self.go, self.rb = Counter(), Counter(), Counter(), Counter(), Counter()
        self.node_builtin = 0
        self.py_stdlib = 0
        self.scanned = {"js": False, "py": False, "rs": False, "go": False, "rb": False}


def _js_pkg(spec: str) -> str | None:
    if spec.startswith((".", "/", "#", "~", "http:", "https:", "data:", "file:")):
        return None
    if spec.startswith("node:"):
        return "node:" + spec[5:].split("/")[0]
    parts = spec.split("/")
    if spec.startswith("@"):
        return "/".join(parts[:2]) if len(parts) >= 2 else None
    return parts[0]


def count_imports(rf) -> ImportStats:
    st = ImportStats()
    per_lang = Counter()
    for rel in rf.files:
        ext = os.path.splitext(rel)[1].lower()
        if ext in JS_EXT:
            key = "js"
        elif ext == ".py":
            key = "py"
        elif ext == ".rs":
            key = "rs"
        elif ext == ".go":
            key = "go"
        elif ext == ".rb":
            key = "rb"
        else:
            continue
        if per_lang[key] >= MAX_FILES_PER_LANG:
            continue
        per_lang[key] += 1
        try:
            full = os.path.join(rf.root, rel)
            if os.path.getsize(full) > MAX_FILE_BYTES:
                continue
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                txt = fh.read()
        except OSError:
            continue
        st.scanned[key] = True
        if key == "js":
            for m in JS_RE.finditer(txt):
                pkg = _js_pkg(m.group(1))
                if not pkg:
                    continue
                if pkg.startswith("node:") or pkg in NODE_BUILTINS:
                    st.node_builtin += 1
                    continue
                st.js[pkg] += 1
        elif key == "py":
            for m in PY_RE.finditer(txt):
                if m.group(1):
                    names = [m.group(1).split(".")[0]]
                else:
                    names = []
                    for part in m.group(2).split(","):
                        toks = part.strip().split()
                        if toks:
                            names.append(toks[0].split(".")[0])
                for n in names:
                    if n in PY_STDLIB:
                        st.py_stdlib += 1
                    else:
                        st.py[n.lower()] += 1
        elif key == "rs":
            for m in RS_RE.finditer(txt):
                n = m.group(1) or m.group(2)
                if n and n not in RS_SKIP:
                    st.rs[n] += 1
        elif key == "go":
            paths = [m.group(1) for m in GO_LINE_RE.finditer(txt)]
            for b in GO_BLOCK_RE.finditer(txt):
                paths += GO_PATH_RE.findall(b.group(1))
            for p in paths:
                st.go[p] += 1
        elif key == "rb":
            for m in RB_RE.finditer(txt):
                st.rb[m.group(1)] += 1
    return st


PY_ALIASES = {
    "pyyaml": ["yaml"], "pillow": ["pil"], "scikit-learn": ["sklearn"], "beautifulsoup4": ["bs4"],
    "opencv-python": ["cv2"], "opencv-python-headless": ["cv2"], "python-dotenv": ["dotenv"],
    "attrs": ["attr", "attrs"], "pyjwt": ["jwt"], "pycryptodome": ["crypto"], "python-jose": ["jose"],
    "psycopg2-binary": ["psycopg2"], "scikit-image": ["skimage"], "protobuf": ["google"],
    "python-dateutil": ["dateutil"], "pymongo": ["pymongo", "bson"], "setuptools": ["setuptools", "pkg_resources"],
    "msgpack-python": ["msgpack"], "ruamel-yaml": ["ruamel"], "python-multipart": ["multipart"],
    "pyzmq": ["zmq"], "pycurl": ["pycurl"], "mysqlclient": ["mysqldb"], "pyserial": ["serial"],
    "python-magic": ["magic"], "pytest-cov": ["pytest_cov"], "typing-extensions": ["typing_extensions"],
    "importlib-metadata": ["importlib_metadata"], "pyopenssl": ["openssl"], "pygithub": ["github"],
    "google-api-python-client": ["googleapiclient"], "tensorflow-cpu": ["tensorflow"],
}


def py_candidates(name: str) -> set:
    n = name.lower()
    cands = {n.replace("-", "_"), n.replace("-", "")}
    if n.startswith("python-"):
        cands.add(n[7:].replace("-", "_"))
    if n.startswith("py-"):
        cands.add(n[3:].replace("-", "_"))
    cands.update(PY_ALIASES.get(n, []))
    return {c.lower() for c in cands}


def import_count_for(dep, st: ImportStats):
    """-> int or None if that ecosystem's sources weren't scanned."""
    eco, name = dep.ecosystem, dep.name
    if eco == "npm":
        if not st.scanned["js"] and not dep.extra.get("script_mentions"):
            return None
        return st.js.get(name, 0) + dep.extra.get("script_mentions", 0)
    if eco == "pypi":
        if not st.scanned["py"]:
            return None
        return sum(st.py.get(c, 0) for c in py_candidates(name))
    if eco == "cargo":
        if not st.scanned["rs"]:
            return None
        return st.rs.get(name.replace("-", "_"), 0)
    if eco == "go":
        if not st.scanned["go"]:
            return None
        return sum(c for p, c in st.go.items() if p == name or p.startswith(name + "/"))
    if eco == "rubygems":
        if not st.scanned["rb"]:
            return None
        return st.rb.get(name, 0) + st.rb.get(name.replace("-", "/"), 0)
    return None
