# E014 NVIDIA host package and qualification

## Status

The frozen E014 primary preregistration is commit `bc27f558b6c0cd6d0c27206ee5e4fff851b7f12f`. The qualification path is deliberately separate from E014's model-quality outputs. It performs real QLoRA optimizer updates, writes its artifacts below `outputs/hardware-qualification/E014/`, and does not score the benchmark or general-capability control.

The currently connected Mac has no NVIDIA/CUDA device. The only configured remote GPU observed for this task was one RTX 3070 with 8 GB, which does not match any selected profile and will not be used. No cloud instance is provisioned or paid for.

Operational gate: `READY_FOR_3090_QUALIFICATION`. E014 remains preregistered as `READY_FOR_COMPUTE`; the target-hardware qualification has not run.

## Execution profiles

All profiles preserve the frozen 4,608-token cap and effective global batch 16. Microbatch remains one sequence per GPU. For two 3090s, DDP world size 2 and accumulation 8 preserve that batch; it does not combine the two VRAM pools. Hardware-specific throughput and peak VRAM are marked unmeasured until a host passes qualification.

| Profile | GPUs | Accumulation | Effective batch | Per-GPU nominal VRAM |
| --- | ---: | ---: | ---: | ---: |
| `RTX3090_SINGLE` | 1 | 16 | 16 | 24 GB |
| `RTX3090_DUAL` | 2 | 8 | 16 | 24 GB |
| `A100_80GB` | 1 | 16 | 16 | 80 GB |
| `H100_80GB` | 1 | 16 | 16 | 80 GB |
| `A100_40GB` | 1 | 16 | 16 | 40 GB |
| `L40S_48GB` | 1 | 16 | 16 | 48 GB |
| `RTX6000_ADA_48GB` | 1 | 16 | 16 | 48 GB |

The first four are the requested primary profiles. The last three are configuration-only fallbacks for an already available host; they do not authorize renting compute. A 24 GB RTX 3090 is a plausible candidate for 8B NF4 QLoRA with microbatch 1 and gradient checkpointing, but the 4,608-token memory peak is not confirmed until the real qualification completes. An 8 GB RTX 3070 is rejected by name and VRAM checks. The A100 40 GB and 48 GB L40S/RTX 6000 Ada profiles have more VRAM headroom and look feasible by capacity, but remain unmeasured until qualified.

## Qualification workload and evidence

Run `bash scripts/qualify_gpu.sh RTX3090_SINGLE` or use the matching profile. The command first checks CUDA/BF16, exact visible GPU count/model/VRAM, frozen dataset hashes, and free disk. If those checks fail, it exits before creating a run directory or downloading model weights.

On a matching host it loads the pinned `Qwen/Qwen3-8B-Base` revision using the same NF4 double-quantized QLoRA setup, BF16 compute, LoRA rank/targets, optimizer, and 4,608-token limit as E014. It selects the 320 longest unique examples from the frozen training split only. For the qualification collator, those true input sequences are right-padded to exactly 4,608 positions with padding labels masked, so each measured update exercises the full allocation length without changing the examples or targets. The validation and test splits are not used by the optimizer or evaluator.

It runs 10 optimizer steps, atomically marks and validates the complete checkpoint, exits that Python process, then starts a fresh process and resumes from step 10 to step 20. It requires adapter, optimizer, scheduler, trainer-state, and every rank's RNG state in each resumable checkpoint; checkpoint markers are atomically renamed into place only after validation. The final adapter hash must differ from the step-10 adapter. No benchmark prediction, hypothesis score, or model-quality comparison is produced.

Each unique run is stored at:

`outputs/hardware-qualification/E014/<PROFILE>/<UTC-timestamp>-<run-id>/`

The `qualification_report.json` includes optimizer steps, save/load/resume checks, selected-sequence token throughput, per-rank CUDA allocated/reserved peaks, process RSS, and sampled `nvidia-smi` utilization, memory, and temperature. Raw phase logs and `gpu_telemetry.jsonl` are kept beside it. Qualification artifacts never go in `experiments/E014_qwen3_8b_primary_qlora/`, `outputs/qwen3-8b-research-v0.1-qlora/`, the frozen benchmark/control, or paper statistics.

## Host requirements

- Linux x86_64, Python 3.13, `uv`, a compatible NVIDIA driver, `nvidia-smi`, and the exact profile's BF16-capable GPU(s).
- At least 40 GB free where the Hugging Face model cache resides; the E014 preregistration recommends 150 GB free disk and 64 GB system RAM for the full run.
- Network access to the public Hugging Face model repository. The pinned model revision is publicly readable (16.4 GB); no Hugging Face login/token is required for this public model. The qualification script does not request or print credentials.
- Copy the untracked frozen training file separately. Its expected SHA-256 is `703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f`.
- No CUDA toolkit install is needed if the compatible NVIDIA driver and locked PyTorch/BitsAndBytes wheels work; `uv sync --locked --extra dev --extra ml` installs the pinned Python environment. Driver packages themselves must be provisioned by the host owner.

## Portable bundle and data transfer

After committing the tooling on this branch, create a self-contained Git bundle locally:

```sh
bash scripts/package_nvidia_host.sh /tmp/research-model-e014.bundle
scp /tmp/research-model-e014.bundle <user>@<linux-gpu-host>:/tmp/
scp /Volumes/Research/research-model-mm/data/generated/research-data-v0.1-expanded.jsonl <user>@<linux-gpu-host>:/tmp/research-data-v0.1-expanded.jsonl
ssh <user>@<linux-gpu-host> 'git clone --branch codex/e014-prereg-ready-for-compute /tmp/research-model-e014.bundle ~/research-model-mm && mkdir -p ~/research-model-mm/data/generated && mv /tmp/research-data-v0.1-expanded.jsonl ~/research-model-mm/data/generated/research-data-v0.1-expanded.jsonl'
```

Then on the Linux host:

```sh
cd ~/research-model-mm
bash scripts/prepare_nvidia_host.sh RTX3090_SINGLE
bash scripts/qualify_gpu.sh RTX3090_SINGLE
```

For a single-GPU profile, expose exactly one intended card with `CUDA_VISIBLE_DEVICES`; for two 3090s, use `RTX3090_DUAL` in both commands and expose exactly the two intended cards. For other listed GPUs, pass the corresponding profile. No host IP, SSH credential, or cloud provider is assumed here.

## E014 compute commands

Only start the primary run after the base benchmark and general-capability control have been recorded, and after the hardware qualification passes. The scientific recipe and output directory are frozen in the config; the profile only changes execution world size and accumulation.

```sh
# One 3090
bash scripts/run_e014.sh RTX3090_SINGLE run

# Two 3090s (DDP)
CUDA_VISIBLE_DEVICES=0,1 bash scripts/run_e014.sh RTX3090_DUAL run

# Resume after interruption; use the same profile/world size as the saved checkpoints
bash scripts/run_e014.sh RTX3090_SINGLE resume
CUDA_VISIBLE_DEVICES=0,1 bash scripts/run_e014.sh RTX3090_DUAL resume
```

The full E014 training adapter and checkpoint tree is `outputs/qwen3-8b-research-v0.1-qlora/`. A profile/world-size mismatch is rejected instead of guessing at a resume. Incomplete checkpoint directories are preserved under `incomplete-checkpoints/` before resuming from the latest fully validated checkpoint.

## Primary-run evaluation commands

The preregistered baseline, control, tuned evaluation, and paired-bootstrap commands are recorded in `experiments/E014_qwen3_8b_primary_qlora/manifest.json`. The core direct invocations use the locked revision `49e3418fbbbca6ecbdf9608b4d22e5a407081db4`, 4-bit inference, and the frozen benchmark/control paths. Keep their E014 output names from the manifest; do not reuse the generic `baseline.json` or `evaluation.json` paths.

Capacity references: [RTX 3090 (24 GB)](https://www.nvidia.com/en-eu/geforce/graphics-cards/30-series/rtx-3090/), [A100 40/80 GB](https://www.nvidia.com/en-us/data-center/a100/), [H100 80 GB](https://www.nvidia.com/en-us/data-center/h100/), [L40S 48 GB](https://www.nvidia.com/en-us/data-center/l40s/), and [RTX 6000 Ada 48 GB](https://www.nvidia.com/en-us/products/workstations/rtx-6000/). NVIDIA's capacities establish VRAM classes, not expected throughput or guaranteed fit. The [pinned Qwen3-8B-Base revision](https://huggingface.co/Qwen/Qwen3-8B-Base/tree/49e3418fbbbca6ecbdf9608b4d22e5a407081db4) is listed publicly at 16.4 GB.
