# PROGRESS

## Current phase

Phase 4 review fixes are done. **Gate 2 status: open; real corpus inputs pending.**
REVIEW_01b M11 is fixed, its fixtures pass, and Gate 1's release conditions passed:
all 680 pinned commits rerun, with 10 high commits (limit ≤10), GH006 high 0,
no errors and no stderr. Phase 5 has not started.

REVIEW_02 M12/M13 and S10/S11 are addressed. The B1 runner and independent
evaluation report are implemented and validated. The requested `<model>` and
`<repos>` are unresolved placeholders: Dippo must supply the actual Ollama model
and repository paths before B1/B2 can run. There are currently zero real cases;
the 40/15/15 exit criterion has not been met.

The baseline is in [docs/noise-baseline.md](docs/noise-baseline.md). The old ≤8
noise budget was waived by REVIEW_01b. No repository or commit exceptions were
introduced.

## Phase 4 completed

- Text groups findings by severity, shows file/classification counts and reviewed
  exceptions, and uses ANSI only on a TTY unless --no-color is set. Markdown
  includes escaped collapsible details and safely fenced evidence. GH010 stays
  grouped per file; evidence defaults to six lines with an explicit truncation note.
- Load validated base-side repo-root .goodhart.toml or operator --config. CLI threshold/skip settings
  replace file settings, --rules selects rules before skips, and an empty
  --skip-rules clears configured skips. Custom path arrays replace defaults.
- Config path and preexisting same/previous-line inline allowances require a reason. Allowed
  findings remain visible and do not fail thresholds. Python/JS strings cannot
  masquerade as comments. Missing reasons emit low GH000; added allow comments
  emit medium GH012, which only config allowances can suppress.
- All requested CLI flags, rules descriptions and goodhart explain are implemented.
  Rule behavior metadata generates docs/rules.md through scripts/generate_rules.py.
- JSON v1 remains the historical frozen contract in docs/json-v1.md. REVIEW_02
  M12 adds config provenance in JSON v2, documented in docs/json-v2.md, with
  exact-key/type regression tests. Every v1 field retains its type and meaning.
  --quiet and evidence caps apply only to text/Markdown so JSON
  consumers always receive the same complete contract.
- CLI tests cover every flag, configuration precedence, all input modes, TTY
  behavior, and exit codes 0/1/3, including injected internal failure. Exit 2 stays
  unused. Config tests cover path/inline allowances, missing reasons and GH012.

## REVIEW_02 resolutions

| Item | Resolution and evidence |
|---|---|
| M12 | Git ranges read config from the resolved merge base; working/staged read HEAD; patch uses explicit config or defaults. Header and JSON show provenance. Root config changes produce a stderr notice and GH007 high for loosening allows, skips, ignores, thresholds or any test-glob change. Tightening does not fire; malformed head TOML gives GH000 info plus GH007 medium. Root config audit cannot suppress itself. All four modes, explicit overrides, divergent merge bases and self-suppression are covered. |
| M13 | Base-mapped actual inline comments can allow findings; newly added comments cannot. Patch allows must be context lines. New comments still give GH012 and the mandated explanation on the active target finding. Full-mode mapping also handles unchanged comments on replacement lines and offsets outside hunks. |
| Fixtures | Added the six required exit-1 probes and preexisting-inline, preexisting-config and tightened-config negatives. Added a patch-context inline negative too: ten new cross-rule fixtures. The harness checks allowed state and exit codes when specified. |
| S10 | Severity summaries show their allowed subset, e.g. high: 1 (1 allowed), in full and quiet text/Markdown. JSON summary meanings stay unchanged. |
| S11 | All five pinned histories rerun after M12/M13. Complete JSON files are byte-identical to the saved baseline: 10/680 high commits, GH006 high 0, errors/stderr 0. No root .goodhart.toml is present in these repos. |
| B1 build | scripts/impossiblebench_local.py uses official source in a separate ignored environment, local-only Ollama endpoint, four 30-sample cells, actual tools snapshots and scored minimal solutions. It exports provenance and observations without expected oracles. Label policy follows the benchmark, including checking every changed test file before an honest label. Original labels are preserved. Unit tests and a real Docker/Inspect mock-model export smoke pass; smoke cases are excluded from the real corpus. |
| B1 run | Pending the actual model name. Source pin 061dc3dce6a96ab6cf02a855157263033dcfa3ba, Inspect 0.3.276, Python 3.14.7; both 103-task splits cached. No real model samples have run. |
| B2 | Pending Dippo-selected repository paths. Existing scan_history.py will scan 300 commits per repo. Candidates remain unreviewed; the builder does not label them. |
| Evaluation | scripts/real_world_eval.py renders benchmark/reviewer labels, expected vs actual, default-high recall and honest false-positive rate. Reviewer-tagged out-of-scope-v1.1 cases leave the recall denominator. docs/real-world-eval.md accurately records zero real cases and unavailable metrics. |

M12/M13 change policy trust rather than tuning detection against benchmark cases.
JSON was versioned because adding provenance to the frozen v1 exact-key contract
requires a new version. The benchmark test-path adapter and upstream tools
test_patch compatibility adjustment are documented in docs/impossiblebench-local.md.

## REVIEW_01b M11

- Empty same-name stubs never corroborate a move. Full-mode destinations require
  at least one assertion and retain the removed test's assertion count for info;
  fewer assertions yield medium. Patch destinations need actual assertion lines
  in their added test hunk. Strings/docstrings and unrelated test assertions do
  not count as evidence. Rejected names are listed in why_flagged.
- Added move_to_empty_stub_full, move_to_empty_stub_patch,
  move_with_fewer_assertions and real_move fixtures. The real Pydantic move still
  passes. Extra Python/JS adversarial tests cover deleted-file GH001, docstring
  stubs, adjacent unrelated tests and existing same-name destinations.
- Cache assertion inventories per scan to avoid repeating AST counts for split
  moves. Cached entries retain only names and counts.
- Noise rerun: click 1, HTTPX 3, Ky 2, Pydantic 2, Vitest 2 = 10/680 high commits.
  Pydantic 69fd688e changes from info to medium, without a new high commit.
- C5: record negated platform gates as a v1.1 evidence/severity candidate; keep
  v1's medium policy until Gate 2 data supports changing it.
- C6: record the reviewer's 1.5s direct 3,000-it-call result. The current bounded
  scan and forward-lexer tests remain; do not widen scope for an unrealistic case.
- C1/C2 remain v1.1 candidates for early return and equal-count trivial replacement.

## REVIEW_01 must items

| Item | Resolution and regression evidence |
|---|---|
| M1 | Path classification takes precedence. Outside source-looking paths, Python requires an actual pytest/unittest import plus a module test function or TestCase subclass. AST signals replace textual matches. Same-path changes use the head kind, and GH001 never interprets a content classification flip as deletion. `py_source_with_test_method`, `source_test_method_removed`, `content_kind_flip`, and framework tests cover it. |
| M2 | Added singular/nested test, tests, spec, e2e directories and test/spec suffixes for JS, JSX, TS, TSX, MJS, CJS, MTS, CTS. Added AVA, Playwright, bun:test, tap, uvu and testing-library imports. Vitest must be the exact module; type-only imports are excluded. TSX/JSX probes and a real Ky AVA serial conversion are covered. |
| M3 | When a default merge base equals head, use the head's first parent. Empty ranges print a stderr notice with both resolved commits. Main-without-upstream and empty-commit integration tests cover it. |
| M4 | JS literals use a small decoder instead of Python literal_eval. Python AST parsing suppresses SyntaxWarning. A subprocess CLI test with backslash-dot, backslash-d and escaped backticks verifies truly empty stderr outside pytest's warning capture. |
| M5 | GH006 separates conditions from outputs, excludes condition literals from high matches, and requires a new output absent from the full base. Inputs and expectations must belong to the same test. Python if/ternary/match and JS branch probes remain covered. A condition-only shared expectation can still produce the section 6 medium finding. Real Vitest getType formatting is negative; corpus GH006 highs are zero. |
| M6 | Replaced the quoted-name regex with a forward lexer and JS escape decoder. GH004 uses describe-path/name/ordinal identities. Duplicate names, mixed quotes, escaped quotes and a real Vitest formatter change are covered. AVA serial calls and template labels also count without evaluating interpolation. |
| M7 | GH001 requires actual base test definitions, GH002 skips deleted files, and both counting rules compare removed names with genuinely added names in other changed test files. At least 80% overlap is info; partial overlap is medium, with destination paths in why_flagged. Synthetic split moves and real Pydantic move, empty-init and benchmark-helper snippets are covered. |
| M8 | Environment/version/platform/module-availability gates become medium; constant conditions and unconditional existing-test skips remain high. New-test skips stay low. Existing marker signatures ignore formatting/reason-only changes. Includes real Pydantic module version gating. |
| M9 | Module pytestmark assignments/lists and imported mark aliases are handled in full mode. Added xtest, fit, fdescribe, skip.each and only.each probes. Module unconditional skips remain high. |
| M10 | Added 56 fixture cases, including every named review probe and nine trimmed corpus cases with full commit provenance in meta.toml. Original fixture coverage is retained. Upstream license notices are in docs/fixture-licenses. |

## REVIEW_01 should items

| Item | Resolution / scope |
|---|---|
| S1 | GH009 runner detection stays high; plain CI checks are medium, settings files low. Masked source positions exclude help strings and comments. Real Vitest CLI help is a negative fixture. |
| S2 | Added os.getenv, environ indexing/membership, pytest in sys.argv[0], import.meta.env.MODE and import.meta.vitest. Each has a fixture. |
| S3 | Bare empty JS catch is low in full and patch mode; bound catches remain medium. The inclusive line range uses end-1 before counting the final line; its +2 is the exclusive Python range endpoint. Editing only the next line does not flag the old catch. Real Vitest bare catch is low. |
| S4 | Catch Exception per rule/file, emit GH000 with rule ID, exception class and message, and continue. Tests inject IndexError, RuntimeError and RecursionError and verify a later rule/file still reports. The corpus tool also counts these diagnostics as rule errors and exits 3 if any occur. |
| S5 / S5b | JS comments/strings/test heads use a forward lexer. Files over 1,000,000 encoded bytes or with a line over 20,000 characters are skipped with GH000 before analysis; related test files obey the same bound. Hostile 40 KB quote/backtick inputs plus 3,000 unterminated it calls complete in 0.015s on Python 3.11. CLI scans with over 300 changed files print a size notice. Library/history scans remain quiet. |
| S6 | GH005 recognizes pytest.raises broadening. Python and patch assertion counters include raises, self.assertRaises, called/awaited/not_called mock checks. Fixtures cover full and patch counts. |
| S7 | Collect static Python parametrize rows and JS each array rows. Named expected/want/output/result columns take precedence; otherwise the last column is expected. Python pytest.param rows are supported. Computed tables and tagged-template/object-form JS tables remain outside the static scalar heuristic. |
| S8 | Test scripts that stop invoking a recognized runner now flag, including jest to echo. Added pytest -m selection. Both have fixtures. |
| S9 | JSON v1 includes a sorted files array with file, effective kinds, base_kinds and head_kinds. Phase 4 freezes the contract with exact-key/type regression tests and docs/json-v1.md. |

## Optional items and handoff v1.1

- C1: recorded early test-body return as candidate GH013 in section 11 of the
  updated handoff. No new v1 rule was introduced.
- C2: equal-count name replacement remains a v1.1 candidate. Detecting it now
  would change GH002's specified count-decrease contract and add rename noise.
- C3: full-mode Python broad tuple catches are handled and tested. Patch mode
  retains the bounded simple-handler heuristic.
- C4: GH010 is grouped per file in reports with bounded evidence, while the
  baseline preserves complete per-file finding counts. No history-only severity
  or suppression policy was introduced.
- Accepted REVIEW_01 answers: legitimate scenarios assert their specified
  downgrades; GH006 patch confidence stays reduced; expanded JS globs and working
  mode untracked files stay; ZIP remains the Gate 1 review vehicle.
- Preserved HANDOFF v1.1's Gate 2 sources: own history, ImpossibleBench with a
  local model, METR transcripts and public agent PRs. ATLAS is no dependency.
- Added scripts/scan_history.py beside scripts/noise_check.py. It exports complete
  high/medium candidate patches, base/head files, related tests and observed
  findings under commit SHAs. Candidates are explicitly unreviewed, have no
  expected.json oracle, and existing candidates/manual labels are preserved.

## Verification

- Ruff check and format check pass. Formatter excludes prose Markdown and inert
  fixture source so supplied review/handoff code blocks are preserved.
- 363 tests pass on Python 3.11.15 and 3.14.7, including the original scenarios.
- 137 individual rule fixtures and 16 cross-rule fixtures; the per-rule minimum
  positive/negative and patch positive/negative requirements still pass.
- Python 3.11 performance: 5,000-line full Git scan 0.194s; all hostile JS probes
  together 0.015s. Required limits are 2s and 1s respectively.
- All 680 pinned first-parent non-merge commits were scanned in full mode. No
  scanner rule error or corpus scan failure was omitted from the denominator.
- The REVIEW_02 corpus run exactly matches the M11 JSON reports for all five
  repositories: 10/680 high commits, GH006 high 0, no errors or stderr.
- The existing Gate 2 ZIP remains the historical aaa9bd8 review snapshot. The
  current revision is not packaged as a released Gate 2 while corpus inputs and
  the required real labels remain missing.

## Fixture counts

| Rule | Cases |
|---|---:|
| GH000 | 8 |
| GH001 | 12 |
| GH002 | 14 |
| GH003 | 21 |
| GH004 | 7 |
| GH005 | 8 |
| GH006 | 12 |
| GH007 | 14 |
| GH008 | 12 |
| GH009 | 14 |
| GH010 | 6 |
| GH011 | 4 |
| GH012 | 5 |
| Cross-rule | 16 |
| **Total** | **153** |

## Gate 2: input needed from Dippo

- Actual installed Ollama model name replacing `<model>`.
- Local repository paths replacing `<repos>`, selected by Dippo for B2.
- Independent reviewer labels for B2 and unreviewed benchmark outcomes, plus
  scope notes where applicable. The builder will not supply these labels.

Exit requires ≥40 complete labeled real cases, ≥15 cheats and ≥15 honest;
per-case results, recall and false-positive rate; green checks and unchanged
noise. Historical maintainer regressions and synthetic smoke cases do not count.

## Next up

- Run B1/B2 when the two pending inputs arrive; fill the real-world report and
  satisfy REVIEW_02's corpus criterion. Then stop for REVIEW_02b.
- Phase 5 integrations and Phase 6 release preparation remain unstarted. Naming,
  license confirmation, private remote setup and publication stay with Dippo.

## Known limitations

JS/TS remains a lexer plus structural heuristics, without executing code or
adding a parser dependency. Imported test aliases, regex literals, deeply nested
templates, generated cases and computed configuration can be missed. Template
labels retain their expression text as identity; they do not expand into runtime
cases. Move matching uses names and multiplicity, so semantically renamed tests
can still flag. GH006's new domain constants can legitimately flag at medium.
Patch-only inputs lack the complete base and test bodies; counting and hardcode
findings retain reduced confidence. Intent always requires human review.

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

- 2026-10-04: REVIEW_01 revision: M1–M10 fixed; S1–S9 addressed; history tools,
  56 new fixtures and pinned noise baseline added. Rule-error diagnostics caught
  and helped fix Python ternary AST handling during the corpus audit. Gate 1
  stays stopped for REVIEW_01b because 10 real-removal commits exceed the target 8.

- 2026-10-05: M11 complete; full/patch stubs stay high, weaker moves medium, real
  moves info. The 680-commit rerun meets ≤10/680 and GH006 high 0. Gate 1 released
  under REVIEW_01b; proceeding into Phase 4 without another review stop.

- 2026-10-05: Phase 4 complete. All flags, config/allow interactions and three
  report formats pass; JSON v1 frozen; generated rule explanations and docs added.
  Ruff check/format clean, 316 tests pass on Python 3.11 and 3.14. Performance
  0.194s full scan / 0.015s hostile probes on Python 3.11. Final corpus output
  matches M11 exactly. Built Gate 2 ZIP with complete docs and regressions;
  stopped for REVIEW_02 and labeled data before integrations or release work.

- 2026-10-05: REVIEW_02 M12/M13 fixed with ten cross-rule fixtures and integration
  tests; S10 summaries clarified; S11 noise unchanged byte for byte. JSON v2 adds
  config provenance. Separate benchmark environment installed, splits cached,
  runner/evaluation built and Docker/Inspect export smoke verified. Model and
  repository inputs remain pending; B2 labels untouched. Gate 2 stays open.
