"""Classify file paths and test contents without executing them."""

import ast
import fnmatch
from pathlib import PurePosixPath
from typing import Literal

from goodhart.config import Config

FileKind = Literal["test", "source", "config", "snapshot", "other"]
SOURCE_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"}
CONFIG_NAMES = {
    "pytest.ini",
    "setup.cfg",
    "tox.ini",
    "pyproject.toml",
    "conftest.py",
    "package.json",
    ".gitlab-ci.yml",
    "Makefile",
    ".coveragerc",
    "codecov.yml",
}


def matches(path: str, pattern: str) -> bool:
    """Match repo-relative globs, including a zero-directory leading **/."""
    return fnmatch.fnmatchcase(path, pattern) or (
        pattern.startswith("**/") and fnmatch.fnmatchcase(path, pattern[3:])
    )


def classify(path: str, content: str | None, config: Config) -> frozenset[FileKind]:
    """Return all applicable kinds; conftest participates in two rule families."""
    if any(matches(path, pattern) for pattern in config.ignore_globs):
        return frozenset({"other"})
    p = PurePosixPath(path)
    if "__snapshots__" in p.parts or p.suffix in {".snap", ".ambr"}:
        return frozenset({"snapshot"})
    kinds: set[FileKind] = set()
    is_config = (
        p.name in CONFIG_NAMES
        or any(
            fnmatch.fnmatchcase(p.name, pattern)
            for pattern in ("jest.config.*", "vitest.config.*", ".mocharc.*")
        )
        or (path.startswith(".github/workflows/") and p.suffix in {".yml", ".yaml"})
    )
    if is_config:
        kinds.add("config")
    from goodhart.lang import limit_reason

    text = content or ""
    if limit_reason(text):
        text = ""
    is_test = any(matches(path, pattern) for pattern in config.test_globs)
    source_path = any(
        part in {"src", "source", "sources", "lib", "app", "apps", "benchmarks", "benchmark"}
        for part in p.parts[:-1]
    )
    if not is_test and not is_config and not source_path:
        if p.suffix == ".py":
            is_test = _python_test_signal(text)
        elif p.suffix in SOURCE_SUFFIXES:
            is_test = _js_test_signal(text)
    if is_test or p.name == "conftest.py":
        kinds.add("test")
    if not kinds:
        kinds.add("source" if p.suffix in SOURCE_SUFFIXES else "other")
    return frozenset(kinds)


def _python_test_signal(text: str) -> bool:
    from goodhart.lang import python

    try:
        tree = python.parse(text)
    except (SyntaxError, RecursionError, ValueError):
        return False
    imported = any(
        (
            isinstance(node, ast.Import)
            and any(alias.name in {"pytest", "unittest"} for alias in node.names)
        )
        or (isinstance(node, ast.ImportFrom) and node.module in {"pytest", "unittest"})
        for node in tree.body
    )
    if not imported:
        return False
    bases = {"unittest.TestCase"}
    for node in tree.body:
        if isinstance(node, ast.Import):
            bases.update(
                (alias.asname or alias.name) + ".TestCase"
                for alias in node.names
                if alias.name == "unittest"
            )
        elif isinstance(node, ast.ImportFrom) and node.module == "unittest":
            bases.update(
                alias.asname or alias.name for alias in node.names if alias.name == "TestCase"
            )
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith(
            "test"
        ):
            return True
        if isinstance(node, ast.ClassDef) and any(
            ast.unparse(base) in bases for base in node.bases
        ):
            return True
    return False


def _js_test_signal(text: str) -> bool:
    from goodhart.lang.jsts import tokens

    items = [token for token in tokens(text) if token.kind != "comment"]
    signals = {
        "vitest",
        "@jest/globals",
        "mocha",
        "node:test",
        "ava",
        "@playwright/test",
        "bun:test",
        "tap",
        "uvu",
    }
    for index, token in enumerate(items):
        if token.kind != "ident" or token.value not in {"import", "require"}:
            continue
        following = items[index + 1 : index + 100]
        if following and following[0].value == "type":
            continue
        if following and following[0].value == "{":
            end = next((i for i, item in enumerate(following) if item.value == "}"), None)
            if end is not None:
                bindings = [item.value for item in following[1:end] if item.value != ","]
                if bindings and all(
                    group.strip().startswith("type ")
                    for group in " ".join(item.value for item in following[1:end]).split(",")
                    if group.strip()
                ):
                    continue
        for item in following:
            if item.value == ";":
                break
            if item.kind == "string":
                from goodhart.lang.jsts import string_value

                module = string_value(item.value)
                if module in signals or (module and module.startswith("@testing-library/")):
                    return True
                break
    return False
