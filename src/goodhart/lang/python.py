"""AST-based test and assertion counts for Python."""

import ast
import warnings
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class Test:
    """A test definition and the complete source range including decorators."""

    name: str
    line: int
    end: int
    assertions: int
    node: ast.FunctionDef | ast.AsyncFunctionDef


@lru_cache(maxsize=128)
def parse(content: str) -> ast.Module:
    """Parse Python without executing it."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SyntaxWarning)
        return ast.parse(content)


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return _call_name(node.value) + "." + node.attr
    return ""


def assertion_count(node: ast.AST) -> int:
    """Count assertion statements/calls, without counting approx twice."""
    count = 0
    for child in ast.walk(node):
        if isinstance(child, ast.Assert):
            count += 1
        elif isinstance(child, ast.Call):
            name = _call_name(child.func)
            if (
                name.startswith("self.assert")
                or name == "pytest.raises"
                or any(
                    name.rsplit(".", 1)[-1].startswith(prefix)
                    for prefix in ("assert_called", "assert_awaited", "assert_not_called")
                )
            ):
                count += 1
    return count


def tests(content: str) -> list[Test]:
    """Find module tests and methods on Test* / TestCase classes."""
    tree = parse(content)
    result = []
    test_bases = {"TestCase", "unittest.TestCase"}
    for item in tree.body:
        if isinstance(item, ast.ImportFrom) and item.module == "unittest":
            test_bases.update(
                alias.asname or alias.name for alias in item.names if alias.name == "TestCase"
            )
        if isinstance(item, ast.Import):
            test_bases.update(
                (alias.asname or alias.name) + ".TestCase"
                for alias in item.names
                if alias.name == "unittest"
            )
    for item in tree.body:
        functions = []
        prefix = ""
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions = [item]
        elif isinstance(item, ast.ClassDef):
            if item.name.startswith("Test") or any(
                _call_name(base) in test_bases for base in item.bases
            ):
                test_bases.add(item.name)
                prefix = item.name + "."
                functions = [
                    node
                    for node in item.body
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                ]
        for fn in functions:
            if fn.name.startswith("test"):
                line = min([fn.lineno] + [dec.lineno for dec in fn.decorator_list])
                result.append(
                    Test(
                        prefix + fn.name, line, fn.end_lineno or fn.lineno, assertion_count(fn), fn
                    )
                )
    return result


def definition_names(text: str) -> list[tuple[str, int]]:
    """Patch-mode test definitions; fragments do not need valid AST syntax."""
    import re

    return [
        (match[1], number)
        for number, line in enumerate(text.splitlines(), 1)
        if (match := re.search(r"\b(?:async\s+)?def\s+(test\w*)\s*\(", line))
    ]


def literals(content: str) -> tuple[list[tuple[object, int]], list[tuple[object, int]]]:
    """Extract expected and input scalar literals only inside test bodies."""
    from goodhart.util import scalar

    expected, inputs = [], []
    for test in tests(content):
        for node in ast.walk(test.node):
            if isinstance(node, ast.Assert) and isinstance(node.test, ast.Compare):
                for op, rhs in zip(node.test.ops, node.test.comparators, strict=True):
                    if isinstance(op, ast.Eq):
                        expected.append((scalar(rhs), rhs.lineno))
            elif isinstance(node, ast.Call):
                name = _call_name(node.func)
                if name.endswith("assertEqual") and len(node.args) >= 2:
                    expected.append((scalar(node.args[1]), node.lineno))
                if not name.startswith(("self.assert", "pytest.", "assert", "print")):
                    inputs.extend((scalar(arg), node.lineno) for arg in node.args)
    return expected, inputs


def literal_groups(
    content: str,
) -> list[tuple[str, list[tuple[object, int]], list[tuple[object, int]]]]:
    """Keep test-local inputs/expectations together, including parametrize rows."""
    from goodhart.util import scalar

    result = []
    for test in tests(content):
        expected, inputs = [], []
        for statement in test.node.body:
            for node in ast.walk(statement):
                if isinstance(node, ast.Assert) and isinstance(node.test, ast.Compare):
                    for op, rhs in zip(node.test.ops, node.test.comparators, strict=True):
                        if isinstance(op, ast.Eq):
                            expected.append((scalar(rhs), rhs.lineno))
                elif isinstance(node, ast.Call):
                    name = _call_name(node.func)
                    if name.endswith("assertEqual") and len(node.args) >= 2:
                        expected.append((scalar(node.args[1]), node.args[1].lineno))
                    if not name.startswith(("self.assert", "pytest.", "assert", "print")):
                        inputs.extend((scalar(arg), arg.lineno) for arg in node.args)
        for decorator in test.node.decorator_list:
            if not isinstance(decorator, ast.Call) or not _call_name(decorator.func).endswith(
                "parametrize"
            ):
                continue
            if len(decorator.args) < 2:
                continue
            argnames, rows = decorator.args[:2]
            columns = scalar(argnames)
            if isinstance(columns, str):
                labels = [label.strip() for label in columns.split(",")]
            elif isinstance(argnames, (ast.List, ast.Tuple)):
                labels = [str(scalar(item)) for item in argnames.elts]
            else:
                labels = []
            if not isinstance(rows, (ast.List, ast.Tuple)):
                continue
            output = next(
                (
                    index
                    for index, label in enumerate(labels)
                    if label.lower() in {"expected", "want", "output", "result"}
                ),
                max(0, len(labels) - 1),
            )
            for row in rows.elts:
                cells = (
                    row.elts
                    if isinstance(row, (ast.List, ast.Tuple))
                    else row.args
                    if isinstance(row, ast.Call)
                    else [row]
                )
                for index, cell in enumerate(cells):
                    target = expected if index == output else inputs
                    target.append((scalar(cell), cell.lineno))
        result.append((test.name, expected, inputs))
    return result
