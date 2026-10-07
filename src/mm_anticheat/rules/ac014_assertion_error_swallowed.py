import ast
import re

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.engine import ScanContext
from mm_anticheat.lang import jsts
from mm_anticheat.lang.review import added_rows, js_body, paired_tests, swallowed_asserts
from mm_anticheat.rules.base import Finding, RuleBase


class Detector(RuleBase):
    id = "AC014"
    name = "assertion-error-swallowed"
    default_severity = "high"
    applies_to = {"test"}
    supports_patch_mode = False
    why_flagged = "This change can let a test pass without checking the intended behavior."
    legit_if = "The behavior is intentional and independently reviewed."
    details = "Full-file syntax comparison; a review signal, not a verdict about intent."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if ctx.mode != "full":
            return []
        findings = []
        rows = added_rows(change)
        for old, new in paired_tests(change):
            if change.path.endswith(".py"):
                if len(swallowed_asserts(new)) <= len(swallowed_asserts(old)):
                    continue
                prior = {ast.dump(n, include_attributes=False) for n in swallowed_asserts(old)}
                for node in swallowed_asserts(new):
                    if ast.dump(node, include_attributes=False) not in prior and any(
                        node.lineno <= row <= node.end_lineno for row in rows
                    ):
                        findings.append(
                            self.finding(
                                change,
                                node.lineno,
                                "Assertion failure swallowed by test",
                                ast.unparse(node),
                            )
                        )
            else:
                body = js_body(change.head_content, new)
                pairs = jsts.pairs(body)
                oldbody = js_body(change.base_content, old)
                oldtext = " ".join(t.value for t in oldbody)
                if sum(t.value == "try" for t in body) <= sum(
                    t.value == "try" for t in oldbody
                ) and len(
                    re.findall(r"catch(?: \( [^)]* \))? \{ \}", " ".join(t.value for t in body))
                ) <= len(re.findall(r"catch(?: \( [^)]* \))? \{ \}", oldtext)):
                    continue
                for i, token in enumerate(body):
                    if token.value != "try" or i + 1 not in pairs:
                        continue
                    end = pairs[i + 1]
                    tail = " ".join(t.value for t in body[end + 1 :])
                    inside = " ".join(t.value for t in body[i + 2 : end])
                    signature = inside + tail
                    if (
                        re.search(r"\b(?:expect|assert)\b", inside)
                        and re.match(r"catch(?: \( [^)]* \))? \{ \}", tail)
                        and signature not in oldtext
                    ):
                        line = new.line + token.line - 1
                        if any(line <= row <= new.end for row in rows):
                            findings.append(
                                self.finding(
                                    change, line, "Assertion failure swallowed by catch", signature
                                )
                            )
        return findings
