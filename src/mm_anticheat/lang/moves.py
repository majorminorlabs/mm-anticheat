"""Shared test inventories and substantive move comparisons; no rule imports."""

from collections import Counter, defaultdict
from dataclasses import dataclass, field

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.lang import jsts, python
from mm_anticheat.util import assertion_line, is_python, python_code


@dataclass(frozen=True)
class TestInventory:
    name: str
    assertions: int


@dataclass
class MoveEvidence:
    overlap: float = 0
    partial: bool = False
    targets: list[str] = field(default_factory=list)
    empty: list[str] = field(default_factory=list)
    weakened: list[str] = field(default_factory=list)

    @property
    def severity(self) -> str:
        if self.partial:
            return "medium"
        return "info" if self.overlap >= 0.8 else "medium" if self.overlap > 0 else "high"

    def explanation(self) -> str:
        text = ""
        if self.targets:
            text += " Tests appear to have moved to: " + ", ".join(self.targets) + "."
        if self.empty:
            text += " Moved test has no assertions: " + ", ".join(self.empty) + "."
        if self.weakened:
            text += " Moved test has fewer assertions: " + ", ".join(self.weakened) + "."
        return text


def inventory(
    change: FileChange,
    side: str,
    full: bool,
    cache: dict | None = None,
) -> list[TestInventory]:
    """Cache lightweight counts per scan, without retaining full ASTs."""
    key = (id(change), side, full)
    if cache is not None and key in cache:
        return cache[key]
    result = _inventory(change, side, full)
    if cache is not None:
        cache[key] = result
    return result


def _inventory(change: FileChange, side: str, full: bool) -> list[TestInventory]:
    """Use AC004's full counters; patch inventories count assertion lines per hunk test."""
    path = change.old_path if side == "base" else change.new_path
    if path is None:
        return []
    lang = python if is_python(path) else jsts
    if full:
        return [
            TestInventory(t.name, t.assertions)
            for t in lang.tests(getattr(change, side + "_content") or "")
        ]
    result = []
    for hunk in change.hunks:
        # Destination proof must be in the added hunk, not an unrelated context test.
        kind = "-" if side == "base" else "+"
        lines = [line.value for line in hunk.lines if line.kind == kind]
        text = "\n".join(lines)
        clean = python_code(text) if is_python(path) else jsts.mask(text, strings=True)
        clean_lines = clean.splitlines()
        js_tests = [] if is_python(path) else jsts.tests(text)
        definitions = (
            lang.definition_names(text)
            if is_python(path)
            else [(test.name, test.line) for test in js_tests]
        )
        for index, (name, row) in enumerate(definitions):
            end = definitions[index + 1][1] - 1 if index + 1 < len(definitions) else len(lines)
            if not is_python(path):
                end = js_tests[index].end
            body = clean_lines[row - 1 : end]
            if is_python(path):
                indent = len(lines[row - 1]) - len(lines[row - 1].lstrip())
                body = [body[0]] + list(_indented_body(body[1:], indent))
            result.append(TestInventory(name, sum(assertion_line(line) for line in body)))
    return result


def _indented_body(lines: list[str], indent: int):
    for line in lines:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        yield line


def names(change: FileChange, side: str, full: bool, cache: dict | None = None) -> list[str]:
    """Return test names on one side."""
    return [test.name for test in inventory(change, side, full, cache)]


def destinations(
    removed: list[str],
    change: FileChange,
    changes: list[FileChange],
    full: bool,
    cache: dict | None = None,
) -> MoveEvidence:
    """Only substantive, genuinely added tests can corroborate a move."""
    requirements = defaultdict(list)
    for test in inventory(change, "base", full, cache):
        requirements[test.name].append(test.assertions)
    # Conservative multiplicity pairing: strongest removed instance first.
    for counts in requirements.values():
        counts.sort(reverse=True)
    remaining = Counter(removed)
    candidates = defaultdict(list)
    evidence = MoveEvidence()
    for item in changes:
        if item is change or "test" not in item.new_kinds:
            continue
        try:
            before = Counter(names(item, "base", full, cache))
            head = sorted(inventory(item, "head", full, cache), key=lambda t: -t.assertions)
        except (SyntaxError, ValueError, RecursionError):
            continue
        for test in head:
            # Reserve the strongest existing instances first: adding a stub next
            # to a substantive same-name test must not reuse its assertions.
            if before[test.name]:
                before[test.name] -= 1
            elif remaining[test.name]:
                candidates[test.name].append((test.assertions, item.path))
    complete = 0
    for name, count in remaining.items():
        available = sorted(candidates[name], reverse=True)
        for needed in requirements[name][:count]:
            if not available:
                break
            assertions, path = available.pop(0)
            label = f"{path}:{name}"
            if assertions == 0:
                evidence.empty.append(label)
            elif not full or assertions >= needed:
                complete += 1
                evidence.targets.append(path)
            else:
                evidence.partial = True
                evidence.targets.append(path)
                evidence.weakened.append(label)
    evidence.overlap = complete / len(removed) if removed else 0
    evidence.targets = sorted(set(evidence.targets))
    evidence.empty.sort()
    evidence.weakened.sort()
    return evidence
