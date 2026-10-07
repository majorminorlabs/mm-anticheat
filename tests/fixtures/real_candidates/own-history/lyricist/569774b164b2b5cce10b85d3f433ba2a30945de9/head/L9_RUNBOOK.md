# L9 A40 execution contract

Status: **local preparation complete; no A40 connection is available**. Do not treat the scheduled sampler plan as an observed training trace. This file records the commands to use from the repository root on a replacement A40. Keep SSH credentials and any pod address outside this repository. Do not push this private experiment.

## Frozen inputs and intervention

- Base: `Qwen/Qwen3-1.7B-Base` revision `ea980cb0a6c2ae4b936e82123acc929f1cec04c1`.
- Training configuration: `scripts.train_l9.L9`, equal to L6 except checkpoint cadence `[25, 35, 40]`; LoRA rank 8, effective batch 8, sequence cap 384, peak LR `6e-5`, terminal EOS loss coefficient `0.25`, and the unchanged L4 length weights.
- Original 75%: `data/l5/train.jsonl`, SHA-256 `a5c3cb2ef60b1fae7e8d11a956c96935f518ae3fb047636000dc327937ca7608`.
- Replacement auxiliary 25%: **only** `data/l9/constraints.jsonl`, SHA-256 `c23e959ff5d4074570665d9fde15c2e3cabcd58541e94ae1b55052e49f511954`. L8 variants are not stacked.
- Sampler: seeds `314162` and `314170`; 2 L9 constraints plus 6 L4-weighted originals per update. The scheduled 40-step exposure is 80/320; actual exposure must be verified from `outputs/l9/sample_trace.jsonl` after training.
- Fixed prompts SHA-256 `358012c9bf38cd18a561db136034fd3eb5f0723a41e0b9053adf46eb060454b8`; unchanged novel20 SHA-256 `74db7b4ec16235f635f59f81e7d23b33d0643a786bfa7a866e5be671b11a3fd5`.

Regenerate and validate before using GPU. This was already completed locally, including `24 passed, 3 skipped`:

```sh
python3 -m scripts.pipeline
python3 -m scripts.build_l5
python3 -m scripts.build_l9
python3 -m scripts.qa_l9
python3 -m scripts.lock_l9_baselines
uv run --extra test python -m pytest -q
```

The local baseline adapters and fixed generations exist at `outputs/l1/checkpoint-048`, `outputs/l6/checkpoint-040`, `outputs/l8/checkpoint-040`, and their corresponding `outputs/*-eval-*` directories. The [pinned base revision](https://huggingface.co/Qwen/Qwen3-1.7B-Base/tree/ea980cb0a6c2ae4b936e82123acc929f1cec04c1) is listed with model and tokenizer files upstream; it is not cached in this local checkout, so the replacement environment must fetch it. Do not log authentication tokens. Before smoke, confirm CUDA and the actual package versions, then copy the private repository and ignored derived datasets to the pod without exposing the lyrics or credentials in a public location.

## A40 smoke and matched run

Use the same CUDA environment class as L8 (observed L8 runtime: Torch `2.8.0+cu128`, Transformers `4.57.6`, PEFT `0.21.2`). From the copied repository root, verify the runtime and dataset identity:

```sh
uv venv --system-site-packages .venv
uv pip install --python .venv/bin/python -r config/requirements-l9-a40.txt
.venv/bin/python -c 'import torch, transformers, peft; print(torch.__version__, transformers.__version__, peft.__version__, torch.cuda.is_available())'
.venv/bin/python -m scripts.qa_l9
.venv/bin/python -m scripts.train_l9 --smoke --out outputs/l9-smoke
.venv/bin/python -m scripts.qa_l9 --trace outputs/l9-smoke/sample_trace.jsonl --out outputs/l9-smoke-qa.json
.venv/bin/python -m scripts.evaluate --adapter outputs/l9-smoke/checkpoint-002 --out outputs/l9-smoke-eval --limit 2
```

Check that the smoke run manifest names the L9 constraint hash above, the trace has two constraints in each of two updates, the EOS-weighted loss is finite, the step-two checkpoint reloads, fresh-process generations finish, and the artifacts copy persistently. If healthy, proceed without changing the recipe:

```sh
.venv/bin/python -m scripts.train_l9 --out outputs/l9 --stop-at 40
.venv/bin/python -m scripts.qa_l9 --trace outputs/l9/sample_trace.jsonl
for step in 025 035 040; do
  .venv/bin/python -m scripts.evaluate --adapter "outputs/l9/checkpoint-$step" --out "outputs/l9-eval-$step"
done
```

The trainer rejects stops above step 50. Step 50 is conditional on step 40 remaining behaviorally healthy **and** a written reason to inspect it; do not run it automatically. No L9b is permitted. Copy all adapters, optimizer state, smoke artifacts, evaluations, and traces locally; verify each adapter SHA-256 against `outputs/l9/run.json`. Terminate the replacement pod when the experiment and artifact checks are finished, following the user's standing instruction.

## Locked evaluations after generation

Use the same 17 fixed criteria from `scripts.audit_l8_constraints` and read **every** pending semantic judgment. The command below prepares the unchanged audit packet; it does not assign passes:

```sh
python3 -m scripts.audit_l8_constraints --runs B0=outputs/b0 L1-48=outputs/l1-eval-048 L6-40=outputs/l6-eval-040 L8-40=outputs/l8-eval-040 L9-25=outputs/l9-eval-025 L9-35=outputs/l9-eval-035 L9-40=outputs/l9-eval-040 --out outputs/l9-fixed-constraint-review.json
```

Use the fixed audit, standard benchmark, and qualitative subset to select the best L9 checkpoint **before opening the novel20 results**. Then run the exact target-free novel20 generation once, with the same seeds and settings. Compare that checkpoint to the saved L1/L6/L8 novel outputs by full requirement, not forbidden-word absence alone:

```sh
python3 -m scripts.compare_l6 --runs B0=outputs/b0 L1-48=outputs/l1-eval-048 L4-35=outputs/l4-eval-035 L6-40=outputs/l6-eval-040 L8-40=outputs/l8-eval-040 L9-25=outputs/l9-eval-025 L9-35=outputs/l9-eval-035 L9-40=outputs/l9-eval-040 --out outputs/l9-standard-comparison.json
BEST_STEP=040  # set to the preselected 025, 035, or 040 checkpoint
.venv/bin/python -m scripts.evaluate_l9_novel --adapter "outputs/l9/checkpoint-$BEST_STEP" --out "outputs/l9-novel-$BEST_STEP"
```

The standard comparison script covers generation metrics. Append held-out loss from the unchanged 22-probe fields of each run manifest, and manually inspect prose drift and editor/assistant language that the automatic format proxy can miss. Read the existing `corpus/metadata/l4_qualitative_subset.json` for L1/L6/L8/L9-35/L9-40, with focus on p07, p18, p19, p30, p37, p39, and p50. Record the internal-review status and its limits; do not imply human preference scores.

After choosing the best L9 checkpoint by **both** constraint and writing quality, run the existing exact and fuzzy audits on its 50 generations:

```sh
python3 -m scripts.fuzzy_memorization --generations outputs/l9-eval-040/generations.jsonl --out outputs/l9-fuzzy-audit-040.json
```

Replace `040` if step 35 is selected. The fixed evaluator already records exact flags and longest shared phrases. If L9 is genuinely competitive, prepare the separate-key 50-prompt blind artifact with `scripts.blind_compare_l9` using the chosen L9 evaluation directory; it does not create scores. Promote or export no model on a constraint count alone. Commit only code and lightweight private metadata, with no weights, credentials, or push.
