"""Validated local TOML settings and reviewed path/inline exceptions."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from goodhart.diffmodel import FileChange
    from goodhart.rules.base import Finding

TEST_GLOBS = (
    "tests/**",
    "**/tests/**",
    "test/**",
    "**/test/**",
    "spec/**",
    "**/spec/**",
    "e2e/**",
    "**/e2e/**",
    "**/*_test.py",
    "**/test_*.py",
    "**/__tests__/**",
) + tuple(
    f"**/*.{kind}.{extension}"
    for kind in ("test", "spec")
    for extension in ("js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts")
)


@dataclass
class Config:
    """Effective scan settings; CLI values override corresponding file settings."""

    fail_on: str = "high"
    test_globs: tuple[str, ...] = TEST_GLOBS
    ignore_globs: tuple[str, ...] = (
        "vendor/**",
        "node_modules/**",
        "**/*.min.js",
        "dist/**",
        "build/**",
        ".next/**",
        "coverage/**",
    ) + tuple("**/assets/*." + "[0-9a-f]" * width + ".js" for width in (8, 12, 16, 20, 32, 40, 64))
    skip_rules: set[str] = field(default_factory=set)
    allows: list["Allow"] = field(default_factory=list)
    source: str = "defaults"


@dataclass(frozen=True)
class Allow:
    """A reviewed path exception; its reason is mandatory."""

    rule: str
    path: str
    reason: str


class ConfigError(ValueError):
    """Invalid user configuration."""


RULE_IDS = frozenset(f"GH{number:03d}" for number in range(13))
FAIL_ON = frozenset({"high", "medium", "low", "never"})


def rule_ids(value: str) -> set[str]:
    """Parse a comma-separated CLI selection, rejecting typos."""
    items = {item.strip() for item in value.split(",") if item.strip()}
    unknown = items - RULE_IDS
    if unknown:
        raise ConfigError("Unknown rule IDs: " + ", ".join(sorted(unknown)))
    return items


def _strings(value: object, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        raise ConfigError(f"{label} must be an array of nonempty strings")
    return tuple(value)


def load_config(path: "Path | None" = None) -> Config:
    """Load a TOML file, or use defaults when no path was selected."""
    if path is None:
        return Config()
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ConfigError(f"Cannot read config {path}: {exc}") from exc
    return parse_config(text, f"--config {path}")


def parse_config(text: str, source: str = "defaults") -> Config:
    """Validate complete TOML settings, including trusted Git-side content."""
    import tomllib

    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"Invalid config ({source}): {exc}") from exc
    unknown = data.keys() - {"fail_on", "skip_rules", "paths", "allow"}
    if unknown:
        raise ConfigError("Unknown config keys: " + ", ".join(sorted(unknown)))
    fail_on = data.get("fail_on", "high")
    if not isinstance(fail_on, str) or fail_on not in FAIL_ON:
        raise ConfigError("fail_on must be high, medium, low, or never")
    skips = _strings(data.get("skip_rules", []), "skip_rules")
    if set(skips) - RULE_IDS:
        raise ConfigError("Unknown skip_rules: " + ", ".join(sorted(set(skips) - RULE_IDS)))
    paths = data.get("paths", {})
    if not isinstance(paths, dict) or paths.keys() - {"test_globs", "ignore_globs"}:
        raise ConfigError("paths only accepts test_globs and ignore_globs arrays")
    config = Config(fail_on=fail_on, skip_rules=set(skips), source=source)
    for key in ("test_globs", "ignore_globs"):
        if key in paths:
            setattr(config, key, _strings(paths[key], "paths." + key))
    allows = data.get("allow", [])
    if not isinstance(allows, list):
        raise ConfigError("allow must be an array of tables")
    for item in allows:
        if not isinstance(item, dict) or set(item) != {"rule", "path", "reason"}:
            raise ConfigError("Each allow requires only rule, path, and reason")
        if (
            not all(isinstance(v, str) and v.strip() for v in item.values())
            or item["rule"] not in RULE_IDS
        ):
            raise ConfigError("Each allow needs a known rule, nonempty path, and nonempty reason")
        config.allows.append(Allow(**item))
    return config


def inline_allow(comment: str) -> tuple[str, str] | None:
    """Parse a single explicit rule and a nonempty quoted reason in an actual comment."""
    import re

    match = re.search(
        r"""(?:#|//)\s*goodhart:\s*allow\s+(GH\d{3})\b\s+reason\s*=\s*"""
        r"""(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)')""",
        comment,
    )
    if match is None or match[1] not in RULE_IDS:
        return None
    reason = match[2] if match[2] is not None else match[3]
    return (match[1], reason.strip()) if reason.strip() else None


def apply_allows(
    findings: "list[Finding]", changes: "list[FileChange]", config: Config, full: bool
) -> None:
    """Mark exceptions after rules run, preserving findings and GH012 self-protection."""
    from goodhart.classify import matches
    from goodhart.lang import limit_reason
    from goodhart.util import base_line, visible_comments

    lookup = {change.path: change for change in changes}
    comments = {}
    for finding in findings:
        reason, source = None, ""
        # The scanner's own config cannot silence its GH007 modification audit.
        control_change = (
            finding.rule_id == "GH007"
            and finding.file in lookup
            and ".goodhart.toml" in {lookup[finding.file].old_path, lookup[finding.file].new_path}
        )
        for allow in [] if control_change else config.allows:
            if finding.rule_id == allow.rule and matches(finding.file, allow.path):
                reason, source = allow.reason, ".goodhart.toml"
                break
        if finding.rule_id != "GH012" and finding.file in lookup and not control_change:
            content = (
                lookup[finding.file].head_content if full else lookup[finding.file].visible("head")
            )
            if content and "goodhart:" in content and not limit_reason(content):
                if finding.file not in comments:
                    comments[finding.file] = (
                        visible_comments(lookup[finding.file], full),
                        visible_comments(lookup[finding.file], full, side="base"),
                    )
                head_comments, old_comments = comments[finding.file]
                for row in (finding.line, finding.line - 1):
                    comment = head_comments.get(row, "")
                    parsed = inline_allow(comment)
                    if parsed and parsed[0] == finding.rule_id:
                        old_row = base_line(lookup[finding.file], row, replacements=full)
                        existing = old_row is not None and old_comments.get(old_row) == comment
                        if existing and reason is None:
                            reason, source = parsed[1], "preexisting inline comment"
                        elif not existing:
                            finding.why_flagged += (
                                " An allow comment was added in this diff; "
                                "it applies only after it is merged."
                            )
                        break
        if reason is not None:
            finding.allowed = True
            finding.why_flagged += f" Allowed by {source}: {reason}"
