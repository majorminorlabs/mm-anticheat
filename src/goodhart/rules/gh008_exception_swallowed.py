"""Broad catch handlers whose bodies discard the exception."""

import ast
import re

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.lang import jsts, python
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import is_python


def _silent(statement: ast.stmt) -> bool:
    if isinstance(statement, (ast.Pass, ast.Continue)):
        return True
    if isinstance(statement, ast.Expr):
        return isinstance(statement.value, ast.Constant) and statement.value.value is Ellipsis
    if isinstance(statement, ast.Return):
        if statement.value is None:
            return True
        try:
            ast.literal_eval(statement.value)
            return True
        except (ValueError, TypeError):
            return False
    return False


class ExceptionSwallowed(RuleBase):
    id = "GH008"
    name = "exception-swallowed"
    default_severity = "medium"
    applies_to = {"source"}
    why_flagged = "A broad exception handler silently converts failures into apparent success."
    legit_if = "The operation is best effort, and discarding this failure is intentional."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        findings = []
        added = {line.new_line for line in change.added}
        if is_python(change.path) and ctx.mode == "full":
            text = change.head_content or ""
            for node in ast.walk(python.parse(text)):
                if not isinstance(node, ast.ExceptHandler):
                    continue
                broad = node.type is None or (
                    isinstance(node.type, ast.Name)
                    and node.type.id in {"Exception", "BaseException"}
                )
                changed = any(
                    number in added
                    for number in range(node.lineno, (node.end_lineno or node.lineno) + 1)
                )
                if broad and changed and node.body and all(_silent(item) for item in node.body):
                    findings.append(
                        self.finding(
                            change,
                            node.lineno,
                            "Broad exception handler discards failures",
                            ast.get_source_segment(text, node) or "except ...",
                        )
                    )
            return findings
        if is_python(change.path):
            for hunk in change.hunks:
                lines = [line for line in hunk.lines if line.kind != "-"]
                for index, line in enumerate(lines[:-1]):
                    if re.match(
                        r"\s*except(?:\s+(?:Exception|BaseException)(?:\s+as\s+\w+)?)?\s*:",
                        line.value,
                    ) and (line.kind == "+" or lines[index + 1].kind == "+"):
                        body = lines[index + 1].value.strip()
                        if re.fullmatch(
                            r"pass|\.\.\.|continue|return(?:\s+(?:None|True|False|"
                            r"-?\d+(?:\.\d+)?|['\"].*['\"]|\[\]|\{\}))?",
                            body,
                        ):
                            # A further body line can log or re-raise; don't flag it.
                            indent = len(lines[index + 1].value) - len(
                                lines[index + 1].value.lstrip()
                            )
                            tail = lines[index + 2 :]
                            if (
                                tail
                                and tail[0].value.strip()
                                and (len(tail[0].value) - len(tail[0].value.lstrip()) >= indent)
                            ):
                                continue
                            findings.append(
                                self.finding(
                                    change,
                                    line.new_line or 1,
                                    "Broad exception handler discards failures",
                                    line.value + "\n" + lines[index + 1].value,
                                )
                            )
            return findings
        pattern = re.compile(
            r"\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:return\s*"
            r"(?:null|undefined|\[\]|\{\}|false)?\s*;?\s*)?\}"
            r"|\.catch\s*\(\s*\([^)]*\)\s*=>\s*\{\s*\}\s*\)"
        )
        if ctx.mode == "full":
            text = change.head_content or ""
            clean = jsts.mask(text)

            def numbers(start: int, end: int) -> range:
                return range(text.count("\n", 0, start) + 1, text.count("\n", 0, end) + 2)

            for match in pattern.finditer(clean):
                if any(number in added for number in numbers(match.start(), match.end())):
                    findings.append(
                        self.finding(
                            change,
                            text.count("\n", 0, match.start()) + 1,
                            "Catch handler discards failures",
                            match[0],
                        )
                    )
        else:
            for hunk in change.hunks:
                lines = [line for line in hunk.lines if line.kind != "-"]
                text = "\n".join(line.value for line in lines)
                for match in pattern.finditer(jsts.mask(text)):
                    index = text.count("\n", 0, match.start())
                    end = text.count("\n", 0, match.end())
                    if any(line.kind == "+" for line in lines[index : end + 1]):
                        findings.append(
                            self.finding(
                                change,
                                lines[index].new_line or 1,
                                "Catch handler discards failures",
                                match[0],
                            )
                        )
        return findings
