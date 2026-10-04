"""AST-based test and assertion counts for Python."""

import ast
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
            if name.startswith("self.assert") or name == "pytest.raises":
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
