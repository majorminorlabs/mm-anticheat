# Gate 2 review

Phases 0–4 are complete. Gate 1 was released after REVIEW_01b M11: empty stub
moves stay high, moves with fewer assertions become medium, substantive moves
stay info. The pinned baseline is 10/680 high commits and GH006 high 0, passing
the revised limit. Development stops here for REVIEW_02 and Dippo's labeled
real-world diffs before Phase 5 integrations.

The review package is `dist/goodhart-check-gate2.zip`. It contains source, docs,
scripts, both Gate 1 reviews and 143 fixtures, without environments, caches or Git
internals. The earlier Gate 1 ZIP is retained as the historical review snapshot.

## Reproduce

1. Extract the ZIP into a fresh directory. Use Python 3.11+ and the README install
   instructions. Ruff check/format and pytest pass: 316 tests, including 137 rule
   fixtures and six cross-rule cases.
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
   Git repository. Check repo-root discovery from a nested directory, explicit
   config overrides, rule selection, skips and fail thresholds. CLI integration
   tests also cover Git ranges, working changes, staged changes and stdin patches.
5. Check Python and JS inline allowances with a reason on the flagged or previous
   line. The original finding stays visible and allowed. An allow comment added
   in the diff still produces medium GH012; --fail-on medium fails unless GH012
   has its own config path allowance. Missing reasons never suppress the flag.
6. Check text with/without a TTY and --no-color, quiet output, evidence limits,
   Markdown details and [JSON v1](json-v1.md). JSON retains complete findings even
   with --quiet or a presentation evidence cap. Summary counts include allowed
   findings; exit codes exclude them. `--fail-on never` still prints findings.
7. Regenerate docs with `.venv/bin/python scripts/generate_rules.py`; the catalog
   must match [rules.md](rules.md). Reproduce the five pinned history scans in
   [noise-baseline.md](noise-baseline.md); no runtime network access is used.

## Review focus and remaining scope

M11 and Phase 4 decisions, fixture counts and limitations are recorded in
[PROGRESS.md](../PROGRESS.md). Exit codes are 0/1/3; usage errors never use 2.
The runtime dependency remains only unidiff. No packages, tags or repos have
been published.

Dippo supplies labeled examples from own history, local ImpossibleBench, METR
or public agent PRs under handoff v1.1 D6. Candidate extraction is available in
scripts/scan_history.py. These candidates remain unreviewed until labeled;
maintainer-history regression fixtures do not establish agent intent. Once data
arrives, add real fixtures and record expected/actual flags, hits/misses and notes
in docs/real-world-eval.md. Early returns, equal-count replacements and negated
platform gates remain v1.1 candidates. Integrations and release preparation are
unstarted.
