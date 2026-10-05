# Gate 2 review

**Gate 2 remains open after REVIEW_02.** M12/M13 and S10/S11 are fixed; the local
benchmark runner is built and validated. Actual B1 runs need the selected Ollama
model, and B2 needs Dippo's repository paths. Current real case counts and metrics
are in [real-world-eval.md](real-world-eval.md). Phase 5 has not started.

The existing `dist/goodhart-check-gate2.zip` is the historical `aaa9bd8` build
reviewed in REVIEW_02, with 143 fixtures. It has not been rebuilt as a released
Gate 2 package while the real-corpus exit criterion remains unmet. Current source
has 153 fixtures: 137 individual rule cases and 16 cross-rule cases.

## Reproduce

1. Use the current checkout, Python 3.11+ and the README install instructions.
   Ruff check/format and pytest pass: 363 tests on Python 3.11.15 and 3.14.7.
2. Run the classic-cheat patch demo (exit 1), clean-refactor patch (exit 0), and
   rule explanation:

   ```sh
   .venv/bin/goodhart scan --diff tests/fixtures/cross/classic_cheat/diff.patch --format markdown
   .venv/bin/goodhart scan --diff tests/fixtures/cross/clean_refactor/diff.patch --format json
   .venv/bin/goodhart explain GH005
   ```

3. Run `.venv/bin/pytest -q -s -m performance`. Python 3.11 measurements: 0.194s
   for the 5,000-line full Git scan and 0.015s for hostile JS probes; limits are
   2s and 1s. The full suite also tests bounded malformed inline reasons.
4. Try `.goodhart.toml` from [the example](example-goodhart.toml) in a scratch
   Git repository. Commit it before expecting it to allow findings. Git ranges
   load the resolved merge-base config; working/staged load HEAD. Patch input
   uses defaults or explicit --config. Config loosening flags high GH007 and
   cannot suppress its own audit. Integration tests cover all four modes,
   provenance, explicit overrides, malformed head config and tightening changes.
5. Check Python and JS inline allowances with a reason on the flagged or previous
   line. Preexisting mapped comments allow findings. An added comment gives
   medium GH012 and leaves its target active, with an explanation that approval
   applies after merge. Patch input honors only context comments. Missing reasons
   never suppress the flag.
6. Check text with/without a TTY and --no-color, quiet output, evidence limits,
   Markdown details and [JSON v2](json-v2.md). JSON retains complete findings even
   with --quiet or a presentation evidence cap. Summary counts include allowed
   findings and show the allowed subset; exit codes exclude them. Config source
   appears in the header and JSON. `--fail-on never` still prints findings.
7. Regenerate docs with `.venv/bin/python scripts/generate_rules.py`; the catalog
   must match [rules.md](rules.md). Reproduce the five pinned history scans in
   [noise-baseline.md](noise-baseline.md); no runtime network access is used.

## Review focus and remaining scope

M11, M12/M13 and Phase 4 decisions, fixture counts and limitations are recorded in
[PROGRESS.md](../PROGRESS.md). Exit codes are 0/1/3; usage errors never use 2.
The runtime dependency remains only unidiff. No packages, tags or repos have
been published.

Follow [the local corpus instructions](impossiblebench-local.md) for B1 and B2.
Benchmark-defined labels are automatic; history candidates remain unreviewed
until independently labeled. Maintainer-history regressions and synthetic smoke
cases do not count as real evaluation data. Reviewer-tagged early returns,
equal-count replacements and grader tampering can be marked out-of-scope-v1.1;
the builder does not assign scope tags to hide misses.

Before stopping for REVIEW_02b, require all of REVIEW_02's exit criteria:

- M12/M13 fixtures, tests and Ruff pass; noise remains ≤10/680 with GH006 high 0.
- At least 40 complete labeled real cases, with ≥15 cheats and ≥15 honest.
- Per-case expected/actual and summary recall/FPR at default high; tagged
  out-of-scope cases remain visible and leave the recall denominator.
- Any tuning preserves existing fixtures and the noise baseline.

Integrations and release preparation remain unstarted.
