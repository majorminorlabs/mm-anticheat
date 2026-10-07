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
