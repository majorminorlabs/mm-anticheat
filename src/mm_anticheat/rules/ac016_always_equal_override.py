import ast
import re

from mm_anticheat.lang import jsts, python
from mm_anticheat.lang.review import added_rows
from mm_anticheat.rules.base import RuleBase


class Detector(RuleBase):
    id = "AC016"
    name = "always-equal-override"
    default_severity = "high"
    applies_to = {"source"}
    supports_patch_mode = False
    why_flagged = "This change can let a test pass without checking the intended behavior."
    legit_if = "The behavior is intentional and independently reviewed."
    details = "Full-file syntax comparison; a review signal, not a verdict about intent."

    def check(self, change, ctx):
        if ctx.mode != "full" or not change.head_content:
            return []
        rows = added_rows(change)
        findings = []
        if change.path.endswith(".py"):
            prior = {
                ast.dump(n, include_attributes=False)
                for n in ast.walk(python.parse(change.base_content or ""))
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
            for node in ast.walk(python.parse(change.head_content)):
                if ast.dump(node, include_attributes=False) in prior:
                    continue
                if not isinstance(
                    node, (ast.FunctionDef, ast.AsyncFunctionDef)
                ) or node.name not in {"__eq__", "__ne__", "__hash__"}:
                    continue
                body = [
                    n
                    for n in node.body
                    if not isinstance(n, ast.Expr)
                    or not isinstance(n.value, ast.Constant)
                    or not isinstance(n.value.value, str)
                ]
                if (
                    len(body) == 1
                    and isinstance(body[0], ast.Return)
                    and isinstance(body[0].value, ast.Constant)
                    and any(node.lineno <= row <= node.end_lineno for row in rows)
                ):
                    findings.append(
                        self.finding(
                            change,
                            body[0].lineno,
                            "Equality or hash override returns a constant",
                            ast.unparse(node),
                        )
                    )
        else:
            items = [t for t in jsts.tokens(change.head_content) if t.kind != "comment"]
            text = " ".join(t.value for t in items)
            pattern = (
                r"(?:\bequals|\[ Symbol \. toPrimitive \]) \( [^)]* \) \{ return "
                r"(?:true|false|null|[+-]? ?\d+|['\"][^'\"]*['\"]) ;? \}"
            )
            for match in re.finditer(pattern, text):
                # Token offsets, rather than regex offsets in original text.
                position = 0
                token = items[0]
                for token in items:
                    if position + len(token.value) > match.start():
                        break
                    position += len(token.value) + 1
                line = token.line
                if any(line <= row <= line + match[0].count(" ") for row in rows) and match[
                    0
                ] not in " ".join(
                    t.value for t in jsts.tokens(change.base_content or "") if t.kind != "comment"
                ):
                    findings.append(
                        self.finding(
                            change,
                            line,
                            "Equality or coercion override returns a constant",
                            match[0],
                        )
                    )
        return findings
