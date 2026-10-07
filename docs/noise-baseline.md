# Noise baseline — REVIEW_04

**21/1,430 commits (1.47%) flag high across ten pinned OSS repositories.**
AC006 high: 0. Scan errors: 0; rule errors: 0. The limit is ≤1.5% (at most 21 commits).

## Method and pins

Scan first-parent, non-merge commits at the pinned head against each first parent,
in full Git mode. Histories are read without checking out or executing repository
code. Every commit and finding is retained in docs/noise-results/*.json.

The original five pins are unchanged. REVIEW_04 did not supply the additional five
SHAs, so those repositories use newly pinned windows. This reproduces the requested
ten repositories and 1,430 commits, not an assumed identical reviewer window.

| Repository | Head | Commits | High | High/medium |
|---|---|---:|---:|---:|
| axios | `2b169bbb0cf67e6539e4cec222ced5ac8a923e00` | 150 | 0 | 7 |
| black | `eb8835829969f82c2567119f528b188769f3ac6d` | 150 | 0 | 1 |
| click | `06b2a678741131fd577ce170e23e5ca0aeba0309` | 80 | 1 | 4 |
| fastapi | `94918c1d40afb27065c64d523219ed2ad9822f76` | 150 | 1 | 3 |
| httpx | `b5addb64f0161ff6bfe94c124ef76f6a1fba5254` | 150 | 3 | 14 |
| ky | `0d59458a0a58e1c3d7c6db0ab17ed5c7cd671e47` | 150 | 2 | 5 |
| pydantic | `e87e11b7a74068c2d8107e48ffed6102744abef8` | 150 | 3 | 15 |
| rich | `9d8f9a372cc5916fd4781fec207ced7ddac2f08f` | 150 | 1 | 3 |
| vitest | `964e1a4404c31bf8fd37cb05ea0095483b506802` | 150 | 2 | 12 |
| zod | `0b216ef674e297ebe41d8bf902262e56f8755822` | 150 | 8 | 22 |

## M23 severity delta

Holding all other current rules fixed, downgrading AC005 and all-assertions-lost
AC004 findings to medium yields 19 high commits. Their severity promotion adds
**2 high commits** (0.14% of the window). AC004 contributes no
additional high commit here. AC005 fires in two maintainer commits:

- fastapi `1d4953d2e528b58cfb09bbc28fb25dcda227c6ea`: 🐛 Allow startup when automatic OpenTelemetry configuration fails (#16418). Positional assertion pairing can flag legitimate test rewrites.
- pydantic `69fd688e2d2d8e6fa25f2b2ec30781b52553a388`: Split stdlib types tests into dedicated test files (#13580). Positional assertion pairing can flag legitimate test rewrites.

## Precision regressions

The measured Vitest migration exposed an existing try/catch being treated as a newly
swallowed assertion. AC014 now compares existing wrappers; edits inside an existing
wrapper do not count as wrapping a previously unwrapped assertion. Constructed Python
and JS negative fixtures cover this. CI recognizes nub run test and filtered test:*
commands, including pnpm-to-nub migrations. Generated Python __pycache__ bytecode is
ignored; moving an existing test into that directory still blocks with AC001.

These maintainer findings measure review noise; they are not cheating labels.
No medium or low finding is hidden from the raw reports.

## Reproduction

Read docs/noise-pins-review04.json for the pinned windows. Clone the corresponding
upstream repositories and run, replacing the local path:

```sh
.venv/bin/python scripts/noise_check.py /path/to/repo COUNT --head SHA --json /tmp/noise.json
```
