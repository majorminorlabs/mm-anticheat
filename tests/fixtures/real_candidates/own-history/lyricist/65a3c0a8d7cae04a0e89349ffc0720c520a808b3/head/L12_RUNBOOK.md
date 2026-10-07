# L12 Qwen3 capacity experiment

Private run. No corpus or weights may be pushed. The only intervention is the
base checkpoint: `Qwen/Qwen3-4B-Base` at
`906bfd4b4dc7f14ee4320094d8b41684abff8539` (Apache 2.0). The frozen
1.7B baseline remains in `config/experiment.json`. The model card reports
4.0B parameters; the pinned index reports 8,045,591,552 bytes of bf16 weights.
The 4B architecture has 36 layers, hidden width 2560, 32 query heads and 8
KV heads. `q_proj` and `v_proj` remain valid LoRA targets. Its tokenizer
vocabulary and EOS ID 151643 match the 1.7B tokenizer. The code uses raw
`format_prompt` strings and never applies the repository chat template.

Run `python3 -m scripts.pipeline` and `python3 -m scripts.build_l5` first.
Then run `uv run --python 3.12 --with 'transformers==4.57.6' --with
'huggingface-hub==0.36.0' python -m scripts.qa_l12` and
`uv run --python 3.12 --with pytest python -m pytest -q` locally.
The preflight verifies the L6 actual trace, dataset hashes, target tokens,
bucket exposure, prompt tokens, EOS and masking. Base weights are not needed.

The A40 image is `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404`. On the
pod, use `uv venv --system-site-packages .venv`, install
`config/requirements-l9-a40.txt` with `uv pip install --no-deps`, and retain
the image's CUDA Torch. Copy only private code, derived data and source needed
for audits over SSH; keep credentials outside the repo. Run the complete GPU
pytest suite before training. The local estimate is 7.493 GiB bf16 weights,
roughly 20–30 GiB conservative VRAM and at least 30 GiB disk including cache,
optimizer and five adapters; smoke measures actual allocation.

```sh
.venv/bin/python -m scripts.train_l12 --smoke --out outputs/l12-smoke
.venv/bin/python -m scripts.evaluate_l6 --model-id Qwen/Qwen3-4B-Base --model-revision 906bfd4b4dc7f14ee4320094d8b41684abff8539 --adapter outputs/l12-smoke/checkpoint-002 --limit 2 --out outputs/l12-smoke-eval
.venv/bin/python -m scripts.evaluate_l6 --model-id Qwen/Qwen3-4B-Base --model-revision 906bfd4b4dc7f14ee4320094d8b41684abff8539 --limit 2 --out outputs/l12-base-smoke-eval
.venv/bin/python -m scripts.train_l12 --out outputs/l12 --stop-at 50
.venv/bin/python -m scripts.evaluate_l6 --model-id Qwen/Qwen3-4B-Base --model-revision 906bfd4b4dc7f14ee4320094d8b41684abff8539 --out outputs/l12-base-eval
for n in 015 025 035 040 050; do
  .venv/bin/python -m scripts.evaluate_l6 --model-id Qwen/Qwen3-4B-Base --model-revision 906bfd4b4dc7f14ee4320094d8b41684abff8539 --adapter outputs/l12/checkpoint-$n --out outputs/l12-eval-$n
done
```

The L6 optimizer, schedule, rank 8, effective batch 8, cap 384, peak LR
`6e-5`, terminal EOS weight 0.25, L5 rows, L4 sample order and fixed50
generation are unchanged. L12 saves steps 15/25/35/40/50 only. Use the
optional `--model-id` and `--model-revision` pair with `scripts.eval_l3_loss`,
`scripts.evaluate_l9_novel` and `scripts.l10_continuation` for the 4B base.

Select exactly one checkpoint by fixed50 behavior, memorization and direct
reading before creating or scoring the blind packet. Record the selection
timestamp and adapter SHA. `scripts.blind_quality_l12` compares B0, L1-48,
L6-40, the untouched 4B base, and selected L12 under the frozen L7 rubric.
`scripts.analyze_blind_l12` verifies complete anonymous records before opening
the keys. Its five pairings total 250 independent judgments.

Before deleting the pod, copy every adapter, generation, manifest, trace,
audit, log and hash file locally and compare recursive SHA-256 manifests.
Then delete the pod and verify `runpodctl pod list` returns `[]`.
