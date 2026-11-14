"""URL validation and safe shallow cloning."""
from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import shutil
import socket
import stat
import subprocess
import tempfile
from contextlib import contextmanager
from urllib.parse import urlparse

CLONE_TIMEOUT = 120


class AnalysisError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def validate_url(raw: str) -> str:
    url = (raw or "").strip()
    if not url or len(url) > 500:
        raise AnalysisError(400, "Please provide a git repository URL.")
    if url.startswith("-") or re.search(r"[\s\x00-\x1f\x7f\"'`\\]", url):
        raise AnalysisError(400, "That does not look like a valid repository URL.")
    p = urlparse(url)
    if p.scheme.lower() not in ("http", "https"):
        raise AnalysisError(400, "Only http(s) repository URLs are supported (e.g. https://github.com/owner/repo).")
    if not p.hostname:
        raise AnalysisError(400, "The repository URL has no host.")
    if p.username or p.password:
        raise AnalysisError(400, "Credentials in the URL are not supported; use a public repository URL.")
    return url


def check_host_public(host: str):
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise AnalysisError(422, f"Could not resolve host '{host}'.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            raise AnalysisError(400, "Repository hosts on private or local networks are not allowed.")


def cache_key(url: str) -> str:
    p = urlparse(url)
    path = re.sub(r"(\.git)?/*$", "", p.path)
    return f"{(p.hostname or '').lower()}{path}".lower()


def repo_name(url: str) -> str:
    parts = [x for x in urlparse(url).path.split("/") if x]
    if not parts:
        return urlparse(url).hostname or url
    return re.sub(r"\.git$", "", parts[-1])


def _rmtree(path: str):
    def onexc(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    shutil.rmtree(path, onexc=onexc)


def _clone(url: str, dest: str) -> str | None:
    env = dict(os.environ)
    env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "echo", "GCM_INTERACTIVE": "never",
                "GIT_CONFIG_NOSYSTEM": "1", "GIT_LFS_SKIP_SMUDGE": "1"})
    cmd = ["git", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
           "-c", "protocol.http.allow=always", "-c", "core.symlinks=false", "-c", "core.longpaths=true",
           "-c", "core.hooksPath=NUL" if os.name == "nt" else "core.hooksPath=/dev/null",
           "-c", "credential.helper=",
           "clone", "--depth", "1", "--single-branch", "--no-tags", "--quiet", "--", url, dest]
    try:
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=CLONE_TIMEOUT,
                           stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise AnalysisError(422, f"Cloning timed out after {CLONE_TIMEOUT}s; the repository may be too large.")
    except FileNotFoundError:
        raise AnalysisError(500, "git is not installed on the server.")
    if r.returncode != 0:
        msg = (r.stderr or "").strip().splitlines()
        tail = next((l for l in reversed(msg) if l.strip()), "unknown error")
        tail = re.sub(r"https?://[^@\s]*@", "https://", tail)
        raise AnalysisError(422, f"Could not clone repository: {tail[:200]}")
    try:
        c = subprocess.run(["git", "-C", dest, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=20,
                           stdin=subprocess.DEVNULL)
        return c.stdout.strip() or None
    except Exception:
        return None


async def clone_repo(url: str):
    """Returns (tempdir, repo_dir, commit).  Caller must call cleanup(tempdir)."""
    host = urlparse(url).hostname
    await asyncio.to_thread(check_host_public, host)
    tmp = tempfile.mkdtemp(prefix="jenga-")
    dest = os.path.join(tmp, "repo")
    try:
        commit = await asyncio.to_thread(_clone, url, dest)
    except BaseException:
        cleanup(tmp)
        raise
    return tmp, dest, commit


def cleanup(tmp: str):
    try:
        _rmtree(tmp)
    except Exception:
        pass
