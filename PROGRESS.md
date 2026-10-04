# PROGRESS

## Current phase
Phase 3: Pattern rules. Status: done.

**GATE 1: stopped, awaiting Dippo and Claude's `REVIEW_01.md`.** Phase 4 has not
started. Do not proceed until the review loop has no open `must` items and Dippo
releases the gate. The local handoff ZIP is `dist/goodhart-check-gate1.zip`.

## Done
- [x] Read the entire handoff before writing code; preserved it in `docs/HANDOFF.md`.
- [x] Phase 0 exit: editable installation, src layout, version and rules commands,
  Ruff, pytest and local Git repository.
- [x] Phase 1 exit: Git range, working tree, index and patch/stdin inputs; upstream /
  main / master / fallback ref resolution; merge-base ranges; file classification;
  renamed, deleted, new, binary, empty, quoted-name and no-final-newline files.
- [x] Phase 2 exit: GH001–GH004, Python AST helpers, JS/TS regex helpers, fixture
  harness, provisional JSON v1, basic text report. Clean refactor passes.
- [x] Phase 3 exit: GH005–GH012 and GH000; all individual and cross-rule fixtures
  pass. Classic cheat triggers GH002, GH003, GH005 and GH006. Clean refactor has
  zero findings, in full and patch modes.
- [x] GH006 full mode reads untouched tests importing changed source modules,
  including tests identified from content. Related content is read in a Git batch.
- [x] Parser problems emit GH000 and scanning continues; comments and strings are
  distinguished for allow / suppression markers. GH012 cannot suppress itself.
- [x] Gate 1 corpus: 81 individual rule fixtures plus two cross-rule fixtures.
- [x] Final verification: Ruff clean; **126 tests pass on Python 3.11.15 and 3.14.7**.
  Latest 5,000-line full Git scan: **0.184s** on this laptop (Python 3.11).
- [x] Review README, MIT license default, and `docs/GATE_1.md` prepared.
- [x] No publication, tags, pushes, runtime network calls, LLM calls or telemetry.
  `unidiff` is the only runtime Python dependency; pytest / Ruff are dev dependencies.

### Fixture counts
Positive includes intentional lower-severity flags for legitimate scenarios.

| Rule | Positive | Negative | Patch positive | Patch negative |
|---|---:|---:|---:|---:|
| GH000 | 5 | 3 | 3 | 1 |
| GH001 | 3 | 2 | 1 | 1 |
| GH002 | 3 | 2 | 1 | 1 |
| GH003 | 3 | 2 | 1 | 1 |
| GH004 | 2 | 2 | 1 | 1 |
| GH005 | 5 | 2 | 1 | 1 |
| GH006 | 3 | 3 | 1 | 2 |
| GH007 | 9 | 3 | 2 | 1 |
| GH008 | 5 | 4 | 2 | 2 |
| GH009 | 3 | 2 | 1 | 1 |
| GH010 | 3 | 3 | 1 | 1 |
| GH011 | 2 | 2 | 1 | 1 |
| GH012 | 2 | 3 | 1 | 2 |

Individual fixtures explicitly select the rule under test using `meta.toml`.
Cross-rule cases use the whole registry. Fixture Python is inert data; pytest
never imports it, and Ruff never rewrites it. Expected locations/severities were
specified independently of scanner output.

## Next up
- [ ] Dippo passes the Gate 1 ZIP or private repository to Claude.
- [ ] Claude reviews against `docs/HANDOFF.md` and writes `REVIEW_01.md`.
- [ ] Fix every `must`; address or answer every `should` here. Repeat as needed.
- [ ] After Gate 1 release: Phase 4 output, config, allowlisting and CLI flags.
- [ ] Stop again at Gate 2; Dippo supplies ATLAS diffs and Claude reviews.
- [ ] Phases 5–6 and Gate 3 remain unstarted. Integration docs are checked when
  implementing those phases, as required; no integration capability is claimed now.

## Decisions made (with reason)
- 2026-10-04: Follow supplied defaults: package goodhart-check, command goodhart,
  Python 3.11+, MIT, fail-on high. Use setuptools and unidiff.
- 2026-10-04: Empty checkout had no Git remote. Initialize local Git and prepare a
  ZIP for Gate 1, rather than inventing a remote or publishing.
- 2026-10-04: Follow section 6's explicit flags/downgrades where section 8 calls
  the same legitimate case negative. Add downgrade fixtures and true negatives.
- 2026-10-04: Include untracked files in working mode. Honor Git ignores and scanner
  ignore globs; do not execute repository code, external diff tools or text converters.
- 2026-10-04: Add conventional `.test.js` / `.spec.js` default globs for stated JS support.
- 2026-10-04: GH006 also uses reduced confidence in patch mode because complete test
  coverage and full base content are unavailable. GH002 / GH004 do so as required.
- 2026-10-04: Unidiff cannot reliably parse quoted Git headers by itself; normalize
  quoted headers for parsing and restore original paths. Regression checks cover
  quotes and Unicode. Related test files are batch-read for speed.
- 2026-10-04: JSON fields match the handoff's v1 schema now; formal freeze remains
  Phase 4. Working / index heads are labelled WORKTREE / INDEX; patch refs are null.

## Open questions for Dippo
- Supply `REVIEW_01.md` and release Gate 1 after its `must` items are resolved.
- Confirm the conservative handling of section 8's negative-case wording against
  section 6's required flags. Legitimate suppression / skip / consolidation cases
  can still flag; they receive the explanations and specified severity downgrades.
- A private remote can be provided if preferred; the ZIP works without one.
- Naming, MIT confirmation and releases remain Dippo's reserved decisions.

## Known risks / false-positive concerns
- JS/TS regex / brace heuristics can miss aliases, computed tests, complex templates,
  regex literals and unusual callback syntax. No JS parser dependency was added.
- GH006 can flag legitimate new domain constants or lookup tables at medium severity.
  High requires an input comparison and expected output within three lines. Dynamic
  import/re-export resolution, computed inputs and expectations are not supported.
- Patch hunks omit global context. Counts may miss surrounding definitions; GH006
  cannot know whether a matching literal exists outside visible base hunks.
- JS config and CI YAML heuristics cannot evaluate computed settings. Coverage and
  narrowed-path comparisons only flag supported explicit representations.
- Position-paired assertion checks can mispair independently reordered assertions.
- Tests removed together with their source get low GH001, while GH002 can still flag
  the reduced count under its independent rule specification.
- Reviews remain necessary: flags never establish intent. Real-world accuracy is
  unmeasured until Dippo supplies the Gate 2 ATLAS corpus.

## Session log
- 2026-10-04: Phase 0 complete: editable install / version work, Ruff clean, 1 test.
- 2026-10-04: Phase 1 complete: all input / classification cases, Ruff clean, 19 tests.
- 2026-10-04: Phase 2 complete: counting rules / JSON / corpus, Ruff clean, 40 tests.
- 2026-10-04: Phase 3 complete: pattern rules / parser diagnostics / expanded corpus.
  Added regressions for unchanged importing tests, source-comment literal matches,
  quoted / empty / untracked files, strings resembling directives, CI comments,
  non-test CI steps, retained selection flags and promise catches. Final Ruff clean;
  126 tests pass on Python 3.11 and 3.14; 5,000-line scan 0.184s on Python 3.11.
  Preparing local Gate 1 ZIP; stopped before Phase 4 for the requested review loop.
