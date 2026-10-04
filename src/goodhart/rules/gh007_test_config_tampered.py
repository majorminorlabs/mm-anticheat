"""Detect explicit reductions in test selection, coverage, or failure handling."""

import ast
import configparser
import json
import re
import shlex
import tomllib
from pathlib import PurePosixPath

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import first_line

LIST_KEYS = {
    "testPathIgnorePatterns",
    "exclude",
    "coveragePathIgnorePatterns",
    "omit",
    "collect_ignore",
    "collect_ignore_glob",
    "testpaths",
}
TEST_RUN = re.compile(
    r"\bpytest\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|"
    r"\bpython(?:3)?\s+-m\s+unittest\b|\b(?:jest|vitest|mocha)\b"
)


def _flatten(data: dict, prefix: str = "") -> dict[str, object]:
    values: dict[str, object] = {}
    for key, value in data.items():
        name = prefix + key
        if isinstance(value, dict):
            values.update(_flatten(value, name + "."))
        else:
            values[name] = value
    return values


def _structured(text: str, path: str) -> dict[str, object]:
    if not text.strip():
        return {}
    name = PurePosixPath(path).name
    if name == "package.json":
        return _flatten(json.loads(text))
    if name == "pyproject.toml":
        return _flatten(tomllib.loads(text))
    if name in {"pytest.ini", "setup.cfg", "tox.ini", ".coveragerc"}:
        parser = configparser.ConfigParser(interpolation=None)
        parser.read_string(text)
        return {
            section + "." + key: value
            for section in parser.sections()
            for key, value in parser.items(section)
        }
    if name == "conftest.py":
        tree = ast.parse(text)
        result = {}
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in LIST_KEYS:
                        try:
                            result[target.id] = ast.literal_eval(node.value)
                        except (ValueError, TypeError):
                            pass  # Computed assignments are outside this deterministic heuristic.
        return result
    result = {}
    for key in LIST_KEYS | {"passWithNoTests"}:
        match = re.search(r"\b" + key + r"\s*[:=]\s*(\[[\s\S]*?\]|true|false)", text)
        if match:
            result[key] = (
                re.findall(r"['\"]([^'\"]+)['\"]", match[1])
                if match[1].startswith("[")
                else match[1] == "true"
            )
    # Track numeric thresholds by property path (line/branch/function/statement thresholds).
    coverage = re.search(r"coverageThreshold\s*:\s*\{([\s\S]*?)\n?\s*\}\s*[,}]", text)
    if coverage:
        for key, value in re.findall(r"(\w+)\s*:\s*(-?\d+(?:\.\d+)?)", coverage[1]):
            result["coverageThreshold." + key] = float(value)
    for key, value in re.findall(r"\b(fail_under)\s*[:=]\s*(\d+(?:\.\d+)?)", text):
        result[key] = float(value)
    for key in {"testpaths", "omit", "addopts"}:
        match = re.search(r"\b" + key + r"\s*[:=]\s*([^\n]+)", text)
        if match and key not in result:
            result[key] = match[1]
    return result


def _entries(value: object) -> set[str]:
    if isinstance(value, list):
        return {str(item) for item in value}
    if isinstance(value, str):
        return set(re.findall(r"[^\s,\[\]'\"]+", value))
    return set()


def _narrower(old: set[str], new: set[str]) -> bool:
    if not new or old == new:
        return False
    if not old:
        return True
    if new < old:
        return True
    return all(any(item.startswith(parent.rstrip("/*") + "/") for parent in old) for item in new)


def _script_paths(text: str) -> set[str]:
    try:
        args = shlex.split(text)
    except ValueError:
        return set()
    return {arg for arg in args[1:] if not arg.startswith("-") and ("/" in arg or arg == "tests")}


def _ci_steps(text: str) -> list[str]:
    text = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    return re.split(r"(?=^\s*-\s+[\w-]+:)", text, flags=re.M)


def _selectors(value: object) -> set[str]:
    text = " ".join(str(item) for item in value) if isinstance(value, list) else str(value or "")
    return {
        match[0].strip()
        for match in re.finditer(
            r"(?:^|\s)(?:-k\s+[^\n]+?(?=\s+-|$)|--(?:deselect|ignore(?:-glob)?)[=\s]+[^\s]+"
            r"|-p\s+no:[^\s]+)",
            text,
        )
    }


class TestConfigTampered(RuleBase):
    id = "GH007"
    name = "test-config-tampered"
    default_severity = "high"
    applies_to = {"config"}
    why_flagged = "Configuration changes reduce what is tested or let failing checks pass."
    legit_if = "The narrower suite or threshold is an intentional, reviewed project policy change."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        before = change.base_content or "" if ctx.mode == "full" else change.visible("base")
        after = change.head_content or "" if ctx.mode == "full" else change.visible("head")
        # Patch fragments need not be valid JSON/TOML/INI; use local property heuristics.
        if ctx.mode == "full":
            old, new = _structured(before, change.path), _structured(after, change.path)
        else:
            old, new = _structured(before, "fragment"), _structured(after, "fragment")
        reasons = []
        for key, value in new.items():
            leaf = key.rsplit(".", 1)[-1]
            previous = old.get(key)
            if leaf in LIST_KEYS:
                if leaf == "testpaths":
                    if _narrower(_entries(previous), _entries(value)):
                        reasons.append("testpaths narrowed")
                elif _entries(value) - _entries(previous):
                    reasons.append(f"{leaf} gained exclusions")
            if leaf == "passWithNoTests" and value is True and previous is not True:
                reasons.append("passWithNoTests enabled")
            if leaf == "fail_under" or "coverageThreshold" in key:
                try:
                    if previous is not None and float(value) < float(previous):
                        reasons.append(f"{key} lowered from {previous} to {value}")
                except (TypeError, ValueError):
                    pass
        for key in {key for key in old | new if key.endswith("addopts")}:
            if _selectors(new.get(key)) - _selectors(old.get(key)):
                reasons.append("pytest addopts gained or changed test selection/disabled plugins")
        old_cov = re.search(r"--cov-fail-under[=\s]+(\d+(?:\.\d+)?)", before)
        new_cov = re.search(r"--cov-fail-under[=\s]+(\d+(?:\.\d+)?)", after)
        if old_cov and new_cov and float(new_cov[1]) < float(old_cov[1]):
            reasons.append("--cov-fail-under lowered")
        if PurePosixPath(change.path).name == "package.json":
            if ctx.mode == "full":
                old_script, new_script = (
                    str(old.get("scripts.test", "")),
                    str(new.get("scripts.test", "")),
                )
            else:
                old_match = re.search(r'"test"\s*:\s*"([^\n]*)"', before)
                new_match = re.search(r'"test"\s*:\s*"([^\n]*)"', after)
                old_script, new_script = (
                    (old_match[1] if old_match else ""),
                    (new_match[1] if new_match else ""),
                )
            if new_script != old_script and (
                re.search(
                    r"\|\|\s*true\b|--passWithNoTests\b|\bexit\s+0\b",
                    new_script,
                )
                or _narrower(_script_paths(old_script), _script_paths(new_script))
            ):
                reasons.append("test script masks failures or narrows paths")
        is_ci = change.path.startswith(".github/workflows/") or change.path == ".gitlab-ci.yml"
        if is_ci:
            old_steps = [step for step in _ci_steps(before) if TEST_RUN.search(step)]
            new_steps = [step for step in _ci_steps(after) if TEST_RUN.search(step)]
            if len(new_steps) < len(old_steps):
                reasons.append("test step removed or commented out")
            for step in new_steps:
                if (
                    re.search(r"continue-on-error:\s*true|\|\|\s*true\b", step)
                    and step not in old_steps
                ):
                    reasons.append("test step tolerates failures")
        # Makefiles can also directly mask the test runner's exit status.
        if any(
            TEST_RUN.search(line.value) and re.search(r"\|\|\s*true\b", line.value)
            for line in change.added
        ):
            reasons.append("test command ignores its exit status")
        if not reasons:
            return []
        evidence = "\n".join(line.value for line in change.removed + change.added)
        return [
            self.finding(
                change,
                first_line(change),
                "Test configuration reduces checks",
                evidence,
                why=self.why_flagged + " " + "; ".join(sorted(set(reasons))),
            )
        ]
