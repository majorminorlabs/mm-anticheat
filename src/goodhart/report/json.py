"""Provisional schema v1 serializer; freezes in Phase 4."""

import json
from dataclasses import asdict

from goodhart import TOOL_NAME, __version__
from goodhart.engine import ScanResult


def render(result: ScanResult) -> str:
    """Serialize stable field names and sorted findings."""
    data = {
        "schema_version": "1",
        "tool": TOOL_NAME,
        "tool_version": __version__,
        "mode": result.data.mode,
        "range": {"base": result.data.base, "head": result.data.head},
        "summary": {**result.summary, "files_scanned": result.files_scanned},
        "findings": [asdict(finding) for finding in result.findings],
    }
    return json.dumps(data, indent=2, ensure_ascii=True) + "\n"
