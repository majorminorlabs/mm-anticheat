"""Classify file paths and test contents without executing them."""

import fnmatch
import re
from pathlib import PurePosixPath
from typing import Literal

from goodhart.config import Config

FileKind = Literal["test", "source", "config", "snapshot", "other"]
SOURCE_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}
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
    text = content or ""
    is_test = any(matches(path, pattern) for pattern in config.test_globs)
    if p.suffix == ".py":
        is_test |= bool(re.search(r"\b(?:async\s+)?def\s+test\w*\s*\(|\bTestCase\b", text))
    elif p.suffix in SOURCE_SUFFIXES:
        is_test |= bool(
            re.search(
                r"(?:from\s*|require\s*\(\s*|import\s*)['\"]"
                r"(?:vitest|@jest/globals|mocha|node:test)['\"]",
                text,
            )
        )
    if is_test or p.name == "conftest.py":
        kinds.add("test")
    if not kinds:
        kinds.add("source" if p.suffix in SOURCE_SUFFIXES else "other")
    return frozenset(kinds)
