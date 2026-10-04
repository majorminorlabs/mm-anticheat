# Gate 1 review

This build completes Phases 0–3 of [HANDOFF.md](HANDOFF.md). Dippo provides the
build to Claude for review. Claude writes `REVIEW_01.md` with `must`, `should`,
and `consider` items. The builder fixes every `must` before Phase 4 begins.

## Reproduce

1. Unzip `dist/goodhart-check-gate1.zip` into a new directory, or use the checkout.
2. Follow the README installation instructions with Python 3.11 or newer.
3. Run Ruff and pytest, including the fixture harness and performance check.
4. Run the classic-cheat patch demo and verify exit 1. Run the clean-refactor
   patch and verify exit 0:

   ```sh
   .venv/bin/goodhart scan --diff tests/fixtures/cross/clean_refactor/diff.patch
   ```

5. Use a scratch Git repository to try Git-range, working and staged scans;
   temp-repository tests in `tests/test_ingestion.py` illustrate each mode.
6. Add adversarial and legitimate cases to `tests/fixtures` and check evidence,
   severity and line locations. Pay special attention to GH006, GH007, Python
   AST class/method counting, JS/TS regex boundaries, and malformed input.

## Scope of this review build

All GH001–GH012 rules plus GH000 are registered, each in its own file. Full and
patch inputs work; JSON output and basic evidence-bearing text output work.
There are 81 individual rule fixtures plus two cross-rule fixtures. The fixture
harness enforces two positive and two negative cases per rule, with patch-mode
cases of each kind. Additional integration and adversarial tests bring the suite
to 126 tests.

Phase 4 has **not** started: config-file loading, allow suppression, CLI selection
and threshold flags, `explain`, markdown/color output, and generated rule docs
are future work. Integrations and real-world ATLAS evaluation also remain behind
their designated gates. GH012 and missing-reason diagnostics already detect allow
comments; they do not yet suppress other findings.

## Points requiring a decision

- Section 8 calls some legitimate scenarios negative cases, while section 6
  explicitly requires a downgraded or unchanged flag for those scenarios. The
  fixtures follow section 6: matching-source deletion, parametrization, new-test
  skips, legitimate environment settings and documented suppressions remain
  explicit findings; separate cases assert no finding.
- GH006 uses reduced confidence in patch mode in addition to the two counting
  rules, because both expectation coverage and base-file comparison are incomplete.
- Default globs additionally include common `.test.js` and `.spec.js` files.
- Working mode includes untracked files. The scanner never runs scanned code.
- No private remote was provided. A ZIP is the Gate 1 handoff artifact.

Known precision limitations are recorded in README and PROGRESS. The ZIP contains
source and fixtures without virtual environments, caches, Git internals or release
tags. Nothing has been published or pushed.
