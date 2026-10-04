# goodhart-check

A local CLI that reviews code diffs for removed tests, weaker assertions, hardcoded
test expectations, and related patterns. Findings show evidence and a legitimate
explanation to consider; they do not prove intent. The scanner is deterministic,
makes no network or LLM calls, and collects no telemetry. It supports Python and
JS/TS, uses Python 3.11+, and has one runtime dependency: `unidiff`.

This is the **Gate 1 review build** (Phases 0–3). Configuration and allowlisting,
additional CLI flags, polished reports, and integrations are scheduled after the
review gates. See [PROGRESS.md](PROGRESS.md) and [the handoff](docs/HANDOFF.md).

## Install

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
```

The commands below use `.venv/bin/goodhart`; activating the virtual environment
also makes `goodhart` available directly. Git input modes require a Git repository
with at least one commit. Patch mode works outside a repository.

## Usage

Review uncommitted changes, including staged, unstaged and untracked files:

```sh
.venv/bin/goodhart scan --working
```

Review a branch against the merge base of `main`:

```sh
.venv/bin/goodhart scan --base main --head HEAD --format json
```

Run the classic-cheat demonstration from the checkout root:

```sh
.venv/bin/goodhart scan --diff tests/fixtures/cross/classic_cheat/diff.patch
```

The demo flags GH002, GH003, GH005, and GH006, plus the patch-level assertion loss
reported by GH004. It intentionally exits **1**. Clean scans exit 0; invalid inputs
and internal errors exit 3. The Gate 1 CLI fails only on high-severity findings.

Also available: `scan --staged`, `scan --diff -` (stdin), `--version`, and `rules`.
`--format text` and `--format json` are implemented. JSON uses the provisional
schema v1 fields from the handoff; the contract freezes in Phase 4. When no Git
base is given, the scanner uses the upstream/main/master merge base or `HEAD~1`.
The header prints the resolved range. Working and staged heads are labelled
`WORKTREE` and `INDEX`; patch range fields are null.

## Rules

| ID | Name | Default severity |
|---|---|---|
| GH001 | test-file-deleted | high |
| GH002 | test-count-decreased | high |
| GH003 | skip-marker-added | high |
| GH004 | assertion-count-decreased | medium |
| GH005 | assertion-weakened | medium |
| GH006 | hardcoded-test-expectation | high (literal-only matches: medium) |
| GH007 | test-config-tampered | high |
| GH008 | exception-swallowed | medium |
| GH009 | test-environment-detection | high |
| GH010 | lint-or-type-suppression-added | low |
| GH011 | snapshot-updated-with-source | info |
| GH012 | allow-comment-added | medium |
| GH000 | parse-skipped / allow-missing-reason | info / low |

## Limitations

- Flags require human review and cannot establish whether someone cheated.
- JS/TS uses regex and brace heuristics. Dynamic test construction, imported test
  aliases, nested templates, regex literals, and unusual syntax can be missed.
- Patch mode lacks complete files. Counting findings have reduced confidence;
  GH006 also reports reduced confidence because it cannot inspect all tests or
  the full base source. Hunk boundaries can hide definitions and existing values.
- GH006 cannot resolve dynamic imports, re-exports, computed expectations, or
  computed inputs. Significant shared domain literals can produce medium flags.
- Configuration parsing uses stdlib parsers for Python/INI/TOML/JSON and local
  heuristics for JS configs and CI YAML. Computed configuration can be missed.
- Suppressions and skips are flagged even when legitimate. Existing reviewed
  comments only suppress findings once Phase 4 allowlisting is implemented.
- Files with binary content, unavailable content, malformed diffs, or Python
  syntax errors produce GH000 diagnostics. Other files continue to be scanned.

## Development and review

```sh
.venv/bin/ruff check .
.venv/bin/pytest -q
.venv/bin/pytest -q -s -m performance
```

Fixture source files are inert input data: pytest does not import them and Ruff
does not rewrite them. The fixture harness compares rule ID, file, line, and
severity. Individual fixtures select their rule via `meta.toml`; cross-rule
fixtures run the entire registry. Skip performance checks with
`pytest -m 'not performance'` on slow CI machines. Add positive and negative
fixtures when changing a rule. Gate 1 review instructions are in
[docs/GATE_1.md](docs/GATE_1.md). Do not publish packages, tags, or a public repo.
