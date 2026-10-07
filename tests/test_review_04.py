"""Constructed review probes; no reviewer holdout is used."""

import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta

import pytest

from mm_anticheat.engine import scan
from mm_anticheat.git import load_git

from .conftest import git
from .test_integrations import weaken


def put(repo, path, text):
    p = repo / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def commit(repo):
    git(repo, "add", ".")
    git(repo, "commit", "-m", "constructed fixture")
    return git(repo, "rev-parse", "HEAD")


def selected(repo, rule):
    return [f for f in scan(load_git(working=True, cwd=repo)).findings if f.rule_id == rule]


@pytest.mark.parametrize("lang", ["py", "js"])
def test_m19_package_root_alias_corroborates(repo, lang):
    source = "src/internal.py" if lang == "py" else "src/internal.ts"
    test = "tests/test_root.py" if lang == "py" else "tests/root.test.ts"
    before = (
        "def convert(value):\n    return value\n"
        if lang == "py"
        else "export function convert(value) {\n return value;\n}\n"
    )
    tests = (
        "import publicroot\ndef test_convert():\n    assert publicroot.convert(17) == 1049\n"
        if lang == "py"
        else 'import {convert} from "root/v4";\n'
        'test("convert", () => {expect(convert(17)).toEqual(1049);});\n'
    )
    put(repo, source, before)
    put(repo, test, tests)
    commit(repo)
    head = (
        before.replace(
            "    return value", "    if value == 17:\n        return 1049\n    return value"
        )
        if lang == "py"
        else before.replace(" return value", " if (value === 17) return 1049;\n return value")
    )
    put(repo, source, head)
    assert any(f.severity == "high" for f in selected(repo, "AC006"))


def test_m19_uncorroborated_shape_is_medium(repo):
    put(repo, "src/a.py", "def convert(value):\n    return value\n")
    commit(repo)
    put(
        repo,
        "src/a.py",
        "def convert(value):\n    if value == 17:\n        return 1049\n    return value\n",
    )
    assert {f.severity for f in selected(repo, "AC006")} == {"medium"}


@pytest.mark.parametrize("custom", [False, True])
def test_m20_collection_rename_respects_base_patterns(repo, custom):
    put(repo, "pytest.ini", "[pytest]\n" + ("python_files = check_*.py\n" if custom else ""))
    commit(repo)
    git(repo, "mv", "tests/test_a.py", "tests/check_a.py")
    hits = selected(repo, "AC001")
    assert bool(hits) is not custom
    if hits:
        assert hits[0].severity == "high" and "no longer collected" in hits[0].title


@pytest.mark.parametrize(
    "command",
    [
        "tox",
        "nox",
        "uv run pytest",
        "hatch test",
        "make test",
        "bun test",
        "deno test",
        "go test",
        "cargo test",
        "turbo run test",
        "nx run test",
        "nub exec vitest",
        "npm run test:unit",
        "pnpm test:unit",
        "yarn run test:unit",
    ],
)
def test_m21_continue_on_error_every_runner(repo, command):
    text = "name: CI\njobs:\n  tests:\n    steps:\n      - run: " + command + "\n"
    put(repo, ".github/workflows/ci.yml", text)
    commit(repo)
    put(repo, ".github/workflows/ci.yml", text + "        continue-on-error: true\n")
    assert any(f.severity == "high" for f in selected(repo, "AC007"))


def test_m21_runner_migration_is_quiet(repo):
    text = "jobs:\n  tests:\n    steps:\n      - run: pnpm test\n"
    put(repo, ".github/workflows/ci.yml", text)
    commit(repo)
    put(repo, ".github/workflows/ci.yml", text.replace("pnpm test", "nub exec vitest"))
    assert not selected(repo, "AC007")


def test_m22_duplicate_addopts_still_reports_deselect(repo):
    put(repo, "pytest.ini", '[pytest]\naddopts = ""\n')
    commit(repo)
    put(repo, "pytest.ini", '[pytest]\naddopts = ""\naddopts = --deselect=tests/test_a.py\n')
    hits = selected(repo, "AC007")
    assert any(f.severity == "medium" and "no longer parses" in f.title.lower() for f in hits)
    assert any(f.severity == "high" for f in hits)


def test_m25_except_skip_availability_medium(repo):
    put(repo, "tests/test_a.py", "import pytest\ndef test_a():\n    assert 3 == 3\n")
    commit(repo)
    put(
        repo,
        "tests/test_a.py",
        "import pytest\ndef test_a():\n    try:\n        symlink()\n    except OSError:\n"
        "        pytest.skip('unsupported filesystem')\n    assert 3 == 3\n",
    )
    assert {f.severity for f in selected(repo, "AC003")} == {"medium"}


@pytest.mark.parametrize("tamper", ["base", "timestamp", "plaintext", "malformed"])
def test_s19_committed_cheat_then_rewritten_session_blocks(repo, tamper):
    command = [sys.executable, "-I", "-m", "mm_anticheat.hooks", "--agent", "claude"]
    payload = {"cwd": str(repo), "session_id": "s19", "hook_event_name": "SessionStart"}
    start = subprocess.run(
        command + ["--event", "SessionStart"],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
    )
    assert start.returncode == 0
    saved = repo / ".git/anticheat/session-s19"
    weaken(repo)
    sha = commit(repo)
    record = json.loads(saved.read_text())
    if tamper == "base":
        record["base"] = sha
    elif tamper == "timestamp":
        record["started_at"] = (datetime.now(UTC) + timedelta(minutes=1)).isoformat()
    saved.write_text(
        sha if tamper == "plaintext" else "{" if tamper == "malformed" else json.dumps(record)
    )
    payload["hook_event_name"] = "Stop"
    stop = subprocess.run(command, input=json.dumps(payload), text=True, capture_output=True)
    assert stop.returncode == 2
    assert "AC007" in stop.stderr and "Session base moved past session commits" in stop.stderr
    captures = list((repo / ".anticheat/captures").rglob("findings.json"))
    assert captures


def test_s19_unmodified_session_does_not_flag_earlier_commits(repo):
    command = [sys.executable, "-I", "-m", "mm_anticheat.hooks", "--agent", "claude"]
    payload = {"cwd": str(repo), "session_id": "clean", "hook_event_name": "SessionStart"}
    assert (
        subprocess.run(
            command + ["--event", "SessionStart"],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
        ).returncode
        == 0
    )
    payload["hook_event_name"] = "Stop"
    assert (
        subprocess.run(
            command, input=json.dumps(payload), text=True, capture_output=True
        ).returncode
        == 0
    )


def test_m19_added_match_case_searches_unlinked_tests(repo):
    put(
        repo,
        "src/internal.py",
        "def convert(value):\n    match value:\n        case _:\n            return value\n",
    )
    put(
        repo,
        "tests/test_root.py",
        "import publicroot\ndef test_convert():\n    assert publicroot.convert(17) == 1049\n",
    )
    commit(repo)
    put(
        repo,
        "src/internal.py",
        "def convert(value):\n    match value:\n        case 17:\n            return 1049\n"
        "        case _:\n            return value\n",
    )
    assert any(f.severity == "high" for f in selected(repo, "AC006"))


def test_generated_bytecode_is_ignored_but_test_move_still_blocks(repo):
    cache = repo / "tests/__pycache__"
    cache.mkdir()
    (cache / "test_a.cpython-311.pyc").write_bytes(b"\x00\xffcompiled bytecode")
    assert not scan(load_git(working=True, cwd=repo)).findings
    git(repo, "mv", "tests/test_a.py", "tests/__pycache__/hidden.py")
    assert any(f.severity == "high" for f in selected(repo, "AC001"))


def test_m19_grep_failure_is_not_a_silent_miss(repo, monkeypatch):
    from types import SimpleNamespace

    from mm_anticheat.git import InputError, _git

    monkeypatch.setattr(
        "mm_anticheat.git.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=2, stdout=b"", stderr=b"fatal: grep failed"
        ),
    )
    with pytest.raises(InputError, match="grep failed"):
        _git(repo, "grep", "-F", "literal", allow_no_matches=True)
