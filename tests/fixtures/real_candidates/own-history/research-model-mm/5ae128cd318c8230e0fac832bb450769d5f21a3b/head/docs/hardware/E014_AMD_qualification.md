# E014 AMD MI300X qualification

## Status and gate

Status: `READY_FOR_AMD_QUALIFICATION`. E014 and E015 remain unchanged. No AMD GPU or signed-in AMD Developer Cloud session was available in the local environment; no VM, credits, or paid compute were used. The actual account balance and provider-specific rate are unknown. Do not provision a VM based on this record alone.

The qualification is an engineering smoke, not a model-quality experiment. Its records belong under `outputs/hardware-qualification/E014/AMD_MI300X/`, never in E014's training outputs or benchmark results. The frozen source snapshot is captured in `configs/research/e014_scientific_invariants_v1.json`; run `python3 scripts/validate_e014_invariants.py` before any host qualification.

## Frozen E014 treatment

| Area | Invariant |
| --- | --- |
| Base | `Qwen/Qwen3-8B-Base`, model and tokenizer revision `49e3418fbbbca6ecbdf9608b4d22e5a407081db4` |
| Training data | `research-data-v0.1-expanded`; 25,269 rows; 19,626 train / 2,816 validation / 2,827 test; file SHA-256 `703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f`; canonical content hash `75283e511cb120bbb29fb95e13b7a26fa5f6b4f887ddf41079c50c4a96505cf1` |
| Research benchmark | `research-bench-v0.1`, 248 cases / 31 families × 8; file SHA-256 `3f1f859a10f1bb34ebb22197fadfeba08f2f812c2346a9d75c2b1b7e97b878c4`; canonical content hash `d44b8226ed8d5122ffedcb353761a9624917fb0bd6f6be60e5595799a0a5eb3e` |
| Control | `general-control-v0.1`, 12 cases; file SHA-256 `b9ff1050dd05eeaf062aba8e8fce1f0a39ffc7da68754d02f011779780628636`; canonical content hash `1be2dc5298066bb645ec49f48157de81c09a05579bab8679d87fa86723efbad5`; narrow keyword regression guard only |
| Method | Transformers/TRL SFT with NF4 4-bit base weights, double quantization, BF16 compute, LoRA rank 16 / alpha 32 / dropout 0.05 on `q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj` |
| Sequence and batch | 4,608 tokens; microbatch 1; accumulation 16; effective global batch 16 on one GPU |
| Optimization | `adamw_torch_fused`; learning rate `2e-4`; cosine scheduler; 5% warmup = 123 steps; weight decay 0.01; two epochs; 2,454 optimizer steps; seed and data seed 17; gradient checkpointing |
| Checkpointing | Save/evaluate each 500 steps; retain at most five; choose lower validation `eval_loss`; no performance early stop; test split is evaluated after training and never selects a checkpoint |
| Primary result | H1 requires positive tuned-minus-base paired mean deltas for both `structured_valid` and `action_accuracy`, with each two-sided 95% paired percentile-bootstrap CI excluding zero; 20,000 resamples, seed 17 |
| Other scores | `citation_precision`, `citation_recall`, `claim_status_f1`, `evidence_recall`, `unsupported_claim_rate`, `insufficient_evidence_accuracy`, task/domain reporting, and the narrow control; no post-hoc composite |

The training config SHA-256 is `efe00566bb8ef12a31c76f8dd4f88986643b53a964d8540f19484e1f7bd920bf`; lockfile SHA-256 is `82e0e70b44474c2ac0f2211664b6352b870171481ca1e6167faf95333e572825`. The validator also checks dataset/benchmark canonical and split hashes plus lock pins. Any mismatch blocks qualification.

## Scientific invariants versus backend details

The values above define E014. ROCm/HIP versus CUDA, kernel dispatch, allocator, device placement, and telemetry are execution details only when the pinned method and data path execute unchanged. They can still change floating-point accumulation order, throughput, memory use, or stability, so record them and require the smoke. Do not assume bitwise equality or interpret a successful health check as equivalence.

The current E014 runner and NVIDIA hardware-profile gate are NVIDIA-specific. The separate AMD script checks `torch.version.hip`, a single MI300X, BF16, exact package versions, all frozen hashes, and the live NF4/double-quantized module state. It tests TRL SFT forward/backward, the configured fused AdamW update, finite adapter/optimizer state, and complete save/restart/resume checkpoints. This leaves E014's code, outputs, and registration untouched.

The smoke uses 96 longest unique examples from the frozen training split only, padded to 4,608 positions, with six optimizer updates (3 before process exit, then a fresh-process resume to step 6). It sets zero warmup because six steps cannot represent E014's 123-step full-run warmup. The frozen JSONL is fully read to verify all split hashes, but only selected training rows are passed to the trainer; validation/test are not evaluated, no benchmark/control cases are loaded, and no checkpoint selection or model-quality scoring occurs. These limited engineering deviations are written into every run record.

## Current software compatibility finding

The concern that E014's PyTorch 2.14.0 pin necessarily forces a downgrade is not supported by the current official artifacts. PyTorch's 2.14 release notes document ROCm 7.14/TheRock, and the official wheel index contains a Linux x86_64 CPython 3.13 `torch-2.14.0+rocm7.14` wheel. Therefore a 2.13 fallback is not currently necessary. [PyTorch 2.14 release notes](https://pytorch.org/blog/pytorch-2-14-release-blog/) · [official wheel index](https://download.pytorch.org/whl/torch/) · [ROCm 7.14 compatibility matrix](https://rocm.docs.amd.com/en/docs-7.14.1/compatibility/compatibility-matrix.html)

PyTorch for HIP intentionally reuses `torch.cuda` APIs; `torch.version.hip` distinguishes it from CUDA. This allows much of the existing single-GPU path to run unchanged but does not remove the NVIDIA-specific profile checks. [PyTorch HIP semantics](https://docs.pytorch.org/docs/main/notes/hip.html)

| Component | Evidence today | Qualification status |
| --- | --- | --- |
| PyTorch | Exact 2.14.0 ROCm 7.14 wheel is published for Linux x86_64 / Python 3.13. | Install path identified; MI300X runtime not exercised. |
| Transformers 5.17.0 | Exact release exists and is pinned in the lock. | Model load + SFT unverified on this ROCm build. |
| PEFT 0.21.0 | Exact release exists; PEFT's Transformers 5 compatibility requires PEFT 0.18+. | Adapter injection/save/resume unverified on this stack. |
| TRL 1.13.0 | Exact release exists; its declared Transformers, Accelerate, and Datasets minimums are met by E014 pins. | SFTTrainer path unverified on this ROCm build. |
| bitsandbytes 0.50.2 | The pinned release includes a ROCm 10 build; its tagged install guide lists Linux ROCm 7.14 `gfx942` support and ROCm CDNA features, including 4-bit NF4/FP4 support. | This is encouraging upstream support, not proof of exact PyTorch 2.14 + MI300X NF4/double-quant + PEFT + TRL + fused AdamW execution. Smoke required. No source build is planned unless the exact wheel fails. |

References: [Transformers 5.17.0](https://github.com/huggingface/transformers/releases/tag/v5.17.0), [PEFT releases](https://github.com/huggingface/peft/releases), [TRL 1.13.0 requirements](https://github.com/huggingface/trl/blob/v1.13.0/pyproject.toml), [bitsandbytes 0.50.2 release](https://github.com/bitsandbytes-foundation/bitsandbytes/releases/tag/0.50.2), [bitsandbytes 0.50.2 install guide](https://github.com/bitsandbytes-foundation/bitsandbytes/blob/0.50.2/docs/source/installation.mdx).

One install trap is already resolved in the setup script: on Linux, `uv.lock` points at the PyPI CUDA Torch artifact and its CUDA dependencies. The AMD setup keeps the lock unchanged for all non-Torch packages (`uv sync --locked --no-install-package torch`) then installs `torch==2.14.0+rocm7.14` from the official ROCm 7.14 index. No local ROCm source build is necessary based on published wheel availability. The pinned bitsandbytes guide also describes building from source on ROCm 6.3–10.0 with CMake ≥3.31.6 and Python ≥3.10, so a source build is feasible if the wheel fails; it would be separately versioned and qualified, not silently substituted. [bitsandbytes 0.50.2 source-build requirements](https://github.com/bitsandbytes-foundation/bitsandbytes/blob/0.50.2/docs/source/installation.mdx)

AMD documents both bare-OS images (install the desired ROCm version) and Quick Start containers with preinstalled frameworks. Either can host this stack, but the exact current ADC image was not checked in the user's account. A container shares the host kernel, so the host's ROCm kernel-mode driver and GPU device access must be compatible even if the PyTorch/HIP user-space stack is inside Docker. The recommended reproducible route is a single-GPU bare-OS VM plus this pinned venv setup, unless the live account shows a matching supported Quick Start image. [AMD Developer Cloud setup guide](https://www.amd.com/en/developer/resources/technical-articles/2025/how-to-get-started-on-the-amd-developer-cloud-.html) · [ROCm container requirements](https://rocm.docs.amd.com/projects/install-on-linux/en/docs-6.0.0/how-to/docker.html)

## MI300X capacity and BF16-LoRA alternative

AMD lists the single-GPU Developer Cloud configuration at 192 GB HBM, 20 vCPUs, and 240 GB host RAM. The 8-GPU option is unnecessary and would waste credits for this single-device recipe. Credits are account/eligibility-specific; AMD says qualified program members may receive $100, but that is not evidence of a balance on this account. A powered-off VM continues to accrue charges/credit use until it is destroyed. [AMD Developer Cloud configuration and terms](https://www.amd.com/en/developer/resources/cloud-access/amd-developer-cloud.html)

Independent rough estimate for full BF16 LoRA, not an E014 treatment: the BF16 base weights are about 16.4 GB decimal (about 15.3 GiB); the frozen seven-module rank-16 adapter is approximately 43.65 million parameters. FP32 Adam moments alone are roughly 0.33 GiB; adapter gradients/weights add on the order of a few tenths of a GiB depending on storage. With gradient checkpointing, one BF16 hidden-state boundary per layer at `[1,4608,4096]` is about 1.27 GiB total, plus per-layer transients, SDPA workspace, activations and allocator overhead. A conservative expected process envelope is roughly 25–45 GiB, not measured; the attention implementation can materially affect the peak. This should fit comfortably in a 192 GB MI300X. It is a different quantization/training method: if selected, leave E014 untouched and preregister a new experiment ID (candidate E016 only after an ID/index audit).

## Candidate hardware comparison

These are capability and current published rate-card observations, not measured runtimes. The RunPod page was updated 13 Sep 2026; rates/stock may change and do not represent AMD credits or a guaranteed reservation. [RunPod GPU pricing](https://www.runpod.io/pricing)

| Option | Method fit / memory | Complexity and reproducibility | Posted rate / availability evidence | Runtime status |
| --- | --- | --- | --- | --- |
| MI300X 192 GB | E014 QLoRA should fit by capacity; BF16 LoRA also has ample theoretical headroom. | Highest new-stack uncertainty; exact TheRock + bitsandbytes + fused optimizer path must pass. Single GPU keeps batch logic simple. | AMD ADC lists 1× and 8× configurations; user account/session and price/credits unknown. | Unmeasured. |
| RTX 3090 single, 24 GB | NF4 QLoRA is plausible, but 4,608-token peak is tight/unqualified. | Most established path is NVIDIA CUDA; simplest on one card if memory smoke passes. | RunPod lists $0.50/GPU-hour; current listing, availability not account-checked. | Unmeasured. |
| RTX 3090 dual, 24 GB each | QLoRA per-GPU memory remains 24 GB; VRAM does not pool. | DDP and transfer/synchronization add complexity; profile adjusts accumulation to keep effective batch 16. | At the listed $0.50 per GPU-hour, two simultaneously rented cards cost about $1.00 per wall-hour before other charges; actual two-card stock/configuration not verified. | Unmeasured; no reliable scaling assumption. |
| A100 40 GB | Likely safer headroom for QLoRA than 24 GB; still qualify. | Standard CUDA/Transformers path; lower memory margin than 80 GB. | No A100 40 GB listing/rate was present on the inspected rate card. | Unmeasured. |
| A100 80 GB | Strong margin for the frozen NF4 path. | Mature CUDA option, least compatibility uncertainty relative to the recorded E014 plan. | RunPod lists $1.59/GPU-hour. | E014 manifest's 9–19 total GPU-hour planning range targets A100/H100-class hardware but is explicitly rough and unmeasured; same-rate scenario is about $14–$30 before storage/other charges. |
| H100 80 GB | Strong margin for the frozen NF4 path. | Mature CUDA option; typically the throughput-first NVIDIA candidate, but compare measured quotes rather than assume. | RunPod lists $2.89/GPU-hour. | Same unmeasured 9–19 GPU-hour planning scenario would be about $26–$55 before storage/other charges; actual runtime not measured. |

The only safe AMD duration formula after smoke is `2,454 × measured median optimizer-step time`, with a confidence range based on the observed six-step variation and added time for periodic evaluation/checkpointing. The benchmark has not been run on the base model, so benchmark duration and full evaluation cost remain separately unmeasured. AMD credit consumption is unknown until the live provider/account billing rate and balance are inspected. Never equate a smoke's throughput with a model result.

## Host setup and exact next commands

AMD Developer Cloud is delivered through a third-party provider. Before launch, choose the single MI300X, verify the session is the intended funded account, inspect its actual GPU/ROCm/OS and disk pricing, and remember that powered-off instances remain billable until destroyed. No cloud command is issued by this repo.

To make a portable, committed-source bundle without including dirty working-tree or E015 files, create it locally with `bash scripts/package_amd_host.sh /tmp/research-model-amd.bundle`. Transfer that bundle and the frozen dataset separately through the provider's approved file-transfer path; verify the dataset SHA-256 shown by the script. After placing both on the AMD Linux host at the expected paths:

```sh
bash scripts/prepare_amd_host.sh
bash scripts/qualify_amd.sh check
bash scripts/qualify_amd.sh run
```

`check` is the no-model-download gate. `run` performs only the six-step smoke and writes a unique report under `outputs/hardware-qualification/E014/AMD_MI300X/`. Inspect the report and provider invoice/credit usage, then destroy the instance when finished. The qualification command is not the full-run command.

No full-run command is authorized here. If (and only if) the smoke passes, a separate implementation/review must add an explicit AMD hardware profile to the training entrypoint, revalidate the same invariant file, complete the frozen base benchmark/control before full training, and obtain fresh explicit authorization for the substantial GPU run. If a material method/version substitution is needed, preregister it under a new experiment instead of routing through E014.
