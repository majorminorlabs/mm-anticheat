"""JSON schema v3 adds trusted config provenance; v1 field meanings are retained."""

import json
from dataclasses import asdict

from mm_anticheat import TOOL_NAME, __version__
from mm_anticheat.engine import ScanResult


def render(result: ScanResult) -> str:
    """Serialize stable field names and sorted findings."""
    data = {
        "schema_version": "3",
        "tool": TOOL_NAME,
        "tool_version": __version__,
        "mode": result.data.mode,
        "range": {"base": result.data.base, "head": result.data.head},
        "config": {"source": result.data.config.source},
        "summary": {**result.summary, "files_scanned": result.files_scanned},
        "files": [
            {
                "file": change.path,
                "kinds": sorted(change.kinds),
                "base_kinds": sorted(change.old_kinds),
                "head_kinds": sorted(change.new_kinds),
            }
            for change in sorted(result.data.changes, key=lambda item: item.path)
        ],
        "findings": [asdict(finding) for finding in result.findings],
    }
    return json.dumps(data, indent=2, ensure_ascii=True) + "\n"
