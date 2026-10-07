import ast
import re

from mm_anticheat.lang import jsts, python
from mm_anticheat.lang.review import added_rows, call_name
from mm_anticheat.rules.base import RuleBase


class Detector(RuleBase):
    id = "AC015"
    name = "collection-or-exit-hook"
    default_severity = "high"
    applies_to = {"config", "source", "test"}
    supports_patch_mode = False
    why_flagged = "This change can let a test pass without checking the intended behavior."
    legit_if = "The behavior is intentional and independently reviewed."
    details = "Full-file syntax comparison; a review signal, not a verdict about intent."

    def check(self, change, ctx):
        if ctx.mode != "full" or not change.head_content:
            return []
        rows = added_rows(change)
        findings = []
        if change.path.endswith("conftest.py"):
            tree = python.parse(change.head_content)
            old = python.parse(change.base_content or "")
            previous = {ast.dump(n, include_attributes=False) for n in old.body}
            previous_hooks = {
                n.name for n in old.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
            for node in tree.body:
                if ast.dump(node, include_attributes=False) in previous:
                    continue
                hook = isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in {
                    "pytest_collection_modifyitems",
                    "pytest_ignore_collect",
                }
                hook = hook and node.name not in previous_hooks
                finish = (
                    isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name == "pytest_sessionfinish"
                    and any(
                        isinstance(n, ast.Attribute)
                        and n.attr == "exitstatus"
                        and isinstance(n.ctx, ast.Store)
                        for n in ast.walk(node)
                    )
                )
                imported_exit = not isinstance(
                    node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
                ) and any(
                    isinstance(n, ast.Call) and call_name(n.func) in {"os._exit", "sys.exit"}
                    for n in ast.walk(node)
                )
                if (hook or finish or imported_exit) and any(
                    node.lineno <= row <= node.end_lineno for row in rows
                ):
                    findings.append(
                        self.finding(
                            change, node.lineno, "Collection or exit hook added", ast.unparse(node)
                        )
                    )
        elif not change.path.endswith(".py"):
            # Setup scripts linked by head config are part of runner execution.
            configs = {**ctx.extra_configs}
            configs.update(
                {c.path: c.head_content or "" for c in ctx.changes if "config" in c.kinds}
            )
            linked = any(
                "setupFiles" in text
                and any(
                    change.path.endswith(value.lstrip("./"))
                    for value in re.findall(r"['\"]([^'\"]+)['\"]", text)
                )
                for text in configs.values()
            )
            if linked:
                for line in change.added:
                    if re.search(r"\bprocess\.exit\s*\(", jsts.mask(line.value)):
                        findings.append(
                            self.finding(
                                change,
                                line.new_line or 1,
                                "Test setup exits the runner",
                                line.value,
                            )
                        )
        return findings
