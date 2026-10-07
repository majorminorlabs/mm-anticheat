# E014: Primary Qwen3-8B-Base research-behavior QLoRA

**Status: `READY_FOR_COMPUTE` — preregistered; primary baseline and training have not run.**

## Frozen objective and hypotheses

The untouched `Qwen/Qwen3-8B-Base` versus research-behavior SFT/QLoRA comparison asks whether specialization improves unseen research behavior while preserving useful general capabilities. The primary H1 is unchanged from `configs/research/primary_v0.1.json`: tuned structured validity and research-action accuracy will exceed the untouched base on the frozen benchmark. H2–H5 remain secondary and unchanged; all are copied into the machine-readable manifest.

For interpretation, H1 is treated as supported only when both preregistered primary metric deltas are positive and their paired 95% bootstrap intervals exclude zero. A formatting/validity gain without evidence of better research decisions will not be described as broad research improvement. Report point estimates, absolute deltas, relative deltas where defined, and intervals; subgroup results remain descriptive. Bootstrap uses 20,000 resamples and seed 17. The small 12-case general-capability control is only a regression guard, not evidence of broad capability retention.

## Frozen artifacts

- Training candidate: `research-data-v0.1-expanded`, 25,269 accepted rows; 19,626 train, 2,816 validation, 2,827 test. Its file SHA-256 is `703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f`; canonical content hash is `75283e511cb120bbb29fb95e13b7a26fa5f6b4f887ddf41079c50c4a96505cf1`.
- Research benchmark: 248 cases, canonical hash `d44b8226ed8d5122ffedcb353761a9624917fb0bd6f6be60e5595799a0a5eb3e`.
- General-capability control: 12 cases, canonical hash `1be2dc5298066bb645ec49f48157de81c09a05579bab8679d87fa86723efbad5`.
- Current strict validation accepts all 25,269 processed training-candidate rows; contamination check reports zero exact question/context overlaps, zero source-ID overlaps, zero near-duplicate question pairs, and `contaminated=false`.

## Training and evaluation protocol

Base and tuned conditions use the same immutable model and tokenizer revision, `49e3418fbbbca6ecbdf9608b4d22e5a407081db4`, the same raw research protocol prompt, NF4 4-bit base weights with double quantization and BF16 compute, temperature 0, and a 512-token research-evaluation cap. The frozen general control uses the same 256-token generation cap in both conditions. The exact base benchmark and control runs must complete before training. The test split is never used for training or checkpoint choice; the best validation-loss checkpoint is evaluated after training.

The serious recipe uses seed 17, 2 epochs, per-device batch 1, gradient accumulation 16, learning rate `2e-4`, cosine scheduling, 5% warmup (123 steps), AdamW fused, BF16 NF4 QLoRA, rank 16 / alpha 32 / dropout 0.05, gradient checkpointing, and the seven attention/MLP projection modules specified in the config. Planned workload is 2,454 optimizer steps and approximately 46,810,376 full sequence tokens over two epochs. Validation and checkpoints run every 500 steps; at most five checkpoints are retained, with the best selected by validation loss.

Two justified recipe adjustments were recorded before compute: sequence length is 4,608 rather than 2,048 because exact tokenization found 1,983 training examples (10.1%) would be truncated at 2,048, including 810 with no answer tokens retained; at 4,608 every train/validation/test target is fully retained. Checkpoint/evaluation cadence is 500 steps with best-validation-loss selection so early/middle/final candidates are available without retaining hundreds of checkpoints. `warmup_ratio=0.05` is mapped to 123 explicit warmup steps because the installed TRL API no longer accepts `warmup_ratio` in `SFTConfig`.

The existing scorer will report validity, action accuracy, citation precision/recall, evidence recall, claim-status F1, unsupported-claim rate, insufficient-evidence accuracy, task-family roll-ups, and six requested domain roll-ups. The paired bootstrap omits cases where a metric is undefined (so insufficient-evidence inference uses its eight eligible cases). The benchmark does not define separate source-rank, source-rejection, evidence-precision, contradiction, or methodology-quality scores; these will not be invented after results. Their task-family cases will be described using the frozen available metrics and raw outputs.

The general control and every research case retain raw generated text, parsed output, per-case scores, runtime and GPU-memory telemetry. Post-run analysis will compare each paired case, report the control descriptively with intervals and its sample size, and prepare a deterministic set of largest metric-wise improvements/regressions, asymmetric successes, shared failures, and failures for manual classification using the preregistered error categories in the manifest. No new composite score will be created.

## Readiness and limits

Local hardware is a Mac Studio with Apple M1 Max, 32 GB unified memory, MPS available and no NVIDIA/CUDA device; `nvidia-smi` is absent. The exact QLoRA runner refuses to start on this host. The training dependencies are installed and locked, dataset/tokenizer dry-runs pass, and a one-step local framework smoke validated the trainer API on a tiny temporary model only; that smoke is not model evidence. No primary model weights are cached and no primary baseline has completed. E010 remains interrupted; E011–E013 are MLX feasibility evidence only.

Target a Linux x86-64 host with one BF16-capable NVIDIA A100 80 GB or H100 80 GB, at least 64 GB system RAM and roughly 150 GB free disk as a conservative provision. The selected CUDA 13 runtime requires a sufficiently recent driver (580+); actual GPU and driver versions must be recorded at launch. These are conservative planning values, not an empirically established minimum. Planning estimate: 8–16 training GPU-hours plus 1–3 evaluation GPU-hours, not benchmarked on the target GPU. Cost incurred is $0; no paid compute or public release is authorized.

The E014 manifest contains the full environment specification and exact base, resume, training, tuned-evaluation, control, and paired-analysis commands. No primary result, analysis, or conclusion is present yet.
