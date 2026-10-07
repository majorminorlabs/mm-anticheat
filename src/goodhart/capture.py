"""Keep the exact input and observations from one blocked scan locally."""

import json
import os
import shutil
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path

from goodhart.engine import ScanResult
from goodhart.report.json import render


def save(result: ScanResult, *, unresolved: bool = False) -> Path:
    """Atomically publish a private capture; never rescan or overwrite prior captures."""
    root = (result.data.repository or Path.cwd()) / ".goodhart"
    if root.is_symlink():
        raise OSError("Capture directory .goodhart must not be a symlink")
    root.mkdir(exist_ok=True)
    ignore = root / ".gitignore"
    if ignore.is_symlink():
        raise OSError("Capture .gitignore must not be a symlink")
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf8")
    captures = root / "captures"
    if captures.is_symlink():
        raise OSError("Capture directory must not be a symlink")
    captures.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
    final = captures / f"{stamp}-{uuid.uuid4().hex[:12]}"
    temporary = Path(tempfile.mkdtemp(prefix=".pending-", dir=captures))
    try:
        for name, content in (
            ("diff.patch", result.data.patch),
            ("findings.json", render(result)),
            ("capture.json", json.dumps({"unresolved": unresolved}) + "\n"),
        ):
            target = temporary / name
            target.write_text(content, encoding="utf8")
            target.chmod(0o600)
        os.rename(temporary, final)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    return final
