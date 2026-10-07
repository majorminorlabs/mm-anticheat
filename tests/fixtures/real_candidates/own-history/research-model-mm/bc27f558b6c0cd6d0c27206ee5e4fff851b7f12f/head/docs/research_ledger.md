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
| E010 | Untuned 8B-class frozen-benchmark baseline attempt | Failed/incomplete after approximately 13.5 minutes; interrupted before final metrics. No model-quality result. The retry path now checkpoints per-example outputs. |
| E011 | Untuned 8B-class frozen-benchmark baseline completed | 248 cases; structured validity 0.000, action accuracy 0.173, citation precision/recall 0.167/0.169, evidence recall 0.839, unsupported-claim rate 0.714. Local MLX feasibility evidence only; 96-token cap and non-primary model are recorded limitations. |
| E012 | 8B-class expanded-dataset MLX LoRA training | Completed 200 iterations on 25,269 strict-validated rows; validation/test loss 1.389/1.401, perplexity 4.061, peak memory 6.597 GB. Adapter and checkpoints at iterations 100 and 200 were written. |
| E013 | Matched tuned-vs-untuned 8B-class benchmark and control comparison | Structured validity improved 0.000→0.859 and unsupported-claim rate fell 0.714→0.129; action accuracy moved 0.173→0.202, evidence recall 0.839→0.831. Small general control retained 1.0 nonempty output and 0.0 forbidden violations. Local feasibility evidence only. |

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

## E014 preregistration, 2026-09-16

| ID | Event | Status | Evidence boundary |
| --- | --- | --- | --- |
| E014 | Primary `Qwen/Qwen3-8B-Base` research-behavior QLoRA preregistration | planned — `READY_FOR_COMPUTE` | Frozen dataset, benchmark, control, config, analysis criteria, exact revision, and launch/resume commands are recorded in [`experiments/E014_qwen3_8b_primary_qlora/manifest.json`](/Volumes/Research/research-model-mm/experiments/E014_qwen3_8b_primary_qlora/manifest.json). No primary baseline, training, or evaluation has run; local NVIDIA CUDA is unavailable. No paid compute was started. |

## Future entries

E014 is reserved for the preregistration required before the primary run. No
result-bearing experiment should be treated as complete until its exact Git
commit, immutable dataset/benchmark hashes, model revisions, command, seed,
environment, raw predictions, metrics, and interpretation are recorded under
the append-only evidence policy. Future unrelated IDs are reserved when an
actual baseline, control evaluation, training run, evaluation, invalidation, or
derived analysis is performed.
