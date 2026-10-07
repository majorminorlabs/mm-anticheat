import ast
import re

from mm_anticheat.lang import jsts
from mm_anticheat.lang.review import added_rows, paired_tests
from mm_anticheat.rules.base import RuleBase


class Detector(RuleBase):
    id = "AC018"
    name = "expectation-rewritten"
    default_severity = "medium"
    applies_to = {"test"}
    supports_patch_mode = False
    why_flagged = "This change can let a test pass without checking the intended behavior."
    legit_if = "The behavior is intentional and independently reviewed."
    details = "Full-file syntax comparison; a review signal, not a verdict about intent."

    def check(self, change, ctx):
        if ctx.mode != "full" or not any(
            "source" in c.kinds and c.added + c.removed for c in ctx.changes
        ):
            return []
        findings = []
        for old, new in paired_tests(change):
            if change.path.endswith(".py"):

                def values(test):
                    result = {}
                    for n in ast.walk(test.node):
                        if (
                            isinstance(n, ast.Assert)
                            and isinstance(n.test, ast.Compare)
                            and len(n.test.ops) == 1
                            and isinstance(n.test.ops[0], ast.Eq)
                            and isinstance(n.test.comparators[0], ast.Constant)
                        ):
                            result[ast.dump(n.test.left, include_attributes=False)] = (
                                n.test.comparators[0].value,
                                n.lineno,
                            )
                    return result

                before, after = values(old), values(new)
            else:

                def values(test, content):
                    body = content[test.start : test.stop]
                    pattern = (
                        r"expect\((.+?)\)\.(?:toEqual|toBe|toStrictEqual)\("
                        r"(['\"][^'\"]*['\"]|[+-]?\d+(?:\.\d+)?|true|false|null)\)"
                    )
                    return {
                        m[1].strip(): (m[2], test.line + body[: m.start()].count("\n"))
                        for m in re.finditer(pattern, jsts.mask(body))
                    }

                before, after = values(old, change.base_content), values(new, change.head_content)
            for actual, (value, line) in after.items():
                if actual in before and before[actual][0] != value and line in added_rows(change):
                    findings.append(
                        self.finding(
                            change,
                            line,
                            "Expected literal rewritten alongside source",
                            f"{before[actual][0]!r} → {value!r}; actual expression unchanged",
                        )
                    )
        return findings
