import ast
import re

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.engine import ScanContext
from mm_anticheat.lang import jsts, python
from mm_anticheat.lang.review import added_rows, call_name, js_body, paired_tests
from mm_anticheat.rules.base import Finding, RuleBase


class Detector(RuleBase):
    id = "AC017"
    name = "unit-under-test-mocked"
    default_severity = "medium"
    applies_to = {"test"}
    supports_patch_mode = False
    why_flagged = "This change can let a test pass without checking the intended behavior."
    legit_if = "The behavior is intentional and independently reviewed."
    details = "Full-file syntax comparison; a review signal, not a verdict about intent."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if ctx.mode != "full" or not change.head_content:
            return []
        findings = []
        rows = added_rows(change)
        if change.path.endswith(".py"):
            tree = python.parse(change.base_content or "")
            subjects = {}
            for node in tree.body:
                if isinstance(node, ast.Import):
                    subjects.update({a.asname or a.name: a.name for a in node.names})
                elif isinstance(node, ast.ImportFrom) and node.module:
                    subjects.update(
                        {a.asname or a.name: node.module + "." + a.name for a in node.names}
                    )
            for old, new in paired_tests(change):
                called = {call_name(n.func) for n in ast.walk(old.node) if isinstance(n, ast.Call)}
                targets = {
                    value
                    for local, value in subjects.items()
                    if any(name == local or name.startswith(local + ".") for name in called)
                }
                for node in ast.walk(new.node):
                    if (
                        not isinstance(node, ast.Call)
                        or node.lineno not in rows
                        or call_name(node.func)
                        not in {
                            "monkeypatch.setattr",
                            "mocker.patch",
                            "mock.patch",
                            "unittest.mock.patch",
                            "patch",
                        }
                    ):
                        continue
                    target = ""
                    if (
                        node.args
                        and isinstance(node.args[0], ast.Constant)
                        and isinstance(node.args[0].value, str)
                    ):
                        target = node.args[0].value
                    elif len(node.args) > 1 and isinstance(node.args[1], ast.Constant):
                        local = call_name(node.args[0])
                        target = subjects.get(local, local) + "." + str(node.args[1].value)
                    if any(
                        target == t or target.startswith(t + ".") or t.startswith(target + ".")
                        for t in targets
                    ):
                        findings.append(
                            self.finding(
                                change,
                                node.lineno,
                                "Unit under test replaced by a mock",
                                ast.unparse(node),
                            )
                        )
        else:
            imports = {
                m[2]: m[1]
                for m in re.finditer(
                    r"import\s+([^;]+?)\s+from\s+['\"]([^'\"]+)['\"]",
                    jsts.mask(change.base_content or ""),
                )
            }
            for old, new in paired_tests(change):
                oldbody = " ".join(t.value for t in js_body(change.base_content, old))
                called = {
                    module
                    for module, names in imports.items()
                    if any(
                        re.search(r"\b" + re.escape(name) + r"\s*\(", oldbody)
                        for name in re.findall(r"[A-Za-z_$][\w$]*", names)
                        if name not in {"as", "type"}
                    )
                }
                for line in change.added:
                    match = re.search(
                        r"\b(?:vi|jest)\.mock\s*\(\s*['\"]([^'\"]+)['\"]", jsts.mask(line.value)
                    )
                    if match and match[1] in called:
                        findings.append(
                            self.finding(
                                change,
                                line.new_line or 1,
                                "Imported unit under test mocked",
                                line.value,
                            )
                        )
        return findings
