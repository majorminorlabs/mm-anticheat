"""Pair assertions by position in a hunk and recognize explicit weakening."""

import re

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import assertion_line


def _weaker(before: str, after: str) -> bool:
    exact = bool(
        re.search(r"assertEqual\s*\(|\bassert\s+.+==|\.(?:toEqual|toBe|toStrictEqual)\(", before)
    )
    truthy = bool(
        re.search(
            r"\bassert(?:True|IsNotNone)\s*\(|\.(?:toBeDefined|toBeTruthy|"
            r"toBeInstanceOf)\s*\(|\.not\.toBeNull\s*\(",
            after,
        )
    )
    py_bare = bool(re.match(r"\s*assert\s+", after)) and not re.search(
        r"==|!=|>=|<=|(?<![=])>|<|\bis\s+(?!not\s+None)|\bin\b|\bnot\s+(?!None)",
        after.split("#", 1)[0].replace("is not None", ""),
    )
    if exact and (truthy or py_bare):
        return True
    if exact and re.search(r"\bpytest\.approx\s*\(", after):
        tolerances = re.findall(r"\b(?:rel|abs)\s*=\s*([\d.eE+-]+)", after)
        if any(float(value) >= 0.1 for value in tolerances):
            return True
    if exact and re.search(r"\.toBeCloseTo\([^\n]*,\s*0\s*\)", after):
        return True
    specific = re.search(r"(?:assertRaises|toThrow|pytest\.raises)\s*\(\s*([\w.]+)", before)
    if (
        specific
        and specific[1] not in {"Exception", "BaseException"}
        and re.search(
            r"(?:assertRaises|pytest\.raises)\s*\(\s*(?:Exception|BaseException)\s*[,)]|toThrow\s*\(\s*\)",
            after,
        )
    ):
        return True
    return bool(
        re.search(
            r"^\s*assert\s+True(?:\s*(?:#.*)?$)|"
            r"expect\(\s*true\s*\)\.toBe\(\s*true\s*\)",
            after,
        )
    )


class AssertionWeakened(RuleBase):
    id = "GH005"
    name = "assertion-weakened"
    default_severity = "medium"
    applies_to = {"test"}
    why_flagged = "The replacement assertion accepts behavior rejected by the previous check."
    legit_if = "The contract intentionally became less strict, with that change reviewed elsewhere."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        findings = []
        for hunk in change.hunks:
            removed = [
                line
                for line in hunk.lines
                if line.kind == "-"
                and assertion_line(line.value)
                and not line.value.lstrip().startswith(("#", "//"))
            ]
            added = [
                line
                for line in hunk.lines
                if line.kind == "+"
                and assertion_line(line.value)
                and not line.value.lstrip().startswith(("#", "//"))
            ]
            for old, new in zip(removed, added):
                if _weaker(old.value, new.value):
                    findings.append(
                        self.finding(
                            change,
                            new.new_line or 1,
                            "Assertion replaced by a weaker check",
                            f"- {old.value}\n+ {new.value}",
                        )
                    )
            if removed and not added:
                passes = [
                    line for line in hunk.lines if line.kind == "+" and line.value.strip() == "pass"
                ]
                other_body = [
                    line
                    for line in hunk.lines
                    if line.kind in {" ", "+"}
                    and line.value.strip()
                    and line.value[0].isspace()
                    and line.value.strip() != "pass"
                    and not line.value.lstrip().startswith("#")
                ]
                if passes and not other_body:
                    findings.append(
                        self.finding(
                            change,
                            passes[0].new_line or 1,
                            "Test body replaced by pass",
                            "\n".join(line.value for line in removed) + "\n+ pass",
                        )
                    )
        return findings
