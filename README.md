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
If that merge base is head, it uses head's first parent. An empty range prints a
stderr notice naming the resolved range; scans with over 300 changed files print
a size notice.
The header prints the resolved range. Working and staged heads are labelled
`WORKTREE` and `INDEX`; patch range fields are null.
JSON's `files` array exposes effective, base and head classifications.

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
- JS/TS uses a forward lexer and structural heuristics. Dynamic test construction, imported test
  aliases, nested templates, regex literals, and unusual syntax can be missed.
- Patch mode lacks complete files. Counting findings have reduced confidence;
  GH006 also reports reduced confidence because it cannot inspect all tests or
  the full base source. Hunk boundaries can hide definitions and existing values.
- GH006 cannot resolve dynamic imports, re-exports, computed expectations, or
  computed inputs. Significant shared domain literals can produce medium flags.
  High matches require new output literals and inputs/expectations from the same
  test. Static parametrize and each array rows are included.
- Configuration parsing uses stdlib parsers for Python/INI/TOML/JSON and local
  heuristics for JS configs and CI YAML. Computed configuration can be missed.
- Suppressions and skips are flagged even when legitimate. Existing reviewed
  comments only suppress findings once Phase 4 allowlisting is implemented.
- Files with binary content, unavailable content, malformed diffs, or Python
  syntax errors produce GH000 diagnostics. Rule errors, files over 1 MB and lines
  over 20,000 characters also produce GH000. Other files continue to be scanned.
- Classification uses paths first. Python content signals require a framework
  import and module test or TestCase subclass, outside source-looking paths.
  CI-only environment checks are medium; bare empty JS catches are low. Counting
  rules downgrade test moves when matching names are added elsewhere in the diff.

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

Measure a local history without checking out commits or fetching anything:

```sh
.venv/bin/python scripts/noise_check.py /path/to/repo 150 --head COMMIT --json /tmp/noise.json
.venv/bin/python scripts/scan_history.py /path/to/repo 150 --head COMMIT --output /tmp/candidates
```

The first script reports per-rule/severity counts, high-flagged commits and at
most five examples per rule; JSON retains every commit and finding. Errors or an
incomplete requested window exit 3. The second exports high/medium candidates
for manual labeling and preserves existing candidate directories. Observed
findings are not expected-result oracles. See the pinned
[noise baseline](docs/noise-baseline.md): 10 of 680 commits flag high, exceeding
the review's target of eight. Gate 1 remains under review.
