# Licensing audit for the v0.1 data boundary

This is a provenance and risk record, not legal advice. Dataset terms, source
rights, and model terms are separate questions. The project does not publish
raw source text or model artifacts from this phase.

| Source | Recorded terms | Project treatment | Open-release risk |
| --- | --- | --- | --- |
| SciFact | CC BY-NC 2.0 on the public dataset card | Keep separately identifiable as `noncommercial`; preserve attribution; do not label derived rows Apache-2.0 | The noncommercial condition and rights in underlying papers need review before redistribution or commercial use. |
| QASPER train/dev archive | CC BY 4.0 on the official dataset card | Keep separately identifiable as `attribution_required`; preserve attribution; raw full text remains ignored | The dataset license does not by itself resolve every underlying paper right or every downstream distribution question. |
| Controlled benchmark fixtures | Apache-2.0-controlled fixture terms in this repository | Separate benchmark source IDs from public training IDs; code and fixture terms are tracked independently | Do not imply that public-source-derived rows inherit these terms. |
| Qwen3 model checkpoints | Apache-2.0 as recorded from the model cards | Model notices and exact revisions must be pinned for any release | A model license does not remove obligations attached to training data or upstream notices. |

The current manifest at
[`data/manifests/public_sources.json`](/Volumes/Research/research-model-mm/data/manifests/public_sources.json)
records URLs, retrieval dates, archive hashes, transformations, redistribution
status, and license classes. The generated release keeps SciFact and QASPER
rows distinguishable through `license_class` and `provenance.source_id`.

The most conservative release policy is: publish code and manifests first;
publish derived data or adapters only after a separate review of attribution,
noncommercial restrictions, underlying article rights, model notices, and the
intended commercial/noncommercial use. Until that review, the data and model
outputs remain local research artifacts.

## References checked

- SciFact: <https://huggingface.co/datasets/allenai/scifact>
- QASPER: <https://huggingface.co/datasets/allenai/qasper>
- QASPER archive: <https://qasper-dataset.s3-us-west-2.amazonaws.com/qasper-train-dev-v0.1.tgz>
- Qwen3-8B-Base: <https://huggingface.co/Qwen/Qwen3-8B-Base>
