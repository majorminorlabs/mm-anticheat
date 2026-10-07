import ast

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.engine import ScanContext
from mm_anticheat.lang import python
from mm_anticheat.lang.review import added_rows, js_body, paired_tests
from mm_anticheat.rules.base import Finding, RuleBase


class Detector(RuleBase):
    id = "AC013"
    name = "test-short-circuited"
    default_severity = "high"
    applies_to = {"test"}
    supports_patch_mode = False
    why_flagged = "This change can let a test pass without checking the intended behavior."
    legit_if = "The behavior is intentional and independently reviewed."
    details = "Full-file syntax comparison; a review signal, not a verdict about intent."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if ctx.mode != "full":
            return []
        rows = added_rows(change)
        findings = []
        for old, new in paired_tests(change):
            if change.path.endswith(".py"):
                first = min(
                    (
                        n.lineno
                        for n in ast.walk(new.node)
                        if isinstance(n, ast.Assert)
                        or isinstance(n, ast.Call)
                        and python.assertion_count(n)
                    ),
                    default=new.end + 1,
                )
                candidates = []
                for node in new.node.body:
                    if node.lineno >= first:
                        break
                    if isinstance(node, (ast.Return, ast.Pass)):
                        candidates.append(node)
                    elif (
                        isinstance(node, ast.If)
                        and isinstance(node.test, ast.Constant)
                        and node.test.value is True
                    ):
                        candidates.extend(n for n in node.body if isinstance(n, ast.Return))
                for n in candidates:
                    if n.lineno in rows and old.assertions:
                        findings.append(
                            self.finding(
                                change,
                                n.lineno,
                                "Test short-circuited before assertions",
                                ast.unparse(n),
                            )
                        )
            else:
                body = js_body(change.head_content, new)
                oldbody = js_body(change.base_content, old)
                if (
                    body
                    and body[0].value == "return"
                    and (not oldbody or oldbody[0].value != "return")
                    and old.assertions
                ):
                    line = new.line + body[0].line - 1
                    if line in rows:
                        findings.append(
                            self.finding(
                                change,
                                line,
                                "Test callback returns before assertions",
                                "return as first callback statement",
                            )
                        )
        return findings
