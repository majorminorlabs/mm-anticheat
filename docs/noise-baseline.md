# Noise baseline — REVIEW_03

Measured 2026-10-07 on Python 3.14.7 after M14–M18 and S12–S17.
**Gate limit passes: 10/680 high-flagged commits; AC006 high 0; errors 0.**
High/medium flagged commits fall from 42 to 31. These are maintainer histories
used to measure review noise; findings do not establish cheating.

## Method and comparison

Scan the newest N first-parent, non-merge commits at each pinned head against
its first parent in full mode. All 680 rows are retained; each script exits 0,
with no scan error, rule-error diagnostic or stderr. Four AC000 info findings
concern binary content. Rescanning reads Git snapshots and never executes tests.

The 2026-10-05 REVIEW_02 and 2026-10-06 Phase 5 baseline had the same 10 high
commits and AC006 high 0. The high commit set is unchanged. Medium noise is
reduced by the reviewed same-diff expectation and small-integer policy; no
repository- or commit-specific exception was introduced. The five complete
JSON/text/stderr reports below replace the old saved reports with this rerun.

## Pins and results

| Repository | Full pinned SHA | Commits | With high | With high or medium |
|---|---|---:|---:|---:|
| pallets/click | `06b2a678741131fd577ce170e23e5ca0aeba0309` | 80 | 1 | 2 |
| encode/httpx | `b5addb64f0161ff6bfe94c124ef76f6a1fba5254` | 150 | 3 | 7 |
| sindresorhus/ky | `0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47` | 150 | 2 | 4 |
| pydantic/pydantic | `e87e11b7a74068c2d8107e48ffed6102744abef8` | 150 | 2 | 11 |
| vitest-dev/vitest | `964e1a4404c31bf8fd37cb05ea0095483b506802` | 150 | 2 | 7 |
| **Total** | | **680** | **10** | **31** |

## Reproduce

Install the project editable into .venv. Clones must contain the pinned heads
and their complete windows. The head need not be checked out. The script exits
3 for missing/incomplete history, scan errors or rule errors. For example:

```sh
.venv/bin/python scripts/noise_check.py /path/to/click 80 --head 06b2a678741131fd577ce170e23e5ca0aeba0309 --json /tmp/click-noise.json
.venv/bin/python scripts/noise_check.py /path/to/httpx 150 --head b5addb64f0161ff6bfe94c124ef76f6a1fba5254 --json /tmp/httpx-noise.json
.venv/bin/python scripts/noise_check.py /path/to/ky 150 --head 0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47 --json /tmp/ky-noise.json
.venv/bin/python scripts/noise_check.py /path/to/pydantic 150 --head e87e11b7a74068c2d8107e48ffed6102744abef8 --json /tmp/pydantic-noise.json
.venv/bin/python scripts/noise_check.py /path/to/vitest 150 --head 964e1a4404c31bf8fd37cb05ea0095483b506802 --json /tmp/vitest-noise.json
```

## Checks

| Check | Result |
|---|---|
| High commits ≤10/680 | 10/680 |
| AC006 high | 0 |
| AC009 high from plain CI checks | 0 |
| Complete window | 680/680 |
| Scan / rule errors / stderr lines | 0 / 0 / 0 |
| Regression suite | 412 tests on Python 3.11.15 and 3.14.7 |
| Ruff check/format | Pass |

## Findings by rule and severity

Counts are findings rather than commits. Missing combinations are zero.

| Rule | Severity | Click | HTTPX | Ky | Pydantic | Vitest | Total |
|---|---|---:|---:|---:|---:|---:|---:|
| AC000 | info | 0 | 2 | 0 | 0 | 2 | 4 |
| AC001 | high | 0 | 0 | 1 | 0 | 2 | 3 |
| AC001 | info | 0 | 0 | 0 | 5 | 0 | 5 |
| AC001 | medium | 0 | 1 | 0 | 3 | 0 | 4 |
| AC002 | high | 1 | 8 | 1 | 2 | 2 | 14 |
| AC002 | info | 0 | 2 | 0 | 0 | 0 | 2 |
| AC002 | medium | 0 | 1 | 0 | 2 | 0 | 3 |
| AC003 | low | 2 | 0 | 1 | 22 | 1 | 26 |
| AC003 | medium | 0 | 0 | 0 | 13 | 0 | 13 |
| AC004 | medium | 1 | 1 | 0 | 3 | 0 | 5 |
| AC005 | medium | 0 | 0 | 0 | 1 | 0 | 1 |
| AC006 | low | 0 | 2 | 0 | 18 | 5 | 25 |
| AC006 | medium | 0 | 1 | 0 | 6 | 0 | 7 |
| AC008 | low | 0 | 0 | 3 | 0 | 38 | 41 |
| AC008 | medium | 0 | 0 | 5 | 0 | 27 | 32 |
| AC009 | medium | 0 | 0 | 0 | 0 | 1 | 1 |
| AC010 | low | 7 | 5 | 51 | 38 | 11 | 112 |
| AC011 | info | 0 | 0 | 0 | 0 | 2 | 2 |

## Every remaining high-flagged commit

Inspection is about what the diff removes, not the author's intent. Legitimate
maintenance can still trigger the specified high rule. In particular, the Ky API
rename and Vitest cache rewrite can replace coverage under different names; the
name-based move heuristic cannot prove equivalence. A review policy change would
be needed to reduce these without repository/commit-specific exceptions.

| Repository / commit | High rule(s) | One-line justification |
|---|---|---|
| pallets/click [c3535905](https://github.com/pallets/click/commit/c3535905c77a29afc84861b29d3ad366ce5451bd) | AC002 ×1 | Removed test_fish_multiline_help_complete while fixing fish completion; the removed name is not added elsewhere. |
| encode/httpx [1805ee0d](https://github.com/encode/httpx/commit/1805ee0d22f96e2b29f0500dd3076e10020004bf) | AC002 ×1 | Removed SSLContext repr and certifi lazy-loading tests during the 0.28 upgrade/deprecation change. |
| encode/httpx [eeb5e3c2](https://github.com/encode/httpx/commit/eeb5e3c2a3ff2403ec47b5926715ecd61143d92d) | AC002 ×1 | Explicit cleanup removes the redundant test_netrc_auth_nopassword case. |
| encode/httpx [8e36f2bc](https://github.com/encode/httpx/commit/8e36f2bc685dfbe43cd7503bc1c422a6ed6e05a5) | AC002 ×6 | SSLContext API/deprecation change removes old proxy, URL, ASGI, WSGI, config and utility tests. |
| sindresorhus/ky [1f2ad7f2](https://github.com/sindresorhus/ky/commit/1f2ad7f20dcb778a4f0758432e8a8eb5c597a3e9) | AC001 ×1 | Old prefixUrl test file is deleted during the prefix/baseUrl API rename; replacement names differ. |
| sindresorhus/ky [433febd5](https://github.com/sindresorhus/ky/commit/433febd55cc19c98c7a643be934693927ac38503) | AC002 ×1 | Removed throwHttpErrors original-type hook test as normalized hook options changed. |
| pydantic/pydantic [de3175c1](https://github.com/pydantic/pydantic/commit/de3175c15a9b3e60c70233e3ad3372500257d353) | AC002 ×1 | Five build tests migrate, but test_schema_as_string is deleted rather than moved; AC002 flags that one loss. |
| pydantic/pydantic [b75fadba](https://github.com/pydantic/pydantic/commit/b75fadbaa55d4d700a388f1b67683ef0be0ed540) | AC002 ×1 | Removed test_is_none_type together with the type-lookup refactor. |
| vitest-dev/vitest [9673c49a](https://github.com/vitest-dev/vitest/commit/9673c49a40535529db6042df7176f123e95bb8f5) | AC001 ×2, AC002 ×1 | Cache rewrite deletes two cache fixture test files and old sequencer cases; their names are not retained elsewhere. |
| vitest-dev/vitest [5dbebe9e](https://github.com/vitest-dev/vitest/commit/5dbebe9e3b8758fe97d233eb9718a3664cd0b9c3) | AC002 ×1 | Removed should not reset retry count while correcting repeats result-status isolation. |

## Saved output and regressions

Complete machine-readable results and refreshed summary output are included:

- pallets/click: [JSON](noise-results/click.json), [text](noise-results/click.txt), [stderr](noise-results/click.stderr) (empty).
- encode/httpx: [JSON](noise-results/httpx.json), [text](noise-results/httpx.txt), [stderr](noise-results/httpx.stderr) (empty).
- sindresorhus/ky: [JSON](noise-results/ky.json), [text](noise-results/ky.txt), [stderr](noise-results/ky.stderr) (empty).
- pydantic/pydantic: [JSON](noise-results/pydantic.json), [text](noise-results/pydantic.txt), [stderr](noise-results/pydantic.stderr) (empty).
- vitest-dev/vitest: [JSON](noise-results/vitest.json), [text](noise-results/vitest.txt), [stderr](noise-results/vitest.stderr) (empty).

Nine trimmed source cases are under `tests/fixtures/GH*/real_*` with full
commit SHAs, subjects, original paths and trimming notes in `meta.toml`.
They cover AVA serial calls, quote formatting, getType formatting, test movement,
empty init and benchmark helpers, module version gates, help text and bare catch.
Upstream license notices are preserved in [fixture-licenses](fixture-licenses/).
Synthetic named probes and CLI/crash/hostile-input tests cover the other review
cases. See [PROGRESS.md](../PROGRESS.md) for each M/S resolution.
