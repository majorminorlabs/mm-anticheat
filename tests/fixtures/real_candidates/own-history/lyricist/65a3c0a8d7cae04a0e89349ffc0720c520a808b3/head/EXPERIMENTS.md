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

## L3 preflight: audit of L2 prompt grounding

Before changing the data, one retained L2 prompt/target pair from **each of the 84 training works** was inspected. The complete private sample and quantitative report are in `outputs/l2-prompt-audit.json`. Across all 373 training examples, there are only **144 distinct prompts**; 226 use just one concept tag, 16 use no tag, 120 prompts have at most three words, and all 239 descriptive prompts use the same “write something short” template. The body-only prompt recurs 28 times. The length control is `short` for 262/373 examples.

The tagger often chose an incidental word instead of the central situation. In `act-appalled:9-11`, “a sound or silence” misses the act of fooling someone; in `airplane-dance-demo:8-11`, “the body and belief or faith” misses the airplane setting; in `at-a-loss:8-13`, “leaving or returning” misses repeated doses and trying to sleep. `frozen-creek:9-11` describes an enclosed place but omits its explicit loneliness; `the-glorious-nosebleed:9-10` reduces a coercive passage to the word “jumping.” These are examples of prompts that plausibly support many unrelated completions. No distinctive prompt/target phrase longer than two words was found by the L2 QA, so long-phrase leakage was not the main failure. The greater problem is weak or misleading semantic supervision, compounded by very short targets and an EOS immediately after each short completion. This is an interpretation of the observed pairings and outputs, not a causal measurement.

## L3 dataset and pre-training gates

L3 keeps the same base model, 84/11/11 split, nine train-only anchors, and fixed 50 evaluation prompts. `scripts/build_l3.py` extracts complete 2–16-line stanzas or adjacent stanzas within one source section; it preserves blank lines between stanzas and exact Markdown source-line ranges. No target text is fabricated. Exact/near repeated sections, internally repetitive spans, and annotation spans are filtered before selection. Longer windows are reserved before overlapping shorter windows. The final training set has **224 passages from all 84 training works**: 29 very short (2–3 lines), 99 short (4–6), 72 medium (7–10), and 24 longer (11–16). The very-short share is below the desired 20% because many available 2–3-line spans lacked enough grounded content, while the medium/longer share is 43% versus L2's maximum of eight lines. There are 146 descriptive (65.2%) and 78 sparse (34.8%) prompts, plus 94 examples with no length request, 67 with the existing `length:` field, and 63 with a natural length request.

Prompt labels came from the **local** `gemma3:12b` model as a build-time labeling aid only. Its model ID, deterministic seed, temperature, prompt hash, per-batch request/response hashes, target hashes, and final prompt text are recorded in `corpus/metadata/l3_prompt_labels.json`; raw response envelopes are in ignored `outputs/l3-labeling/`. The labeler never generated target text. A first local model test invented unsupported scenes, so its output was discarded. The final labeler still needed rule-based and manual repair: 73 initially invalid class/evidence labels were re-requested, seven remaining cases were fixed manually, and eight overlong copied phrases were paraphrased. The private 79-pair review sample is stratified by length bucket, class, anchor status, and early/middle/late work order. Internal review marked **39 GOOD, 36 revised, 4 rejected**; source pairs and decisions are in `outputs/l3-review/reviewed.jsonl`, with a hash and counts in `corpus/metadata/l3_review_summary.json`. These are Codex's internal judgments, not independent human scores.

Final QA found **zero** source-line/provenance errors, split leaks, exact/fuzzy duplicate target pairs, or prompts sharing four consecutive words with targets. It verified the train-work coverage and nine train-only anchors. On the pinned Qwen tokenizer, L3 target lengths are median 48 tokens, p90 89, max 172; full sequences are median 77 and max 208, below the 384 cap. `scripts.train_l3.prepare` places **one EOS only after the entire target** and masks prompt tokens; an unequal-length batch check confirmed padding labels are `-100`, with no unmasked padding or truncated examples. L2 used the same terminal-EOS concept and did not have an identified formatting bug; its 35-token median target and 70% short length controls were a plausible data-distribution reason for early stopping. The machine-readable audit is `corpus/metadata/l3_qa.json`. Ten local tests passed, including an EOS/masking regression test, before A40 training.

## L3 training, evaluation, and selection

The two-update L3 smoke job passed CUDA forward/backward training, validation and held-out loss, adapter save/reload, fresh-process generation, and persistent-storage hash verification. The real run used the pinned Qwen3-1.7B base and LoRA rank 8 / alpha 16 / dropout 0.10 on query and value projections; BF16, sequence cap 384, batch 2, accumulation 4 (effective batch 8), AdamW weight decay 0.01, peak learning rate 6e-5, 10% warmup and linear decay over a planned 200 steps, and seed 314162. It ran **100 updates / 3.571 passage-level effective epochs in 79.64 seconds** on the existing A40. A checkpoint GPU snapshot showed about 5,769 MiB used; peak PyTorch allocation was 4,098 MiB. The training manifest and adapter hashes are in `outputs/l3/run.json`; training data SHA-256 is `0ec0569d1310c1baf9ceafc679950bec4f653546c2610ce86137ea4630559b02`.

All four retained checkpoints were generated on the **unchanged 50 prompts and generation settings**. `scripts/behavior_l3.py` reports a simple topic-contact proxy on 42 prompts: each has hand-defined concept groups with acceptable paraphrase stems, and eight vague prompts are excluded. The *first-50-word* version limits the advantage of long, wandering outputs; it still cannot judge whether the concept is used correctly. The premature-stop proxy flags short requests below 12 words, medium below 35, and long below 65. These are heuristic thresholds, not exact adherence to every prompt. The completion-only losses below use the **same 22 L3 held-out passages from the same 11 held-out works** for every model. They cannot be compared directly with the older complete-work or L2 short-passage loss values.

| Model | L3 held-out loss | Fixed-prompt length adherence | Mean words | Mean words/line | Below requested minimum | Medium/long below minimum | Topic-any, first 50 words | Generic phrase hits | Exact memorization flags |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | 3.37395 | 78% | 125.7 | 38.12 | 0/50 | 0/30 | 71.4% | 51 | 0 |
| L1 step 48 | 3.25005 | 84% | 119.3 | 25.09 | 0/50 | 0/30 | 54.8% | 49 | 0 |
| L2 step 50 | 3.15430 | 44% | 35.9 | 11.09 | 27/50 | 19/30 | 57.1% | 12 | 0 |
| L3 step 25 | 3.27575 | 76% | 116.3 | 39.55 | 2/50 | 1/30 | 66.7% | 50 | 0 |
| L3 step 50 | 3.09759 | 42% | 27.6 | 8.38 | 29/50 | 21/30 | 83.3% | 11 | 0 |
| L3 step 75 | 3.03767 | 42% | 24.9 | 9.05 | 29/50 | 24/30 | 71.4% | 10 | 0 |
| L3 step 100 | 3.01309 | 36% | 22.4 | 9.20 | 32/50 | 28/30 | 76.2% | 12 | 0 |

L3 validation losses at steps 25/50/75/100 were **3.30847 / 3.13360 / 3.08559 / 3.06051**. Falling loss again tracked progressively shorter output, rather than better completion. Step 25 mostly retained the base model's long prose shape: 41/50 prose-like flags and 50 generic phrase hits. Step 50 was the best **L3 candidate for blind review**, with the strongest early topic-contact proxy and shorter lyric-like lines. But its output was below the length minimum in 58% of prompts and 70% of medium/long requests. Steps 75 and 100 worsened that failure, so the scheduled 150/200 updates were **not run**. The 100-step adapter and optimizer remain saved for reproducibility.

Manual output checks support the failure diagnosis and the limits of the topic proxy. L3-50 gave only “A room in the sun” for the locked-room prompt, missed rain and the hospital with “A little girl with no eyes,” and answered the moth/emergency-exit prompt with one short line. It did sometimes use the requested subject more directly than L2-50, such as jealousy in p07, but the responses were often too brief to satisfy the prompt. Step 25's p33 produced a long prose biography of an invented clock collector. On the 50 L3-50 outputs, there were zero empty outputs, zero unexpected section labels, two meta-instruction phrase hits, and no duplicate lines; those narrow format checks do not certify that every passage is well formed. The full per-prompt behavioral data are in `outputs/l3-behavior-comparison.json`.

The selected L3-50 run has **0/50 exact memorization flags**, no shared training 5-grams, and a maximum four-word exact shared phrase. The conservative fuzzy-window audit found **0/50 suspicious outputs** at its two-rare-term and similarity thresholds (`outputs/l3-fuzzy-audit-050.json`). A clean detector is not proof of originality; the full candidate windows remain in that private file for inspection. `outputs/l3-blind-review/review_packet.jsonl` has all 50 randomized L1/L2-50/L3-50 comparisons, with `answer_key.json` kept separately and a nine-dimension human rubric. No independent blind reviewer scores have been received.

**L3 does not clearly beat L1, and the creative-quality gate remains unmet.** L3-50 improves a lexical topic-contact proxy over L1 and L2-50, but it sacrifices complete responses and shows no convincing overall writing improvement in the spot checks. L1 step 48 remains the current best usable model. No L3 GGUF was exported or promoted; `models/best.gguf` remains the verified L1 artifact. L3b was not run: the remaining problem has several plausible causes, and the present evidence does not isolate one low-risk fix tightly enough for a useful single-variant claim. The next controlled experiment should change only the **sampling weight of medium/long L3 targets**, preserving labels, base, rank, optimizer, and fixed evaluation prompts; inspect the first 25/50 updates before any longer run. This specifically tests whether the target-length distribution, rather than label grounding, drives early EOS.

L3 datasets, model adapters, generation records, local labeling envelopes, manual review, comparison loss files, and blind packet are ignored by Git and retained both locally and on the pod's `/workspace/lyricist` persistent mount. The pod remains running. No repository push or model publication occurred.

## L4: length-weighted sampling of the unchanged L3 passages

L4 tested one independent variable: **sampling weight by target-length bucket**. It reused the exact L3 prompts, targets, 84/11/11 work split, 24 validation and 22 held-out probes, pinned base revision, rank-8 adapter, optimizer, 200-step warmup/decay schedule, seed 314162, sequence cap 384, effective batch 8, and fixed 50-prompt generation settings. No lyric source, label, tokenizer, or evaluation prompt changed. The 224 L3 training examples had 29 very-short / 99 short / 72 medium / 24 longer targets. `scripts/l4_sampler.py` gave them relative weights **0.5 / 0.75 / 1.5 / 2.5**, choosing a weighted bucket and then a least-repeated passage from a least-used source work within that bucket. The expected sampled proportions were **5.65% / 28.92% / 42.06% / 23.37%**. The 50-step trace verified actual proportions **5.00% / 31.00% / 40.25% / 23.75%** (20 / 124 / 161 / 95 of 400 draws). It covered **215 distinct passages and all 84 training works**; no passage appeared more than four times and no work more than 14 times. Effective descriptive/sparse exposure was 65.75%/34.25%. The trace was checked exactly against the deterministic plan in `corpus/metadata/l4_sampler_qa.json`.

Before training, the full tokenizer and sampler QA rechecked one EOS only after each target, prompt and padding labels masked as `-100`, unequal-length padding, target-token median 48 / p90 89 / max 172, full-sequence max 208 below the cap, and zero truncation. No formatting defect was found. Twelve local tests passed before the GPU run. A two-update A40 smoke test passed forward/backward training, validation/held-out loss, adapter save/reload, deterministic trace verification, and fresh-process generation on two fixed prompts.

The real run completed **50 updates / 1.786 effective passage epochs in 40.44 seconds** on the existing A40; peak PyTorch allocation was 4,098 MiB and checkpoint snapshots showed about 5,483 MiB GPU use. Checkpoints 15/25/35/50 all used the unchanged 50-prompt suite; run manifests for all nine comparison models have the same prompt SHA-256 `358012c9bf38cd18a561db136034fd3eb5f0723a41e0b9053adf46eb060454b8` and generation configuration. Validation losses were 3.39705 / 3.30689 / 3.21897 / 3.13473. The held-out losses below are completion-only loss on the **same 22 L3 held-out passages** for all models. “Below minimum” is the premature-stop proxy (short <12, medium <35, long <65 words). Topic contact is a first-50-word concept-stem proxy on 42 prompts, not a semantic judgment. Format anomaly counts are heuristic matches for empty text, unexpected section labels, instruction-like text, or section-label-only skeletons; they do not detect every malformed output.

| Model | Held-out loss | Length adherence | Mean words | Mean words/line | Below minimum | Medium/long below minimum | Topic contact | Generic hits | Duplicate lines | Format anomalies | Exact flags |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | 3.37395 | 78% | 125.7 | 38.12 | 0/50 | 0/30 | 71.4% | 51 | 1 | 1 | 0 |
| L1-48 | 3.25005 | 84% | 119.3 | 25.09 | 0/50 | 0/30 | 54.8% | 49 | 7 | 3 | 0 |
| L2-50 | 3.15430 | 44% | 35.9 | 11.09 | 27/50 | 19/30 | 57.1% | 12 | 0 | 0 | 0 |
| L3-25 | 3.27575 | 76% | 116.3 | 39.55 | 2/50 | 1/30 | 66.7% | 50 | 0 | 3 | 0 |
| L3-50 | 3.09759 | 42% | 27.6 | 8.38 | 29/50 | 21/30 | 83.3% | 11 | 0 | 0 | 0 |
| L4-15 | 3.34914 | 86% | 122.9 | 37.67 | 0/50 | 0/30 | 61.9% | 43 | 1 | 1 | 0 |
| L4-25 | 3.26957 | 80% | 109.7 | 32.59 | 3/50 | 2/30 | 69.0% | 29 | 0 | 3 | 0 |
| **L4-35** | **3.17975** | **82%** | **74.9** | **19.07** | **9/50** | **7/30** | **83.3%** | **33** | **2** | **0** | **0** |
| L4-50 | 3.09724 | 42% | 28.7 | 8.52 | 29/50 | 25/30 | 76.2% | 13 | 1 | 0 | 0 |

For the 30 medium/long requests, the per-prompt artifact `corpus/metadata/l4_medium_long.json` records each requested category, actual word length, below-minimum flag, and topic-contact proxy. The category summaries are:

| Model | Medium below 35 words (20) | Mean medium words | Medium contact | Long below 65 words (10) | Mean long words | Long contact |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| L1-48 | 0 | 127.8 | 52.9% | 0 | 196.4 | 50.0% |
| L3-25 | 1 | 128.1 | 58.8% | 0 | 194.3 | 87.5% |
| L3-50 | 13 | 31.0 | 88.2% | 8 | 44.5 | 75.0% |
| L4-15 | 0 | 131.9 | 58.8% | 0 | 201.6 | 62.5% |
| L4-25 | 2 | 109.2 | 70.6% | 0 | 201.0 | 62.5% |
| **L4-35** | **6** | **76.7** | **88.2%** | **1** | **136.9** | **62.5%** |
| L4-50 | 16 | 28.1 | 76.5% | 9 | 40.6 | 75.0% |

The same 16 prompts were manually read at every L4 checkpoint; IDs and coverage are in `corpus/metadata/l4_qualitative_subset.json`, with notes in `corpus/metadata/l4_qualitative_notes.json`. Step 15 retained long generic prose. Step 25 gained some line breaks, but one lighthouse request produced unrelated writing instructions and the lost-dog form request produced only empty “Verse” and “Chorus” headings. Step 35 found a better length/style region: the riverbed and moth prompts had more distinctive images, the vague “other side” prompt became a complete lyric-shaped response, and the lost-dog request used verse/chorus. However, the hospital prompt put rain outside instead of inside; the lighthouse prompt placed sailors nearby despite asking for distance from water; the voicemail/refrain request became four unrelated lines; other long outputs wandered into explanatory prose or ended mid-thought. Step 50 again collapsed to very short outputs. These are internal judgments, not independent human scores.

**L4-35 is the best L4 checkpoint for review**, chosen for the 82% length adherence and much lower medium/long premature-stop rate than L3-50 while retaining strong topic contact. It is still not a clear overall win over L1: 7/30 medium/long requests stop below minimum versus 0/30 for L1, several fixed-subset prompts materially miss their requested situation or form, and the creative-quality gate remains unmet. It therefore was **not promoted**. The L1 GGUF and local writer remain unchanged; no L4 GGUF was exported. No step 75 ran because step 50 was unhealthy. No L4b ran: the failure includes prompt/form drift and prose degeneration, so a one-weight adjustment is not a sufficiently isolated remedy.

The L4-35 exact audit found **0/50 memorization flags**, a maximum five-word exact shared phrase, and a mean 0.02 shared training 5-grams per output. The conservative fuzzy-window audit found **0/50 suspicious outputs** (`outputs/l4-fuzzy-audit-035.json`); neither result proves originality. A randomized 50-prompt L1-48/L3-25/L3-50/L4-35 packet is in `outputs/l4-blind-review/review_packet.jsonl`, with `answer_key.json` separate and the existing nine-dimension rubric. No independent scores are claimed. Full fixed-prompt metrics and per-prompt diagnostic values are in `corpus/metadata/l4_evaluation.json` and `corpus/metadata/l4_medium_long.json`. Adapters, optimizer state, traces, generations, audit, and packet are retained locally and on the pod's persistent `/workspace/lyricist` mount. The pod remains running; nothing was pushed or published.

The single next controlled experiment should test **length-control field exposure** while keeping L4 sampling, source passages, semantic labels, model, and optimizer fixed. Only 67 of 224 L3/L4 training examples carry the `length:` field, while every fixed evaluation call supplies one. The L4-35-to-50 collapse despite 64% medium/long sampling makes that conditioning mismatch a more specific hypothesis than simply increasing long-target weight again. Evaluate at the same early checkpoints before considering promotion.

## L5: controlled length-field exposure on the L4 sampler

L5 tested the train/evaluation conditioning mismatch identified above. The machine-readable original audit (`corpus/metadata/l5_original_field_audit.json`) confirmed **67/224 explicit `length:` fields** and 157 without a field (94 `none`, 63 natural-language length requests). The original explicit counts were 11/29 very-short, 29/99 short, 21/72 medium, and 6/24 longer. All 11 explicit fields on very-short targets said `short`, whereas the canonical label for that bucket is `very short`; these are a coarse-label mismatch, not malformed syntax. The other 56 existing labels matched their buckets. The 63 natural requests used seven `very short`, 30 `short`, 18 `medium-length`, and eight `longer` phrases; none was ambiguous or mismatched to its bucket. The original explicit examples covered 49 training works; the full source set covered all 84. The field syntax is the same `length: LABEL` line produced by `scripts.modeling.format_prompt` at training and evaluation.

`scripts.build_l5` uses deterministic selection seed **314165** and produces exactly 224 variants, not additional examples. It leaves every target, prompt string, provenance field, semantic concept/evidence, class, work, and row order unchanged; only `length_control` and `length_mode` can differ. Canonical labels are `very short` / `short` / `medium` / `long`. The L5 train JSONL SHA-256 is `a5c3cb2ef60b1fae7e8d11a956c96935f518ae3fb047636000dc327937ca7608`. The final **179 explicit (79.91%) / 45 fieldless (20.09%)** counts are:

| Target bucket | Total | Explicit | No field |
| --- | ---: | ---: | ---: |
| Very short | 29 | 23 | 6 |
| Short | 99 | 79 | 20 |
| Medium | 72 | 58 | 14 |
| Longer | 24 | 19 | 5 |

The descriptive class is 116 explicit / 30 fieldless (146 total); sparse is 63 / 15 (78 total). Explicit rows cover 79 works and fieldless rows cover 45; all 84 works remain present. Among the 45 fieldless rows, 29 are fully length-unspecified and 16 retain their original natural-language length request. The nine style-anchor works contribute 19 explicit and four fieldless examples among their 23 total. The complete per-work counts and checks are in `corpus/metadata/l5_qa.json`. That audit verified unchanged target hashes/text and all non-field properties, source-line provenance, no duplicate target hashes or cross-work split leakage, 384-token cap with zero truncation, one EOS after each target, prompt and padding loss masks, and the exact L4 sample plan. The **actual 50-step L5 sample trace SHA-256 equals L4's**, `7d22e0bfa3028feeef09763906cb956c87cf7fc23da99bf8c7458cee240ac540`, with the same 20/124/161/95 bucket draws. Fourteen local tests passed before training.

The two-update A40 smoke passed loading, training, checkpoint save/reload, fixed evaluation on two prompts, and fresh-process generation. The real A40 run completed **50 updates in 44.41 seconds** (42.44 seconds measured to the step-50 checkpoint), using the pinned base/revision, rank-8 LoRA, effective batch 8, sequence cap 384, peak LR `6e-5`, L4 sampler weights, unchanged validation/held-out passages, and the unchanged fixed 50-prompt generation settings. Step-15/25/35/50 adapter hashes and losses are in `outputs/l5/run.json`. The fixed prompt SHA-256 matched all six baselines: `358012c9bf38cd18a561db136034fd3eb5f0723a41e0b9053adf46eb060454b8`. Lower held-out loss again coincided with shorter outputs. The table uses the same 22 L3 held-out probes for all models. “Below minimum” is a word-count proxy; format anomalies are anchored instruction phrases, unexpected labels, empty output, or label-only skeletons. Topic contact is a first-50-word lexical proxy on 42 prompts.

| Model | Held-out loss | Length adherence | Mean words | Words/line | Below minimum | Medium/long below | Topic contact | Duplicate lines | Format anomalies | Exact flags |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | 3.37395 | 78% | 125.7 | 38.12 | 0 | 0/30 | 71.4% | 1 | 1 | 0 |
| L1-48 | 3.25005 | 84% | 119.3 | 25.09 | 0 | 0/30 | 54.8% | 7 | 2 | 0 |
| L3-25 | 3.27575 | 76% | 116.3 | 39.55 | 2 | 1/30 | 66.7% | 0 | 2 | 0 |
| L3-50 | 3.09759 | 42% | 27.6 | 8.38 | 29 | 21/30 | 83.3% | 0 | 0 | 0 |
| L4-35 | 3.17975 | 82% | 74.9 | 19.07 | 9 | 7/30 | 83.3% | 2 | 0 | 0 |
| L4-50 | 3.09724 | 42% | 28.7 | 8.52 | 29 | 25/30 | 76.2% | 1 | 0 | 0 |
| L5-15 | 3.35288 | 78% | 120.1 | 38.89 | 0 | 0/30 | 69.0% | 4 | 1 | 0 |
| L5-25 | 3.27312 | 84% | 114.6 | 29.80 | 2 | 1/30 | 73.8% | 4 | 2 | 0 |
| **L5-35** | **3.18034** | **76%** | **76.8** | **18.26** | **9** | **6/30** | **85.7%** | **2** | **1** | **0** |
| L5-50 | 3.09603 | 52% | 32.0 | 8.80 | 24 | 19/30 | 81.0% | 0 | 0 | 0 |

The full requested-length breakdown for every row above is in `corpus/metadata/l5_evaluation.json`: prompt count, adherence, mean/median words, below/above range, topic contact, format-anomaly count, and unfinished-tail proxy. The fixed suite contains **zero very-short requests**, so that category is correctly marked unavailable. The decisive matched-step comparison: L5-35 improves medium shortfalls from 6/20 to 4/20, but long shortfalls worsen from 1/10 to 2/10; short adherence falls from 90% to 70% (three short requests below and three above range), overall adherence falls from 82% to 76%, and the one clear L5-35 instruction leak is on p16. Mean output words barely change, 74.9 to 76.8. This is a mixed change, not a clean length-conditioning gain. At step 50 L5 again contracts to 32 mean words and 19/30 medium/long shortfalls, so step 75 was not run.

The secondary no-length diagnostic removed the field from 16 preselected fixed concepts, kept form, seeds, sampling settings, and a common 160-token cap, and did not alter the main benchmark. Its summaries and internal reading are in `corpus/metadata/l5_no_length.json`, with generations in ignored `outputs/l5-no-length-*`. L1-48 / L4-35 / L5-35 averaged **99.9 / 36.8 / 70.7 words**, with **81.8% / 90.9% / 90.9%** first-50-word topic contact on 11 scorable prompts. L5-35 is not completely dependent on a supplied field, but p01 and p04 hit the cap in prose, p18 wrongly places a landlocked beacon by the sea, p33 is only five words, and p50 lacks the requested refrain. These are diagnostic, not comparable length-adherence scores.

Internal reading of the same L4 16-prompt subset across L1-48, L4-35, L5-25/35/50 is recorded in `corpus/metadata/l5_qualitative_notes.json`. L5-25 usually meets length but often becomes generic explanatory prose: p38 is an invented pseudo-scientific essay and p43 a book synopsis. L5-35 has some line-broken imagery and more developed medium outputs, but p16 emits an unrelated text-editing instruction, p18 contradicts its landlocked premise, p33 rambles, p42 is sprawling prose, and p50 mentions a phone message without a recognizable refrain. L5-50 is commonly too short to develop the requested idea. No independent human scores are claimed.

For L5-35, exact checks flagged **0/50**, the longest shared phrase was **five words**, and `outputs/l5-fuzzy-audit-035.json` found **0/50 suspicious outputs** at the documented threshold. This is limited detector evidence, not proof of originality. Because L5-35 was a plausible writing-review candidate, a randomized 50-prompt **L1-48/L4-35/L5-35** packet was made at `outputs/l5-blind-review/review_packet.jsonl`; `answer_key.json` is separate and no human preference scores are asserted.

**Decision:** L5-35 is the best L5 checkpoint for review, but L5 does **not** clearly beat L4-35 or L1, and the creative-quality gate did not pass. L1-48 remains the current model; no GGUF export or `writer` change occurred. L5b did not run: the result does not isolate the explicit/no-field ratio as a clear cause, and step-50 collapse plus prompt-quality failures remain. Code, QA, ledger, and lightweight results are committed; generated data, adapters, optimizer state, prompts, and packet remain ignored and private. The local and A40 persistent copies retain the artifacts; the pod remains running. No push or publication occurred.

One next controlled experiment should test **down-weighting only the terminal EOS loss** while keeping L4 sampling, L3 targets/semantic prompts, pinned base, and evaluation fixed. The repeated step-35-to-50 collapse despite falling loss gives a specific hypothesis that EOS supervision becomes too attractive; it has not yet been tested or established as the cause. Inspect 25/35/50 behavior and require independent blind quality review before promotion.

## L6: terminal EOS loss weight 0.25

**Intervention and audit.** The pinned Qwen3-1.7B base/revision, rank-8 LoRA, effective batch 8, 384-token cap, `6e-5` peak LR, AdamW, L5 dataset, work splits, L4 sampler, seed, and fixed prompt/generation suite were held constant. The only training intervention was a `0.25` coefficient on the single terminal target EOS label. `scripts.audit_l6_eos` traced the installed causal-LM loss: labels shift one token, ignored labels stay out of float32 mean cross entropy, and the L5 trainer supplies no alternate item-count denominator. Every target has exactly one supervised EOS after its passage; prompts and padding are masked with `-100`, and no internal EOS is supervised. There was **no implementation bug** to repair. In 224 training passages, 224 EOS labels occupy 1.8316% of 12,230 supervised tokens. Target text excluding EOS ranges from 11 to 172 tokens (median 47.5). The EOS share is 4.68% for very-short passages and 0.99% for longer passages; the 400 draws in the first 50 L4-sampled updates have 400 EOS labels among 26,450 supervised tokens (1.5123%). These proportions establish relative exposure, not an observed causal mechanism.

`scripts.terminal_eos_loss` changes only the terminal EOS contribution and divides by the original number of supervised tokens, leaving every non-EOS coefficient unchanged. Synthetic tests cover weight-one equivalence, terminal-only gradients, masking, internal EOS, finite batched gradients, and invalid inputs. On the A40, a two-update weight-`1.0` control reproduced L5 smoke train/validation/held-out losses, the sampled-example trace hash, and both adapter SHA-256 hashes **exactly**. The `0.25` smoke passed backward updates, finite losses, checkpoint save/reload, fresh-process two-prompt generation/evaluation, and persistent-storage hash checks. `corpus/metadata/l6_loss_equivalence.json`, `l6_eos_audit.json`, `l6_qa.json`, and `l6_generation_equivalence.json` retain the details.

The real A40 run completed **50 updates in 45.82 seconds**; checkpoints 15, 25, 35, 40, 45, and 50 were evaluated. The L6 and L5 first-50-update sample traces are identical (`7d22e0bfa3028feeef09763906cb956c87cf7fc23da99bf8c7458cee240ac540`), covering 215 distinct examples from all 84 training works. Held-out loss below is ordinary, unweighted causal loss on the same 22 probes; it is comparable with earlier rows. “Below minimum” uses the established short/medium/long word minima of 12/35/65, a proxy for premature stopping. EOS position is one-based in the generated token sequence and its mean/median are conditional on EOS being emitted; capped generations are censored.

| L6 step | Held-out loss | Mean output tokens | Mean words | EOS emitted | First EOS mean | First EOS median | Length adherence | Below minimum | Medium/long below |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 15 | 3.35583 | 144.32 | 122.3 | 4/50 | 73.00 | 56 | 78% | 0 | 0/30 |
| 25 | 3.29768 | 137.68 | 117.5 | 9/50 | 88.56 | 92 | 76% | 1 | 0/30 |
| 35 | 3.21672 | 125.10 | 107.9 | 21/50 | 91.62 | 77 | 80% | 3 | 1/30 |
| 40 | 3.17145 | 107.28 | 91.8 | 31/50 | 84.74 | 89 | 80% | 4 | 2/30 |
| 45 | 3.13189 | 72.16 | 60.7 | 38/50 | 58.47 | 48 | 56% | 16 | 14/30 |
| 50 | 3.10931 | 65.82 | 55.1 | 45/50 | 58.84 | 39 | 66% | 15 | 12/30 |

The unchanged evaluator was instrumented to record generated token IDs and teacher-forced raw EOS softmax probability on ten fixed prompts (`p01,p02,p04,p06,p10,p16,p18,p33,p43,p50`). A full 50-prompt instrumented rerun of L5-35 and L5-50 produced **50/50 identical texts** to each original evaluation. L5-35 emitted EOS on 41/50 prompts (mean first position 76.88); L5-50 emitted it on 50/50 (mean first position 39.18). L6-35's 21/50 and L6-40's 31/50 show materially delayed EOS emission, but L6-45/50 rise to 38/50 and 45/50. The ten-prompt raw-probability curves and reached-position summaries are in `corpus/metadata/l6_eos_diagnostics.json`. They show large EOS probability at some sampled EOS positions, but no clean monotonic probability at any fixed position: each checkpoint samples different content, later positions have fewer surviving prompts, and the raw probability excludes sampling filters. The **emission and length** changes are stronger evidence for delayed stopping than the pointwise probability aggregates.

The full standard comparison below uses the same 50 prompts and generation settings. Topic contact is the existing lexical first-50-word proxy on 42 scorable prompts. Duplicate lines, format anomalies, unfinished tails, and exact source overlap are existing heuristics; unfinished tails can also be legitimate lyric endings. Full per-length and prompt-level metrics are in `corpus/metadata/l6_evaluation.json`.

| Model | Held-out loss | Adherence | Mean words | Words/line | Below min | M/L below | Topic contact | Duplicate lines | Format anomalies | Unfinished tails | Exact flags |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | 3.37395 | 78% | 125.7 | 38.12 | 0 | 0/30 | 71.4% | 1 | 1 | 43 | 0 |
| L1-48 | 3.25005 | 84% | 119.3 | 25.09 | 0 | 0/30 | 54.8% | 7 | 2 | 33 | 0 |
| L4-35 | 3.17975 | 82% | 74.9 | 19.07 | 9 | 7/30 | 83.3% | 2 | 0 | 19 | 0 |
| L5-35 | 3.18034 | 76% | 76.8 | 18.26 | 9 | 6/30 | 85.7% | 2 | 1 | 15 | 0 |
| L5-50 | 3.09603 | 52% | 32.0 | 8.80 | 24 | 19/30 | 81.0% | 0 | 0 | 36 | 0 |
| L6-15 | 3.35583 | 78% | 122.3 | 40.08 | 0 | 0/30 | 71.4% | 2 | 1 | 41 | 0 |
| L6-25 | 3.29768 | 76% | 117.5 | 29.45 | 1 | 0/30 | 78.6% | 2 | 2 | 36 | 0 |
| L6-35 | 3.21672 | 80% | 107.9 | 24.12 | 3 | 1/30 | 76.2% | 2 | 0 | 32 | 0 |
| L6-40 | 3.17145 | 80% | 91.8 | 17.57 | 4 | 2/30 | 85.7% | 0 | 0 | 33 | 0 |
| L6-45 | 3.13189 | 56% | 60.7 | 9.73 | 16 | 14/30 | 71.4% | 6 | 0 | 30 | 0 |
| L6-50 | 3.10931 | 66% | 55.1 | 9.35 | 15 | 12/30 | 88.1% | 4 | 0 | 38 | 0 |

The 20 medium and 10 long prompts show the transition more clearly: L4-35 falls below minimum on 6 medium and 1 long prompt; L5-35 on 4 and 2; L6-35 on **0 and 1**; L6-40 on **1 and 1**; L6-45 on **9 and 5**; L6-50 on **10 and 2**. At L6-40, medium outputs average 102.0 words and long outputs 140.2; at L6-50 they average 56.5 and 96.9. The full per-prompt breakdown is in `corpus/metadata/l6_evaluation.json`.

Internal reading of the preselected 16 prompts compared L1-48, L4-35, L5-35, and L6-25/35/40/50; notes and per-prompt word counts are in `corpus/metadata/l6_qualitative_notes.json`. L6-40 is the best **L6 blind-review candidate**: compared with L6-35 it has more line-broken development on the riverbed glass and empty theater staircase prompts, while retaining 80% length adherence, 85.7% lexical topic contact, and only 2/30 medium/long shortfalls. It still fails important constraints. The locked-room prompt becomes a five-word fragment; the far-from-water lighthouse is placed above the sea; jealousy is explicitly named despite the request not to name it; a recognizable voicemail refrain is absent. Broken clocks and “what happened before” drift into long ordinary prose. L6-25 is often still explanatory prose, including a book synopsis on “the other side.” By step 50 many responses end before their idea develops. Thus the extra length at 35–40 yields some useful local images, but does **not** establish better overall writing, unusual phrasing, cadence, ambiguity, or completeness than L4 or L1. No independent preference scores are claimed.

All fixed-prompt runs have zero exact memorization flags; L6-40's longest normalized exact phrase shared with a training work is **four words**. The conservative fuzzy audit of L6-40 found **0/50 suspicious outputs** at its documented threshold; `corpus/metadata/l6_fuzzy_summary.json` covers every standard comparison row. The nearest L6-40 source windows (p05, p12, p22, p23, and p40) reached only 0.625 similarity over eight tokens, each with zero rare shared terms; none is a suspicious case under the audit rule. These detectors cannot prove originality. A reproducibly randomized, separate-key **L1-48/L4-35/L6-40** packet is at `outputs/l6-blind-review-040/review_packet.jsonl`, with `answer_key.json` and the established 1–5 rubric alongside it. It has not been independently scored.

**Decision:** Reducing terminal EOS pressure delays the shortening: L6-40 has 2/30 medium/long shortfalls versus L4-35's 7/30 and L5-35's 6/30. Collapse still arrives around steps 45–50 while held-out loss keeps falling. EOS weighting is a contributing length mechanism, but the experiment does not establish it as the main creative-quality limit. L6-40 is competitive enough for blind review, yet it does **not clearly beat L4-35 or L1-48** on actual writing and fails the promotion gate. L6b did not run: the 0.25 intervention already lengthens outputs without resolving prompt and prose-drift failures, so a further EOS weight change lacks a clear creative-quality rationale. No GGUF was exported; the L1 GGUF and `writer` remain unchanged. Adapters, optimizer state, evaluations, and blind packet are ignored by Git and retained locally and on the pod's persistent mount. The pod remains running; no push or publication occurred.

The next controlled experiment should change **only the training stopping/selection criterion**, using the fixed L6-40 and historical checkpoints as candidates and a small predeclared prompt-quality rubric that penalizes violated constraints and generic prose. Blind ratings could establish whether length gains correspond to better writing before any additional training intervention. Avoid choosing by held-out loss alone, which improved throughout the observed collapse.

## L7: predeclared blind quality comparison

L7 used **existing generations only**: B0, L1-48, L3-25, L4-35, L5-35, and L6-40. Each run has the same 50 prompt SHA-256 (`358012c9bf38cd18a561db136034fd3eb5f0723a41e0b9053adf46eb060454b8`), generation settings (`0.85` temperature, `0.92` top-p, `1.08` repetition penalty, length-specific token cap), and per-prompt seeds (`314159` onward). No training, source-lyric changes, prompt rewriting, or regeneration occurred. The new A40 pod was left running and unchanged.

The complete 0–4 rubric, composite formulas, failure definitions, and local-judge protocol were committed in `corpus/metadata/l7_blind_rubric.md` before scoring. Style is `(imagery + phrasing + cadence + ambiguity)/4`. Utility is the mean of prompt contact, constraint following, imagery, phrasing, cadence, ambiguity, coherence, completeness, and overall quality, **minus prose drift/4**. Prompt-only regime labels were frozen in `l7_prompt_types.json`. `scripts.blind_quality_l7` independently shuffled all six identities within each prompt (seed `314168`) and all three pair orders and A/B sides (seed `314169`). Answer keys were separate. A fresh-context **local Mistral Small 3.2 24B** request at temperature 0 and seed `314167` scored each anonymous response, then compared the anonymous pairs without seeing earlier scores. The exact local model ID was `5a408ab55df5`; all 300 response and 150 pairwise records validated, with **zero retries**. Packet, keys, raw scores, input hashes, and runtime metadata are in `corpus/metadata/l7_blind/`. This is one model judge, **not human preference data**.

Means from the frozen rubric, each over 50 prompts:

| Candidate | Prompt A | Constraint B | Imagery C | Phrasing D | Cadence E | Ambiguity F |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | 2.62 | 2.92 | 2.48 | 2.18 | 1.84 | 1.56 |
| L1-48 | 2.00 | 2.36 | 2.22 | 2.06 | 1.74 | 1.72 |
| L3-25 | 2.22 | 2.54 | 2.08 | 1.82 | 1.52 | 1.36 |
| L4-35 | 2.20 | 2.58 | 1.94 | 1.96 | 1.90 | 1.44 |
| L5-35 | 2.12 | 2.50 | 1.80 | 1.92 | 1.78 | 1.54 |
| L6-40 | 2.18 | 2.62 | 2.04 | 2.08 | 1.94 | 1.64 |

| Candidate | Prose penalty G | Coherence H | Complete I | Overall J | Style | Utility |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | 1.48 | 2.68 | 1.54 | 2.16 | **2.015** | **1.850** |
| L1-48 | 2.02 | 2.48 | 1.64 | 1.94 | 1.935 | 1.513 |
| L3-25 | 1.88 | 2.36 | 1.54 | 1.78 | 1.695 | 1.443 |
| L4-35 | 1.50 | 2.56 | 2.08 | 2.00 | 1.810 | 1.698 |
| L5-35 | 1.42 | 2.46 | **2.30** | 1.86 | 1.760 | 1.676 |
| L6-40 | 1.48 | 2.54 | 1.94 | 2.00 | 1.925 | **1.739** |

Style ranks **B0 > L1 > L6 > L4 > L5 > L3**. Utility ranks **B0 > L6 > L4 > L5 > L1 > L3**. Overall-quality mean ranks **B0 > L4 = L6 > L1 > L5 > L3**. Every model's median overall score is 2/4; B0's median utility is 1.972, L4/L5 1.917, L6 1.847, L1 1.667, and L3 1.556. These scores do not establish a large quality separation among trained candidates. Exploratory paired-prompt bootstrap intervals for the utility difference include zero for L6−L1 (`+0.226`, 95% interval `−0.014` to `+0.458`) and L4−L1 (`+0.186`, `−0.088` to `+0.456`). Details are in `l7_model_scores.json` and `l7_judge_audit.json`.

The pairwise pass, restricted to the three preselected trained candidates, reached a different ordering. Counts show wins for the first candidate, ties, then wins for the second:

| Pair | First wins | Ties | Second wins | Clear wins, first / second |
| --- | ---: | ---: | ---: | ---: |
| L1-48 vs L4-35 | 14 | 30 | 6 | 8 / 3 |
| L1-48 vs L6-40 | 15 | 32 | 3 | 3 / 3 |
| L4-35 vs L6-40 | 7 | 32 | 11 | 1 / 5 |

The judge favored L1 among the non-ties against both L4 and L6, especially on short prompts (L1–L6: 9 wins, 9 ties, 2 losses). Most prompts were ties, and these pairwise preferences conflict with L1's lower mean utility, so they are evidence of **different judgments under direct comparison**, not proof that L1 is better. See `l7_pairwise_summary.json` for all 150 per-prompt outcomes and reason tags.

Prompt regimes reveal a real tradeoff. On the ten long prompts, L6-40 had the highest mean utility (`2.11`) and overall quality (`2.30`), while B0 scored `1.50` and `2.10`. On 20 short prompts, B0 led utility (`2.08`), L4 followed (`1.99`), and L6 fell to `1.64`. On 20 medium prompts, B0 led (`1.80`), with L6 second (`1.66`). The three sparse prompts favored L4 by mean overall quality (`2.33`), but that cell is too small for a stable claim. For the three explicit structural prompts, L5 had the highest mean utility (`2.37`), yet the focused audit found that none of the six p50 responses actually supplied a refrain. The full concrete/abstract, sparse/descriptive, explicit-constraint, and structural breakdown is in `l7_prompt_type_breakdown.json`.

The full 300-response failure taxonomy is in `l7_failure_taxonomy.json`. The judge tagged 190 responses as premature stopping, 184 as generic prose, 58 as subject misses, 57 as good contact with generic writing, 33 as structure failures, 10 as incoherent abstraction, 7 as cliché, 6 as malformed, 5 as refrain failures, 4 each as excessive literalness and strong imagery with poor contact, 2 as repetition, and 1 as assistant/editor language. It tagged **zero** explicit contradictions and forbidden-word violations. These free-form tags require caution: 130 `generic_prose` tags had prose-penalty score G below 3, and 48 `premature_stopping` tags had completeness I above 1. The predeclared numeric cross-checks give 59 responses with G≥3, 142 with I≤1, and 54 with A≤1. The deterministic length check found 24 below the requested minimum and 38 above the maximum; p07's forbidden `jealous*` stem appeared in L3 and L6. All 18 pairs of identical texts within a prompt received identical numeric scores, but that reproducibility does not fix the semantic tag errors.

A separately labeled **post-unblinding focused audit of only five explicit/structural prompts** (`l7_focused_constraint_audit.json`) confirmed the judge missed meaningful failures. L4, L5, and L6 place the far-from-water p18 lighthouse at or near the sea; L3 and L6 name the forbidden p07 concept; L3 emits only labels for p48; L1, L4, L5, and L6 violate p49's single-stanza requirement; and **all six** lack a recognizable p50 refrain. The L6 p49 response also asks for feedback. The raw judge tags are therefore reported as model-produced classifications, not verified all-corpus counts for those semantic categories. The frozen numeric scores were not edited after this audit. The fixed p50 benchmark asks for **a refrain**, not a growing refrain; earlier L5/L6 notes that imposed growth were over-specific and have been corrected.

**Learned tradeoff and selection:** B0's single-response means lead on contact, imagery, style, utility, and overall quality, though its completeness mean is low (1.54). Relative to L1, L4/L5/L6 generally reduce prose drift and improve completeness, but do not improve mean imagery; L6 adds cadence and is especially useful on long prompts while remaining weaker on short ones. L3-25 is weakest by all three summary rankings. No later checkpoint clearly beats L1: L6's utility advantage has an interval spanning zero, L4 and L6 tie on overall-quality mean, direct pairwise judgments favor L1 among non-ties, and explicit constraints still fail. **Retain L1 as the deployed incumbent provisionally**, without claiming it is globally best; the single judge's B0 lead and its missed constraints make promotion or demotion premature. No model was exported or changed.

**One next training experiment, not executed:** Add a fixed small share of **train-work-derived negative/location constraint prompts** whose constraints are verified against unchanged training target passages. Start from the same pinned base and L6 setup, keeping work splits, targets, L4 sampler, terminal EOS weight `0.25`, optimizer, and 50-prompt evaluation fixed. Compare matched 25/35/40-step checkpoints and inspect p07/p18 plus the full blind rubric for style or completeness regression. This targets the direct negation and spatial failures seen in the focused audit without using evaluation prompts or held-out works as training examples. The proposal and limits are in `l7_decision.json`. The A40 pod remains running and unchanged; no push or publication occurred.

## L8: train-derived constraint prompts at 25% exposure

L8 tested the L7 proposal as **one controlled training run**. It kept the pinned Qwen3 1.7B base revision, L6 rank-8 LoRA/optimizer/LR/sequence cap/terminal EOS coefficient, L5 semantic prompts and target passages, work splits, L4 length weights, fixed 50 prompts, and generation settings. Only the auxiliary constraint prompt component and checkpoint cadence changed. The 70 proposed prompts came from training works only; all 70 were reviewed against their complete unchanged targets. Internal review marked **60 GOOD, 3 REVISE, 7 REJECT**, leaving **63** variants across 49 works: **44 lexical prohibitions, 12 spatial/relation, 7 indirect exclusions**. Five proposals failed deterministic lexical checks; remaining rejections or revisions came from target support or prompt quality review. Each final target is an exact existing training target, with one variant per target; no evaluation prompt or held-out work was used as a training example. Provenance, validation, decisions, and final prompt metadata are in `corpus/metadata/l8_constraint_*.json`. Full target text remains in the ignored derived dataset `data/l8/constraints.jsonl`, SHA-256 `1457da43fa1c37ee7e683b8e338b2f5625dd31a7ad71f5ce9c695a5ab8fd418a`.

The deterministic sampler used seed **314162** and constraint seed **314170**, drawing exactly two constraint variants and six original L4-weighted examples per effective batch of eight. Scheduled and actual first-50-step exposure were both **100/400 = 25%**, from 57 unique constraint variants. Actual constraint draws were **70 lexical, 18 spatial/relation, 12 exclusion**; this reflects the lexical-heavy curated pool. The actual trace SHA-256 is `8045c8957811a2835ad5a84d1cd6f9eac41b147d79da9e494d85c83a149970c7`; `l8_qa.json` reports no split, target, recipe, review, or trace errors. Local tests and pre-run A40 tests passed. A two-update A40 smoke verified mixed loading, deterministic trace, EOS-weighted backward pass, checkpoint save/reload, fresh-process fixed-prompt generation, and artifact persistence. The real A40 run completed **50 updates in 65.33 seconds wall time**, with checkpoints at 15, 25, 35, 40, and 50. Held-out loss on the unchanged 22 probes fell from **3.35638** to **3.11306**; this is not a writing-quality score. Run manifest and all five adapters are retained in ignored local `outputs/l8/`; checkpoint adapter hashes were verified against the run manifest.

The following **17 fixed prompts** were audited without changing their text: 1 lexical, 9 spatial/relation, 4 exclusion, and 3 structure/refrain. A pass required the requested subject and relation or exclusion, not merely absence of a forbidden string. Deterministic checks were used where possible; semantic passes are an unblinded internal reading, not independent ratings. The full per-prompt judgments and contradiction details are in `l8_baseline_constraint_audit.json` and `l8_constraint_evaluation.json`.

| Model | Lexical | Spatial/relation | Exclusion | Structure/refrain | Overall |
| --- | ---: | ---: | ---: | ---: | ---: |
| B0 | 0/1 | 3/9 | 0/4 | 2/3 | 5/17 |
| L1-48 | 0/1 | 2/9 | 1/4 | 1/3 | 4/17 |
| L4-35 | 0/1 | 1/9 | 1/4 | 1/3 | 3/17 |
| L6-40 | 0/1 | 2/9 | 1/4 | 1/3 | 4/17 |
| L8-15 | 0/1 | 4/9 | 1/4 | 2/3 | 7/17 |
| L8-25 | 0/1 | 1/9 | 2/4 | 2/3 | 5/17 |
| L8-35 | 1/1 | 0/9 | 2/4 | 1/3 | 4/17 |
| L8-40 | 0/1 | 2/9 | 1/4 | 1/3 | 4/17 |
| L8-50 | 0/1 | 1/9 | 2/4 | 1/3 | 4/17 |

The fixed p07 forbidden-word case passes only at L8-35; L8-40 names the forbidden concept. L8-40 also places the supposedly inland lighthouse by the sea and misses the p50 refrain. L8-15's 7/17 is accompanied by conspicuous explanatory prose (41.76 mean words per line), so that count is not a usable quality gain. The fixed p50 prompt requires a refrain; it does not require a growing one.

The unchanged 50-prompt benchmark was run at every L8 checkpoint. Topic contact is the pre-existing first-50-word proxy on 42 scored prompts. “Below minimum” uses 12/35/65 words for short/medium/long, and “medium/long below” is out of 30. The complete output, EOS, length-bucket, and proxy tables are in `l8_evaluation.json`; all raw generations are in ignored local `outputs/l8-eval-*`.

| Model | Held-out loss | Length adherence | Mean words | Words/line | Below minimum | Medium/long below | Topic contact |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | 3.37395 | 78% | 125.7 | 38.12 | 0/50 | 0/30 | 71.4% |
| L1-48 | 3.25005 | 84% | 119.3 | 25.09 | 0/50 | 0/30 | 54.8% |
| L4-35 | 3.17975 | 82% | 74.9 | 19.07 | 9/50 | 7/30 | 83.3% |
| L6-40 | 3.17145 | 80% | 91.8 | 17.57 | 4/50 | 2/30 | 85.7% |
| L8-15 | 3.35638 | 80% | 122.8 | 41.76 | 0/50 | 0/30 | 76.2% |
| L8-25 | 3.30029 | 80% | 118.9 | 28.36 | 1/50 | 0/30 | 69.0% |
| L8-35 | 3.21760 | 84% | 115.1 | 21.44 | 2/50 | 1/30 | 61.9% |
| L8-40 | 3.17424 | 82% | 93.4 | 17.79 | 3/50 | 1/30 | 88.1% |
| L8-50 | 3.11306 | 64% | 55.2 | 8.71 | 16/50 | 13/30 | 83.3% |

L8-40 has zero duplicate lines, zero automatic format anomalies, **two additional editor/assistant meta intrusions found by reading** (p12 and p49), and 30/50 alphanumeric endings under the weak unfinished-tail proxy. Its exact-overlap flags are zero. L8-50 sharply contracts despite lower held-out loss, so step 60 was not run. L8-40 was selected *before* the novel diagnostic as the most balanced L8 checkpoint for inspection: its length and lineation roughly match L6-40 and it has only one medium/long shortfall. It is not a promoted model.

The separate **20 new, generation-only prompts** comprised five each of lexical, spatial/relation, exclusion, and mixed constraints. They contain no lyric targets and do not copy L8 training prompts. With matched seeds and settings, full-criterion internal passes were **L1-48 3/20, L6-40 2/20, L8-40 2/20**. By class, L8-40 scored **0/5 lexical, 2/5 spatial, 0/5 exclusion, 0/5 mixed**. Simple forbidden-word absence alone was 10/10 for L1 and 9/10 for both L6 and L8, but most full instructions missed the requested subject or relation. This diagnostic gives no evidence of improved general constraint following. Prompts, per-response notes, and summaries are in `l8_novel_prompts.json` and `l8_novel_diagnostic.json`.

The existing locked 16-prompt qualitative subset was read at L1, L4, L6, and L8-25/35/40/50; focused notes include the forbidden-word, inland lighthouse, exclusion/relation, and refrain cases. L8-40 sometimes produces useful images and line breaks, but also a five-word locked-room fragment, the p07/p18 contradictions, a p12 editor note, clock-related prose drift, and no p50 refrain. L8-35 has an assistant-style p30 explanation. Neither the internal reading nor the unscored separate-key **L1-48/L6-40/L8-40** blind packet establishes better imagery, cadence, ambiguity, or creative usefulness than L1 or L6. The complete 50-prompt packet, key, and 17-prompt constraint subset are in `corpus/metadata/l8_blind_review/`; no independent human score is claimed.

The L8-40 exact/fuzzy memorization audit found **0 exact flags, 0/50 suspicious fuzzy outputs**, and a **five-word** longest normalized exact overlap. The nearest windows reached 0.625 similarity over eight tokens with no rare shared terms. These detectors do not prove originality; `l8_memorization_audit.json` and ignored `outputs/l8-fuzzy-audit-040.json` retain the evidence.

**Decision:** L8-40 ties L1-48 and L6-40 on fixed constraints, ties L6-40 and trails L1-48 on the novel diagnostic, and has unresolved style/quality failures. It **does not beat L6 or L1**, and fails the creative-quality promotion gate. L1 remains the incumbent; no GGUF was exported or `writer` changed. L8b did not run because the observed class imbalance and prompt-contact failures do not isolate 25% exposure as too weak or too strong; changing only the mixture percentage would be hard to interpret. One next experiment, if sufficient train targets support it: keep the L6 recipe and 25% auxiliary share, curate a **class-balanced** set with more verified spatial/relation and indirect-exclusion cases, then compare matched 35/40-step checkpoints on the same fixed and novel audits. Do not train if the source targets cannot support those constraints. See `l8_decision.json` for the gate and evidence limits. No push or publication occurred.

After the L8 run, the local copies of all five checkpoint adapters were checked against the training manifest hashes, and the smoke, fixed evaluation, and novel evaluation artifacts were verified present. The A40 pod `h560zms591iuga` was then **deleted** as requested; a subsequent RunPod pod list did not contain its ID. Earlier sections describe pod state at the time of those experiments and are historical, not current availability claims.

## L9: balanced constraint supervision, completed

L9 asks whether replacing L8's lexical-heavy auxiliary set with a high-confidence, more balanced set improves generalization while holding the L6 training recipe and **25%** constraint exposure fixed. Its preparation was completed before GPU work; the replacement A40 run and decision are recorded below. The exact execution contract is in `L9_RUNBOOK.md`.

The reviewed L9 pool has **101 proposed examples**. Every complete source target was read internally, including the rejected proposals. Decisions were **82 GOOD, 3 REVISE, 16 REJECT**, leaving **85** final prompt variants from **60/84** training works: **18 lexical prohibitions, 32 spatial/relation, 25 indirect/exclusion, and 10 mixed**. The 16 rejections include weak semantic links, overclaimed locations or emotions, and examples that would reward a missing label while stating the concept directly. The three revisions repaired ambiguous actor assignments or overstrong claims without changing targets. `l9_constraint_proposals.json`, `l9_constraint_review.json`, and `l9_constraint_final.json` preserve each source target ID/hash, original and proposed prompts, structured constraint, paraphrased evidence, adverse reading, deterministic checks, and review outcome. Full target text stays in ignored `data/l9/constraints.jsonl` and `outputs/l9-private-review.json`, never in the tracked metadata. The original L5 train SHA-256 remains `a5c3cb2ef60b1fae7e8d11a956c96935f518ae3fb047636000dc327937ca7608`; L9 derived rows hash to `c23e959ff5d4074570665d9fde15c2e3cabcd58541e94ae1b55052e49f511954`.

The final set reuses each target **once**, reaches at most **three variants per work**, and contains **66 descriptive / 19 sparse** origins with length buckets **11 very short, 34 short, 32 medium, 8 longer**. Case-insensitive whole-word and common-form checks pass for all 53 examples with a lexical or implied-concept exclusion. All 42 spatial/mixed examples have explicit subject–predicate–object relation metadata and matched source-evidence markers; marker presence is only a deterministic aid, so all 42 still require the recorded full-target semantic review. No final prompt shares more than four consecutive normalized words with its target, and no final prompt equals a fixed50 or novel20 evaluation prompt. The complete machine report is `l9_qa.json`; it records **zero errors**. These are internal judgments, not independent human ratings.

The L9 sampler is the L8 sampler with only the replacement constraint set: seed **314162**, constraint seed **314170**, two L9 variants plus six unchanged L4-weighted originals per effective batch of eight. The deterministic planned 40-step trace has **80/320 = 25%** auxiliary draws: **16 lexical, 28 spatial/relation, 25 exclusion, 11 mixed**. Its full-plan hash is `0b440adda50173ae5d8ba1785b88f13a8ba347c33037d77da5aaf4cf31b57d95`. The local `l9_baseline_lock.json` verifies unchanged fixed and novel prompt hashes and saved baseline generations; it carries forward the prior internal fixed passes **B0 5/17, L1 4/17, L6 4/17, L8 4/17** and novel passes **L1 3/20, L6 2/20, L8 2/20**, without rescoring them. The run then verified those planned exposures against the actual sample trace. Matched L9 checkpoints are **25, 35, 40**; step 50 was not justified, and no L9b ran.

`python3 -m scripts.pipeline`, `python3 -m scripts.build_l5`, `python3 -m scripts.build_l9`, `python3 -m scripts.qa_l9`, and `python3 -m scripts.lock_l9_baselines` completed; the source tree and old L5 dataset hash were unchanged. The local suite reported **24 passed, 3 skipped**. L1/L6/L8 adapters and fixed generations were present locally, as were the unchanged fixed50 and novel20 prompt files. The pinned base was fetched on the replacement A40. No model weights or secrets are committed; no push or publication occurred.

### A40 execution and actual trace

A replacement **NVIDIA A40 48GB** used the RunPod Torch `2.8.0+cu128` environment, Transformers `4.57.6`, and PEFT `0.21.2`. The pinned Qwen base revision was fetched and its model file SHA-256 was `6df85b39330e5a425ee36253d0f894e4387e4f0a15b9c53cb467d668e6b3a841`. The copied lyrics, metadata, scripts, configuration, unchanged L5 train set, and L9 constraints matched local hashes. All **27** tests passed on the pod, including the three CUDA-dependent tests skipped locally. The first smoke invocation revealed a missing `PLAN_STEPS` import in `train_l9.py`; that execution bug was fixed without changing the recipe. The two-update smoke then passed finite loss, exact 4/16 constraint exposure, checkpoint save/reload, fresh-process two-prompt generation, and hash-checked persistent copies.

The actual 40-step run took **33.31 seconds**. Peak PyTorch allocated memory was **4469.4 MiB**; the highest logged device-memory snapshot was **6227 MiB**. The actual trace SHA-256 is `49969f1cf398a4671e03ddf16420411a6781b9e645873b402e8df93f1e4524f8`; it matches the frozen sampler order and contains **80/320 = 25%** constraints, with **16 lexical, 28 spatial, 25 indirect/exclusion, and 11 mixed** draws from 60 unique variants. Checkpoints 25/35/40 have ordinary held-out loss **3.30111 / 3.21308 / 3.16650** on the same 22 L3 probes. The exact adapter hashes, runtime checks, and local recovery evidence are in `l9_artifact_integrity.json`; the actual sampler audit is in `l9_qa.json`.

### Locked constraint results

The unchanged fixed17 audit used full-response internal semantic judgments; forbidden-word absence alone was not a pass. The baseline outputs were hash-matched to the earlier internal audit. Counts are **lexical /1, spatial /9, indirect/exclusion /4, structure/refrain /3, total /17**:

| Run | Lexical | Spatial | Exclusion | Structure | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| B0 | 0 | 3 | 0 | 2 | 5 |
| L1-48 | 0 | 2 | 1 | 1 | 4 |
| L6-40 | 0 | 2 | 1 | 1 | 4 |
| L8-40 | 0 | 2 | 1 | 1 | 4 |
| L9-25 | 0 | 1 | 1 | 1 | 3 |
| L9-35 | 1 | 1 | 2 | 1 | 5 |
| L9-40 | 0 | 2 | 1 | 2 | 5 |

Before generating or opening L9 novel results, **L9-40** was selected as the diagnostic candidate on fixed50 line shape, topic contact, length adherence, and direct reading; `l9_candidate_selection.json` records that boundary. The unchanged target-free novel20 then ran at all three L9 checkpoints. Counts are **lexical /5, spatial /5, indirect/exclusion /5, mixed /5, total /20**:

| Run | Lexical | Spatial | Exclusion | Mixed | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| L1-48 | 0 | 2 | 1 | 0 | 3 |
| L6-40 | 0 | 1 | 1 | 0 | 2 |
| L8-40 | 0 | 2 | 0 | 0 | 2 |
| L9-25 | 0 | 0 | 0 | 1 | 1 |
| L9-35 | 1 | 0 | 1 | 0 | 2 |
| L9-40 | 0 | 1 | 0 | 1 | 2 |

L9-40 thus ties L6/L8 and trails L1 on the novel total; it does not improve the targeted spatial or exclusion cases. Full criterion notes and limits are in `l9_fixed_constraint_evaluation.json` and `l9_novel_diagnostic.json`. This small diagnostic is not an independent human evaluation.

### Writing quality, memorization, and decision

The fixed50 generation settings and prompt hash match the earlier runs. In the table below, held-out loss uses the same 22 L3 probes where available; length and topic rates are proxies. “Below” is the established minimum-word proxy, “ML below” is its medium/long subset, “prose” is the existing prose-like count, and “unfinished” is the existing tail proxy.

| Run | Held-out | Length | Mean words | Words/line | Below | ML below | Topic | Duplicates | Format | Prose | Unfinished |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | — | 78% | 125.7 | 38.12 | 0 | 0 | 71.4% | 1 | 1 | 43 | 43 |
| L1-48 | — | 84% | 119.3 | 25.09 | 0 | 0 | 54.8% | 7 | 2 | 26 | 33 |
| L6-40 | 3.17145 | 80% | 91.8 | 17.57 | 4 | 2 | 85.7% | 0 | 0 | 18 | 33 |
| L8-40 | 3.17424 | 82% | 93.4 | 17.79 | 3 | 1 | 88.1% | 0 | 0 | 18 | 30 |
| L9-25 | 3.30111 | 72% | 122.6 | 30.03 | 1 | 0 | 69.0% | 2 | 1 | 37 | 41 |
| L9-35 | 3.21308 | 74% | 106.9 | 20.91 | 4 | 2 | 73.8% | 1 | 0 | 22 | 28 |
| L9-40 | 3.16650 | 78% | 101.2 | 12.46 | 5 | 2 | 81.0% | 1 | 0 | 14 | 31 |

The fixed qualitative subset and requested extra cases show improved line shape at L9-40 but no credible creative-usefulness gain. The inland lighthouse still moves to the sea; the supposedly silent car argument contains dialogue; the voicemail/refrain case supplies neither a voicemail nor repetition; and L9 loses the through-wall name relation that L8 made explicit. L9-35 additionally has overt prompt/assistant leakage. Generic phrase and coherence problems remain, and L9-40 has more below-minimum responses than L1, L6, or L8. `l9_evaluation.json` and `l9_qualitative_notes.json` give the full internal rubric and limitations.

For the selected L9-40 checkpoint, the exact audit found **0 flags** and a **four-word** longest normalized train-source phrase. The fuzzy audit found **0/50** suspicious outputs; the strongest nearest 8-token window had **0.625** similarity and no rare shared terms. These screens do not prove originality. Full private per-output evidence is retained in ignored `outputs/l9-fuzzy-audit-040.json`, and the lightweight summary is `l9_memorization_audit.json`.

**Decision:** Balanced L9 supervision did **not** generalize on the requested novel spatial/relation or indirect/exclusion cases. The constraint-data rebalance direction should stop. L9-40 does not clearly beat L6 or L1 and fails the creative-quality gate. L1-48 remains incumbent; no blind packet, GGUF, promotion, or `writer` change was made. Step 50 and L9b did not run. The single next proposed experiment is a controlled, small train-only **raw-corpus continued-pretraining stage followed by unchanged behavioral SFT**, with a prespecified token budget and the same held-out, fixed, novel, blind-quality, and memorization gates. It tests the weak writing-distribution internalization left unresolved by L1–L9, rather than another constraint-data rebalance; it is a proposal, not an authorized run. `l9_decision.json` records the decision and limits.

All **69** pod files, including adapters, optimizer state, smoke, traces, fixed50 and novel20 generations, and logs, were copied locally and SHA-256-verified; all three adapter files also match the training manifest. The A40 pod was then **deleted**, and a fresh RunPod pod list was empty. All raw outputs and model weights remain ignored and private. No push or publication occurred.

## L10: one-pass raw CPT followed by unchanged behavioral SFT

L10 tested one new training-stage question: whether learning the train lyrics as a writing distribution before the existing L6 behavioral SFT makes the final generator more distinctive or useful. C0 is the saved B0, L1-48, and L6-40 reference; C1 is base plus a raw-corpus CPT LoRA; C2 is one selected CPT LoRA merged into the pinned base, then a **fresh** L6 SFT LoRA. All three use `Qwen/Qwen3-1.7B-Base` revision `ea980cb0a6c2ae4b936e82123acc929f1cec04c1`, the same tokenizer, original fixed50 prompts/seeds/generation settings, and complete-work split. No L8/L9 constraint auxiliary data, evaluation prompts, heldout lyrics, external lyrics, or synthetic creative targets entered CPT or C2 training. The exact execution contract and hashes are in `L10_RUNBOOK.md` and `corpus/metadata/l10_*.json`.

`scripts.build_l10_cpt` read all 106 unchanged Markdown sources and used **84 train works only** for optimizer updates. It inherited the source parser's UTF-8 BOM handling, NFC, newline normalization, trailing-line-space trim, and outer trim, removed 507 bracketed transcript section headings across the whole split (400 train), and retained the lyric lines, internal stanza breaks, punctuation, capitalization, and repeated sections. No prompt or metadata wrapper entered the raw text. After a deterministic train-work shuffle, every work ends in native EOS ID `151643`; train sequences may cross a work boundary only through that EOS. The 84 train works contain **16,787 words**, **21,843 raw model tokens**, **21,927 tokens including work-end EOS**, and **21,884 supervised next-token targets** in **43 chunks** of at most 512 tokens. All 43 train chunks cross a work boundary; no validation or heldout chunk does. The 11 validation and 11 heldout works contain 3,089 and 3,189 raw model tokens. Train microbatch padding was 0% with the frozen packed order. `scripts.qa_l10` reconstructed each split's exact token stream from its source works, checked all 106 EOS boundaries and split owners, and verified the unchanged L5/L3 behavioral hashes and L4 sample plan. The tracked dataset report contains normalization, counts, hashes, and the precise exposure mapping, without lyric text.

CPT used rank-8, alpha-16, dropout-0.1 LoRA on `q_proj`/`v_proj`, AdamW decay 0.01, peak LR **2e-5** with a six-update linear decay and no zero-LR warmup, microbatch 2, effective batch 8 except the final 3-sequence update, and ordinary token-weighted next-token cross entropy. There was no prompt mask, length weight, constraint weight, or EOS weight. The six updates made exactly **one supervised-token corpus pass**; saved steps 1/3/4/6 map to 0.187/0.560/0.747/1.000 passes. The two-update smoke passed finite losses, save/reload, and fresh-process generation. The full CPT training/evaluation/save phase took **15.83 seconds** with **5,220 MiB peak PyTorch allocation** on the replacement A40. B0 raw-LM losses on the same chunks were train/validation/heldout **2.605313 / 2.393602 / 2.592720**.

| CPT step | Effective passes | Train raw loss | Validation raw loss | Heldout raw loss | Fixed50 length | Mean words | Words/line |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.187 | 2.605724 | 2.395353 | 2.591493 | 78% | 125.2 | 37.78 |
| **3** | **0.560** | **2.605296** | **2.393464** | **2.591217** | **84%** | **126.1** | **38.32** |
| 4 | 0.747 | 2.605260 | 2.394597 | 2.591671 | 74% | 123.2 | 37.72 |
| 6 | 1.000 | 2.605216 | 2.393605 | 2.591232 | 78% | 123.1 | 37.17 |

Step 3 was selected **before C2 training**: it was the earliest checkpoint with the lowest observed validation and heldout raw losses, 84% fixed50 length adherence, and no detected exact/fuzzy/continuation memorization flags. The selection file binds its adapter SHA-256 `9469f6657ea6682806112cbf3b51f0d5a61dc82ed4c569781c67967a63c4033c`. The heldout gain over B0 is just **0.001503** raw-LM loss; CPT-only outputs remain mostly ordinary prose, with **38.32 mean words per line**, 44/50 narrative-paragraph proxy hits, and 3.37551 loss on the 22 heldout behavioral probes versus B0's 3.37395. This is a controlled starting point for C2, not a CPT creative-quality success.

`scripts.merge_l10_cpt` fused step 3 into the pinned bf16 base; the merged `model.safetensors` SHA-256 is `72b585e79cd5d85a26c4cfc96ee3986286b7813af72d7aa97eefaeb5acbe9385`. C2 then trained a fresh rank-8 SFT adapter on the exact L5 train rows and L4 target-length schedule, with cap 384, effective batch 8, LR **6e-5**, and terminal EOS weight **0.25**, matching L6 apart from the merged initialization and saved checkpoint list. Its first-50-step sample trace is byte-for-byte identical to L6's. The C2 two-update smoke and fresh-process generation passed. The 50-step run took **43.64 seconds**, peak PyTorch allocation **4,476 MiB**; its adapters are saved at 15/25/35/40/50. The 40-step C2 adapter SHA-256 is `bdb561920c9a0444f23914fb594f995a2abcb4b295ceb6409a4b951646c1d255`. Inference is exactly **merged CPT base + that single C2 adapter**. The optional `--base-path` on evaluation/export tools preserves that composition for later GGUF conversion if a promotion gate passes.

The unchanged 50 prompts were regenerated at every CPT and C2 checkpoint. Heldout behavioral loss is on the same 22 completion-only L3 probes; length, lexical topic contact, prose, and unfinished-tail counts are proxies, not quality ratings. The complete per-length and EOS diagnostics are in ignored `outputs/l10-*/` and compact `l10_fixed50.json`.

| Run | Heldout loss | Length | Mean words | Words/line | Below min | Medium/long below | Topic contact | Dup lines | Format | Meta hits | Prose-like | Unfinished tail |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | 3.37395 | 78% | 125.7 | 38.12 | 0 | 0 | 71.4% | 1 | 1 | 3 | 43 | 43 |
| L1-48 | 3.25005 | 84% | 119.3 | 25.09 | 0 | 0 | 54.8% | 7 | 2 | 9 | 26 | 33 |
| L6-40 | 3.17145 | 80% | 91.8 | 17.57 | 4 | 2 | 85.7% | 0 | 0 | 2 | 18 | 33 |
| CPT-3 | 3.37551 | 84% | 126.1 | 38.32 | 0 | 0 | 71.4% | 1 | 1 | 5 | 45 | 40 |
| C2-15 | 3.35743 | 74% | 121.3 | 39.42 | 0 | 0 | 78.6% | 1 | 1 | 3 | 48 | 38 |
| C2-25 | 3.29752 | 74% | 118.3 | 32.30 | 1 | 0 | 66.7% | 1 | 1 | 5 | 36 | 33 |
| C2-35 | 3.21584 | 74% | 103.4 | 19.42 | 4 | 2 | 66.7% | 1 | 1 | 6 | 19 | 31 |
| **C2-40** | **3.16988** | **78%** | **92.9** | **13.79** | **5** | **2** | **81.0%** | **3** | **0** | **7** | **16** | **29** |
| C2-50 | 3.10471 | 68% | 60.6 | 9.48 | 15 | 11 | 85.7% | 2 | 0 | 2 | 14 | 39 |

Step **40** was selected for blind review **before** novel20: it has the best balance of line shape and usable length in C2. Step 35 loses topic contact; step 50 sharply contracts despite lower heldout loss. Against L6-40, C2-40 has shorter lines and two fewer prose-like outputs but slightly worse length adherence, five versus four below-minimum outputs, two fewer topic-contact hits among the 42 scored prompts, three versus zero duplicate lines, and a negligible **0.00157** heldout-loss advantage. Eight of its 50 outputs match L6 exactly; 29 share their first 50 characters. The heldout raw-LM loss after SFT is 2.555973 for C2-40 versus 2.556296 for L6-40, another tiny difference. These matched measurements do not by themselves establish a creative gain.

The focused 17-prompt internal agent audit found **B0 5/17, L1 4/17, L6 4/17, CPT-3 5/17, C2-40 4/17**. The unchanged target-free novel20 found **L1 3/20, L6 2/20, C2-40 3/20**. C2 still directly names the forbidden concept on p07, places the inland lighthouse above the sea on p18, and omits the p50 refrain; novel outputs also miss many requested relations or exclusions. These are agent full-response criterion judgments, not human ratings. `l10_fixed17.json` and `l10_novel20.json` preserve provenance, by-type counts, and per-case notes; simple forbidden-word absence was never counted as a full pass.

The full raw-source audit found **zero exact flags and zero suspicious fuzzy outputs** for B0, L1, L6, best CPT-only, and best C2; the longest exact training-source phrase for CPT-3 and C2-40 is **four and five words**, respectively. With 12-token prefixes and greedy 64-token continuations, each model had zero flags across 11 heldout and 11 training-work probes at the 16-token threshold. C2's maximum shared continuation was three tokens heldout and four training, comparable to L1/L6. No long heldout continuation or source passage is in tracked metadata. These screens do not prove originality, but they detect no CPT-related increase at the specified thresholds. The high-precision prose screen counts narrative-paragraph patterns on **43/50 B0, 25/50 L1, 14/50 L6, 44/50 CPT-3, and 10/50 C2-40**. It catches one explanatory and one editor/meta case for C2-40; direct-theme explanation framing has zero hits under its narrow rule. The blind model judge's prose-penalty dimension and tags are needed for broader coverage.

The replacement secure NVIDIA A40 used Torch `2.8.0+cu128`, Transformers `4.57.6`, and PEFT `0.21.2`. All **30** tests passed on the pod; local preflight and final tests had **27 passed, 3 skipped** because Torch was absent locally. Before deleting the pod, all **194** run files totaling **3,581,333,433 bytes**—adapters, merged bf16 base, traces, generations, manifests, optimizer states, smoke artifacts, diagnostics, and logs—were copied to ignored local `outputs/` and verified against a remote SHA-256 manifest. `runpodctl pod delete jam6oremg8ebxc` succeeded and the subsequent pod list was `[]`. The private sources, model weights, generated outputs, and credentials remain uncommitted.

### Blind writing quality and pairwise review

The frozen L7 rubric was applied by one local Mistral Small 3.2 24B model judge to **250 anonymous individual responses** and **200 anonymous pairs**. The answer keys stayed separate until all scores, IDs, input hashes, packet hashes, rubric hash, and prompt-type hash validated. There were zero scoring retries. These are **model judgments, not human ratings**. Mean/median scores are on the rubric's 0–4 scale; utility includes the frozen prose penalty. Differences below 0.05 are practical ties.

| Run | Style mean/median | Utility mean/median | Overall mean/median | Imagery C | Phrasing D | Cadence E | Indirectness F | Prose penalty G | Contact A | Completeness I |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B0 | 2.015 / 2.0 | 1.850 / 1.972 | 2.16 / 2.0 | 2.48 | 2.18 | 1.84 | 1.56 | 1.48 | 2.62 | 1.54 |
| L1-48 | 1.935 / 2.0 | 1.513 / 1.667 | 1.94 / 2.0 | 2.22 | 2.06 | 1.74 | 1.72 | 2.02 | 2.00 | 1.64 |
| L6-40 | 1.925 / 2.0 | 1.739 / 1.847 | 2.00 / 2.0 | 2.04 | 2.08 | 1.94 | 1.64 | 1.48 | 2.18 | 1.94 |
| CPT-only step 3 | 1.925 / 2.0 | 1.831 / 1.972 | 2.12 / 2.0 | 2.42 | 2.04 | 1.74 | 1.50 | 1.46 | 2.60 | 1.66 |
| C2-40 | 2.050 / 2.0 | 1.861 / 2.083 | 2.14 / 2.0 | 2.14 | 2.18 | 2.12 | 1.76 | 1.42 | 2.22 | 2.06 |

The judge ranks C2 first on the individual **style** and **utility** means and second to B0 on **overall**; C2 and B0 are practical ties on all three. C2's mean style, utility, and overall exceed L6 by 0.125, 0.122, and 0.14, and exceed L1 by 0.115, 0.348, and 0.20. It has better cadence, indirectness, and completeness than CPT-only, but lower imagery and prompt contact. These averages need the independent pairwise check: among non-ties, the judge preferred the first named run or C2 as follows.

| First run vs C2-40 | First wins | Ties | C2 wins | Clear wins, first/C2 |
| --- | ---: | ---: | ---: | ---: |
| L1-48 | 7 | 39 | 4 | 2 / 3 |
| L6-40 | 2 | 45 | 3 | 0 / 1 |
| B0 | 17 | 29 | 4 | 8 / 1 |
| CPT-only step 3 | 17 | 29 | 4 | 6 / 1 |

Thus C2 has **no clear direct preference over L6 or L1**; it loses decisively more non-tied prompts to B0 and CPT-only. The most frequent reason tags across all outcomes were coherence and prompt fit: 35/26 for L6–C2, 42/39 for L1–C2, 37/33 for B0–C2, and 45/35 for CPT-only–C2. Tags describe the comparison, **not which side won**. Per-prompt wins, ties, and reason tags are in `l10_pairwise_summary.json`; the input-bound score manifest, prompt-regime breakdown, failure taxonomy, and machine checks are in the other tracked `l10_*.json` files. Small regime cells are not a selection basis.

The high-precision narrative-paragraph proxy is **B0 43/50, L1 25/50, L6 14/50, CPT-only 44/50, C2 10/50**. That indicates stronger lineation after SFT, but does not establish a robust lyrical-quality gain over L6. The judge's mean prose penalty G is **2.02 L1, 1.48 L6, 1.46 CPT-only, 1.42 C2**, while its `generic_prose` tag counts are **37, 29, 36, 29** respectively. Those tags disagree with the judge's own G≥3 counts (L6 5, C2 8); they are not a clean independent prose measure. The deterministic explanatory/editor framing screen finds one of each in C2; the broader fixed50 meta proxy finds seven C2 hits versus two L6 hits. C2 also has weaker contact than CPT-only and B0, and the separate full-criterion review catches failures the judge can overlook: it preferred C2 on p07 in one B0 pair despite C2 directly naming the forbidden concept. The fixed17/novel20, length, and machine checks therefore remain part of the usability gate.

### L10 decision

**No promotion.** CPT step 3's heldout raw-LM improvement over B0 is only **0.001503**, and CPT-only generations remain mainly prose. C2-40 shows modest line-shape and individual-judge score movement, but **8/50 outputs exactly match L6-40**, 29/50 start with the same first 50 characters, and 45/50 L6–C2 blind pairs are ties. C2 has five below-minimum fixed50 outputs versus four for L6, two fewer topic-contact hits on the scored subset, and still passes only **4/17 fixed** and **3/20 novel** full-criterion cases. The same memorization screens found no exact/fuzzy or 16-token continuation flags at the specified thresholds; that gate passes, but it cannot rescue the creative-quality result. L10 does **not clearly beat L6 or L1** for the project's purpose, and the creative-quality gate fails. SFT imposed the familiar L6 lineation and shortening behavior on the CPT base; there was no strong CPT-only lyric-writing gain to preserve, and the direct judge preferred CPT-only over C2 on 17 prompts versus four. The individual and pairwise judge disagreement limits any stronger causal claim.

L1-48 remains the incumbent `models/best.gguf`; `writer` is unchanged, and no L10 GGUF was exported. The selected CPT adapter is retained at `outputs/l10-cpt/checkpoint-003/`, its merged bf16 base at `outputs/l10-merged-cpt/`, and the selected C2 adapter at `outputs/l10-c2/checkpoint-040/`. All are ignored local files; `l10_artifact_integrity.json` binds their hashes. The single next proposed experiment is **train-only stylistic target curation under the unchanged L6 SFT recipe**: preselect complete, strongly lineated, distinctive passages from the existing 84 training works, hold the optimizer and exposure budget fixed, and reuse the blind and memorization gates. It tests target quality directly rather than sweeping CPT strength on a 21.8k-token corpus. It is a proposal, not an authorized L11 run. `l10_decision.json` records the gates and limitations.

## L11 source-target curation: stopped before GPU

The experiment tested whether the existing 224 L5 train-work passages could support an 80–120 target, high-quality SFT subset under the unchanged L6 recipe. `L11_RUBRIC.md` was committed before source scoring; `L11_SELECTION_POLICY.md` locked the composite cutoff at 8 before any L11 model output. A local Mistral Small 3.2 24B judge, digest recorded in `l11_target_scores.json`, scored all 224 anonymous passages with zero retries using only source text. The composite median was 8 (range −12 to 20); 118 passages across 66 works passed the numeric and hard gates. Raising the cutoff to 9 would have left 56 across 35 works. These are model-assisted source ratings, not human quality measurements.

Manual review rejected 55 candidates for generic or expository language, incomplete/context-dependent endings, weak lineation, and near-duplicate material. The final ignored `data/l11/train.jsonl` contains **57 unchanged targets from 39 training works**, including eight of the nine style-anchor works and eight anchor targets. Buckets are eight very short, 25 short, 15 medium, and nine longer. Twenty existing prompts had privately recorded fidelity revisions; no target was rewritten or expanded. Original targets, reviewed prompts, train provenance, source spans, fixed evaluation prompt isolation, tokenizer sequence cap (longest 212), terminal EOS, masking, and the L6 core configuration were checked. The selected target and prompt hashes are bound in `l11_selection.json`; full source-bearing review stays ignored locally.

The 50-update L4 sampler would draw 400 targets and expose **26,396 target tokens**, within 1.3% of L6's **26,050**. However, the small curated set would receive **8.55 effective target-token passes** versus L6's 2.17, and its most repeated target would be drawn **14 times** versus L6's maximum four. Local QA intentionally failed three predeclared gates: at least 70 targets, at least 50 works, and no more than 10 draws per target. Therefore the GPU experiment **did not run**. There is no L11 smoke, checkpoint, fixed50/blind/pairwise/qualitative/memorization comparison, adapter, GGUF, or promotion claim. `writer` and L1 remain unchanged. `runpodctl pod list` returned `[]`; there was no L11 pod to delete. The single next proposed experiment is a **larger-model upper-bound test** on the existing full L5 behavioral data, with the same fixed50 and memorization gates. It changes capacity materially while avoiding another small-data SFT curation sweep.

## L12 Qwen3 capacity test

L12 changes the base checkpoint to official pretrained `Qwen/Qwen3-4B-Base` at revision `906bfd4b4dc7f14ee4320094d8b41684abff8539` (Apache 2.0). The model card reports 4.0B parameters; summing unique tensor shapes in the pinned safetensors gives **4,022,468,096**. The 4B model has 36 layers, hidden size 2560, 32 query heads and eight KV heads, versus 28 layers, 2048 hidden size, 16 query heads and eight KV heads for the pinned 1.7B. Its `q_proj` and `v_proj` modules are present on all 36 layers. The rank-eight LoRA has 2,949,120 trainable parameters. The tokenizer vocabulary and EOS ID 151643 match the 1.7B exactly; `format_prompt` remains the raw input and no chat template is applied. `l12_model_provenance.json` records the model and downloaded-file hashes.

L12 uses the **unchanged full L5 train rows**, L3 validation/held-out work split, L4 weighted sample order, L6 terminal-EOS coefficient 0.25, effective batch eight, cap 384, AdamW with peak LR `6e-5`, and the same 200-step scheduler horizon. It only trains through step 50, saving 15/25/35/40/50. The actual L12 and L6 first-50-step trace files are byte-identical (SHA-256 `7d22e0bfa3028feeef09763906cb956c87cf7fc23da99bf8c7458cee240ac540`): 400 draws, 26,050 target tokens, and very-short/short/medium/longer bucket counts **20/124/161/95**. The train JSONL hash remains `a5c3cb2ef60b1fae7e8d11a956c96935f518ae3fb047636000dc327937ca7608`. The local weight-free preflight checked tokenizer, EOS, prompt masking and sequence cap. Local tests passed **33**, with three CUDA-only skips; the complete pod suite passed **36**.

The secure NVIDIA A40 ran at the RunPod listed **$0.49/hour** with 46,068 MiB reported VRAM. Runtime was Torch `2.8.0+cu128`, Transformers `4.57.6`, and PEFT `0.21.2`. The two-update smoke had finite losses and gradient norms, saved and reloaded its adapter, and produced fresh-process adapter and untouched-base generations. The smoke adapter and generations were locally SHA-verified. The 50-step run took **51.81 seconds** and peaked at **8,970.5 MiB PyTorch allocation**. The five adapter hashes and frozen model-file hashes are in `l12_artifact_integrity.json` and `l12_model_provenance.json`. A lower held-out loss at later steps is evidence of target fit, not a writing-quality score.

| L12 state | Validation loss | Held-out loss in training log | Frozen 22-probe held-out loss | Fixed50 length adherence | Mean/median words | Words/line | Below minimum | Medium/long below minimum | Narrative paragraph proxy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Untouched 4B base | — | — | 3.33904 | 78% | 123.3 / 132 | 43.27 | 0 | 0 | 47/50 |
| Step 15 | 3.35951 | 3.31140 | 3.31222 | 82% | 125.8 / 131.5 | 43.63 | 0 | 0 | 46/50 |
| Step 25 | 3.25415 | 3.23698 | 3.23591 | 80% | 124.4 / 135 | 33.17 | 0 | 0 | 37/50 |
| **Step 35, pre-blind selection** | **3.16954** | **3.14981** | **3.15148** | **74%** | **111.7 / 86** | **23.27** | **1** | **1** | **24/50** |
| Step 40 | 3.12102 | 3.09655 | 3.09797 | 74% | 97.6 / 83 | 17.58 | 3 | 3 | 15/50 |
| Step 50 | 3.04913 | 3.01040 | 3.00947 | 72% | 60.4 / 53 | 12.51 | 10 | 8 | 2/50 |

The narrative-paragraph column uses the pre-existing L10 screen; `l12_prose_drift.json` also preserves the stricter paragraph proxy used during selection. The full `l12_evaluation.json` compares B0, L1-48, L6-40, C2-40, untouched 4B, and every L12 checkpoint under the same prompt hash and generation settings. Selected step 35 has **85.7%** topic contact in the first 50 words on the 42 scored prompts, versus 54.8% L1 and 85.7% L6; six duplicate lines, zero narrow format anomalies, three meta-instruction hits and 37 unfinished-tail proxy hits. The base has 81.0% first-50 topic contact but 47/50 narrative-paragraph flags. EOS emission rises from 4% for the untouched base to 28% at step 35 and 88% at step 50. Step 50's 10 below-minimum outputs make its falling loss especially misleading as a creative signal. Loss values across parameter sizes are not directly comparable writing-quality measurements.

Step **35** was selected at `2026-10-04T23:51:15Z`, before creating the blind packet. It balances lineation against usable length: the strict narrative-paragraph proxy falls from 47/50 for the 4B base to 17/50, with one medium/long shortfall. Step 40 has three such shortfalls and a speech violation on the silent-car prompt; step 50 contracts sharply. Step 35's exact/fuzzy screen had no flags. The selection file binds the adapter and fixed50 generation SHA-256 hashes, and the blind builder requires that file before creating its separate keys.

In a direct read of the frozen 16-prompt subset, step 35 sustains some scenes more coherently than the 1.7B runs, but much of its text is literal narrative, process explanation or conventional rhyme. The inland lighthouse stays far from water; the hospital rain stays outside, the silent car argument contains a spoken statement, the mouth-of-salt subject is missed, and the late-voicemail refrain is absent. Several otherwise usable responses end mid-clause. `l12_qualitative.json` records the pre-blind internal notes without reproducing generations. This reading alone does not establish a better specialized writer.

The full-response internal constraint review is **5/17 fixed** and **7/20 novel** at step 35, compared with the previously audited **4/17 and 2/20** for L6 and **4/17 and 3/20** for L1. Two novel outputs emit forbidden forms, and several relational requests still fail; the 7/20 result is a secondary gain, not a creative-quality verdict. The selected fixed50 output has zero exact/fuzzy memorization flags, a longest exact training-source phrase of five words, and a maximum nearest-train trigram overlap of 0.0323. Eleven held-out and eleven train-work greedy continuation probes have zero 16-token flags; their maximum shared lengths are two and four tokens respectively. L1/L6 also had no flags under these screens. `l12_memorization.json` gives the comparison without source passages.

Quantized-size planning estimates for the 4B model are **4.3–4.8 GB Q8_0, 3.3–3.8 GB Q6_K, 2.8–3.3 GB Q5_K_M, and 2.4–2.9 GB Q4_K_M**. These are byte-per-weight estimates with overhead allowance, not measured GGUF files or Mac Studio throughput. All appear to fit an M1 Max with 32 GB; an actual merged-model test is warranted only if the creative gate supports promotion.

Before pod deletion, all **122 L12 files (154,939,974 bytes)** were copied to ignored local `outputs/` and matched a recursive pod SHA-256 manifest. The five adapter hashes and the exact L6 trace were separately checked. `runpodctl pod delete w6ziddh5ewsavb` succeeded and `runpodctl pod list` returned `[]`. The private source, adapters, generated responses, blind records, and credentials are uncommitted.
