# Candidate-expansion analysis

No additional models were run. This is publication-decision support only.

## Recommendation

Do not expand merely to increase the leaderboard. The current four-model result is publishable as a bounded, transparent study if the release clearly states its narrow task set, consumer-hardware scope, low absolute scores, and pre-exposure gate. If the goal is a stronger current field before publication, add at most two candidates after a separately frozen admission amendment. Recommended expansion size: **+2**, not +4 or +6.

## Serious candidates

| Candidate | Approx. size | License | Tool calling / GGUF expectation | ThinkPad expectation | Why it helps |
|---|---:|---|---|---|---|
| Llama 3.2 3B Instruct | 3B | Llama 3.2 Community License | Mature structured-chat ecosystem; many GGUF builds expected | High likelihood at Q4_K_M, subject to RAM gate | Adds a widely used Meta reference point |
| Gemma 3 4B IT | 4B | Gemma Terms of Use | Strong ecosystem, but this exact family previously failed the frozen structured gate and would require a new exact artifact/gate result | Likely memory-viable, interface uncertain | Tests whether the earlier exclusion was artifact/runtime-specific; only worthwhile if re-admission is scientifically justified |
| SmolLM3 3B | 3B | Apache-2.0 | Official tool modes exist, but the exact prior candidate failed the frozen structured gate | Likely memory-viable, interface uncertain | Strong small-local relevance, but must not reuse the excluded artifact silently |
| Qwen3.5 4B-class instruct variant | ~4B class | Verify exact release terms | Expected GGUF availability and tool support, exact version must be frozen | Likely viable subject to gate | Tests a newer Qwen family without changing Qwen3’s recorded condition |
| Granite 3.3 2B Instruct | 2B | Apache-2.0 | Official GGUF expected; prior exact artifact failed structured tool transport | Very likely memory-viable, interface uncertain | Adds a smaller efficiency point, but prior failure makes re-entry costly |
| Phi-4 Mini Instruct | ~3.8B | MIT | GGUF availability expected; prior exact candidate failed the structured gate | Likely memory-viable, interface uncertain | Relevant Microsoft small-model baseline, but re-entry must use a new exact artifact and gate |

The last four are lower-priority because their exact prior families/artifacts include recorded pre-exposure interface failures. They should not be added without a new candidate amendment and neutral gate; they are not zero scores.

The strongest clean addition to investigate first is Llama 3.2 3B Instruct, followed by one genuinely new contemporary 3B–5B instruct model with independently verified structured tool calls. Exact release dates, revisions, license text, and GGUF availability must be verified at amendment time; no such verification or download was performed here.

## Fairness rule

Every addition must use unchanged Q01–Q07 prompts, scorer, resource thresholds, model-server semantics, and the same pre-exposure admission gate. A protocol amendment is required before exposure if a candidate cannot use the frozen interface normally.
