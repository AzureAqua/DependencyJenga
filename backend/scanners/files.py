"""Repository file walking and safe text reading."""
from __future__ import annotations

import os
from collections import Counter

SKIP_DIRS = {
    "node_modules", "vendor", ".git", "target", "dist", "build", "__pycache__", ".venv", "venv",
    "env", ".tox", ".mypy_cache", ".pytest_cache", "bower_components", "third_party", "third-party",
    "testdata", "fixtures", "__fixtures__", ".next", ".nuxt", "site-packages", ".gradle", "Pods",
    ".idea", ".vscode", "coverage", "out", ".cache", ".yarn", ".pnpm-store",
}
MAX_FILES = 40000
MAX_DEPTH = 6

LANG_EXT = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
    ".vue": "javascript", ".svelte": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".py": "python", ".rs": "rust", ".go": "go", ".rb": "ruby", ".java": "java", ".kt": "java",
    ".php": "php", ".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".hpp": "c", ".cxx": "c",
}


class RepoFiles:
    def __init__(self, root: str):
        self.root = root
        self.files: list[str] = []          # posix relative paths
        self.lang_counts: Counter = Counter()
        self.truncated = False
        self._walk()

    def _walk(self):
        root = self.root
        for dirpath, dirnames, filenames in os.walk(root):
            rel_dir = os.path.relpath(dirpath, root)
            depth = 0 if rel_dir == "." else rel_dir.count(os.sep) + 1
            dirnames[:] = [d for d in dirnames
                           if d not in SKIP_DIRS and not os.path.islink(os.path.join(dirpath, d))]
            if depth >= MAX_DEPTH:
                dirnames[:] = []
            for fn in filenames:
                if len(self.files) >= MAX_FILES:
                    self.truncated = True
                    return
                full = os.path.join(dirpath, fn)
                if os.path.islink(full):
                    continue
                rel = fn if rel_dir == "." else (rel_dir + os.sep + fn)
                rel = rel.replace(os.sep, "/")
                self.files.append(rel)
                lang = LANG_EXT.get(os.path.splitext(fn)[1].lower())
                if lang:
                    self.lang_counts[lang] += 1

    def named(self, *names: str) -> list[str]:
        s = set(names)
        return [f for f in self.files if f.rsplit("/", 1)[-1] in s]

    def matching(self, pred) -> list[str]:
        return [f for f in self.files if pred(f.rsplit("/", 1)[-1], f)]

    def read(self, rel: str, limit: int = 3_000_000) -> str | None:
        try:
            p = os.path.join(self.root, rel)
            if os.path.getsize(p) > limit:
                return None
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()
        except OSError:
            return None
