import io

import pytest

from goodhart.classify import classify
from goodhart.cli import main
from goodhart.config import Config
from goodhart.git import load_git, load_patch

from .conftest import git


def test_range(repo):
    git(repo, "checkout", "-b", "feature")
    (repo / "tests/test_a.py").write_text("def test_a():\n    assert 4 == 4\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "head")
    data = load_git(cwd=repo)
    assert data.mode == "full"
    assert data.changes[0].base_content == "def test_a():\n    assert 3 == 3\n"
    assert data.changes[0].head_content == "def test_a():\n    assert 4 == 4\n"
    assert data.base == git(repo, "rev-parse", "main")


def test_working_includes_staged_unstaged_untracked(repo):
    path = repo / "tests/test_a.py"
    path.write_text("def test_a():\n    assert 5 == 5\n")
    git(repo, "add", ".")
    path.write_text("def test_a():\n    assert 6 == 6\n")
    (repo / "fresh.py").write_text("value = 42\n")
    data = load_git(cwd=repo, working=True)
    assert {c.path for c in data.changes} == {"tests/test_a.py", "fresh.py"}
    assert data.changes[0].head_content == path.read_text()


def test_staged_reads_index_not_working(repo):
    path = repo / "tests/test_a.py"
    path.write_text("def test_a():\n    assert 5 == 5\n")
    git(repo, "add", ".")
    path.write_text("def test_a():\n    assert 6 == 6\n")
    data = load_git(cwd=repo, staged=True)
    assert data.changes[0].head_content == "def test_a():\n    assert 5 == 5\n"
    assert data.changes[0].parse_error is None


def test_rename_new_delete_binary(repo):
    git(repo, "mv", "tests/test_a.py", "tests/test_renamed.py")
    (repo / "new.py").write_text("answer = 42\n")
    (repo / "blob.py").write_bytes(b"\0\xff")
    git(repo, "add", ".")
    data = load_git(cwd=repo, staged=True)
    changes = {c.path: c for c in data.changes}
    assert changes["tests/test_renamed.py"].old_path == "tests/test_a.py"
    assert changes["new.py"].old_path is None
    assert changes["blob.py"].is_binary
    git(repo, "rm", "--force", "tests/test_renamed.py")
    deleted = load_git(cwd=repo, staged=True)
    assert any(c.new_path is None and c.old_path == "tests/test_a.py" for c in deleted.changes)


def test_default_upstream_and_fallback(repo):
    git(repo, "branch", "-m", "trunk")
    (repo / "a.py").write_text("x = 99\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "second")
    data = load_git(cwd=repo)
    assert data.base == git(repo, "rev-parse", "HEAD~1")
    git(repo, "branch", "parent", "HEAD~1")
    git(repo, "branch", "--set-upstream-to=parent")
    assert load_git(cwd=repo).base == data.base


def test_explicit_range_uses_merge_base(repo):
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-b", "feature")
    (repo / "f.py").write_text("x = 42\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "feature")
    git(repo, "checkout", "main")
    (repo / "m.py").write_text("x = 43\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "main diverges")
    data = load_git(cwd=repo, base="main", head="feature")
    assert data.base == base
    assert [c.path for c in data.changes] == ["f.py"]


def test_patch_file_and_stdin(tmp_path, monkeypatch, capsys):
    patch = "--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 41\n+x = 42\n"
    data = load_patch(patch)
    assert data.mode == "patch"
    assert data.changes[0].added[0].new_line == 1
    path = tmp_path / "diff.patch"
    path.write_text(patch)
    assert main(["scan", "--diff", str(path)]) == 0
    monkeypatch.setattr("sys.stdin", io.StringIO(patch))
    assert main(["scan", "--diff", "-"]) == 0
    assert "source: 1" in capsys.readouterr().out


def test_malformed_patch_continues():
    data = load_patch(
        "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n"
        "@@ -1 +1 @@\n-x\n"
        "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n"
        "@@ -1 +1 @@\n-x\n+y\n"
    )
    assert data.changes[0].parse_error
    assert data.changes[1].path == "b.py"


@pytest.mark.parametrize(
    ("path", "content", "kinds"),
    [
        ("conftest.py", "", {"test", "config"}),
        ("test_foo.py", "", {"test"}),
        ("checks.py", "class Checks(unittest.TestCase): pass", {"source"}),
        ("checks.ts", "import {test} from 'node:test';", {"test"}),
        ("vendor/test_a.py", "def test_a(): pass", {"other"}),
        (".github/workflows/ci.yml", "", {"config"}),
        ("__snapshots__/a.snap", "", {"snapshot"}),
        ("src/a.ts", "", {"source"}),
        ("doc.md", "", {"other"}),
    ],
)
def test_classification(path, content, kinds):
    assert classify(path, content, Config()) == frozenset(kinds)


def test_cli_bad_input(monkeypatch, repo):
    monkeypatch.chdir(repo)
    assert main(["scan", "--base", "does-not-exist"]) == 3
    with pytest.raises(SystemExit) as error:
        main(["scan", "--working", "--base", "HEAD"])
    assert error.value.code == 3


def test_untracked_empty_no_newline_and_special_paths(repo):
    (repo / "empty.py").write_text("")
    (repo / 'odd "name" é.py').write_text("value = 42")
    (repo / "note.md").write_text('// goodhart: allow GH012 reason="reviewed"\n')
    data = load_git(cwd=repo, working=True)
    changes = {change.path: change for change in data.changes}
    assert set(changes) == {"empty.py", 'odd "name" é.py', "note.md"}
    assert changes['odd "name" é.py'].head_content == "value = 42"
    assert not any(change.parse_error for change in data.changes)


def test_ignored_files_not_scanned():
    from goodhart.engine import scan

    patch = "--- a/vendor/broken.py\n+++ b/vendor/broken.py\n@@ -1 +1 @@\n-x = 3\n+def broken(:\n"
    data = load_patch(patch)
    data.mode = "full"
    data.changes[0].head_content = "def broken(:\n"
    assert scan(data).findings == []
