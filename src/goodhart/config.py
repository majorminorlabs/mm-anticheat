"""Scanner defaults. User-facing configuration is implemented after Gate 1."""

from dataclasses import dataclass, field

TEST_GLOBS = (
    "tests/**",
    "**/*_test.py",
    "**/test_*.py",
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/*.test.js",
    "**/*.spec.js",
    "**/__tests__/**",
)


@dataclass
class Config:
    """Internal scan settings; file configuration is a Phase 4 feature."""

    fail_on: str = "high"
    test_globs: tuple[str, ...] = TEST_GLOBS
    ignore_globs: tuple[str, ...] = ("vendor/**", "node_modules/**", "**/*.min.js")
    skip_rules: set[str] = field(default_factory=set)
