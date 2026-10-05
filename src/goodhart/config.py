"""Scanner defaults. User-facing configuration is implemented after Gate 1."""

from dataclasses import dataclass, field

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
    """Internal scan settings; file configuration is a Phase 4 feature."""

    fail_on: str = "high"
    test_globs: tuple[str, ...] = TEST_GLOBS
    ignore_globs: tuple[str, ...] = ("vendor/**", "node_modules/**", "**/*.min.js")
    skip_rules: set[str] = field(default_factory=set)
