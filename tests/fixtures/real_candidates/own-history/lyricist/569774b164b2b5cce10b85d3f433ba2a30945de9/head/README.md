# Lyricist: private small-model writing experiment

This repository trains a 1.7B base language model for narrow creative writing from the 106 Markdown works already present in `lyrics/`. It is a private experiment. The source files are immutable. Do not publish the corpus, adapters, or generated outputs without separate review.

## Current source and model

The actual checkout contains **106** Markdown works; the supplied prior audit expected 107. The current pipeline finds 21,652 lyric words, 30,507 Qwen tokenizer tokens, 3,384 content lines, 1,036 repeated-line occurrences and 61 repeated-section occurrences, nine training style anchors, and no exact duplicate works. Three source files carry notes about incomplete transcriptions. These figures come from the current files, not the earlier audit.

The selected base is [`Qwen/Qwen3-1.7B-Base`](https://huggingface.co/Qwen/Qwen3-1.7B-Base) at commit `ea980cb0a6c2ae4b936e82123acc929f1cec04c1`. It is a pretrained/base checkpoint near the 1.5B target, licensed Apache 2.0, with a Qwen3 tokenizer and architecture supported by current Transformers. PEFT LoRA targets `q_proj` and `v_proj`. The 3.44 GB base checkpoint and a small adapter fit practical local inference on a 32 GB Mac. The base model is not instruction tuned; prompt following must be measured, not assumed.

The model license governs the base checkpoint. The source lyrics are separate copyrighted material; this repo makes no claim that the base license covers them.

## Reproduce local preparation

From the repo root:

```sh
python3 -m scripts.pipeline
uv run --with pytest python -m pytest -q
```

`corpus/metadata/manifest.json` holds work IDs, SHA-256 hashes, split assignments, section labels, counts, and anchor flags. `corpus/metadata/stats.json` holds aggregate statistics and `token_stats.json` holds per-work tokenizer counts. `corpus/metadata/dataset_hashes.json` identifies the generated datasets. Raw source remains in `lyrics/`; `corpus/cleaned/` is generated and ignored by Git.

The split is by complete work: 84 train, 11 validation, 11 held out. All nine anchors are train-only. Exact repeated *sections* are collapsed in training representations to reduce refrain overweighting, while individual line repetition and punctuation are preserved. One work is sampled once per epoch during training, with a deterministic 75% generation / 25% raw-style representation choice. This does not invent new lyric ground truth. Generation prompts for SFT are deterministic transformations of source titles; that is a weak control signal and a known limitation.

`data/eval/prompts.json` contains 50 fixed prompts and is excluded from training. The evaluator reports length, duplicate lines, vocabulary and line length statistics, 5-gram overlap, nearest training work, and longest shared phrase. Its flags require human review. A shared phrase is not by itself proof of copying, and a clean flag is not proof of originality.

## Run B0 and training on CUDA

On the A40 pod used here, CUDA PyTorch 2.8.0+cu128 was preinstalled. Its object-backed `/workspace` mount did not permit package installation, so the run used `/root/lyricist` and copied verified artifacts to `/workspace/lyricist/outputs`. Create a virtual environment on local pod storage and install the pinned packages:

```sh
uv venv --system-site-packages .venv
uv pip install --python .venv/bin/python --no-deps -r config/requirements-a40.txt
.venv/bin/python -m scripts.evaluate --out outputs/b0
.venv/bin/python -m scripts.train --smoke --out outputs/smoke
.venv/bin/python -m scripts.train --out outputs/l1
.venv/bin/python -m scripts.evaluate --adapter outputs/l1/checkpoint-016 --out outputs/l1-eval-016
```

Evaluate every saved checkpoint, then choose the best with validation, prompt responsiveness, overlap diagnostics, and blind human reading. `scripts.train --resume --out outputs/l1` resumes from the saved optimizer and adapter. Training logs include step, epoch equivalent, loss, validation loss, learning rate, wall time, and available GPU utilization. The run manifest records checkpoint and dataset hashes.

For local inference, the chosen adapter is also converted to a local GGUF file at `models/best.gguf`. With `llama-cli` installed, run:

```sh
./writer 'write about returning somewhere unfamiliar' --length short --seed 42
```

The CLI prints only generated writing. `--mood`, `--form`, `--samples`, and `--temperature` are optional. Freeform is the default; form is only supplied when requested.

## Layout

- `lyrics/`: unmodified source Markdown
- `scripts/pipeline.py`: parser, statistics, splits, datasets
- `scripts/evaluate.py`: fixed prompt run and overlap diagnostics
- `scripts/train.py`: CUDA LoRA trainer
- `scripts/writer.py`: minimal local CLI
- `corpus/metadata/`: reproducible manifests and statistics
- `data/`: generated datasets and fixed evaluation prompts
- `outputs/`, `models/`: ignored run artifacts and weights
- `EXPERIMENTS.md`: run ledger and limitations

## Export and outcome

L1 step 48 is the selected adapter. Export used the pinned base and llama.cpp conversion at commit `11fe02151f79c41d0d4af7da708755d73b9c0da6`:

```sh
.venv/bin/python -m scripts.export --adapter outputs/l1/checkpoint-048 --out models/fused-048
python /path/to/llama.cpp/convert_hf_to_gguf.py models/fused-048 --outfile models/lyricist-048-f16.gguf --outtype f16
/path/to/llama.cpp/build/bin/llama-quantize models/lyricist-048-f16.gguf models/best.gguf Q4_K_M
```

`models/best.gguf` is already prepared locally; its SHA-256 is `90bbabf458f74c22e153d5c7d6df2cb06fa6600bb094f35d95299a63e0a1ab31`. Local `./writer` inference was tested with Homebrew llama.cpp. The automated evaluations and selected examples do **not** establish that L1 meets the creative-quality objective. See `EXPERIMENTS.md` for results and limitations.

## L2 short-passage experiment

L2 uses the same pinned base, work split, and 50 fixed prompts. `scripts.build_l2` deterministically extracts 2–8-line source passages and grounded prompts, recording exact source-line provenance. Only the 84 training works feed optimizer updates; the 11 validation and 11 held-out works supply separate loss probes. Rebuild and check the dataset from the repo root:

```sh
python3 -m scripts.build_l2
```

On the A40, use the virtual environment with Transformers installed to run full tokenizer QA, training, and evaluation:

```sh
.venv/bin/python -m scripts.qa_l2 --tokenizer
.venv/bin/python -m scripts.train_l2 --smoke --out outputs/l2-smoke
.venv/bin/python -m scripts.train_l2 --out outputs/l2
for n in 050 100 150 200 250; do
  .venv/bin/python -m scripts.evaluate --adapter outputs/l2/checkpoint-$n --out outputs/l2-eval-$n
done
.venv/bin/python -m scripts.eval_l2_loss --split heldout --out outputs/l2-comparison/b0-short-heldout.json
.venv/bin/python -m scripts.eval_l2_loss --adapter outputs/l1/checkpoint-048 --split heldout --out outputs/l2-comparison/l1-short-heldout.json
```

The best L2 checkpoint for **review** is step 50. Its adapter is `outputs/l2/checkpoint-050/`; the blind B0/L1/L2 packet and separate key are in `outputs/l2-blind-review/`. L2 produces more compact lines but loses prompt fit and frequently stops too early, so it did not pass the creative-quality gate. The current local CLI model remains the L1 `models/best.gguf`; no L2 GGUF was exported. All L2 outputs and adapters are ignored by Git and backed up on the pod's `/workspace/lyricist/outputs` mount. See `EXPERIMENTS.md` for complete metrics and the selection rationale.

## L3 grounded-prompt and length-diversity experiment

L3 uses the same pinned base, work split, style anchors, LoRA rank, and 50 fixed prompts. The tracked `corpus/metadata/l3_prompt_labels.json` contains build-time prompt labels and provenance; `corpus/metadata/l3_review_overrides.json` contains the 79-pair internal review decisions and prompt revisions. The original passage targets, raw local label responses, and review pairs stay in ignored private artifacts. Rebuild the dataset from the original `lyrics/` files and run the preflight checks:

```sh
python3 -m scripts.build_l3
.venv/bin/python -m scripts.qa_l3 --tokenizer
uv run --with pytest python -m pytest -q
```

The builder produces 224 train passages from all 84 training works, plus 24 validation and 22 held-out probes. The train dataset SHA-256 is `0ec0569d1310c1baf9ceafc679950bec4f653546c2610ce86137ea4630559b02`. On the existing A40 pod, the completed run used:

```sh
.venv/bin/python -m scripts.train_l3 --smoke --out outputs/l3-smoke
.venv/bin/python -m scripts.train_l3 --out outputs/l3 --stop-at 100
for n in 025 050 075 100; do
  .venv/bin/python -m scripts.evaluate --adapter outputs/l3/checkpoint-$n --out outputs/l3-eval-$n
done
python3 -m scripts.behavior_l3 --runs outputs/b0 outputs/l1-eval-048 outputs/l2-eval-050 outputs/l3-eval-025 outputs/l3-eval-050 outputs/l3-eval-075 outputs/l3-eval-100 --out outputs/l3-behavior-comparison.json
```

The same L3 held-out probes were scored for B0, L1, and L2-50 with `scripts.eval_l3_loss`; the L3 training log contains its own comparable held-out losses. `scripts.fuzzy_memorization` checked L3-50 against training works, and `scripts.blind_compare_l3` produced the private 50-prompt packet at `outputs/l3-blind-review/`. Detailed commands, selection rationale, limits, and metrics are in `EXPERIMENTS.md`.

L3 step 50 is the best L3 checkpoint for **review**, but it frequently stops too early; steps 75 and 100 worsen that behavior. Training stopped at 100, with no L3b run or GGUF export. **L1 step 48 remains the current best usable model**, and the creative-quality gate is still unmet. All L3 outputs and adapters are retained locally and on the pod's persistent `/workspace/lyricist` mount. The pod remains running.

## L4 weighted length sampling experiment

L4 reads the **unchanged L3 JSONL** and changes only passage sampling: very short `0.5x`, short `0.75x`, medium `1.5x`, longer `2.5x`. Its deterministic bucket draw balances repeated examples and works within each bucket. The original 224 passages, prompts, work split, model, LoRA/optimizer settings, and fixed generation suite are unchanged. On the A40, run the sampler and EOS/masking preflight, smoke, and early checkpoints with:

```sh
.venv/bin/python -m scripts.qa_l4 --out outputs/l4-sampler-preflight.json
.venv/bin/python -m scripts.train_l4 --smoke --out outputs/l4-smoke
.venv/bin/python -m scripts.evaluate --adapter outputs/l4-smoke/checkpoint-002 --limit 2 --out outputs/l4-smoke-eval
.venv/bin/python -m scripts.train_l4 --out outputs/l4 --stop-at 50
.venv/bin/python -m scripts.qa_l4 --trace outputs/l4/sample_trace.jsonl --out corpus/metadata/l4_sampler_qa.json
for n in 015 025 035 050; do
  .venv/bin/python -m scripts.evaluate --adapter outputs/l4/checkpoint-$n --out outputs/l4-eval-$n
done
```

`scripts.compare_l4` aggregates the existing B0/L1/L2/L3 runs with the four L4 evaluations into `corpus/metadata/l4_evaluation.json` and the 30-prompt medium/long detail in `corpus/metadata/l4_medium_long.json`. The conservative fuzzy audit for the review candidate is `outputs/l4-fuzzy-audit-035.json`; the separate-key four-way blind packet is `outputs/l4-blind-review/`.

L4 step 35 is the best **L4 review candidate**: it improves topic contact and restores substantially more complete responses than L3-50, but still misses several requests and stops below the medium/long minimum on 7 of 30 prompts. Step 50 collapses back to very short responses, so step 75 and L4b were not run. L4 did **not** clearly beat L1 or pass the creative-quality gate. No L4 GGUF was exported, and the local `models/best.gguf` remains L1. Full metrics, manual notes, and the next controlled experiment are in `EXPERIMENTS.md`.

## L5 explicit length-field exposure

L5 keeps L4's exact sample trace, model, optimizer, target passages, semantic prompts, held-out probes, and fixed evaluation. It changes only `length:` exposure in the 224 training examples: 179 carry the canonical field and 45 omit it, balanced near 80/20 in every target bucket. The 67/224 original count, original very-short label mismatch, deterministic selection, unchanged target hashes, token masking, and source checks are recorded in `corpus/metadata/l5_original_field_audit.json` and `corpus/metadata/l5_qa.json`. Regenerate the ignored dataset with `python3 -m scripts.build_l5`; its SHA-256 is `a5c3cb2ef60b1fae7e8d11a956c96935f518ae3fb047636000dc327937ca7608`.

The A40 smoke passed, and L5 checkpoints 15/25/35/50 were trained and evaluated on the original 50 prompts. The full comparison and per-requested-length breakdown are in `corpus/metadata/l5_evaluation.json`; no-length diagnostics and qualitative notes are in `corpus/metadata/l5_no_length.json` and `corpus/metadata/l5_qualitative_notes.json`. L5-35 is the best L5 writing-review candidate, but its 76% length adherence trails L4-35's 82%, and it does not clearly improve creative quality or beat L1. Step 50 contracts to short outputs; step 75 and L5b did not run. The L1 GGUF and `writer` remain unchanged. A separate-key blind packet and retained adapters are in ignored `outputs/l5-blind-review/` and `outputs/l5/`, with copies on the pod's persistent mount. See `EXPERIMENTS.md` for the decision and limits.

## L6 terminal EOS loss experiment

L6 keeps L5's dataset and L4's exact 50-step sample trace. It changes only the supervised loss coefficient of the single terminal target EOS token to `0.25`; ordinary target tokens retain their original cross-entropy coefficient and denominator. The audit found no EOS masking or padding bug. A two-update weight-`1.0` control reproduced L5 smoke losses, sample trace, and adapter hashes exactly. The `0.25` A40 smoke passed forward/backward, save/reload, fresh-process evaluation, and persistent-copy checks.

```sh
.venv/bin/python -m scripts.audit_l6_eos --out corpus/metadata/l6_eos_audit.json
.venv/bin/python -m scripts.train_l6 --out outputs/l6 --stop-at 50 --terminal-eos-loss-weight 0.25
for n in 015 025 035 040 045 050; do
  .venv/bin/python -m scripts.evaluate_l6 --adapter outputs/l6/checkpoint-$n --out outputs/l6-eval-$n
done
```

The six checkpoints and fixed 50-prompt comparison are in `corpus/metadata/l6_evaluation.json`; EOS positions and 10-prompt raw probability curves are in `corpus/metadata/l6_eos_diagnostics.json`. L6-40 is the best L6 candidate for blind writing review, with 80% length adherence and 2/30 medium/long responses below minimum. It has unresolved prompt failures and does not clearly beat L4-35 or L1-48. L6 still shortens sharply by steps 45–50, so steps 60/75 and L6b did not run. The separate-key L1/L4/L6 packet is `outputs/l6-blind-review-040/`. L1 remains the current model; no L6 GGUF or `writer` change was made. Adapters and evaluation outputs are retained locally and on the pod's persistent `/workspace/lyricist/outputs` mount. See `EXPERIMENTS.md` for the evidence and decision.

## L7 blind quality evaluation

L7 trains nothing. It compares saved B0, L1-48, L3-25, L4-35, L5-35, and L6-40 outputs on the unchanged 50 prompts. Their prompt SHA, generation configuration, and per-prompt seeds were verified identical before the 300-response packet was frozen. The rubric and prompt-type definitions in `corpus/metadata/l7_blind_rubric.md` and `l7_prompt_types.json` were committed before scoring. A local Mistral Small 3.2 24B judge scored each anonymous response in a fresh request and then made 150 independent anonymous pairwise judgments; the two answer keys stayed separate until all results validated. The packets, raw ratings, keys, and runtime record are in `corpus/metadata/l7_blind/`; aggregates and a judge-consistency audit are in `corpus/metadata/l7_*.json`.

This single model judge ranked B0 highest by mean style, utility, and overall quality. Among trained checkpoints, L6-40 had the highest mean utility, while L4-35 and L6-40 tied on mean overall quality. The pairwise pass favored L1 over L4 and L6 among non-ties, but had 30 and 32 ties out of 50. A focused constraint audit found failures missed by the judge, so these ratings are **provisional, not human preference evidence**. No later checkpoint clearly earns promotion; L1 remains the current model and no new GGUF was made. `EXPERIMENTS.md` gives the full table, prompt regimes, failure counts, limitations, and one proposed next experiment. The new A40 pod was not used or changed during L7.

## L8 constraint-prompt experiment

L8 added 63 internally reviewed, train-work-only negative or relational prompt variants to the unchanged L5 targets. Rebuild the ignored derived file after the normal pipeline and L5 preparation with `python3 -m scripts.build_l8`; then run `python3 -m scripts.qa_l8`. The reviewed provenance and validation records are `corpus/metadata/l8_constraint_*.json`, and the actual 50-step sample trace and exposure audit are in `l8_qa.json`. The A40 run used the fixed L6 recipe and exactly 25% constraint-example exposure. Checkpoints 15/25/35/40/50 and raw evaluations are retained in ignored local `outputs/l8/` and `outputs/l8-eval-*/`.

L8-40 was the strongest L8 diagnostic candidate, but it tied L1-48 and L6-40 at 4/17 fixed constraint passes and scored 2/20 on new constraints, equal to L6 and below L1's 3/20. It did not pass the creative-quality gate. L1 remains the current model; no L8 GGUF or L8b run was made. The full results, qualitative limits, memorization check, and blinded review packet are recorded in `EXPERIMENTS.md` and `corpus/metadata/l8_blind_review/`. All L8 run artifacts were copied locally and checked before the A40 pod was deleted; earlier pod-state descriptions are historical.

## L9 balanced constraint preparation

L9 replaces L8's auxiliary pool with 85 reviewed train-only prompt variants: 18 lexical, 32 spatial/relation, 25 indirect/exclusion, and 10 mixed. It keeps the L6 recipe, unchanged L5 targets, L4 sampling weights, and 25% constraint exposure. After `python3 -m scripts.pipeline` and `python3 -m scripts.build_l5`, regenerate the ignored derived set with `python3 -m scripts.build_l9` and check it with `python3 -m scripts.qa_l9`. The proposal, adversarial review, final provenance, dataset hash, and full balance report are in `corpus/metadata/l9_*.json`.

**L9 has not been trained.** The replacement A40 connection is the remaining prerequisite. [L9_RUNBOOK.md](L9_RUNBOOK.md) records the exact smoke, training, fixed50, unchanged novel20, qualitative, and memorization commands and the required artifact-copy check. No L9 adapter, evaluation, GGUF, or promotion decision exists yet; L1 remains the current model.
