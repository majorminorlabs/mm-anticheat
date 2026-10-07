# Research questions and preregistered-style hypotheses

The machine-readable source of truth is
[`configs/research/primary_v0.1.json`](/Volumes/Research/research-model-mm/configs/research/primary_v0.1.json).
It was frozen on 2026-09-15, before the primary Qwen3-8B training run. The
earlier 0.6B and 8B-class MLX smokes are engineering evidence and are not
retroactively treated as tests of these hypotheses.

## Central question

Can research-behavior specialization substantially improve the research
competence of an approximately 8B open-weight language model?

The primary comparison is untouched `Qwen/Qwen3-8B-Base` versus a research-
behavior SFT/QLoRA adapter on an unseen, source-grouped benchmark. The longer-
term comparison to a larger generic model is a secondary question and does not
block the primary experiment.

## Research questions

RQ1 asks whether specialization improves unseen research tasks. RQ2 and RQ6
ask which skills and task families benefit. RQ3 asks which regress. RQ7–RQ9
focus on citation discipline, unsupported synthesis, and insufficient-evidence
recognition. RQ10 checks retention of instruction following, basic reasoning,
summarization, and technical explanation. RQ4 and RQ5 concern the eventual
size/performance tradeoff and the data learning curve.

## Hypotheses frozen before primary training

- H1: tuned structured validity and research-action accuracy will exceed the
  untouched base on the frozen benchmark.
- H2: citation precision/recall will rise and unsupported-claim rate will fall.
- H3: insufficient-evidence recognition will improve on cases where evidence is
  inadequate.
- H4: attribution, source selection, and methodology critique will gain more
  than generic planning families.
- H5: at least one useful general capability may regress unless the mixture or
  control objective protects it. This is a risk hypothesis, not a conclusion.

The analysis plan calls for paired per-example comparisons and bootstrap
intervals when metric semantics and sample sizes support them. Subgroup results
are descriptive unless the final design justifies stronger claims. No result or
conclusion is written here.
