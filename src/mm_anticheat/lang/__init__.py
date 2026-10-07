"""Non-executing language helpers and resource bounds."""

MAX_FILE_BYTES = 1_000_000
MAX_LINE_CHARS = 20_000


def limit_reason(text: str) -> str | None:
    """Bound hostile inputs before parsing or regex matching."""
    if len(text) > MAX_FILE_BYTES or len(text.encode("utf8", errors="replace")) > MAX_FILE_BYTES:
        return "File exceeds the 1 MB analysis limit"
    if any(len(line) > MAX_LINE_CHARS for line in text.splitlines()):
        return "Line exceeds the 20,000 character analysis limit"
    return None
