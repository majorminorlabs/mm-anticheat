# L10 raw-CPT then behavioral-SFT experiment

Status: experiment complete. The replacement NVIDIA A40 pod `jam6oremg8ebxc` was deleted after all 194 pod files were locally SHA-256 verified. The completed 250-response/200-pair blind model review and no-promotion decision are recorded in `EXPERIMENTS.md` and `corpus/metadata/l10_*.json`. Private experiment: do not publish source, generations, adapters, or credentials.

## Frozen data and intervention

- Base: `Qwen/Qwen3-1.7B-Base` revision `ea980cb0a6c2ae4b936e82123acc929f1cec04c1`; same tokenizer and EOS as prior runs.
- CPT source: exactly the 84 complete train works from `corpus/metadata/manifest.json`. The 11 validation and 11 heldout works supply only independent raw-LM and continuation probes. Fixed prompts never enter the optimizer. `scripts.build_l10_cpt` creates ignored raw and packed JSONL and tracked aggregate statistics/hashes. `scripts.qa_l10` verifies exact source reconstruction, split isolation, EOS boundaries, and behavioral input hashes.
- Raw text inherits `scripts.pipeline.parse` UTF-8 BOM decoding, NFC, newline normalization, right trim of each source line and outer trim. Bracketed transcript section headings are removed; actual writing lines, internal stanza breaks, punctuation, capitalization, and repeated sections remain. There are no prompts or artificial document markers. Each work ends with the model's native EOS. Train documents are shuffled once with seed `314169`, then packed across EOS into chunks of at most 512 tokens. Validation and heldout documents never cross a work boundary.
- CPT LoRA rank 8, alpha 16, dropout 0.1 on `q_proj` and `v_proj`; batch 2 with up to four microbatches per update (effective 8, final partial update 3); AdamW decay 0.01, peak LR `2e-5`, no warmup and linear decay over six updates. Standard unweighted shifted causal-LM cross entropy. One corpus pass, no repeat or SFT examples. Saved steps 1/3/4/6 map to 0.187/0.560/0.747/1.000 supervised-token passes. Token loss on all train/validation/heldout chunks is computed at every checkpoint.
- C2 merges exactly one **preselected** CPT adapter into the pinned base in bf16, freezes that merged state, then starts a fresh L6 rank-8 adapter. `scripts.train_l10_c2` uses unchanged L5 behavioral rows, L4 sampler and 50-step plan, effective batch 8, cap 384, LR `6e-5`, terminal EOS weight 0.25. It has no L8/L9 auxiliary data. Saved steps 15/25/35/40/50. The original L6 scheduler's 200-step horizon is retained for comparability.
- Baselines B0, L1-48, and L6-40 use saved fixed50 generations and unchanged 22-probe heldout behavioral losses; no retraining. Generation uses the original seeds and settings. C2 comparison includes all five checkpoints.

## Local preflight

```sh
python3 -m scripts.pipeline
python3 -m scripts.build_l5
uv run --python 3.12 --with 'transformers==4.57.6' --with 'huggingface-hub==0.36.0' python -m scripts.build_l10_cpt
uv run --python 3.12 --with 'transformers==4.57.6' --with 'huggingface-hub==0.36.0' python -m scripts.qa_l10
uv run --python 3.12 --with pytest python -m pytest -q
```

## A40 sequence

Provision a secure A40 with SSH only after local preflight. Use the PyTorch 2.8.0 + CUDA 12.8 template and install `config/requirements-l9-a40.txt` with `uv pip install --no-deps` into a `--system-site-packages` virtual environment, preserving the image's CUDA Torch. Copy the private checkout and ignored derived inputs by SSH; never place credentials in the repo. Check CUDA, package versions, data hashes, and available disk first.

```sh
.venv/bin/python -m scripts.train_l10_cpt --smoke --out outputs/l10-cpt-smoke
.venv/bin/python -m scripts.evaluate_l6 --adapter outputs/l10-cpt-smoke/checkpoint-002 --limit 2 --out outputs/l10-cpt-smoke-eval
.venv/bin/python -m scripts.train_l10_cpt --out outputs/l10-cpt
for n in 001 003 004 006; do
  .venv/bin/python -m scripts.evaluate_l6 --adapter "outputs/l10-cpt/checkpoint-$n" --out "outputs/l10-cpt-eval-$n"
done
```

At every CPT checkpoint, run full raw-source fuzzy/exact audits and the short-prefix heldout/train continuation probe. Review train/validation/heldout raw-LM loss, fixed50 behavior, and memorization **before** writing `outputs/l10-cpt-selection.json`. The selection file must bind the chosen step and adapter SHA-256, with an explicit reason and risk note. Prefer the earliest useful checkpoint. Then:

```sh
.venv/bin/python -m scripts.merge_l10_cpt --adapter outputs/l10-cpt/checkpoint-NNN --selection outputs/l10-cpt-selection.json --out outputs/l10-merged-cpt
.venv/bin/python -m scripts.train_l10_c2 --base-path outputs/l10-merged-cpt --smoke --out outputs/l10-c2-smoke
.venv/bin/python -m scripts.train_l10_c2 --base-path outputs/l10-merged-cpt --out outputs/l10-c2 --stop-at 50
for n in 015 025 035 040 050; do
  .venv/bin/python -m scripts.evaluate_l6 --base-path outputs/l10-merged-cpt --adapter "outputs/l10-c2/checkpoint-$n" --out "outputs/l10-c2-eval-$n"
done
```

The exact inference composition is `outputs/l10-merged-cpt` plus one fresh C2 adapter. `scripts.eval_l3_loss` accepts `--base-path` for comparable 22-probe behavioral loss. The best C2 checkpoint is selected from fixed50 quality, utility and safety before secondary constraints. Generate novel20 using `scripts.evaluate_l9_novel --base-path`; use `scripts.audit_l8_constraints` for the fixed17 review packet. Run full-source exact/fuzzy and continuation checks on the best CPT-only and best C2, with L1/L6 comparisons.

If a later promotion gate passes, fuse the same composition with `python -m scripts.export --base-path outputs/l10-merged-cpt --adapter outputs/l10-c2/checkpoint-040 --out models/l10-fused-040`, then use the existing llama.cpp GGUF conversion and local `writer` verification flow. Preserve the L1 GGUF rollback.

The frozen L7 rubric is reused by `scripts.blind_quality_l10` and `scripts.analyze_blind_l10`: five anonymous models, 250 independent ratings, 200 blinded pairs across the four requested comparisons, separate keys, same local judge model and seed. Report these as model judgments, not human ratings. Explanatory/narrative prose, editor/meta language, and theme explanation receive a separate manual drift review.

## Recovery and shutdown

Before pod deletion, copy locally all CPT/C2 adapter directories, the merged bf16 base, smoke outputs, traces, loss/evaluation outputs, prompts, manifests, hash files, and logs. Create a recursive SHA-256 manifest on the pod and verify identical local hashes. Only then delete the pod and confirm `runpodctl pod list` is empty. Commit code and lightweight statistics/decisions, not weights, raw data, outputs with lyrics, credentials, or the merged model. No push.

Actual execution used RunPod Torch `2.8.0+cu128`, Transformers `4.57.6`, and PEFT `0.21.2`. The local preflight had 27 passed and 3 skipped tests; the pod had all 30 passed. CPT and C2 each passed a separate two-update smoke and fresh-process two-prompt generation. CPT completed six updates in 15.83 seconds; C2 completed 50 updates in 43.64 seconds with the exact L6 50-step sample trace. CPT step 3 was selected before C2 and merged into the base. The selected C2 review checkpoint is step 40. `corpus/metadata/l10_artifact_integrity.json` records adapter/model hashes and the verified recovery manifest. The final `runpodctl pod list` returned `[]`.
