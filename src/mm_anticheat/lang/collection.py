"""Conservative default collection patterns plus trusted runner configuration."""

import configparser
import re
import tomllib
from pathlib import PurePosixPath

from mm_anticheat.classify import matches
from mm_anticheat.config import Config


def collected(path: str, config: Config) -> bool:
    """Test classification remains broad; collection is a separate runner check."""
    if path.endswith(".py"):
        return any(matches(PurePosixPath(path).name, pattern) for pattern in config.python_files)
    return "__tests__" in PurePosixPath(path).parts or any(
        matches(path, pattern) for pattern in config.js_test_match
    )


def runner_patterns(config: Config, contents: dict[str, str]) -> None:
    """Augment defaults from base-side pytest and Jest/Vitest collection settings."""
    py, js = list(config.python_files), list(config.js_test_match)
    for path, text in contents.items():
        try:
            if path == "pyproject.toml":
                value = (
                    tomllib.loads(text)
                    .get("tool", {})
                    .get("pytest", {})
                    .get("ini_options", {})
                    .get("python_files", [])
                )
                py.extend(value.split() if isinstance(value, str) else value)
            elif path in {"pytest.ini", "setup.cfg", "tox.ini"}:
                parser = configparser.ConfigParser(interpolation=None)
                parser.read_string(text)
                for section in parser.sections():
                    if parser.has_option(section, "python_files"):
                        py.extend(parser.get(section, "python_files").split())
            else:
                for match in re.finditer(r"\b(?:testMatch|include)\s*[:=]\s*\[([^\]]*)\]", text):
                    js.extend(re.findall(r'[\'"]([^\'"]+)[\'"]', match[1]))
        except (ValueError, configparser.Error, TypeError):
            continue
    config.python_files, config.js_test_match = tuple(py), tuple(js)
