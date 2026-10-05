# Gate 1 re-review

This revision addresses [REVIEW_01.md](../REVIEW_01.md) against the updated
[HANDOFF.md](HANDOFF.md). **Gate 1 is stopped for REVIEW_01b.md.** Phase 4 has
not started; Dippo must release the gate after review.

## Reproduce

1. Unzip `dist/goodhart-check-gate1.zip` into a new directory and follow the
   README editable-install instructions with Python 3.11 or newer.
2. Run `.venv/bin/ruff check .`, `.venv/bin/ruff format --check .`, and
   `.venv/bin/pytest -q`. The revision has 223 tests, including 133 individual
   rule fixtures and six cross-rule fixtures. All original scenarios remain.
3. Run `.venv/bin/pytest -q -s -m performance`; required limits are two seconds
   for the 5,000-line full Git scan and one second for hostile JS inputs.
4. Run the classic-cheat patch demo and verify exit 1; the clean-refactor patch
   should exit 0:

   ```sh
   .venv/bin/goodhart scan --diff tests/fixtures/cross/classic_cheat/diff.patch
   .venv/bin/goodhart scan --diff tests/fixtures/cross/clean_refactor/diff.patch
   ```

5. Reproduce the five pinned history scans using the commands in
   [noise-baseline.md](noise-baseline.md). Complete per-commit results are in
   `docs/noise-results/`. The scripts are local and do not clone or fetch repos.
6. Try Git-range, working, staged and patch inputs in a scratch repo. The CLI
   reports empty resolved ranges and large commit sizes on stderr. History
   scanning uses the quiet library path and records actual stderr and errors.

## Results requiring review

The high-flagged count fell from 23 to 10 of 680. Every remaining high commit
removes real tests and is individually justified in the baseline. **The release
target of at most eight is unmet.** GH006 highs, GH009 CI highs, rule errors,
scan errors and stderr lines are zero. Preserve the specified high severity for
actual uncorroborated test loss unless the reviewer approves a policy change.

M1–M10 fixes, S1–S9 resolutions and optional decisions are recorded in
[PROGRESS.md](../PROGRESS.md). Nine real trimmed regression cases include full
commit provenance and upstream license notices. Python 3.11.15 and 3.14.7 pass;
Ruff check and format check are clean.

## Scope

All GH001–GH012 rules plus GH000, full and patch inputs, basic text output and
provisional JSON v1 are implemented. JSON now exposes per-file classification.
Fixture minima still require two positives and two negatives per rule, including
patch coverage. Legitimate scenarios assert section 6's specified downgrades.

Phase 4 config-file loading, allow suppression, CLI selection/threshold flags,
explain, polished reports and schema freezing remain future work. Integrations,
Gate 2 labeled evaluation and publication remain behind their designated gates.
The handoff's own-history, local ImpossibleBench, METR and public-PR sources are
recorded; this revision only supplies the candidate exporter.

The ZIP contains source, docs, scripts and fixtures without virtual environments,
caches, Git internals or release tags. Nothing has been pushed or published.
