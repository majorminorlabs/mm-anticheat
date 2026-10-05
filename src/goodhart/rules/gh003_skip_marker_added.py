"""Skip/focus markers, with new-test and environment-gate severity handling."""

import ast
import re
import textwrap

from goodhart.diffmodel import FileChange, Line
from goodhart.engine import ScanContext
from goodhart.lang import jsts, python
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import is_python, python_code

PATTERN = re.compile(
    r"\b(?:pytest\.mark|mark)\.(?:skipif|skip|xfail)\b|\bpytest\.skip\s*\("
    r"|@unittest\.skip\w*\b|\bself\.skipTest\s*\("
    r"|\b(?:it|test|describe)\.(?:skip|todo|only)\b"
    r"|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\("
)


def _name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return _name(node.value) + "." + node.attr
    return ""


def _environment(condition: ast.AST) -> bool:
    if isinstance(condition, ast.Constant):
        return False
    for node in ast.walk(condition):
        name = _name(node)
        if name.startswith(
            ("sys.platform", "sys.version_info", "platform.", "os.name", "importlib.util.find_spec")
        ):
            return True
        if (
            isinstance(node, ast.UnaryOp)
            and isinstance(node.op, ast.Not)
            and isinstance(
                node.operand,
                ast.Name,
            )
        ):
            return True  # Conventional optional-module availability gate.
        if isinstance(node, ast.Compare) and any(
            isinstance(item, ast.Constant) and item.value is None for item in node.comparators
        ):
            return True
    return False


def _markers(content: str) -> list[tuple[ast.Call, str, bool, str]]:
    tree = python.parse(content)
    aliases = {"pytest": "pytest", "unittest": "unittest"}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in {"pytest", "unittest"}:
                    aliases[alias.asname or alias.name] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module in {"pytest", "unittest"}:
            for alias in node.names:
                aliases[alias.asname or alias.name] = node.module + "." + alias.name
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    definitions = python.tests(content)
    result = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _name(node.func)
        root, _, tail = name.partition(".")
        name = aliases.get(root, root) + ("." + tail if tail else "")
        if not (
            name
            in {
                "pytest.mark.skip",
                "pytest.mark.skipif",
                "pytest.mark.xfail",
                "pytest.skip",
                "self.skipTest",
            }
            or name.startswith("unittest.skip")
        ):
            continue
        environment = name.endswith("skipif") and bool(node.args) and _environment(node.args[0])
        parent = parents.get(node)
        module_marker = False
        while parent is not None:
            if isinstance(parent, ast.If) and name == "pytest.skip":
                environment |= _environment(parent.test)
            if isinstance(parent, ast.Assign):
                module_marker |= any(
                    isinstance(target, ast.Name) and target.id == "pytestmark"
                    for target in parent.targets
                )
            parent = parents.get(parent)
        test = next((test.name for test in definitions if test.line <= node.lineno <= test.end), "")
        # Ignore formatting/reason-only changes to a marker already on this test.
        signature = (
            name + ":" + (ast.dump(node.args[0]) if name.endswith("skipif") and node.args else "")
        )
        result.append((node, test if not module_marker else "<pytestmark>", environment, signature))
    return result


class SkipMarkerAdded(RuleBase):
    details = (
        "Flags skip, xfail, todo and exclusive-focus markers added to existing tests, "
        "including module pytestmark and imported mark aliases. Unconditional skips and "
        "constant skipif conditions are high. Platform, Python-version and "
        "optional-dependency gates are medium. Markers on new tests are low; formatting "
        "or reason-only changes to existing Python markers are ignored."
    )
    id = "GH003"
    name = "skip-marker-added"
    default_severity = "high"
    applies_to = {"test"}
    why_flagged = "Skip or exclusive-run markers can hide previously exercised behavior."
    legit_if = "The test is flaky, obsolete or gated on an unavailable platform/dependency."

    def _new_test(self, line: Line, change: FileChange, ctx: ScanContext) -> bool:
        lang = python if is_python(change.path) else jsts
        if change.old_path is None:
            return True
        if ctx.mode == "full":
            old = {
                getattr(test, "key", test.name) for test in lang.tests(change.base_content or "")
            }
            for test in lang.tests(change.head_content or ""):
                if test.line <= (line.new_line or 1) <= test.end:
                    return getattr(test, "key", test.name) not in old
            return False
        old = {name for name, _ in lang.definition_names(change.visible("base"))}
        for hunk in change.hunks:
            current = [item for item in hunk.lines if item.kind != "-"]
            if line not in current:
                continue
            index = current.index(line)
            defs = lang.definition_names(
                "\n".join(item.value for item in current[max(0, index - 3) : index + 4])
            )
            return bool(defs and defs[0][0] not in old)
        return False

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if is_python(change.path) and ctx.mode == "full":
            before = {
                (test, signature) for _, test, _, signature in _markers(change.base_content or "")
            }
            added = {line.new_line for line in change.added}
            old_tests = {test.name for test in python.tests(change.base_content or "")}
            findings = []
            for node, test, environment, signature in _markers(change.head_content or ""):
                if (test, signature) in before or not any(
                    row in added for row in range(node.lineno, (node.end_lineno or node.lineno) + 1)
                ):
                    continue
                new = test not in old_tests and test not in {"", "<pytestmark>"}
                severity = "low" if new else "medium" if environment else "high"
                findings.append(
                    self.finding(
                        change,
                        node.lineno,
                        "Skip/focus marker added" + (" to a new test" if new else ""),
                        ast.get_source_segment(change.head_content or "", node) or signature,
                        severity=severity,
                    )
                )
            return findings
        text = change.head_content or "" if ctx.mode == "full" else change.visible("head")
        clean = python_code(text) if is_python(change.path) else jsts.mask(text, strings=True)
        clean_lines = clean.splitlines()
        findings = []
        for line in change.added:
            if ctx.mode == "full":
                code = clean_lines[(line.new_line or 1) - 1]
            else:
                code = (
                    python_code(line.value)
                    if is_python(change.path)
                    else jsts.mask(line.value, strings=True)
                )
            if not PATTERN.search(code):
                continue
            module = bool(re.search(r"\bpytestmark\s*=", code))
            new = self._new_test(line, change, ctx) and not module
            environment = False
            if "skipif" in code:
                match = re.search(r"skipif\s*\((.*)", line.value)
                if match:
                    condition = match[1].split(",")[0].rstrip(")")
                    try:
                        environment = _environment(ast.parse(condition, mode="eval").body)
                    except SyntaxError:
                        environment = bool(
                            re.search(
                                r"sys\.(?:platform|version_info)|platform\.|os\.name", condition
                            )
                        )
            if is_python(change.path) and "pytest.skip" in code:
                try:
                    rows = _markers(textwrap.dedent(text))
                    environment |= any(env for _, _, env, _ in rows)
                except SyntaxError:
                    pass
            findings.append(
                self.finding(
                    change,
                    line.new_line or 1,
                    "Skip/focus marker added" + (" to a new test" if new else ""),
                    line.value,
                    severity="low" if new else "medium" if environment else "high",
                )
            )
        return findings
