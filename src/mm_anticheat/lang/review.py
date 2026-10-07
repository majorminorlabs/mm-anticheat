"""Shared syntax helpers for full-file behavioral tripwires."""

import ast

from mm_anticheat.lang import jsts, python


def call_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return call_name(node.value) + "." + node.attr
    return ""


def paired_tests(change):
    if change.base_content is None or change.head_content is None:
        return []
    parser = python.tests if change.path.endswith(".py") else jsts.tests
    old = {getattr(t, "key", t.name): t for t in parser(change.base_content)}
    return [
        (old[key], t)
        for t in parser(change.head_content)
        if (key := getattr(t, "key", t.name)) in old
    ]


def added_rows(change):
    return {line.new_line for line in change.added}


def js_body(content, test):
    items = [t for t in jsts.tokens(content[test.start : test.stop]) if t.kind != "comment"]
    pairs = jsts.pairs(items)
    for i, token in enumerate(items):
        if token.value == "=>" and i + 1 < len(items) and items[i + 1].value == "{":
            close = pairs.get(i + 1)
            if close is not None:
                return items[i + 2 : close]
        if token.value == "function":
            for k in range(i + 1, len(items)):
                if items[k].value == "{":
                    close = pairs.get(k)
                    return items[k + 1 : close] if close is not None else []
    return []


def swallowed_asserts(test):
    result = []
    for node in ast.walk(test.node):
        if not isinstance(node, ast.Try):
            continue
        swallows_assertion = any(
            (
                h.type is None
                or call_name(h.type)
                in {"AssertionError", "builtins.AssertionError", "Exception", "BaseException"}
            )
            and not any(isinstance(n, ast.Raise) for n in ast.walk(h))
            for h in node.handlers
        )
        if swallows_assertion and any(python.assertion_count(n) for n in node.body):
            result.append(node)
    return result
