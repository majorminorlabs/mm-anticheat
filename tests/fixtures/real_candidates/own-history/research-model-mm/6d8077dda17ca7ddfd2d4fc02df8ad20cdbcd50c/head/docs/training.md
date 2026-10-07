# Training

The primary recipe is SFT with QLoRA on `Qwen/Qwen3-8B-Base`. The pilot config
is `configs/training/qwen3_8b_qlora.toml`; the serious release-candidate config
is `configs/training/qwen3_8b_v0.1_qlora.toml`.

The NVIDIA path uses Transformers, PEFT, TRL, and 4-bit NF4 quantization. The
Apple path is a separate 8B-class MLX feasibility recipe in
`configs/training/qwen3_8b_v0.1_mlx.toml`; it uses the public quantized MLX
conversion and is not identical to the primary base checkpoint. MLX data is
generated under a versioned directory alongside each JSONL release.

Training metadata must include base revision, dataset hash, seed, sequence
length, optimizer/scheduler, LoRA settings, hardware, duration, intermediate
checkpoint policy, and checkpoint path. The CLI refuses to overwrite existing
training artifacts unless explicitly overridden. No paid compute is launched by
this repository.
