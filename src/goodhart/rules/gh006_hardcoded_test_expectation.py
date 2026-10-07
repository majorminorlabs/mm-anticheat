"""New input-specific outputs tied to expectations from the same test."""

import ast
import re
from functools import lru_cache

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.lang import jsts, python
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import is_python, scalar, significant, without_comments


def _values(text: str) -> list[object]:
    return [value for token in jsts.tokens(text) if significant(value := jsts.literal(token))]


@lru_cache(maxsize=64)
def _groups(text: str, py: bool, full: bool) -> list:
    if py:
        try:
            return python.literal_groups(text)
        except SyntaxError:
            if full:
                return []
    else:
        return jsts.literal_groups(text)
    expected, inputs = [], []
    # In incomplete Python patch fragments retain the documented line heuristic.
    for number, line in enumerate(without_comments(text, True).splitlines(), 1):
        match = re.search(r"(?:==\s*|assertEqual\s*\([^,]*,\s*)(.*)", line)
        if match and "assert" in line:
            expected.extend((value, number) for value in _values(match[1]))
        before = line[: match.start()] if match else line
        if re.search(r"\w+\s*\(", before):
            inputs.extend((value, number) for value in _values(before))
    return [("<fragment>", expected, inputs)]


def _source_values(text: str, py: bool) -> set[object]:
    if py:
        return {
            value
            for node in ast.walk(python.parse(text))
            if isinstance(node, (ast.Constant, ast.UnaryOp)) and significant(value := scalar(node))
        }
    return set(_values(jsts.mask(text)))


def _output(text: str) -> list[object]:
    items = [token for token in jsts.tokens(text) if token.kind != "comment"]
    start = next(
        (
            index + 1
            for index, item in enumerate(items)
            if item.kind == "ident" and item.value == "return" or item.value in {"=", "?"}
        ),
        None,
    )
    return (
        []
        if start is None
        else [value for item in items[start:] if significant(value := jsts.literal(item))]
    )


class HardcodedTestExpectation(RuleBase):
    details = (
        "Collects significant scalar test inputs and expectations, including static "
        "parametrize/each rows. High requires a new output literal absent from the "
        "base, an input-specific branch and matching input/expectation from the same "
        "test. Condition literals cannot serve as outputs. Literal-only matches are "
        "medium; patch findings have reduced confidence. Computed tables, imports and "
        "expectations can be missed."
    )
    id = "GH006"
    name = "hardcoded-test-expectation"
    default_severity = "high"
    applies_to = {"source"}
    why_flagged = (
        "New source literals match test expectations; a special-case branch can bypass logic."
    )
    legit_if = (
        "The value is a legitimate domain constant, lookup table entry, or specified behavior."
    )

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if "expectations" not in ctx.cache:
            contents = dict(ctx.extra_tests)
            coordinates = {}
            added_expectations = {}
            for item in ctx.changes:
                if "test" in item.new_kinds and item.new_path:
                    added_expectations[item.path] = {line.new_line for line in item.added}
                    contents[item.path] = (
                        item.head_content or "" if ctx.mode == "full" else item.visible("head")
                    )
                    if ctx.mode == "patch":
                        coordinates[item.path] = [
                            line.new_line or 1
                            for hunk in item.hunks
                            for line in hunk.lines
                            if line.kind != "-"
                        ]
            groups = []
            for path, content in sorted(contents.items()):
                from goodhart.lang import limit_reason

                if limit_reason(content):
                    continue
                lines = content.splitlines()
                for _, output, input_ in _groups(content, is_python(path), ctx.mode == "full"):
                    evidence = {}
                    for value, row in output:
                        if significant(value):
                            actual = coordinates[path][row - 1] if path in coordinates else row
                            candidate = (
                                path,
                                actual,
                                lines[row - 1],
                                actual in added_expectations.get(path, set()),
                            )
                            if value not in evidence or not candidate[3]:
                                evidence[value] = candidate
                    groups.append((evidence, {value for value, _ in input_ if significant(value)}))
            groups.sort(key=lambda group: all(item[3] for item in group[0].values()))
            ctx.cache["expectations"] = groups
        groups = ctx.cache["expectations"]
        expected = {
            value: evidence
            for outputs, _ in reversed(groups)
            for value, evidence in outputs.items()
        }
        if not expected:
            return []
        py = is_python(change.path)
        base = (
            _source_values(change.base_content or "", py)
            if ctx.mode == "full"
            else set(_values(change.visible("base")))
        )
        added = {line.new_line or 1: line for line in change.added}
        visible = {}
        if ctx.mode == "full":
            visible = dict(
                enumerate(without_comments(change.head_content or "", py).splitlines(), 1)
            )
        else:
            for hunk in change.hunks:
                lines = [line for line in hunk.lines if line.kind != "-"]
                clean = without_comments("\n".join(line.value for line in lines), py).splitlines()
                visible.update(
                    (line.new_line or 1, clean[index]) for index, line in enumerate(lines)
                )
        branches = []
        if py and ctx.mode == "full":
            for node in ast.walk(python.parse(change.head_content or "")):
                if isinstance(node, (ast.If, ast.IfExp)):
                    condition = {
                        scalar(item)
                        for item in ast.walk(node.test)
                        if isinstance(item, (ast.Constant, ast.UnaryOp))
                    }
                    candidates = node.body if isinstance(node, ast.If) else [node.body, node.orelse]
                    for candidate in candidates:
                        outputs = (
                            [candidate]
                            if isinstance(node, ast.IfExp)
                            else [
                                child
                                for child in ast.walk(candidate)
                                if isinstance(child, (ast.Return, ast.Assign, ast.AnnAssign))
                            ]
                        )
                        for output in outputs:
                            if output.lineno > node.lineno + 3:
                                continue
                            expression = output if isinstance(node, ast.IfExp) else output.value
                            values = (
                                {
                                    scalar(item)
                                    for item in ast.walk(expression)
                                    if isinstance(item, (ast.Constant, ast.UnaryOp))
                                }
                                if expression
                                else set()
                            )
                            branches.append(
                                (node.lineno, output.lineno, condition, values - condition)
                            )
                elif isinstance(node, ast.Match):
                    for case in node.cases:
                        row = case.pattern.lineno
                        condition = {
                            scalar(item)
                            for item in ast.walk(case.pattern)
                            if isinstance(item, (ast.Constant, ast.UnaryOp))
                        }
                        for statement in case.body:
                            for output in ast.walk(statement):
                                if (
                                    not isinstance(output, (ast.Return, ast.Assign, ast.AnnAssign))
                                    or output.lineno > row + 3
                                ):
                                    continue
                                values = (
                                    {
                                        scalar(item)
                                        for item in ast.walk(output.value)
                                        if isinstance(item, (ast.Constant, ast.UnaryOp))
                                    }
                                    if output.value
                                    else set()
                                )
                                branches.append((row, output.lineno, condition, values - condition))
        else:
            for row, line in added.items():
                code = visible.get(row, "")
                shape = jsts.mask(code, strings=True)
                if not re.search(r"\b(?:if|elif|case)\b|\?", shape):
                    continue
                # Separate ternary conditions before extracting outputs.
                split = (
                    shape.find("?")
                    if "?" in shape
                    else shape.find(":")
                    if re.search(r"\bcase\b|^\s*(?:if|elif)\b", shape)
                    else -1
                )
                if split < 0 and "if" in shape:
                    if_match = re.search(r"\bif\s*\(", shape)
                    paren = shape.find("(", if_match.start()) if if_match else -1
                    depth = 0
                    for index in range(paren, len(shape)):
                        depth += (shape[index] == "(") - (shape[index] == ")")
                        if depth == 0:
                            split = index
                            break
                condition_text = code[: split + 1] if split >= 0 else code
                condition = set(_values(condition_text))
                if not re.search(r"==|\bcase\b", jsts.mask(condition_text, strings=True)):
                    continue
                for target in range(row, row + 4):
                    output_text = visible.get(target, "")
                    if target == row and split >= 0:
                        output_text = "return " + code[split + 1 :]
                    branches.append((row, target, condition, set(_output(output_text)) - condition))
        findings, high_outputs = [], set()
        for row, output_row, condition, outputs in branches:
            if row not in added:
                continue
            for expectations, inputs in groups:
                matches = sorted((outputs & expectations.keys()) - base, key=repr)
                if not condition & inputs or not matches:
                    continue
                value = matches[0]
                path, test_row, evidence, fresh = expectations[value]
                findings.append(
                    self.finding(
                        change,
                        row,
                        "Input-specific branch matches a test expectation",
                        f"{visible.get(row, '')}\n{visible.get(output_row, '')}\n"
                        f"{path}:{test_row}: {evidence}",
                        severity="medium" if fresh else "high",
                        reduced=ctx.mode == "patch",
                    )
                )
                high_outputs.add(output_row)
                break
        for row, line in added.items():
            if row in high_outputs:
                continue
            values = [
                value
                for value in _values(visible.get(row, ""))
                if value in expected
                and value not in base
                and not (isinstance(value, int) and abs(value) < 1000)
            ]
            if values:
                path, test_row, evidence, fresh = expected[values[0]]
                findings.append(
                    self.finding(
                        change,
                        row,
                        "New source literal matches a test expectation",
                        f"{line.value}\n{path}:{test_row}: {evidence}",
                        severity="low" if fresh else "medium",
                        reduced=ctx.mode == "patch",
                    )
                )
        # A one-line branch and repeated tests should produce only one high per location.
        return list({(f.line, f.severity): f for f in findings}.values())
