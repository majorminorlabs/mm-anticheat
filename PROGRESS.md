# PROGRESS

## Current phase

Phase 3 is complete. REVIEW_01 fixes are complete; **Gate 1 remains stopped for
REVIEW_01b.md and Dippo's release**. Phase 4 has not started. The refreshed artifact
is `dist/goodhart-check-gate1.zip`.

The five pinned repositories cover 680 commits. The baseline is in
[docs/noise-baseline.md](docs/noise-baseline.md). High-flagged commits fell from
23 to 10; the release target of at most 8 remains unmet. The ten commits remove
actual tests, including obsolete or redundant cases. Their justifications are
listed individually. GH006 highs, GH009 CI highs, rule errors, scan errors, and
stderr lines are all zero. No severity exception was added for a repository or
commit.

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
| S9 | Provisional JSON v1 includes a sorted files array with file, effective kinds, base_kinds and head_kinds. Schema freezing remains Phase 4. |

## Optional items and handoff v1.1

- C1: recorded early test-body return as candidate GH013 in section 11 of the
  updated handoff. No new v1 rule was introduced.
- C2: equal-count name replacement remains a v1.1 candidate. Detecting it now
  would change GH002's specified count-decrease contract and add rename noise.
- C3: full-mode Python broad tuple catches are handled and tested. Patch mode
  retains the bounded simple-handler heuristic.
- C4: defer commit-level GH010 grouping to Phase 4 report work; low findings are
  counted transparently in the baseline.
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
- 223 tests pass on Python 3.11.15 and 3.14.7, including the original 126 scenarios.
- 133 individual rule fixtures and six cross-rule fixtures; the per-rule minimum
  positive/negative and patch positive/negative requirements still pass.
- Python 3.11 performance: 5,000-line full Git scan 0.301s; all hostile JS probes
  together 0.015s. Required limits are 2s and 1s respectively.
- All 680 pinned first-parent non-merge commits were scanned in full mode. No
  scanner rule error or corpus scan failure was omitted from the denominator.
- The refreshed ZIP includes the review, updated handoff, scripts, baseline and
  regression data, excluding environments, caches and Git internals.

## Next up

- Claude reruns the probes/corpus and writes REVIEW_01b.md. Resolve the remaining
  ten-versus-eight release threshold through that review; the builder has stopped.
- Only after Dippo releases Gate 1: Phase 4 reports, config, allowlisting and CLI
  flags. Gate 2 corpus labeling and Phases 5–6 remain unstarted.
- Nothing has been pushed, published or tagged. Naming, license confirmation,
  private GitHub provisioning and releases remain Dippo's decisions.

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
