"""Extract branch literals for a bounded, batched repository-wide expectation search."""

import ast
import re

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.lang import jsts, python
from mm_anticheat.util import scalar, significant


def branch_literals(changes: list[FileChange]) -> set[str]:
    """Only search when an added source branch compares and emits significant literals."""
    values = set()
    for change in changes:
        if "source" not in change.new_kinds or not change.head_content or change.parse_error:
            continue
        rows = {line.new_line for line in change.added}
        if change.path.endswith(".py"):
            try:
                tree = python.parse(change.head_content)
            except (SyntaxError, ValueError, RecursionError):
                continue
            for node in ast.walk(tree):
                if not isinstance(node, (ast.If, ast.IfExp, ast.Match)) or node.lineno not in rows:
                    continue
                condition = (
                    node.test
                    if isinstance(node, (ast.If, ast.IfExp))
                    else ast.Tuple(elts=[case.pattern for case in node.cases], ctx=ast.Load())
                )
                inputs = {
                    scalar(item)
                    for item in ast.walk(condition)
                    if isinstance(item, (ast.Constant, ast.UnaryOp)) and significant(scalar(item))
                }
                outputs = {
                    scalar(item)
                    for output in ast.walk(node)
                    if isinstance(output, (ast.Return, ast.Assign, ast.AnnAssign, ast.IfExp))
                    and output.lineno <= node.lineno + 3
                    for item in ast.walk(output)
                    if isinstance(item, (ast.Constant, ast.UnaryOp)) and significant(scalar(item))
                }
                if inputs and outputs - inputs:
                    values.update(str(value) for value in inputs | outputs)
        else:
            lines = change.head_content.splitlines()
            for row in rows:
                if row is None or row > len(lines):
                    continue
                if not re.search(r"\b(?:if|case)\b|\?", jsts.mask(lines[row - 1], strings=True)):
                    continue
                window = "\n".join(lines[row - 1 : row + 3])
                literals = {
                    value
                    for token in jsts.tokens(window)
                    if significant(value := jsts.literal(token))
                }
                if len(literals) > 1 and re.search(r"==|\bcase\b", window):
                    values.update(str(value) for value in literals)
    return values
