# Master research ledger

This ledger is chronological and append-oriented. It distinguishes engineering
validation from model-behavior evidence and records when history had to be
reconstructed. The machine-readable index is
[`experiments/index.json`](/Volumes/Research/research-model-mm/experiments/index.json).

## Historical pilot, reconstructed after the fact

The repository had no Git commit history when the initial work was performed.
The following manifests were reconstructed from the initial build report,
adapter configs, prediction files, and source manifest. They preserve known
values and leave unavailable timestamps, revisions, and commit IDs null.

| ID | Event | Status | Evidence boundary |
| --- | --- | --- | --- |
| E001 | Initial 480-row SciFact protocol/data pilot | completed | Engineering validation only; 480 accepted and 0 rejected under the earlier weak validator. |
| E002 | Qwen3-0.6B masked 512-token smoke | invalidated | NaN/non-finite loss after prompt masking and truncation removed assistant targets. Retained as a negative engineering result. |
| E003 | Qwen3-0.6B aligned MLX smoke | completed | Targeted structured-behavior change on a held-out SciFact-derived test; not a general research-capability result. |
| E004 | Qwen3-8B-class 4-bit MLX feasibility smoke | completed | Local memory/adapter feasibility only; not the primary Qwen3-8B-Base checkpoint. |
| E005 | Qwen3-8B-class 20-iteration MLX smoke | completed | Mixed controlled-microbenchmark result; 20 iterations and 10 cases are insufficient for broad claims. |

## Dataset and benchmark expansion

| ID | Event | Result |
| --- | --- | --- |
| E006 | `research-data-v0.1-alpha` | 3,547 accepted, 13 rejected; hash `8249bdf28ff2d34e64adbffd39dfed5aee0d7e40fa237179268700f829dc026c`. |
| E007 | `research-data-v0.1-expanded` | 25,269 accepted, 3,048 rejected (10.76%); hash `75283e511cb120bbb29fb95e13b7a26fa5f6b4f887ddf41079c50c4a96505cf1`. |
| E008 | `research-bench-v0.1` freeze | 248 independent controlled cases; hash `d44b8226ed8d5122ffedcb353761a9624917fb0bd6f6be60e5595799a0a5eb3e`. |
| E009 | `general-control-v0.1` freeze | 12 small retention prompts; hash `1be2dc5298066bb645ec49f48157de81c09a05579bab8679d87fa86723efbad5`. |

Strict validation rejected low-information SciFact rows and normalized
duplicates, exposing a quality signal that the original 0%-rejection pilot did
not measure. Benchmark contamination checks found zero exact question/context
overlaps, zero source-ID overlaps, and zero high-overlap question pairs for the
expanded candidate.

## Research protocol freeze

The research questions and hypotheses for the primary Qwen3-8B experiment were
frozen in
[`configs/research/primary_v0.1.json`](/Volumes/Research/research-model-mm/configs/research/primary_v0.1.json)
before the primary training run. No conclusion is written into that file.

## Future entries

The next IDs are reserved only when an actual baseline, control evaluation,
training run, evaluation, invalidation, or derived analysis is performed. A
future run must record its exact Git commit, immutable dataset/benchmark hashes,
model revisions, command, seed, environment, raw predictions, metrics, and
interpretation in a new manifest before it is treated as evidence.
