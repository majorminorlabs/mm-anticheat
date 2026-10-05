"""Shared test-inventory comparisons; no rule imports."""

from collections import Counter

from goodhart.diffmodel import FileChange
from goodhart.lang import jsts, python
from goodhart.util import is_python


def names(change: FileChange, side: str, full: bool) -> list[str]:
    """Return test names on one side, using fragment definitions in patch mode."""
    path = change.old_path if side == "base" else change.new_path
    if path is None:
        return []
    lang = python if is_python(path) else jsts
    content = getattr(change, side + "_content") or "" if full else change.visible(side)
    if full:
        return [test.name for test in lang.tests(content)]
    return [name for name, _ in lang.definition_names(content)]


def destinations(
    removed: list[str],
    change: FileChange,
    changes: list[FileChange],
    full: bool,
) -> tuple[float, list[str]]:
    """Find genuinely added names elsewhere, including split/moved-and-edited files."""
    remaining, targets = Counter(removed), []
    for item in changes:
        if item is change or "test" not in item.new_kinds:
            continue
        try:
            added = Counter(names(item, "head", full)) - Counter(names(item, "base", full))
        except (SyntaxError, ValueError, RecursionError):
            continue
        overlap = added & remaining
        if overlap:
            targets.append(item.path)
            remaining -= overlap
    total = len(removed)
    return (1 - remaining.total() / total if total else 0), sorted(targets)
