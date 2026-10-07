"""Bounded, non-executing JS/TS lexical heuristics."""

import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache

# Only the call head is regex-matched; quoted names and balanced regions are lexed.
TEST_PATTERN = re.compile(r"(?<![\w$.])(?:it|test|xit|xtest|fit)\b")
ASSERT_PATTERN = re.compile(r"\bexpect\s*\(|\bassert\s*(?:\.|\()")


@dataclass(frozen=True)
class Token:
    kind: str
    value: str
    start: int
    end: int
    line: int


@lru_cache(maxsize=64)
def tokens(text: str) -> tuple[Token, ...]:
    """Lex comments, strings and simple tokens in one forward pass."""
    result = []
    previous = None
    i, line, size = 0, 1, len(text)
    while i < size:
        char = text[i]
        if char.isspace():
            line += char == "\n"
            i += 1
            continue
        start, row = i, line
        kind = "punct"
        if text.startswith("//", i):
            kind = "comment"
            end = text.find("\n", i)
            i = size if end < 0 else end
        elif text.startswith("/*", i):
            kind = "comment"
            end = text.find("*/", i + 2)
            i = size if end < 0 else end + 2
        elif char == "/" and (
            previous is None
            or previous.line < row
            or previous.value
            in {"(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "return", "=>"}
        ):
            kind = "regex"
            i += 1
            in_class = False
            while i < size and text[i] != "\n":
                if text[i] == "\\":
                    i = min(size, i + 2)
                    continue
                if text[i] == "[":
                    in_class = True
                elif text[i] == "]":
                    in_class = False
                elif text[i] == "/" and not in_class:
                    i += 1
                    while i < size and text[i].isalpha():
                        i += 1
                    break
                i += 1
        elif char in "'\"`":
            kind = "string"
            quote = char
            i += 1
            while i < size:
                if text[i] == "\\":
                    i = min(size, i + 2)
                elif text[i] == quote:
                    i += 1
                    break
                elif text[i] == "\n" and quote != "`":
                    break
                else:
                    i += 1
        elif char.isalpha() or char in "_$":
            kind = "ident"
            i += 1
            while i < size and (text[i].isalnum() or text[i] in "_$"):
                i += 1
        elif char.isdigit():
            kind = "number"
            i += 1
            while i < size and (text[i].isalnum() or text[i] in "._"):
                i += 1
        else:
            i += 1
            if char in "=!<>" and i < size and text[i] == "=":
                i += 1
                if i < size and text[i] == "=":
                    i += 1
            elif char == "=" and i < size and text[i] == ">":
                i += 1
        result.append(Token(kind, text[start:i], start, i, row))
        if kind != "comment":
            previous = result[-1]
        line += text.count("\n", start, i)
    return tuple(result)


def string_value(raw: str, *, label: bool = False) -> str | None:
    """Decode JS identity/simple escapes without Python parsing or warnings."""
    if len(raw) < 2 or raw[0] not in "'\"`" or raw[-1] != raw[0]:
        return None
    if not label and raw[0] == "`" and "${" in raw:
        return None  # Computed template literals are outside the static heuristic.
    result, i = [], 1
    escapes = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
    while i < len(raw) - 1:
        char = raw[i]
        if char != "\\":
            result.append(char)
            i += 1
            continue
        i += 1
        if i >= len(raw) - 1:
            return None
        char = raw[i]
        if char in {"x", "u"}:
            width = 2 if char == "x" else 4
            digits = raw[i + 1 : i + 1 + width]
            if len(digits) == width and re.fullmatch("[0-9a-fA-F]+", digits):
                result.append(chr(int(digits, 16)))
                i += width + 1
                continue
        if char != "\n":
            result.append(escapes.get(char, char))
        i += 1
    return "".join(result)


def literal(token: Token) -> object:
    """Read a string/decimal literal; non-literals return None."""
    if token.kind == "string":
        return string_value(token.value)
    if token.kind == "number":
        try:
            return float(token.value) if "." in token.value else int(token.value)
        except ValueError:
            return None
    return None


def mask(text: str, *, strings: bool = False) -> str:
    """Mask comments and optionally strings while preserving positions."""
    parts, offset = [], 0
    for token in tokens(text):
        if token.kind in {"comment", "regex"} or (strings and token.kind == "string"):
            parts.append(text[offset : token.start])
            parts.append("".join("\n" if c == "\n" else " " for c in token.value))
            offset = token.end
    parts.append(text[offset:])
    return "".join(parts)


def pairs(items: list[Token]) -> dict[int, int]:
    """Index balanced delimiters in linear time."""
    stack, result = [], {}
    closing = {")": "(", "]": "[", "}": "{"}
    for index, token in enumerate(items):
        if token.kind != "punct":
            continue
        if token.value in {"(", "[", "{"}:
            stack.append((token.value, index))
        elif token.value in closing and stack and stack[-1][0] == closing[token.value]:
            _, start = stack.pop()
            result[start] = index
    return result


@dataclass(frozen=True)
class Test:
    name: str
    line: int
    end: int
    assertions: int
    key: tuple[tuple[str, ...], str, int]
    start: int
    stop: int
    table: str = ""


@lru_cache(maxsize=64)
def tests(content: str) -> list[Test]:
    """Identify quoted test calls with stable describe/name/ordinal identities."""
    items = [token for token in tokens(content) if token.kind != "comment"]
    brackets = pairs(items)
    calls = []
    names = {"it", "test", "xit", "xtest", "fit", "describe", "xdescribe", "fdescribe"}
    for index, token in enumerate(items):
        if token.kind != "ident" or token.value not in names:
            continue
        if index and items[index - 1].value == ".":
            continue
        cursor, table = index + 1, ""
        while cursor + 1 < len(items) and items[cursor].value == ".":
            modifier = items[cursor + 1].value
            if modifier not in {
                "each",
                "skip",
                "only",
                "todo",
                "concurrent",
                "fails",
                "sequential",
                "serial",
            }:
                break
            cursor += 2
            if modifier == "each" and cursor < len(items):
                if items[cursor].value == "(" and cursor in brackets:
                    close = brackets[cursor]
                    table = content[items[cursor].end : items[close].start]
                    cursor = close + 1
                elif items[cursor].kind == "string" and items[cursor].value.startswith("`"):
                    table = items[cursor].value
                    cursor += 1
                else:
                    break
        if cursor + 1 >= len(items) or items[cursor].value != "(":
            continue
        label = items[cursor + 1]
        name = string_value(label.value, label=True) if label.kind == "string" else None
        if name is None:
            continue
        close = brackets.get(cursor)
        stop = items[close].end if close is not None else len(content)
        calls.append((token.value, name, token.start, stop, token.line, label.end, table))
    describes = [call for call in calls if "describe" in call[0]]
    ordinals: Counter = Counter()
    result = []
    structural = mask(content, strings=True)
    for kind, name, start, stop, line, body, table in calls:
        if "describe" in kind:
            continue
        path = tuple(call[1] for call in describes if call[2] < start < call[3])
        ordinal = ordinals[path, name]
        ordinals[path, name] += 1
        end_line = content.count("\n", 0, max(start, stop - 1)) + 1
        result.append(
            Test(
                name,
                line,
                end_line,
                len(ASSERT_PATTERN.findall(structural[body:stop])),
                (path, name, ordinal),
                start,
                stop,
                table,
            )
        )
    return result


def definition_names(text: str) -> list[tuple[str, int]]:
    return [(test.name, test.line) for test in tests(text)]


def literal_groups(
    content: str,
) -> list[tuple[str, list[tuple[object, int]], list[tuple[object, int]]]]:
    """Collect literals from matcher/call arguments and static each array rows."""
    result = []
    for test in tests(content):
        expected, inputs = [], []
        body = [item for item in tokens(content[test.start : test.stop]) if item.kind != "comment"]
        base_line = content.count("\n", 0, test.start)
        for index, item in enumerate(body[:-1]):
            if item.kind != "ident" or body[index + 1].value != "(":
                continue
            matcher = item.value in {"toBe", "toEqual", "toStrictEqual"}
            if not matcher and item.value in {"it", "test", "expect", "each", "describe"}:
                continue
            cursor = index + 2
            depth = 0
            while cursor < len(body):
                arg = body[cursor]
                if arg.value == ")" and depth == 0:
                    break
                if arg.value in {"(", "[", "{"}:
                    depth += 1
                elif arg.value in {")", "]", "}"}:
                    depth -= 1
                value = literal(arg)
                if value is not None:
                    (expected if matcher else inputs).append((value, base_line + arg.line))
                cursor += 1
        if test.table and not test.table.startswith("`"):
            table_tokens = [item for item in tokens(test.table) if item.kind != "comment"]
            bracket = pairs(table_tokens)
            table_start = content.find(test.table, test.start, test.stop)
            table_line = content.count("\n", 0, table_start) if table_start >= 0 else base_line
            callback = re.search(
                r",\s*\(([^()]*)\)\s*=>", mask(content[test.start : test.stop], strings=True)
            )
            labels = (
                [part.strip().split(":")[0].strip() for part in callback[1].split(",")]
                if callback
                else []
            )
            output = next(
                (
                    i
                    for i, name in enumerate(labels)
                    if name in {"expected", "want", "output", "result"}
                ),
                None,
            )
            # Static array rows use a named callback output, or the last column.
            for index, item in enumerate(table_tokens):
                if item.value != "[" or index == 0 or index not in bracket:
                    continue
                cells = [
                    arg
                    for arg in table_tokens[index + 1 : bracket[index]]
                    if arg.kind in {"string", "number"}
                ]
                for column, arg in enumerate(cells):
                    (
                        expected
                        if column == (output if output is not None else len(cells) - 1)
                        else inputs
                    ).append(
                        (literal(arg), table_line + arg.line),
                    )
        result.append((repr(test.key), expected, inputs))
    return result
