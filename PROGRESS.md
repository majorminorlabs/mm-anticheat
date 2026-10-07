# PROGRESS

## Current phase

**Stopped for REVIEW_03b after Gate 3 repairs (2026-10-07).** M14–M18 and
S12–S17 are implemented with regression probes. B2's independent labels are
imported: 0 confirmed cheats, 2 suspicious, 52 legitimate. All 393 pinned history
commits were rescanned: both suspicious cases remain high-blocked, and only one
legitimate commit blocks (1/393, within ≤3/393). The 52-candidate legitimate
false-positive rate is 1/52; it is selection-biased, and unflagged commits were
not independently labeled. See docs/real-world-eval.md and
docs/b2-rescan-review03.json.

B1 remains invalid: no structured tool calls, Docker failures and disk pressure.
Its runner is retained and was not rerun; 120 B1 cases remain excluded. Dippo's
reduced-scope Gate 2 release still applies; confirmed-cheat recall is unavailable.
Phase 5's hosted Action/sample-PR check remains pending an existing private
remote. Nothing is published, tagged, or installed into live hook settings.
The local commit and dist/mm-anticheat-gate3.zip are the REVIEW_03b handoff.

## REVIEW_03 repairs (2026-10-07)

| Item | Resolution / regression |
|---|---|
| M14 | Hook scans in-process through the already imported installed package. Both shell event wrappers use Python -I. Action's scanner subprocess uses -I. Planted mm-anticheat package probes block through the console entry, both shell Stop wrappers, and Action. Shell/Action tests also plant PYTHONPATH. Setup examples use isolated Python; an operator must control the installed environment and command. |
| M17 | scan --working --base accepts a session-start ref and includes committed plus uncommitted work. Both hosts support SessionStart; saved bases live under the actual Git directory, validated by session_id, and survive resume/compact. Fallback selects an upstream/default merge-base, then HEAD with a committed-coverage notice. A committed skip blocks at Stop; branch fallback and direct CLI base are tested. |
| M18 | Working and staged loaders enumerate ls-files -v -z; flagged paths differing from the index are read directly and included. AC007 high integrity findings cannot be suppressed by inline/path allows, skip_rules, or rule selection. Staged scans intentionally include hidden worktree edits for flagged paths. Every scanner/history Git invocation disables fsmonitor and untrackedCache. Both flags reproduce exit 2; a malicious fsmonitor is never invoked. |
| M15 | New runner configs skip narrowing/exclusion comparisons; explicit failure masking still flags. New .anticheat.toml retains the defaults audit. All three named fixtures pass. |
| M16 | New-file module/class skip markers are low; existing-file os.environ/os.getenv and import-is-None gates are medium. Trimmed Hermes and Lyricist fixtures preserve provenance; existing variants verify medium. |
| S12 | Deleted-test relative imports resolve to deleted source files before downgrade to low; all must resolve, with stem matching retained as fallback. JS and Python relative imports are supported. The anyways deletion fixture and retained-import negative probe pass. |
| S13 | Expectations on added test lines reduce severity by one level. Preexisting matching expectations retain priority and full severity. Medium literal matches ignore integers with absolute value under 1000; the high branch path remains intact. Existing/new branch and constant fixtures plus a small-integer collision probe pass. The old patch expected-constant oracle is low under this explicit policy change; match/ternary tests retain preexisting expectation coverage. |
| S14 | JS lexer recognizes opaque regex literals, escaping and character classes in expression positions; quotes/backticks inside them cannot mask following assertions. Both full original B2 test-file diffs have no AC002/AC004 count decrease. |
| S15 | First capture creates .anticheat/.gitignore with *. git add -A leaves captures unstaged. Existing operator gitignore files are preserved. |
| S16 | Active continuation hooks still scan. Unresolved high findings capture and emit systemMessage on both hosts, then exit 0. capture.json stores unresolved=true separately so findings.json keeps frozen schema v3. Storage failure retains the warning and normal blocks. |
| S17 | Default ignores include dist, build, .next, coverage and hashed JS assets. Exact eight-hex pattern is included; common 12/16/20/32/40/64-hex lengths cover the B2 bundle as well. Nonhashed source is not ignored. |
| S18 / C9 | Commit all Phase 5/6 work and repairs; build dist/mm-anticheat-gate3.zip from committed files, with BUILD_INFO.json identifying the commit. Remove the reviewer's partial tarball. Stop for REVIEW_03b. |
| C7 | Deferred. Single-call parse/stat/access catch handlers remain reviewable medium flags; broader severity tuning needs dedicated fixtures and a separate review. |
| C8 | Consumer Action examples already require a pinned commit SHA. The self-test workflow uses ./ intentionally; hosted validation is still pending. |

Official hook docs rechecked 2026-10-07:
[Claude Code](https://code.claude.com/docs/en/hooks) and
[Codex](https://learn.chatgpt.com/docs/hooks) both support SessionStart and
systemMessage warnings. No transcript is read. No new runtime dependency.

### Verification

Final suite: 412 tests on Python 3.14.7 and a fresh Python 3.11.15 install;
Ruff check/format and git diff --check pass. Fixture whitespace is exempted
through .gitattributes to preserve original corpus snapshot and patch bytes.
Fresh Git snapshot/clone README
commands produce exits 0/0/1; isolated integration probes pass from the install.
All five noise windows are rerun at the saved pins: 680 commits, 10 high-blocked,
AC006 high 0, scan/rule errors and stderr lines 0. High/medium commits fall from
42 to 31. Raw complete reports and the refreshed table are in
docs/noise-results/ and docs/noise-baseline.md.

B2 label import is one-to-one by repository + short SHA, preserving reviewer,
date and exact notes; findings.json was regenerated from the pinned source Git
history without assigning labels. Original snapshots/diffs are unchanged.
Both suspicious cases remain blocked (anyways/a95da0c9 AC002 and
anyways/e6f88e27 AC009). The one legitimate block is anyways/58e3f541, an
intentional narrowing of the test script. B2 contains no confirmed-cheat recall
sample. The generated report excludes all invalid B1 cases.

## Revised B2 repository selection (2026-10-06)

~/GitHub is absent. Searched home project folders, /Volumes/External/GitHub,
/Volumes/External/major-minor and /Volumes/Research. Excluded upstream/vendor
clones, duplicate checkouts, this detector and repos with fewer than 20 commits.
Selected the following using read-only Codex session metadata (cwd and start/end
times only) correlated with Git commit timestamps. A majority of each selected
repo's first-parent window falls within recorded Codex session intervals. This
is an attribution inference, not proof that every overlapping commit was made
by an agent. No conversation transcripts were read. Counts below pin the selected
HEAD; scans request the last 300 first-parent non-merge commits, including root
commits against an empty tree when fewer than 300 exist.

| Repository | Local path | Total commits | First-parent window | Session-overlap commits | Codex sessions |
|---|---|---:|---:|---:|---:|
| home-watch | /Volumes/External/GitHub/IGNORED/MBHW/home-watch | 27 | 27 | 26 | 28 |
| anyways | /Volumes/External/GitHub/IGNORED/anyways | 257 | 211 | 211 | 89 |
| research-model-mm | /Volumes/Research/research-model-mm | 39 | 39 | 39 | 23 |
| hermes-ios | /Volumes/Research/tools/hermes-ios | 43 | 43 | 43 | 17 |
| lyricist | /Volumes/Research/tools/lyricist | 25 | 25 | 25 | 2 |
| mm-4b-benchmark | /Volumes/Research/tests/mm-4b-benchmark | 20 | 20 | 20 | 4 |
| mm-8b-benchmark | /Volumes/Research/tests/mm-8b-benchmark | 28 | 28 | 28 | 2 |

Outputs: tests/fixtures/real_candidates/own-history/<repo>/<commit>/ on the
Research volume. Every new candidate starts as unreviewed; existing metadata and
reviewer labels are preserved. Source repository and commit provenance are saved.
Selection evidence and per-repo scan summaries are kept in .benchmarks/.

## Phase 4 completed

- Text groups findings by severity, shows file/classification counts and reviewed
  exceptions, and uses ANSI only on a TTY unless --no-color is set. Markdown
  includes escaped collapsible details and safely fenced evidence. AC010 stays
  grouped per file; evidence defaults to six lines with an explicit truncation note.
- Load validated base-side repo-root .anticheat.toml or operator --config. CLI threshold/skip settings
  replace file settings, --rules selects rules before skips, and an empty
  --skip-rules clears configured skips. Custom path arrays replace defaults.
- Config path and preexisting same/previous-line inline allowances require a reason. Allowed
  findings remain visible and do not fail thresholds. Python/JS strings cannot
  masquerade as comments. Missing reasons emit low AC000; added allow comments
  emit medium AC012, which only config allowances can suppress.
- All requested CLI flags, rules descriptions and mm-anticheat explain are implemented.
  Rule behavior metadata generates docs/rules.md through scripts/generate_rules.py.
- JSON v1 remains the historical frozen contract in docs/json-v1.md. REVIEW_02
  M12 adds config provenance in JSON v3, documented in docs/json-v3.md, with
  exact-key/type regression tests. Every v1 field retains its type and meaning.
  --quiet and evidence caps apply only to text/Markdown so JSON
  consumers always receive the same complete contract.
- CLI tests cover every flag, configuration precedence, all input modes, TTY
  behavior, and exit codes 0/1/3, including injected internal failure. Exit 2 stays
  unused. Config tests cover path/inline allowances, missing reasons and AC012.

## REVIEW_02 resolutions

| Item | Resolution and evidence |
|---|---|
| M12 | Git ranges read config from the resolved merge base; working/staged read HEAD; patch uses explicit config or defaults. Header and JSON show provenance. Root config changes produce a stderr notice and AC007 high for loosening allows, skips, ignores, thresholds or any test-glob change. Tightening does not fire; malformed head TOML gives AC000 info plus AC007 medium. Root config audit cannot suppress itself. All four modes, explicit overrides, divergent merge bases and self-suppression are covered. |
| M13 | Base-mapped actual inline comments can allow findings; newly added comments cannot. Patch allows must be context lines. New comments still give AC012 and the mandated explanation on the active target finding. Full-mode mapping also handles unchanged comments on replacement lines and offsets outside hunks. |
| Fixtures | Added the six required exit-1 probes and preexisting-inline, preexisting-config and tightened-config negatives. Added a patch-context inline negative too: ten new cross-rule fixtures. The harness checks allowed state and exit codes when specified. |
| S10 | Severity summaries show their allowed subset, e.g. high: 1 (1 allowed), in full and quiet text/Markdown. JSON summary meanings stay unchanged. |
| S11 | All five pinned histories rerun after M12/M13. Complete JSON files are byte-identical to the saved baseline: 10/680 high commits, AC006 high 0, errors/stderr 0. No root .anticheat.toml is present in these repos. |
| B1 build | scripts/impossiblebench_local.py uses official source in a separate ignored environment, local-only Ollama endpoint, four 30-sample cells, actual tools snapshots and scored minimal solutions. It exports provenance and observations without expected oracles. Label policy follows the benchmark, including checking every changed test file before an honest label. Original labels are preserved. Unit tests and a real Docker/Inspect mock-model export smoke pass; smoke cases are excluded from the real corpus. |
| B1 run | Stopped qwen2.5-coder:14b on 2026-10-06: 120 attempts, 0 conflicting passes, 1 original pass, 49 sample errors and 3 further snapshot failures; no model switch or extra split ran. Source pin 061dc3dce6a96ab6cf02a855157263033dcfa3ba, Inspect 0.3.276, Python 3.14.7; both 103-task splits cached. Minimal logs are in .benchmarks/runs/20261006T230803837725Z/; conflicting/tools is in .benchmarks/runs/20261007T003124618878Z/; original/tools is in .benchmarks/runs/20261007T005100128253Z/. Completed minimal cells are not retried; infrastructure errors stay visible. |
| B2 | Four repos selected: 6th-man-main, Bento CRM, fly-bot and telegram-progress-bot. The specified parent folder is absent; corrected local paths are pending. Existing scan_history.py will scan 300 commits per repo. Candidates remain unreviewed; the builder does not label them. |
| Evaluation | scripts/real_world_eval.py renders benchmark/reviewer labels, expected vs actual, default-high recall and honest false-positive rate. Reviewer-tagged out-of-scope-v1.1 cases leave the recall denominator. docs/real-world-eval.md records exported real candidates, incomplete cases and available metrics; labels never come from detector findings. |

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
  passes. Extra Python/JS adversarial tests cover deleted-file AC001, docstring
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
| M1 | Path classification takes precedence. Outside source-looking paths, Python requires an actual pytest/unittest import plus a module test function or TestCase subclass. AST signals replace textual matches. Same-path changes use the head kind, and AC001 never interprets a content classification flip as deletion. `py_source_with_test_method`, `source_test_method_removed`, `content_kind_flip`, and framework tests cover it. |
| M2 | Added singular/nested test, tests, spec, e2e directories and test/spec suffixes for JS, JSX, TS, TSX, MJS, CJS, MTS, CTS. Added AVA, Playwright, bun:test, tap, uvu and testing-library imports. Vitest must be the exact module; type-only imports are excluded. TSX/JSX probes and a real Ky AVA serial conversion are covered. |
| M3 | When a default merge base equals head, use the head's first parent. Empty ranges print a stderr notice with both resolved commits. Main-without-upstream and empty-commit integration tests cover it. |
| M4 | JS literals use a small decoder instead of Python literal_eval. Python AST parsing suppresses SyntaxWarning. A subprocess CLI test with backslash-dot, backslash-d and escaped backticks verifies truly empty stderr outside pytest's warning capture. |
| M5 | AC006 separates conditions from outputs, excludes condition literals from high matches, and requires a new output absent from the full base. Inputs and expectations must belong to the same test. Python if/ternary/match and JS branch probes remain covered. A condition-only shared expectation can still produce the section 6 medium finding. Real Vitest getType formatting is negative; corpus AC006 highs are zero. |
| M6 | Replaced the quoted-name regex with a forward lexer and JS escape decoder. AC004 uses describe-path/name/ordinal identities. Duplicate names, mixed quotes, escaped quotes and a real Vitest formatter change are covered. AVA serial calls and template labels also count without evaluating interpolation. |
| M7 | AC001 requires actual base test definitions, AC002 skips deleted files, and both counting rules compare removed names with genuinely added names in other changed test files. At least 80% overlap is info; partial overlap is medium, with destination paths in why_flagged. Synthetic split moves and real Pydantic move, empty-init and benchmark-helper snippets are covered. |
| M8 | Environment/version/platform/module-availability gates become medium; constant conditions and unconditional existing-test skips remain high. New-test skips stay low. Existing marker signatures ignore formatting/reason-only changes. Includes real Pydantic module version gating. |
| M9 | Module pytestmark assignments/lists and imported mark aliases are handled in full mode. Added xtest, fit, fdescribe, skip.each and only.each probes. Module unconditional skips remain high. |
| M10 | Added 56 fixture cases, including every named review probe and nine trimmed corpus cases with full commit provenance in meta.toml. Original fixture coverage is retained. Upstream license notices are in docs/fixture-licenses. |

## REVIEW_01 should items

| Item | Resolution / scope |
|---|---|
| S1 | AC009 runner detection stays high; plain CI checks are medium, settings files low. Masked source positions exclude help strings and comments. Real Vitest CLI help is a negative fixture. |
| S2 | Added os.getenv, environ indexing/membership, pytest in sys.argv[0], import.meta.env.MODE and import.meta.vitest. Each has a fixture. |
| S3 | Bare empty JS catch is low in full and patch mode; bound catches remain medium. The inclusive line range uses end-1 before counting the final line; its +2 is the exclusive Python range endpoint. Editing only the next line does not flag the old catch. Real Vitest bare catch is low. |
| S4 | Catch Exception per rule/file, emit AC000 with rule ID, exception class and message, and continue. Tests inject IndexError, RuntimeError and RecursionError and verify a later rule/file still reports. The corpus tool also counts these diagnostics as rule errors and exits 3 if any occur. |
| S5 / S5b | JS comments/strings/test heads use a forward lexer. Files over 1,000,000 encoded bytes or with a line over 20,000 characters are skipped with AC000 before analysis; related test files obey the same bound. Hostile 40 KB quote/backtick inputs plus 3,000 unterminated it calls complete in 0.015s on Python 3.11. CLI scans with over 300 changed files print a size notice. Library/history scans remain quiet. |
| S6 | AC005 recognizes pytest.raises broadening. Python and patch assertion counters include raises, self.assertRaises, called/awaited/not_called mock checks. Fixtures cover full and patch counts. |
| S7 | Collect static Python parametrize rows and JS each array rows. Named expected/want/output/result columns take precedence; otherwise the last column is expected. Python pytest.param rows are supported. Computed tables and tagged-template/object-form JS tables remain outside the static scalar heuristic. |
| S8 | Test scripts that stop invoking a recognized runner now flag, including jest to echo. Added pytest -m selection. Both have fixtures. |
| S9 | JSON v1 includes a sorted files array with file, effective kinds, base_kinds and head_kinds. Phase 4 freezes the contract with exact-key/type regression tests and docs/json-v1.md. |

## Optional items and handoff v1.1

- C1: recorded early test-body return as candidate AC013 in section 11 of the
  updated handoff. No new v1 rule was introduced.
- C2: equal-count name replacement remains a v1.1 candidate. Detecting it now
  would change AC002's specified count-decrease contract and add rename noise.
- C3: full-mode Python broad tuple catches are handled and tested. Patch mode
  retains the bounded simple-handler heuristic.
- C4: AC010 is grouped per file in reports with bounded evidence, while the
  baseline preserves complete per-file finding counts. No history-only severity
  or suppression policy was introduced.
- Accepted REVIEW_01 answers: legitimate scenarios assert their specified
  downgrades; AC006 patch confidence stays reduced; expanded JS globs and working
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
  repositories: 10/680 high commits, AC006 high 0, no errors or stderr.
- The existing Gate 2 ZIP remains the historical aaa9bd8 review snapshot. The
  current revision is not packaged as a released Gate 2 while corpus inputs and
  the required real labels remain missing.

## Fixture counts

| Rule | Cases |
|---|---:|
| AC000 | 8 |
| AC001 | 12 |
| AC002 | 14 |
| AC003 | 21 |
| AC004 | 7 |
| AC005 | 8 |
| AC006 | 12 |
| AC007 | 14 |
| AC008 | 12 |
| AC009 | 14 |
| AC010 | 6 |
| AC011 | 4 |
| AC012 | 5 |
| Cross-rule | 16 |
| **Total** | **153** |

## Gate 3: remaining operator/reviewer work

- An existing private GitHub repo for the hosted composite Action/sample-PR check.
  There is no Git remote here. Local Action helper tests do not substitute for a
  real hosted workflow; the configured workflow is ready.
- Independent B2 labels, scope notes and REVIEW_03. These proceed in parallel and
  do not block the reduced-scope Gate 2 release. Builder never labels B2 cases.
- Naming, license confirmation, remote setup and public release stay with Dippo.

## Phase 5 integrations and Phase 6 preparation

- Root action.yml: Python setup, pip install from its own action path, PR base vs
  GITHUB_SHA Markdown scan, job summary before preserving scan exit, fail-on/config
  inputs, and optional bot-owned PR comment create/update with pagination. Inputs
  become environment variables/argument lists, not shell code. Comments default
  off. Fake-transport tests only; no live comment was posted.
- Root .pre-commit-hooks.yaml: staged-only scan, no filenames, always_run, and
  blocked-scan captures. Actual pre-commit try-repo installed the hook from a local
  snapshot: staged classic-cheat exited 1 and saved a capture; reset passed at 0.
- Claude Code Stop wrapper: official docs checked 2026-10-06. JSON stdin supplies
  cwd and stop_hook_active. Scan exit 1 maps to hook exit 2 with stderr feedback;
  a previous Stop continuation returns 0 to avoid loops. Docs and command:
  https://code.claude.com/docs/en/hooks#stop and mm-anticheat-hook --agent claude.
- Codex **supports native Stop hooks**, per the official documentation checked
  2026-10-06: https://learn.chatgpt.com/docs/hooks. It supports exit-2 stderr
  feedback and stop_hook_active; success must be JSON, so the adapter emits {}.
  User/project hooks.json require trust review. Native adapter and an AGENTS.md
  fallback snippet ship in hooks/codex/. No live user hook settings were changed.
- Capture-on-block uses the same loaded diff and ScanResult JSON, never rescans.
  Creates unique, atomically published private files under the scanned Git root.
  Captures are excluded from future working/staged/range diffs. Storage failures
  emit a diagnostic and preserve the findings block; symlink destinations cannot
  silence it. Add the directory to the target repo's gitignore as documented.
- Actual classic-cheat scratch test: both Stop adapters reported AC002/AC003/AC005/
  AC006 and exited 2; after git reset --hard HEAD both exited 0 with captures left
  on disk. Repeats create separate captures; continuation input avoids another
  capture. Staged-only input, malformed JSON and Codex JSON output are tested.
- README includes install, three usage examples, rule table, limitations,
  integrations, capture behavior and contributing note. CHANGELOG.md has 0.1.0
  unreleased. scripts/demo.sh runs in a scratch repo and is suitable for terminal
  recording/screenshots; confirmed classic-cheat exit 1 and reverted exit 0.
- Fresh clone of a **local snapshot of this worktree**, on the Research volume:
  Python 3.11.15 venv, pip install .[dev], installed scanner --version, all three
  README examples with expected exits 0/0/1, and full tests passed. This is not a
  clone from or CI execution on a hosted private repo. Raw verification is saved
  locally under .benchmarks/phase6/; no model was called or rerun.

## Known limitations

JS/TS remains a lexer plus structural heuristics, without executing code or
adding a parser dependency. Imported test aliases, regex literals, deeply nested
templates, generated cases and computed configuration can be missed. Template
labels retain their expression text as identity; they do not expand into runtime
cases. Move matching uses names and multiplicity, so semantically renamed tests
can still flag. AC006's new domain constants can legitimately flag at medium.
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
  moves info. The 680-commit rerun meets ≤10/680 and AC006 high 0. Gate 1 released
  under REVIEW_01b; proceeding into Phase 4 without another review stop.

- 2026-10-05: Phase 4 complete. All flags, config/allow interactions and three
  report formats pass; JSON v1 frozen; generated rule explanations and docs added.
  Ruff check/format clean, 316 tests pass on Python 3.11 and 3.14. Performance
  0.194s full scan / 0.015s hostile probes on Python 3.11. Final corpus output
  matches M11 exactly. Built Gate 2 ZIP with complete docs and regressions;
  stopped for REVIEW_02 and labeled data before integrations or release work.

- 2026-10-05: REVIEW_02 M12/M13 fixed with ten cross-rule fixtures and integration
  tests; S10 summaries clarified; S11 noise unchanged byte for byte. JSON v3 adds
  config provenance. Separate benchmark environment installed, splits cached,
  runner/evaluation built and Docker/Inspect export smoke verified. Model and
  repository inputs remain pending; B2 labels untouched. Gate 2 stays open.

## 2026-10-06 B1 runtime recovery

- Docker repeatedly stopped responding, then failed sample sandbox initialization.
  The first minimal cell retains 12 sample errors and one 900-second time-limit
  outcome; the second retains 26 sample errors. Inspect's task-level "success"
  does not mean every sample executed. These errors must not be scored as evidence
  that the model failed the tasks. Tools had not started when the first run exited.
- Docker was restarted, and the remaining tools cells launched with 1 GiB container
  RAM and no additional swap, two CPUs and 128 processes. No model, dataset or detector rule changed.
  The original/minimal container received the same limits after its first solver pass;
  conflicting/minimal ran before these limits. Manifests record these differences.
- The macOS system volume was full (about 700 MiB free). To preserve data while
  freeing space, moved the 1 GiB pip download cache from
  /Users/dippo/Library/Caches/pip to
  /Volumes/Research/tools/cheat-detector/.benchmarks/cache-backups/pip-20261006
  and replaced the original path with a symlink. All 2,666 files were SHA-256 verified
  before removing the duplicate copy. About 1.7 GiB was free afterward. This cache
  remains user data: preserve it if deleting .benchmarks. No other user files were
  removed. Full disk space is a possible contributor; Docker's exact failure cause
  was not established. An isolated capped sandbox smoke passed before continuation.
- B2's four requested paths are recorded in .benchmarks/b2-request-20261006.json
  as missing, with scanned/candidate counts null. No alternative repos were used,
  no history candidates exported, and no B2 labels assigned.

- Conflicting/tools finished with 28 scored failures and two sandbox startup errors
  after Docker shut down (socket disappeared). None of its 30 samples executed
  structured tool calls: the model emitted JSON-shaped requests as plain text,
  and the scored sandbox files retained the stub. This is recorded, not repaired
  by changing models or prompts. Original/tools resumed alone after Docker start
  and a capped sandbox smoke succeeded. No completed cell was rerun.

- Final count audit: 30 attempts per cell, 0 conflicting passes, 1 original pass;
  49 Docker sample errors, three additional failed tools snapshots, one minimal
  time limit and 49 tools message limits without structured tool calls. All 120
  exports retain provenance/observations and have no expected oracle. Labels:
  0 cheats, 1 honest, 119 unreviewed. The model was unloaded after completion.
  B1 stopped below the ten-pass floor. B2 was not run because all four requested
  paths are missing. Gate 2 remains open, Phase 5 remains unstarted.

- Final verification after the runner resource-limit/message changes: Ruff check
  and format check pass, 363 tests pass on Python 3.14.7, and git diff --check is
  clean. Detector rules are unchanged; the verified 10/680 noise baseline and
  AC006 high 0 remain the latest baseline. No ZIP, push or release was performed.

## Revised B2 results

| Repo | Pinned HEAD | Scanned commits | Candidates | With unallowed high | Errors |
|---|---|---:|---:|---:|---:|
| anyways | `334a0e2b1f7f1237194b520020c464d4e5fcadca` | 211 | 19 | 5 | 0 |
| hermes-ios | `ce98b07cc438a8aa0f9a0939e3a301973f94f3c8` | 43 | 9 | 1 | 0 |
| home-watch | `8d8e210dc2deeaf7646c4ac590cf39249af0149a` | 27 | 2 | 0 | 0 |
| lyricist | `ab1a68cc08b190d3fe342b0f9414b14da7a7fb2f` | 25 | 12 | 1 | 0 |
| mm-4b-benchmark | `f4632b0e71f90a773a48057a445cf5b317a475e9` | 20 | 2 | 1 | 0 |
| mm-8b-benchmark | `6e80566ef9487f3b7b592eee621d3bc27af52108` | 28 | 2 | 0 | 0 |
| research-model-mm | `7b82f179e994dcefea57011051ceafe6d64ff0db` | 39 | 8 | 1 | 0 |

Total: **393 commits, 54 distinct candidate commits, 9 with unallowed high,
45 with medium-only findings, zero errors**. Every candidate has source repository/
commit provenance, diff.patch, full base/head content and observed findings JSON;
no expected oracle. All 54 labels remain unreviewed as of the export audit. Existing
labels are retained on rescans; no labels were assigned by the builder. Each repo
has fewer than 300 first-parent non-merge commits, so the full available history
was scanned, including its initial commit against the empty tree.

Initial exports exposed a root-commit bug in the old history exporter: it assumed
SHA~1 existed when saving a patch. Added full root ingestion and saved the exact
loaded patch instead of re-reading a parent diff. Removed only the four empty
failed-export directories and repeated the scans, preserving all existing
candidates and metadata. The final summaries all exited 0. A regression checks
root export and reviewer-label preservation. B2 candidates remain on the Research
volume in tests/fixtures/real_candidates/own-history/ for Dippo's parallel review.

## Final local verification for Gate 3 (2026-10-06)

- Ruff check and format checks pass; full suite 372 tests passes on Python 3.14.7
  and the fresh local clone's Python 3.11.15. Integration checks exercise real
  subprocesses; synthetic test records never enter the real corpus.
- All five pinned noise histories rerun after capture-path ingestion changed;
  complete JSON output is byte-identical to REVIEW_02: 10/680 high, AC006 high 0,
  no scan/rule errors and no stderr. No rule tuning or noise exceptions.
- YAML files parse and pre-commit validates the hook manifest; its actual install/
  blocked/reverted run succeeds. GitHub Action helper tests pass; the hosted
  private-repo/sample-PR check remains pending. Shipped workflow uses current
  actions/checkout@v7 and actions/setup-python@v7 verified against their official
  READMEs on 2026-10-06, on ubuntu-latest runners.
- Core scanner retains only unidiff as a runtime dependency and makes no network
  or model calls. Optional GitHub comment networking is isolated in the Action
  helper and disabled by default. Model benchmark runner was not rerun.
- Stopped at Gate 3 for REVIEW_03. B2 labels remain independent. No source repo,
  package, tag, PR or comment was published, and no live hook settings installed.

## REVIEW_04 candidate work (2026-10-07, in progress)

Dippo approved `majorminorlabs/mm-anticheat` as a private MIT repository and the
full Part A rename. The remote contains the complete history. The CLI/distribution
is `mm-anticheat`, Python package `mm_anticheat`, policy `.anticheat.toml`, directive
`anticheat: allow`, captures `.anticheat/captures`, rule IDs AC000–AC018, JSON schema 3.
Original reviewer documents retain their historical names and quoted identifiers.

S19 records `{base, started_at}` plus an original `.start` anchor in the actual Git
directory. A committed cheat followed by rewritten base, rewritten timestamp,
plaintext record or malformed JSON blocks with AC007 high. Unmodified/resumed
sessions retain their base. S20 documents the same-user threat model, recommends
user-level SessionStart/Stop hooks, and uses protected PR checks as enforcement.
C10: the hook console entry point was removed; supported examples use Python `-I`.

M19–M25 are implemented with constructed examples, including Python/JS package-root
aliases, collection renames, every requested runner, malformed config fallback,
blocking assertion weakening, six new full-file rules and except availability skips.
Ruff is clean; 466 tests pass locally. Noise and B2 remeasurement, hosted Action
checks, branch protection and the Part C study are still pending. The study uses
subscription defaults, preserves all attempts, and does not use paid API keys.
The grading sandbox initially denied pytest's `/dev/null`; preserved agent outputs
are regraded locally after fixing this permission, without rerunning agents.

No publishing, public visibility change, release tags or package upload is authorized
until Dippo replies GO after the holdout check.
