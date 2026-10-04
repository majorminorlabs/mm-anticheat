"""Unified diffs represented with old and new line coordinates."""

import re
from dataclasses import dataclass, field

from unidiff import PatchSet
from unidiff.errors import UnidiffParseError

from goodhart.classify import FileKind, classify
from goodhart.config import Config


@dataclass(frozen=True)
class Line:
    """A diff line (without its prefix or trailing newline)."""

    value: str
    kind: str
    old_line: int | None
    new_line: int | None


@dataclass
class Hunk:
    """A contiguous changed region."""

    lines: list[Line]


@dataclass
class FileChange:
    """One changed file, with optional complete contents in full mode."""

    old_path: str | None
    new_path: str | None
    hunks: list[Hunk] = field(default_factory=list)
    is_binary: bool = False
    base_content: str | None = None
    head_content: str | None = None
    old_kinds: frozenset[FileKind] = frozenset({"other"})
    new_kinds: frozenset[FileKind] = frozenset({"other"})
    parse_error: str | None = None

    @property
    def path(self) -> str:
        return self.new_path or self.old_path or "<patch>"

    @property
    def kinds(self) -> frozenset[FileKind]:
        return self.old_kinds | self.new_kinds

    @property
    def added(self) -> list[Line]:
        return [line for hunk in self.hunks for line in hunk.lines if line.kind == "+"]

    @property
    def removed(self) -> list[Line]:
        return [line for hunk in self.hunks for line in hunk.lines if line.kind == "-"]

    def visible(self, side: str) -> str:
        """Return hunk content for classification and patch-only heuristics."""
        exclude = "+" if side == "base" else "-"
        return "\n".join(
            line.value for hunk in self.hunks for line in hunk.lines if line.kind != exclude
        )


def _path(path: str) -> str | None:
    if path == "/dev/null":
        return None
    if path.startswith(("a/", "b/")):
        path = path[2:]
    # Git quotes special paths using C escapes, including octal UTF-8 bytes.
    if path.startswith('"') and path.endswith('"'):
        import ast

        try:
            path = ast.literal_eval(path)
            path = path.encode("latin1").decode("utf8")
        except (ValueError, SyntaxError, UnicodeError):
            pass
        if path.startswith(("a/", "b/")):
            path = path[2:]
    return path


def _quoted_chunk(chunk: str) -> tuple[str, tuple[str | None, str | None] | None]:
    """Work around unidiff's greedy Git-header parsing for quoted filenames."""
    token = r'"(?:\\.|[^"\\])*"'
    header = re.match(r"^diff --git (" + token + r"|a/[^\n]*?) (" + token + r"|b/[^\n]*)\n", chunk)
    if not header or not (header[1].startswith('"') or header[2].startswith('"')):
        return chunk, None
    original = (_path(header[1]), _path(header[2]))
    chunk = "diff --git a/__goodhart_file__ b/__goodhart_file__\n" + chunk[header.end() :]
    chunk = re.sub(r"^--- (?!/dev/null)([^\n]+)$", "--- a/__goodhart_file__", chunk, flags=re.M)
    chunk = re.sub(r"^\+\+\+ (?!/dev/null)([^\n]+)$", "+++ b/__goodhart_file__", chunk, flags=re.M)
    return chunk, original


def parse_diff(text: str, config: Config | None = None) -> list[FileChange]:
    """Parse independent files; preserve a diagnostic for each malformed chunk."""
    config = config or Config()
    if not text.strip():
        return []
    if re.search(r"^diff --git ", text, re.M):
        chunks = re.split(r"(?=^diff --git )", text, flags=re.M)
    else:
        chunks = re.split(r"(?=^--- .+\n\+\+\+ )", text, flags=re.M)
    changes = []
    for chunk in chunks:
        if not chunk.strip():
            continue
        try:
            normalized, original = _quoted_chunk(chunk)
            patch = PatchSet(normalized)
            if not patch:
                raise UnidiffParseError("No unified-diff file headers found")
            for file in patch:
                old_path, new_path = _path(file.source_file), _path(file.target_file)
                if original:
                    old_path = original[0] if old_path is not None else None
                    new_path = original[1] if new_path is not None else None
                change = FileChange(
                    old_path,
                    new_path,
                    [
                        Hunk(
                            [
                                Line(
                                    line.value.rstrip("\n\r"),
                                    line.line_type,
                                    line.source_line_no,
                                    line.target_line_no,
                                )
                                for line in hunk
                                if line.line_type in {" ", "+", "-"}
                            ]
                        )
                        for hunk in file
                    ],
                    is_binary=file.is_binary_file,
                )
                change.old_kinds = classify(
                    change.old_path or change.path,
                    change.visible("base"),
                    config,
                )
                change.new_kinds = classify(
                    change.new_path or change.path,
                    change.visible("head"),
                    config,
                )
                if change.is_binary:
                    change.parse_error = "Binary content is not parsed"
                changes.append(change)
        except (UnidiffParseError, ValueError, IndexError) as exc:
            header = re.search(r"^\+\+\+ (.+?)(?:\t.*)?$", chunk, re.M)
            path = _path(header[1]) if header else "<patch>"
            changes.append(FileChange(path, path, parse_error=f"Malformed diff: {exc}"))
    return changes
