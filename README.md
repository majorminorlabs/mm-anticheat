# goodhart-check

A local CLI that reviews code diffs for removed tests, weaker assertions, hardcoded
test expectations, and related patterns. Findings show evidence and a legitimate
explanation to consider; they do not prove intent. The scanner is deterministic,
makes no network or LLM calls, and collects no telemetry. It supports Python and
JS/TS, uses Python 3.11+, and has one runtime dependency: `unidiff`.

Gate 2 is released with reduced scope by Dippo. B1 is invalid and excluded from
metrics; 54 own-history candidates await independent labels. Local integration and
fresh-install checks pass; stopped for Gate 3 review. Hosted Action validation
awaits a private remote. See [PROGRESS.md](PROGRESS.md),
[integrations](docs/integrations.md), [Gate 3](docs/GATE_3.md) and
[the handoff](docs/HANDOFF.md).

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
and internal errors exit 3. The default threshold is high; `--fail-on medium`,
`low` or `never` changes which unallowed findings cause exit 1.

Also available: `scan --staged`, `scan --diff -` (stdin), `--version`, `rules`,
and `explain GH005`. Formats are `text`, `json` and `markdown`. Text groups findings
by severity and uses color only on a TTY; `--no-color` forces plain output.
Markdown includes collapsible evidence per finding. `--quiet` prints a summary
line in text/Markdown; `--max-evidence-lines N` limits their evidence (default 6).
JSON retains all evidence and findings with the [v2 contract](docs/json-v2.md),
which adds config provenance to the frozen v1 fields.
When no Git
base is given, the scanner uses the upstream/main/master merge base or `HEAD~1`.
If that merge base is head, it uses head's first parent. An empty range prints a
stderr notice naming the resolved range; scans with over 300 changed files print
a size notice.
The header prints the resolved range and config source. Working and staged heads are labelled
`WORKTREE` and `INDEX`; patch range fields are null.
JSON's `files` array exposes effective, base and head classifications.

Run selected rules with `--rules GH001,GH003`; skip rules with `--skip-rules GH010`.
Unknown rule IDs and invalid options exit 3. Input diagnostics still report lost
analysis coverage even when rule selection is restricted.

## Configuration and reviewed exceptions

Git range scans load the root `.goodhart.toml` from the resolved merge base.
Working and staged scans load it from HEAD; `--working --base <ref>` loads it
from that base and includes committed session work. Patch scans use defaults unless
`--config path` selects a file relative to the current directory. The header and
JSON report `base:<sha>`, `HEAD`, `--config path`, or `defaults` as the source.
When `.goodhart.toml` changes in the diff, a stderr notice names that change and
the config source. Hooks and CI should use the base-side default or an explicit
config in a location the agent cannot edit.

CLI `--fail-on` and `--skip-rules` replace
the corresponding file settings; `--skip-rules ''` clears configured skips.
`--rules` selects from the registry before effective skips are applied.

```toml
fail_on = "high"
skip_rules = ["GH010"]

[[allow]]
rule = "GH001"
path = "tests/legacy/**"
reason = "Legacy suite removal reviewed in #212"
```

Optional `[paths]` arrays `test_globs` and `ignore_globs` replace defaults; omitted
arrays keep defaults. Globs use repository-relative paths. A leading `**/` also
matches the root; `*` can match directory separators. The
[example config](docs/example-goodhart.toml) shows the syntax. Unknown keys,
unknown rule IDs and missing allowance reasons are errors.

GH007 flags changes to root `.goodhart.toml` at high when they add or widen
allowances, add skips or ignored paths, raise the fail threshold, or change test
globs in any way. Tightening changes produce no GH007. Malformed head TOML adds
GH000 info and GH007 medium. When GH007 is selected, config allows, skips and
ignored paths cannot suppress its audit of the root config itself.

An actual comment on the flagged line or the line above can allow that rule when
it already existed on the base side:

```python
# goodhart: allow GH003 reason="flaky test tracked in #88"
@pytest.mark.skip(reason="flaky")
def test_remote_service():
    assert service_available()
```

JS/TS uses `// goodhart: allow GH008 reason="best-effort telemetry"`. Reasons must
be nonempty quoted text. A missing reason leaves the flag active and adds low
GH000. Adding any allow comment in the scanned diff adds medium GH012, which can
only be allowed by a trusted config path exception. A newly added comment leaves
its target finding active; the approval applies after the comment is merged.
Full scans validate the mapped comment against base content; patch scans honor
only context comments. Deleted files need a config allowance.
Allowed findings remain visible, with `allowed: true` in JSON, and are excluded
from the exit threshold. Summary severity counts show the allowed subset, for
example `high: 1 (1 allowed)`.

## Rules

| ID | Name | Default severity |
|---|---|---|
| GH001 | test-file-deleted | high |
| GH002 | test-count-decreased | high |
| GH003 | skip-marker-added | high |
| GH004 | assertion-count-decreased | medium |
| GH005 | assertion-weakened | medium |
| GH006 | hardcoded-test-expectation | high (literal-only: medium; same-diff expectations one level lower) |
| GH007 | test-config-tampered | high |
| GH008 | exception-swallowed | medium |
| GH009 | test-environment-detection | high |
| GH010 | lint-or-type-suppression-added | low |
| GH011 | snapshot-updated-with-source | info |
| GH012 | allow-comment-added | medium |
| GH000 | parse-skipped / allow-missing-reason | info / low |

Full explanations are generated from the rule metadata in
[docs/rules.md](docs/rules.md). Regenerate with
`.venv/bin/python scripts/generate_rules.py`.

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
- Suppressions and skips are flagged even when legitimate. Reviewed allowances
  require a specific reason; findings remain available for review.
- Files with binary content, unavailable content, malformed diffs, or Python
  syntax errors produce GH000 diagnostics. Rule errors, files over 1 MB and lines
  over 20,000 characters also produce GH000. Other files continue to be scanned.
- Classification uses paths first. Python content signals require a framework
  import and module test or TestCase subclass, outside source-looking paths.
  CI-only environment checks are medium; bare empty JS catches are low. Counting
  rules downgrade test moves when matching names and substantive assertions are
  added elsewhere in the diff. Empty stubs cannot corroborate movement; full-mode
  destinations with fewer assertions yield medium.

## Integrations and blocked-scan captures

Use the shipped GitHub Action, pre-commit registration and native Claude Code or
Codex Stop hook: [setup and validation](docs/integrations.md). The Action has
fail-on, config and optional comment inputs; PR comments are disabled by default.
Agent hooks record a SessionStart base, scan commits plus working changes, and
block at high. Continued stops rescan and warn about unresolved findings.

`goodhart scan --working --capture-on-block` saves the exact diff and complete
findings JSON to `.goodhart/captures/<timestamp>-<id>/` on exit 1. Hooks enable
this automatically. Captures stay local, use private file permissions and are
excluded from subsequent Git scans. First save writes `.goodhart/.gitignore`
with `*`; capture.json records unresolved continuation state.
Storage failure emits a diagnostic and preserves the findings block.

To record the terminal demo, run:

```sh
GOODHART_PYTHON="$PWD/.venv/bin/python" scripts/demo.sh
```

The script applies classic-cheat in an isolated scratch repo, verifies exit 1,
then reverts and verifies exit 0. Use a terminal recorder or screenshot tool if
needed; it does not edit this checkout.

Contributions should include relevant positive/negative fixtures and preserve
the pinned noise budget. Run Ruff and pytest before proposing a change. Detector
findings require human review; corpus labels are assigned independently.

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
fixtures when changing a rule. Gate 2 review instructions are in
[docs/GATE_2.md](docs/GATE_2.md). Do not publish packages, tags, or a public repo.

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
[noise baseline](docs/noise-baseline.md): 10 of 680 commits flag high and GH006
highs are zero, passing REVIEW_01b's release limit of at most ten. The original
eight-commit target was waived. Gate 2 is released with reduced scope. B2 has
independent labels; no confirmed-cheat recall sample exists. Candidate-only false
positives are selection-biased; the report also shows blocks per full history window.

The [local ImpossibleBench runner](docs/impossiblebench-local.md) uses a separate
environment and Ollama through Inspect. It exports complete snapshots and
benchmark-defined labels without adding model libraries to the scanner runtime.
The 2026-10-06 B1 campaign is invalid (tools protocol, Docker and disk-pressure
failures); its runner is retained and is not rerun. History candidates were
reviewed independently: 52 legitimate and 2 suspicious (0 confirmed cheats). Current
case counts and metrics are in [real-world-eval.md](docs/real-world-eval.md).
