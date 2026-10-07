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

## L1 failure analysis before L2

The fixed B0 and L1 step-48 generations were re-read and scored with `scripts/analyze_outputs.py` (report: `outputs/l1-failure-analysis.json`). The shape heuristic marks 43/50 B0 outputs and 26/50 L1 outputs as prose-like; mean content lines rose from 4.4 to 7.52 and mean words per line fell from 38.12 to 25.09. This is real movement toward shorter lines, but 29/50 L1 outputs still contain a line over 25 words. The lexical prompt-term check found no substantive prompt word in 24/50 B0 and 32/50 L1 outputs. That check misses paraphrases, so it is a warning rather than a semantic score.

Manual spot checks: L1 p03 and p16 gained line breaks and some imagery; p33 made an indirect connection between broken clocks and bodily value. L1 p07 drifted from jealousy into a generic kitchen scene, p18 emitted writing-instruction text, and p50 described a refrain instead of writing one. Generic phrase matches remained high (51 B0 versus 49 L1), while meta-instruction matches rose from 3 to 9. Duplicate lines rose from 1 to 7 across the 50 outputs, mostly in structured requests. Many outputs ended mid-thought at the fixed token cap (43 B0 versus 33 L1); that count is partly a generation-cap effect, not evidence of malformed corpus targets. These observations motivate shorter grounded targets and closer prompt/target alignment for L2. The 50 prompts and generation settings remain fixed.

## L2 dataset design and preflight

L2 keeps the pinned Qwen3 base, the frozen 84/11/11 work split, and the fixed 50 prompts. The dataset is made by `scripts/build_l2.py` from stanza-bounded source passages, never whole works. Each training target is 2–8 original lyric lines with exact Markdown source line numbers and a source SHA-256. It has one generated prompt per retained passage, no synthetic lyric targets, and no evaluation prompt in training. Short/medium controls follow target length. The prompt builder uses auditable lexical evidence for broad concepts or, in a small minority, one concrete source word. It copies no target phrase longer than two words into a prompt.

The final build contains **373 training passages from all 84 training works**, 54 validation passages from the 11 validation works, and 50 held-out passages from the 11 held-out works. Training prompts are 239 descriptive (64.1%) and 134 sparse (35.9%). Length controls are 262 short and 111 medium. Training target lines: 54 two-line, 43 three-line, 129 four-line, 49 five-line, 55 six-line, 20 seven-line, and 23 eight-line. Median target length is 28 words / 35 Qwen tokens; p90 is 46 words / 58 tokens; maximum is 74 words / 88 tokens. Source-work coverage is 1–10 passages per work (median four).

The builder skipped 58 exact and 25 near-repeated sections, 21 near-repeated passages, 101 internally repetitive chunks, 61 chunks lacking a grounded prompt, and three chunks containing section annotations. The QA tool found zero exact or fuzzy duplicate target pairs across L2 splits, zero work-level leakage, no broken source-line provenance, no prompt/target overlap of four or more words, and no ungrounded retained prompt tags. A deterministic spot check of 15 final examples found broad but defensible concept labels and intact target line breaks. The final train dataset SHA-256 is recorded in `corpus/metadata/l2_dataset.json` and `corpus/metadata/l2_qa.json`; the latter includes complete distributions and checks. The build is deterministic; eight local tests passed before GPU training.

## L2 training and fixed-prompt evaluation

The two-update smoke job passed loading, training, adapter save/reload, fresh-process generation, evaluation, and persistent-storage checks. The full run used the same pinned base with LoRA rank 8 / alpha 16 / dropout 0.10 on query and value projections; BF16, sequence length 256, batch 2, accumulation 4 (effective batch 8), AdamW weight decay 0.01, peak learning rate 6e-5, 10% warmup and linear decay, seed 314161. It completed **250 optimizer updates / 5.362 passage-level effective epochs in 182.78 seconds** on one A40. The checkpoint GPU snapshots reported about 4,799–4,801 MiB in use; peak PyTorch allocation was 3,761 MiB. Validation loss never deteriorated by the early-stop margin. The run manifest and per-checkpoint adapter SHA-256 values are in `outputs/l2/run.json`; its training dataset hash is `47dbc753e3796754f2bb917c5b05bedceef58a044280911607e92105774d6fe3`.

All five checkpoints used the **unchanged** 50 evaluation prompts and the same generation settings as B0 and L1. The held-out numbers below are completion-only loss on the **same 50 L2 short-passage probes**. They are not directly comparable with the older 11-complete-work losses of 2.955 B0 and 2.870 L1. On the short-passage probes, B0 scored 3.87292 and L1 step 48 scored 3.70032.

| L2 step | Val loss | Held-out loss | Length adherence | Mean words | Output tokens median / p90 | Mean words/line | Prompt-term misses | Generic phrase hits | Memorization flags |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 3.46311 | 3.58015 | 44% | 35.9 | 27 / 96 | 11.09 | 38/50 | 12 | 0/50 |
| 100 | 3.36431 | 3.47284 | 34% | 22.2 | 23 / 42 | 9.98 | 48/50 | 6 | 0/50 |
| 150 | 3.34847 | 3.45029 | 40% | 25.6 | 28.5 / 46 | 10.18 | 47/50 | 6 | 0/50 |
| 200 | 3.34612 | 3.44596 | 48% | 25.1 | 25 / 50 | 9.97 | 47/50 | 9 | 0/50 |
| 250 | 3.34127 | 3.44496 | 50% | 27.9 | 28 / 55 | 9.91 | 48/50 | 10 | 0/50 |

The prompt-term check counts a miss if no substantive word from the prompt appears in the output. It cannot judge paraphrases, but manual reading supports a real adherence problem. For comparison, B0/L1 step 48 had 78%/84% length adherence, 125.7/119.3 mean words, 38.12/25.09 mean words per output line, 24/32 prompt-term misses, and 51/49 generic-phrase hits. Step 50 is the **best L2 checkpoint for review** because it retains more substance and prompt contact than later checkpoints, despite their better loss. Its median output is 27 Qwen tokens, versus 160 B0 and 137.5 L1. The median line has eight words versus 25 B0 and nine L1; L2 has far fewer long lines (4/50 outputs with a line over 25 words versus 44 B0 and 29 L1). Its 32/50 prose-like flag count is largely from outputs of three or fewer lines. Full shape diagnostics, distributions, per-prompt flags, and token counts are in `outputs/l2-comparison/shape-selected.json` and `shape-{100,150,200,250}.json`.

Manual spot checks show some movement toward concise lyric phrasing: step 50 addresses the unfamiliar old friend directly and uses a moth image for the emergency-exit prompt. But it also gives only four words for the jealousy prompt, omits the locked room in that prompt, and turns the broken-clock request into a conventional story. Later checkpoints often fall to two or three generic relationship lines, including the wet-concrete and red-chair prompts; step 250 also misses the requested refrain. The model frequently ends after a short passage despite a longer requested length. These are material regressions in prompt fit and useful completion length. **L2 does not pass the creative-quality gate; L1 step 48 remains the current best available model.** Lower L2 loss alone does not change that decision. No optional follow-up was run because there is no clearly improved L2 checkpoint to refine.

The selected step-50 evaluation has **0/50 memorization flags**, zero shared training 5-grams, and a maximum four-word exact phrase shared with a training work. There are no flagged cases requiring a nearest-source-work listing. No substantial source passage is evident in the 50 generated outputs under the exact-overlap audit. A suspicious fuzzy-overlap detector was not implemented; this audit cannot prove that every output is original. The step-50 adapter is retained at `outputs/l2/checkpoint-050/` and all five checkpoint/evaluation artifacts are retained locally and on persistent pod storage. The 50-prompt randomized three-way packet is `outputs/l2-blind-review/review_packet.jsonl`, with `answer_key.json` separate and a rubric beside it. No blind human scores are claimed.

Because L2 did not improve actual writing over L1, it was **not exported to GGUF** and `models/best.gguf` was not changed. The existing L1 GGUF was loaded by the local `./writer` CLI after L2 and produced a response for a sunlight-room prompt; this is an operational check of the current model, not an L2 quality result. The pod remains running. The next experiment should specifically test stronger, human-checked prompt-to-passage grounding and a target-length mix that includes complete short responses, while preserving the fixed work split and eval prompts. A longer run with the current L2 labels is not supported by these results.
