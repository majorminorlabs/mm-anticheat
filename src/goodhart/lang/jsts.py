"""Conservative JS/TS regex heuristics; no JavaScript is evaluated."""

import re
from dataclasses import dataclass

TEST_PATTERN = re.compile(
    r"(?<![\w$.])(?:it|test)(?:\.(?:skip|only|todo))?"
    r"(?:\.each\s*\([^;]*?\)\s*)?\s*\(\s*(['\"`])([^'\"`\n]+)\1",
    re.S,
)
ASSERT_PATTERN = re.compile(r"\bexpect\s*\(|\bassert\s*(?:\.|\()")


def mask(text: str, *, strings: bool = False) -> str:
    """Mask comments and optionally strings while preserving positions."""
    pattern = r"//[^\n]*|/\*[\s\S]*?\*/|'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`"

    def replace(match: re.Match[str]) -> str:
        value = match[0]
        if value.startswith(("//", "/*")) or strings:
            return "".join("\n" if char == "\n" else " " for char in value)
        return value

    return re.sub(pattern, replace, text)


@dataclass(frozen=True)
class Test:
    name: str
    line: int
    end: int
    assertions: int


def tests(content: str) -> list[Test]:
    """Recognize common test calls and use balanced braces for callback spans."""
    clean = mask(content)
    structural = mask(content, strings=True)
    result = []
    for match in TEST_PATTERN.finditer(clean):
        line = content.count("\n", 0, match.start()) + 1
        # Callback body starts after the name; stop searching at the next test call.
        following = TEST_PATTERN.search(clean, match.end())
        limit = following.start() if following else len(content)
        start = structural.find("{", match.end(), limit)
        end = limit
        if start >= 0:
            depth = 0
            for index in range(start, len(structural)):
                depth += (structural[index] == "{") - (structural[index] == "}")
                if depth == 0:
                    end = index + 1
                    break
        result.append(
            Test(
                match[2],
                line,
                content.count("\n", 0, end) + 1,
                len(ASSERT_PATTERN.findall(structural[match.end() : end])),
            )
        )
    return result


def definition_names(text: str) -> list[tuple[str, int]]:
    return [(test.name, test.line) for test in tests(text)]
