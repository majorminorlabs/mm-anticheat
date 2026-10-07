# Experiment ledger

## Source snapshot and design

- Source tree SHA-256: `c68c46641928d92c7a950702c79f8babdfdd1ef657915abf11d230f6bb348cd2`
- 106 unique works, 84 train / 11 validation / 11 held out; nine style anchors in train.
- The supplied prior audit counted 107 works. The current checkout has 106 Markdown files. No missing work can be inferred from filenames alone.
- Three source notes describe partial screenshot transcriptions. The notes are kept in metadata and omitted from training targets.
- Repeated exact sections are represented once; internal repeated lines remain. Training samples one representation per work per epoch.
- Base: `Qwen/Qwen3-1.7B-Base` at `ea980cb0a6c2ae4b936e82123acc929f1cec04c1`, Apache 2.0.
- LoRA: rank 8, alpha 16, dropout 0.05, query/value projections, BF16, sequence length 768, effective batch 8, LR 8e-5, 48 updates with linear warmup and decay. This is approximately 4.6 work-level epochs. Checkpoints at 16/32/48.
- B0 and L1 generation use the same 50 prompts, seeds, temperature 0.85, top-p 0.92, repetition penalty 1.08, and length-specific token caps.

## Run results: 2026-10-03 local time

Local tests: six passed. Tokenizer accounting found 30,507 source tokens; the longest source work is 474 tokens, below the 768-token training cap. The preparation pipeline reported 61 exact repeated-section occurrences and 1,036 repeated-line occurrences. All 106 source files remain unchanged.

The untouched B0 run generated all 50 fixed prompts before training. A two-update smoke run completed forward/backward training, recorded validation loss, wrote a PEFT adapter, and loaded that adapter in a fresh inference process. Smoke elapsed 2.8 seconds for its two updates and used about 5.9 GiB GPU memory.

L1 ran 48 optimizer updates, 4.571 effective work-level epochs, in **36.9 seconds** on one NVIDIA A40 with 46,068 MiB total VRAM. Recorded GPU use at saved checkpoints was about 10,193 MiB; observed utilization was 81–100% at those snapshots. Validation completion loss was 2.41445 at step 16, 2.39136 at step 32, and **2.38393 at step 48**. The learning rate warmed to 8e-5 and decayed to zero. The best retained adapter is checkpoint 48, chosen by validation loss and fixed-prompt diagnostics.

| Measure | B0 | L1 step 16 | L1 step 32 | L1 step 48 |
| --- | ---: | ---: | ---: | ---: |
| Length adherence, 50 prompts | 78% | 72% | 82% | 84% |
| Mean words | 125.7 | 118.3 | 108.9 | 119.3 |
| Mean words per output line | 38.12 | 36.17 | 26.41 | 25.09 |
| Mean duplicate lines | 0.02 | 0.02 | 0 | 0.14 |
| Mean shared training 5-grams | 0 | 0 | 0.02 | 0.04 |
| Longest training phrase overlap, words | 4 | 4 | 5 | 5 |
| Memorization flags | 0 | 0 | 0 | 0 |

On the 11 complete held-out works, mean completion loss improved from **2.95488 B0** to **2.86968 L1**. That is evidence of a learned signal, but held-out loss and line-length statistics do not establish writing quality.

Spot checks found some more line-broken output and isolated unusual images at step 48. Many outputs remain generic prose, and several drift from the requested subject or discuss the requested form instead of writing it. The model responds to some simple prompts and uses verse/chorus when asked, but it does not consistently meet the objective. No additional training experiment was run because L1 is not clearly healthy. The blind B0/L1 packet is in `outputs/blind-review/`; a human comparison has not been completed. **The acceptance gate is not met.**

The step-48 PEFT adapter is `models/best/` (6.2 MiB). It was merged into the pinned base, converted with llama.cpp commit `11fe02151f79c41d0d4af7da708755d73b9c0da6`, and quantized Q4_K_M. `models/best.gguf` is about 1.05 GiB and has SHA-256 `90bbabf458f74c22e153d5c7d6df2cb06fa6600bb094f35d95299a63e0a1ab31`. The same hash was verified on the Mac and persistent RunPod storage. `./writer` loaded it with `llama-completion` and produced text locally on the Mac Studio. Quantized CLI output was smoke-tested, not rerun through the full 50-prompt comparison.

Training and evaluation artifacts are in ignored `outputs/` locally and in `/workspace/lyricist/outputs` on RunPod; the GGUF is also in `/workspace/lyricist/models/best.gguf`. The source repository has no remote and has not been pushed. Model weights, caches, and outputs are not committed.

Recommended next experiment, after human review: improve prompt-to-target supervision with grounded descriptions of smaller passages and a stronger mix of short line-broken targets, then run one controlled LoRA comparison against this B0/L1 evidence. Keep the same work split and fixed prompt suite. Do not infer that longer training alone will fix the prompt drift.

## Known limitations

- SFT prompts derive from titles, so theme control may be weak or overly title-driven.
- A small source corpus makes memorization a material risk; quantitative flags need human inspection.
- The automated suite cannot reliably judge unusual imagery, ambiguity, cadence, or overall quality. Blind human comparison is required for a success claim.
- Held-out works are reserved and never used as training examples; prompt corpus is separate.

## Blind comparison protocol

After checkpoint evaluation, make a paired packet with `python3 -m scripts.blind_compare --b0 outputs/b0/generations.jsonl --l1 outputs/l1-best/generations.jsonl --out outputs/blind-review`. Read each pair without opening `answer_key.json`. Score imagery, phrasing, cadence, ambiguity, indirect associations, coherence, prompt response, and originality. This is a required human judgment before claiming the acceptance gate is met.
