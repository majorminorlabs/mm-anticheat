"""Scanner orchestration. Rules are added in subsequent phases."""

from goodhart.git import ScanInput


def file_counts(data: ScanInput) -> dict[str, int]:
    """Count files by kind; conftest is included in both test and config."""
    return {
        kind: sum(kind in change.kinds for change in data.changes)
        for kind in ("test", "source", "config", "snapshot", "other")
    }
