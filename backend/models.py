"""Core data model shared by scanners, metrics and the API layer."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

METRIC_KEYS = (
    "size_bytes", "import_count", "dependents_in_tree", "global_dependents",
    "recent_commits", "recent_commits_source", "open_issues", "open_prs",
    "stars", "age_days", "first_release", "last_release",
)


def empty_metrics() -> dict:
    return {k: None for k in METRIC_KEYS}


@dataclass
class Dep:
    ecosystem: str
    name: str
    kind: str = "package"
    version: str | None = None
    direct: bool = False
    source_file: str | None = None
    repo_url: str | None = None
    description: str | None = None
    # ids of other deps this one depends on; None = unknown (no lock graph)
    edges: set | None = None
    # final, serialised edges: ids present in the returned list (set by the analyzer after the cap)
    depends_on: list = field(default_factory=list)
    metrics: dict = field(default_factory=empty_metrics)
    # scratch values used by the metrics stage (not serialised)
    extra: dict = field(default_factory=dict)

    @property
    def id(self) -> str:
        return f"{self.ecosystem}:{self.name}"

    def to_json(self) -> dict:
        m = {k: self.metrics.get(k) for k in METRIC_KEYS}
        return {
            "id": self.id, "name": self.name, "kind": self.kind,
            "ecosystem": self.ecosystem, "version": self.version,
            "direct": self.direct, "source_file": self.source_file,
            "repo_url": self.repo_url, "description": self.description,
            "depends_on": list(self.depends_on),
            "metrics": m,
        }


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
