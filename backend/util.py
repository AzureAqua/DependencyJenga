"""Small helpers: repo URL normalisation."""
from __future__ import annotations

import re
from urllib.parse import urlparse

FORGES = ("github.com", "gitlab.com", "bitbucket.org")


def normalize_repo_url(raw) -> str | None:
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    s = re.sub(r"^git\+", "", s)
    if "://" not in s and not s.startswith("git@"):
        for pfx, host in (("github:", "github.com"), ("gitlab:", "gitlab.com"), ("bitbucket:", "bitbucket.org")):
            if s.startswith(pfx):
                s = s[len(pfx):]
                if re.fullmatch(r"[\w.-]+/[\w.-]+", s):
                    return f"https://{host}/{re.sub(r'\.git$', '', s)}"
        if re.fullmatch(r"[\w.-]+/[\w.-]+", s):
            return f"https://github.com/{re.sub(r'\.git$', '', s)}"
    s = re.sub(r"^git@([^:/]+):", r"https://\1/", s)
    s = re.sub(r"^(?:git|ssh|git\+ssh)://(?:git@)?", "https://", s)
    if not re.match(r"^https?://", s):
        return None
    p = urlparse(s)
    host = (p.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return None
    parts = [x for x in p.path.split("/") if x]
    if host in FORGES:
        if len(parts) < 2:
            return None
        parts = parts[:2]
    path = "/".join(parts)
    path = re.sub(r"\.git$", "", path)
    return f"https://{host}/{path}" if path else None


def forge_slug(url: str | None) -> tuple[str, str] | None:
    """('github.com', 'owner/repo') for known forges, else None."""
    u = normalize_repo_url(url)
    if not u:
        return None
    p = urlparse(u)
    if p.hostname in FORGES:
        parts = [x for x in p.path.split("/") if x]
        if len(parts) >= 2:
            return p.hostname, f"{parts[0]}/{parts[1]}"
    return None


def clean_version(spec) -> str | None:
    if spec is None:
        return None
    s = str(spec).strip()
    return s or None
