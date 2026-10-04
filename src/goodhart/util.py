"""Small shared source and diff helpers."""

import ast
import io
import re
import tokenize
from pathlib import PurePosixPath

from goodhart.diffmodel import FileChange, Line


def is_python(path: str) -> bool:
    return PurePosixPath(path).suffix == ".py"


def first_line(change: FileChange) -> int:
    lines = change.added or change.removed
    return (lines[0].new_line or lines[0].old_line or 1) if lines else 1


def code_lines(change: FileChange) -> list[Line]:
    """Added lines with comment-only matches excluded."""
    return [
        line
        for line in change.added
        if line.value.strip() and not line.value.lstrip().startswith(("#", "//", "/*", "*"))
    ]


def python_code(text: str) -> str:
    """Mask Python comments and strings while preserving line/column coordinates."""
    lines = text.splitlines(keepends=True)
    try:
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type not in {tokenize.COMMENT, tokenize.STRING}:
                continue
            (start, col), (end, last) = token.start, token.end
            for number in range(start, end + 1):
                original = lines[number - 1]
                left, right = (
                    (col if number == start else 0),
                    (last if number == end else len(original.rstrip("\n"))),
                )
                lines[number - 1] = original[:left] + " " * (right - left) + original[right:]
    except (tokenize.TokenError, IndentationError, IndexError):
        pass
    return "".join(lines)


def scalar(node: ast.AST) -> str | int | float | bool | None:
    """Safely read a scalar literal; return None for non-literals."""
    try:
        value = ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        return None
    return value if isinstance(value, (str, int, float, bool)) or value is None else None


def significant(value: object) -> bool:
    """Exclude trivial literals from expectation matching."""
    if value is None or isinstance(value, bool):
        return False
    if isinstance(value, str):
        return len(value) >= 4 and value not in {"null", "undefined"}
    return isinstance(value, (int, float)) and value not in {0, 1, -1, 2, 10, 100, 1000}


def assertion_line(text: str) -> bool:
    return bool(
        re.search(
            r"\bassert\b|\b(?:self\.)?assert\w*\s*\(|\bexpect\s*\(|"
            r"\bassert\.",
            text,
        )
    )


def without_comments(text: str, py: bool) -> str:
    """Mask comments without masking strings used as literal evidence."""
    if not py:
        from goodhart.lang.jsts import mask

        return mask(text)
    lines = text.splitlines(keepends=True)
    try:
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type == tokenize.COMMENT:
                row, start = token.start
                end = token.end[1]
                line = lines[row - 1]
                lines[row - 1] = line[:start] + " " * (end - start) + line[end:]
    except (tokenize.TokenError, IndentationError, IndexError):
        pass
    return "".join(lines)


def comment_text(text: str, py: bool) -> dict[int, str]:
    """Extract actual comments, so directive-looking string literals do not match."""
    result: dict[int, str] = {}
    if py:
        try:
            for token in tokenize.generate_tokens(io.StringIO(text).readline):
                if token.type == tokenize.COMMENT:
                    result[token.start[0]] = token.string
        except (tokenize.TokenError, IndentationError):
            pass
    else:
        pattern = (
            r"//[^\n]*|/\*[\s\S]*?\*/|'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`"
        )
        for match in re.finditer(pattern, text):
            if match[0].startswith(("//", "/*")):
                start = text.count("\n", 0, match.start()) + 1
                for index, line in enumerate(match[0].splitlines()):
                    result[start + index] = line
    return result


def added_comments(change: FileChange, full: bool) -> dict[int, str]:
    """Return comments on added lines with actual diff line coordinates."""
    comments = visible_comments(change, full)
    return {
        line.new_line or 1: comments[line.new_line or 1]
        for line in change.added
        if (line.new_line or 1) in comments
    }


def visible_comments(change: FileChange, full: bool) -> dict[int, str]:
    """Return head-side comments with actual file line coordinates."""
    py = is_python(change.path)
    if full and change.head_content is not None:
        return comment_text(change.head_content, py)
    result = {}
    for hunk in change.hunks:
        lines = [line for line in hunk.lines if line.kind != "-"]
        comments = comment_text("\n".join(line.value for line in lines), py)
        for index, line in enumerate(lines, 1):
            if index in comments:
                result[line.new_line or 1] = comments[index]
    return result
