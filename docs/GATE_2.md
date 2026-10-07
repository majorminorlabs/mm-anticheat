# Gate 2 review

**Gate 2 released with reduced scope by Dippo on 2026-10-06.** M12/M13 and S10/S11 are fixed; the local
benchmark runner is built and validated. B1 stopped with 0 conflicting passes and 1 original pass from 120 recorded
attempts, including 49 Docker sample errors and three further snapshot failures.
B1 is invalid and excluded from metrics; its runner is retained, not rerun.
The revised B2 search scanned 393 commits in seven repositories and exported
54 unreviewed candidates with no errors.
See [the corpus run](corpus-run-20261006.md). Current real case counts and metrics
are in [real-world-eval.md](real-world-eval.md). Phase 5 is authorized; see the current status in PROGRESS.md.

The existing `dist/mm-anticheat-gate2.zip` is the historical `aaa9bd8` build
reviewed in REVIEW_02, with 143 fixtures. It has not been rebuilt as a released
Gate 2 package; the historical 40/15/15 criterion was waived for reduced-scope release. Current source
has 153 fixtures: 137 individual rule cases and 16 cross-rule cases.

## Reproduce

1. Use the current checkout, Python 3.11+ and the README install instructions.
   Ruff check/format and pytest pass: 363 tests on Python 3.11.15 and 3.14.7.
2. Run the classic-cheat patch demo (exit 1), clean-refactor patch (exit 0), and
   rule explanation:

   ```sh
   .venv/bin/mm-anticheat scan --diff tests/fixtures/cross/classic_cheat/diff.patch --format markdown
   .venv/bin/mm-anticheat scan --diff tests/fixtures/cross/clean_refactor/diff.patch --format json
   .venv/bin/mm-anticheat explain AC005
   ```

3. Run `.venv/bin/pytest -q -s -m performance`. Python 3.11 measurements: 0.194s
   for the 5,000-line full Git scan and 0.015s for hostile JS probes; limits are
   2s and 1s. The full suite also tests bounded malformed inline reasons.
4. Try `.anticheat.toml` from [the example](example-mm_anticheat.toml) in a scratch
   Git repository. Commit it before expecting it to allow findings. Git ranges
   load the resolved merge-base config; working/staged load HEAD. Patch input
   uses defaults or explicit --config. Config loosening flags high AC007 and
   cannot suppress its own audit. Integration tests cover all four modes,
   provenance, explicit overrides, malformed head config and tightening changes.
5. Check Python and JS inline allowances with a reason on the flagged or previous
   line. Preexisting mapped comments allow findings. An added comment gives
   medium AC012 and leaves its target active, with an explanation that approval
   applies after merge. Patch input honors only context comments. Missing reasons
   never suppress the flag.
6. Check text with/without a TTY and --no-color, quiet output, evidence limits,
   Markdown details and [JSON v3](json-v3.md). JSON retains complete findings even
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

The 2026-10-06 request is to stop and report counts after these corpus runs;
if fewer than ten conflicting samples pass, do not switch models or add splits.
The historical REVIEW_02 exit criteria below are retained for review context;
Dippo explicitly waived the labeled-corpus requirement for this release:

- M12/M13 fixtures, tests and Ruff pass; noise remains ≤10/680 with AC006 high 0.
- At least 40 complete labeled real cases, with ≥15 cheats and ≥15 honest.
- Per-case expected/actual and summary recall/FPR at default high; tagged
  out-of-scope cases remain visible and leave the recall denominator.
- Any tuning preserves existing fixtures and the noise baseline.

Integrations and release preparation proceed to Gate 3. B2 labeling continues
in parallel; no metrics are inferred from detector-selected candidates.
