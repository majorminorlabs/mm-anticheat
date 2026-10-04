"""Match significant expected literals and input branches, with local evidence."""

import ast
import re

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.lang import jsts, python
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import is_python, python_code, scalar, significant, without_comments

LITERAL = re.compile(r"(['\"])(?:\\.|(?!\1).)*?\1|(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])")


def _values(text: str) -> list[object]:
    result = []
    for match in LITERAL.finditer(text):
        try:
            value = ast.literal_eval(match[0])
        except (SyntaxError, ValueError):
            continue
        if significant(value):
            result.append(value)
    return result


def _patch_literals(text: str) -> tuple[list[tuple[object, int]], list[tuple[object, int]]]:
    expected, inputs = [], []
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(("#", "//")):
            continue
        match = re.search(r"(?:==\s*|\.(?:toBe|toEqual|toStrictEqual)\s*\()(.*)", line)
        if match and ("assert" in line or "expect" in line):
            expected.extend((value, number) for value in _values(match[1]))
        equal = re.search(r"assertEqual\s*\([^,]*,\s*(.*)\)", line)
        if equal:
            expected.extend((value, number) for value in _values(equal[1]))
        # Restrict input matching to call argument regions before assertion matchers.
        before = line[: match.start()] if match else line
        if re.search(r"\w+\s*\(", before):
            inputs.extend((value, number) for value in _values(before))
    return expected, inputs


def _source_values(text: str, py: bool) -> list[object]:
    if py:
        return [
            scalar(node)
            for node in ast.walk(python.parse(text))
            if isinstance(node, (ast.Constant, ast.UnaryOp)) and significant(scalar(node))
        ]
    return _values(jsts.mask(text))


class HardcodedTestExpectation(RuleBase):
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
        expected: dict[object, tuple[str, int, str]] = {}
        inputs: set[object] = set()
        test_contents = dict(ctx.extra_tests)
        patch_coordinates = {}
        for item in ctx.changes:
            if "test" in item.new_kinds and item.new_path:
                test_contents[item.path] = (
                    item.head_content or "" if ctx.mode == "full" else item.visible("head")
                )
                if ctx.mode == "patch":
                    patch_coordinates[item.path] = [
                        line.new_line or 1
                        for hunk in item.hunks
                        for line in hunk.lines
                        if line.kind != "-"
                    ]
        for path, content in sorted(test_contents.items()):
            if is_python(path) and ctx.mode == "full":
                try:
                    output_values, input_values = python.literals(content)
                except SyntaxError:
                    continue
            else:
                output_values, input_values = _patch_literals(
                    without_comments(content, is_python(path)),
                )
            lines = content.splitlines()
            for value, number in output_values:
                if significant(value):
                    coordinates = patch_coordinates.get(path)
                    actual = coordinates[number - 1] if coordinates else number
                    expected.setdefault(value, (path, actual, lines[number - 1]))
            inputs.update(value for value, _ in input_values if significant(value))
        if not expected:
            return []
        py = is_python(change.path)
        base_values = (
            set(_source_values(change.base_content or "", py))
            if ctx.mode == "full"
            else set(_values(change.visible("base")))
        )
        added = {line.new_line: line for line in change.added}
        if ctx.mode == "full":
            text = change.head_content or ""
            clean = without_comments(text, py).splitlines()
            structure = (python_code(text) if py else jsts.mask(text, strings=True)).splitlines()
            visible = {index: value for index, value in enumerate(clean, 1)}
            structural = {index: value for index, value in enumerate(structure, 1)}
        else:
            visible, structural = {}, {}
            for hunk in change.hunks:
                lines = [line for line in hunk.lines if line.kind != "-"]
                text = "\n".join(line.value for line in lines)
                clean = without_comments(text, py).splitlines()
                structure = (
                    python_code(text) if py else jsts.mask(text, strings=True)
                ).splitlines()
                for index, item in enumerate(lines):
                    visible[item.new_line] = clean[index]
                    structural[item.new_line] = structure[index]
        findings, high_lines = [], set()
        for number, line in added.items():
            code = visible.get(number, "")
            shape = structural.get(number, "")
            # Require an actual input comparison, not merely a literal in a nearby comment.
            condition = re.search(r"\b(?:if|elif|case)\b|\?.*:", shape)
            branch_inputs = set(_values(code)) & inputs
            if not condition or not branch_inputs or not re.search(r"==|===|\bcase\b", shape):
                continue
            for target in range(number or 1, (number or 1) + 4):
                output = visible.get(target, "")
                if not re.search(r"\breturn\b|(?<![=!<>])=(?!=)|\?.*:", structural.get(target, "")):
                    continue
                for value in _values(output):
                    if value in expected:
                        path, test_line, evidence = expected[value]
                        findings.append(
                            self.finding(
                                change,
                                number or 1,
                                "Input-specific branch matches a test expectation",
                                f"{line.value}\n{output}\n{path}:{test_line}: {evidence}",
                                reduced=ctx.mode == "patch",
                            )
                        )
                        high_lines.add(target)
                        break
                if target in high_lines:
                    break
        for number, line in added.items():
            if number in high_lines or line.value.lstrip().startswith(("#", "//")):
                continue
            for value in _values(visible.get(number, "")):
                if value in expected and value not in base_values:
                    path, test_line, evidence = expected[value]
                    findings.append(
                        self.finding(
                            change,
                            number or 1,
                            "New source literal matches a test expectation",
                            f"{line.value}\n{path}:{test_line}: {evidence}",
                            severity="medium",
                            reduced=ctx.mode == "patch",
                        )
                    )
                    break
        return findings
