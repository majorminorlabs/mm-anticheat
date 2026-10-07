# Initial build report

Date: 2026-09-15

## Result

The standalone pipeline is operational from public data acquisition through structured task generation, validation, MLX training, inference, scoring, and comparison. The local run produced real LoRA adapters for a 0.6B smoke model and an 8B-class 4-bit feasibility model.

## Base decision

Primary target: `Qwen/Qwen3-8B-Base`. The rationale and three-candidate screen are recorded in `docs/base_model_selection.md`. The selected base is not fully trained locally: the exact NVIDIA QLoRA recipe is ready in `configs/training/qwen3_8b_qlora.toml`.

The local 8B-class run used `mlx-community/Qwen3-8B-4bit`, a public MLX conversion, to test memory and adapter mechanics. It is a feasibility smoke and should not be conflated with a Qwen3-8B-Base research-tuning result.

## Data

- Public source used: SciFact release archive, CC BY-NC 2.0 according to its dataset card.
- Raw archive SHA-256: `11c621288d41ac144d29b13b0f8503b3820b7d6e8b1f6ff24dff335c196d76be`.
- Pilot release: `research-data-v0.1`.
- Generated examples: 480 from 120 claims; 120 each of evidence verification, citation integrity, insufficient-evidence recognition, and research planning.
- Splits: 384 train, 48 validation, 48 test; source-grouped with no cross-split leakage.
- Dataset SHA-256: `d894eaa8f60ac8272b6690cc662a1ace3ca52144d8c4a053b66114fb1da41ee4`.
- Deterministic validation: 480 accepted, 0 rejected, 0% rejection; no leakage groups.
- QASPER and other candidate corpora were investigated but not ingested in this release. No license/redistribution assumption was made for them.

## Training

- Local runtime: Apple M1 Max, 32 GB unified memory, MLX 0.32.2 / mlx-lm 0.31.3.
- 0.6B smoke: Qwen3-0.6B, seed 0, 20 iterations, 4 LoRA layers, rank 8, learning rate 1e-4, max sequence 1024; final validation loss 1.355 and test loss 1.326; peak memory 3.13 GB; approximately 2 minutes including cached model load and test; adapter at `outputs/qwen3-0.6b-research-smoke-v3/`.
- 8B feasibility smoke: `mlx-community/Qwen3-8B-4bit`, seed 0, 20 iterations, 8 LoRA layers, rank 8, learning rate 5e-5, max sequence 1024; final validation loss 0.958 and test loss 0.984; peak memory 8.82 GB; approximately 9 minutes including model fetch and test; adapter at `outputs/qwen3-8b-4bit-research-smoke-v2/`.
- The earlier masked 512-token 0.6B attempt was rejected because truncation removed assistant targets and produced NaN loss; the corrected aligned-data run is the valid smoke artifact.

## Evaluation

On 48 unseen SciFact-derived public test examples, the 0.6B smoke adapter versus its untouched checkpoint changed:

| Metric | Untuned | Adapter | Delta |
| --- | ---: | ---: | ---: |
| Structured validity | 0.000 | 0.750 | +0.750 |
| Action accuracy | 0.000 | 0.375 | +0.375 |
| Citation precision | 0.354 | 0.396 | +0.042 |
| Citation recall | 0.354 | 0.396 | +0.042 |
| Claim-status F1 | 0.188 | 0.250 | +0.063 |
| Evidence recall | 0.688 | 0.688 | +0.000 |
| Unsupported-output rate | 0.917 | 0.250 | -0.667 |

On the 10-case controlled micro-benchmark, the 8B-class feasibility adapter versus its untouched 4-bit checkpoint changed structured validity from 0.0 to 1.0 and unsupported-output rate from 0.3 to 0.0, while action accuracy fell from 0.5 to 0.3 and citation precision fell from 0.45 to 0.10. This is a five-to-twenty-step smoke, not evidence of final model quality.

## Known weaknesses

The pilot is small, domain-skewed, and mostly abstract-level evidence. The current scorer is structured and deterministic but not a substitute for expert rubric judging. The local 8B run used an instruct-derived quantized conversion, not the primary base checkpoint. Long-context effectiveness, ordinary-capability retention, domain balance, and independent teacher labels remain to be measured.

## Exact reproduction

```bash
uv sync --extra dev --extra mlx
uv run research-model data build --max-claims 120
uv run research-model validate
uv run mlx_lm lora --model Qwen/Qwen3-0.6B --data data/generated/mlx --train \
  --fine-tune-type lora --adapter-path outputs/qwen3-0.6b-research-smoke-v3 \
  --iters 20 --batch-size 1 --learning-rate 0.0001 --max-seq-length 1024 \
  --num-layers 4 --seed 0 --steps-per-report 1 --steps-per-eval 10 --test
uv run research-model evaluate --backend mlx --model Qwen/Qwen3-0.6B \
  --dataset data/generated/research-data-v0.1.jsonl --split test \
  --max-new-tokens 256 --output data/generated/qwen3-0.6b-untuned-public-test.json
uv run research-model evaluate --backend mlx --model Qwen/Qwen3-0.6B \
  --adapter-path outputs/qwen3-0.6b-research-smoke-v3 \
  --dataset data/generated/research-data-v0.1.jsonl --split test \
  --max-new-tokens 256 --output data/generated/qwen3-0.6b-smoke-public-test.json
uv run mlx_lm lora --model mlx-community/Qwen3-8B-4bit --data data/generated/mlx --train \
  --fine-tune-type lora --adapter-path outputs/qwen3-8b-4bit-research-smoke-v2 \
  --iters 20 --batch-size 1 --learning-rate 0.00005 --max-seq-length 1024 \
  --num-layers 8 --seed 0 --steps-per-report 5 --steps-per-eval 10 --test
uv run research-model train --config configs/training/qwen3_8b_qlora.toml --backend transformers
```
