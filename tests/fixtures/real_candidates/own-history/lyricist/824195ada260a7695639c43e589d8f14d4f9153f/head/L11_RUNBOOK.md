# L11 curated-target experiment

Status: **stopped at local QA before GPU provisioning**. The completed 224-target source audit, frozen cutoff, manual review, and exposure calculation are recorded in `corpus/metadata/l11_preflight_decision.json`. No L11 model was trained, evaluated, or promoted. RunPod still lists zero pods. This is a private experiment; do not push or publish lyrics, prompts, generations, adapters, or credentials.

## Frozen intervention

- Base: `Qwen/Qwen3-1.7B-Base` revision `ea980cb0a6c2ae4b936e82123acc929f1cec04c1`, loaded directly from the base for L11.
- Training: unchanged L6 rank-8 LoRA, batch/accumulation, 384-token cap, `6e-5` LR, 0.25 terminal EOS coefficient, optimizer and 200-step schedule horizon, and L4 target-length weights. Save steps 15/25/35/40/50; never exceed L6's 50-step target-token budget.
- Data: only existing, unchanged L5 train-work targets. The committed `L11_RUBRIC.md` freezes source-only scores, formula, gates, and candidate ranking before any L11 generation. The numeric cutoff is chosen once from the completed source-score distribution, before GPU use. Keep full source-bearing review and judge data under ignored `outputs/`.
- Evaluation: unchanged fixed50 prompts, generation seeds/settings, held-out split, L7 output-quality rubric, and four blinded comparisons against B0/L1-48/L6-40/C2-40. No L8/L9 augmentation or L10 CPT initialization.

## Local preparation

```sh
python3 -m scripts.pipeline
python3 -m scripts.build_l5
python3 -m scripts.audit_l11_targets
python3 -m scripts.score_l11_targets build
python3 -m scripts.score_l11_targets score
python3 -m scripts.score_l11_targets analyze
# Freeze cutoff, manually review selected/borderline source targets and prompts,
# record private review decisions, then build the curated data.
python3 -m scripts.build_l11 --cutoff CUT --max-count MAX
uv run --python 3.12 --with 'transformers==4.57.6' --with 'huggingface-hub==0.36.0' python -m scripts.l11_exposure --curated data/l11/train.jsonl
uv run --python 3.12 --with 'transformers==4.57.6' --with 'huggingface-hub==0.36.0' python -m scripts.qa_l11
uv run --python 3.12 --with pytest python -m pytest -q
```

Inspect `l11_qa.json` before GPU use. It must confirm train-only provenance, unchanged targets, prompt fidelity, no evaluation leakage, complete endings, length coverage, EOS/masking, L6 configuration identity, deterministic sampler, and acceptable target-token exposure and repeat count. If the quality cutoff cannot make an adequate and safe set, stop without provisioning a pod.

This run reached that stop condition: 224 scored candidates, cutoff 8, 118 numerically eligible, 55 manual rejections, and 57 selected passages from 39 works. The projected 50-step draw has 26,396 target tokens versus L6's 26,050, but requires 8.55 effective passes over the curated set and draws one target 14 times (L6: 2.17 passes; max four draws). The local QA deliberately fails its minimum 70 targets / 50 works and maximum 10 draws gates. The A40 sequence below is a preserved recovery contract only; **do not run it on this 57-target set**.

## A40 execution

Only after local QA and a preparation commit, provision a secure NVIDIA A40 with SSH. Use the established PyTorch 2.8.0/CUDA 12.8 template, a `--system-site-packages` virtual environment, and `uv pip install --no-deps -r config/requirements-l9-a40.txt`; never replace CUDA Torch. Copy the private checkout and ignored derived inputs to the pod. Check CUDA, package versions, free disk, pinned base revision, curated data hash, sampler hash, and L11 config before smoke.

```sh
.venv/bin/python -m pytest -q
.venv/bin/python -m scripts.qa_l11
.venv/bin/python -m scripts.train_l11 --smoke --out outputs/l11-smoke
.venv/bin/python -m scripts.evaluate_l6 --adapter outputs/l11-smoke/checkpoint-002 --limit 2 --out outputs/l11-smoke-eval
.venv/bin/python -m scripts.train_l11 --out outputs/l11 --stop-at 50
for n in 015 025 035 040 050; do
  .venv/bin/python -m scripts.evaluate_l6 --adapter "outputs/l11/checkpoint-$n" --out "outputs/l11-eval-$n"
  .venv/bin/python -m scripts.eval_l3_loss --adapter "outputs/l11/checkpoint-$n" --split heldout --out "outputs/l11-heldout-$n.json"
done
```

Verify two-update finite losses, exact curated sample IDs, 0.25 EOS weight, checkpoint save/reload, fresh-process two-prompt evaluation, and persistent artifact copy before the full run. Check all five checkpoint adapter SHA-256 values and the 50-step sample trace against the preflight plan.

## Evaluation and shutdown

Select the best L11 candidate on fixed50 quality and memorization evidence before building the five-way blind packet. For every competitive checkpoint, run full-source exact/fuzzy overlap, longest phrase, nearest-source, and train/heldout prefix-continuation screens. Review the targeted qualitative cases that distinguish interesting writing from mere lineation. Run the unchanged L7 blind rubric on 250 anonymous responses and 200 anonymous pairs; keep keys separate until all judgments are complete. A single model judge gives provisional ratings, not human preference evidence.

Copy **all** L11 adapters, manifests, sample traces, generations, loss/evaluation files, blind review records, memorization outputs, and logs locally. Create a recursive SHA-256 manifest on the pod and verify every copied file against it. Only then delete the pod and confirm `runpodctl pod list` returns `[]`. If L11 does not clearly improve creative quality without memorization or usability cost, keep L1 and do not export a GGUF. Commit only code and lightweight statistics/decisions, never weights, raw corpus data, source-bearing outputs, or credentials. Do not push.
