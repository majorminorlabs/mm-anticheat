# Dataset design

Each example is a JSON object with question, supplied context, source metadata, search state, observable actions, claims, evidence, contradictions, gaps, uncertainty, expected protocol output, provenance, license, split, and generation method.

The original `research-data-v0.1` file is retained as the engineering pilot. It
contains 480 SciFact-derived rows and must not be confused with the expanded
release candidate.

## Release candidates

`research-data-v0.1-alpha` contains 3,547 accepted rows and 13 strict
rejections. `research-data-v0.1-expanded` contains 25,269 accepted rows and
3,048 strict rejections (10.76%). The expanded candidate combines 1,409
SciFact claims across all public claim splits with 2,000 QASPER questions. Its
content hash is recorded in the validation report and ledger.

The generated data is source-grouped before validation: all rows derived from a
source document stay in one split. Every accepted row carries a `license_class`
and source provenance. Current license classes are `noncommercial` for SciFact
and `attribution_required` for QASPER. Raw downloads remain in ignored local
directories.

The strict validator rejects malformed structure, unsupported or unavailable
evidence, low-information contexts, normalized duplicates, unknown citations,
and split leakage. For the expanded candidate the rejection report is a useful
quality result: 3,000 rows were low-information after missing/too-short SciFact
source material was exposed, and 78 were normalized duplicates.

## Composition

The validation report includes tables for examples by domain, task family,
difficulty, license class, source type, and the domain × task-family matrix.
The current candidate is intentionally not quota-balanced: QASPER is NLP-heavy
and SciFact is biomedical-heavy, while behavioral-science and education rows
are sparse. This is documented as a limitation rather than hidden behind
synthetic balancing.

## Public sources

SciFact is annotation-grounded at abstract level. QASPER contributes expert-
annotated information-seeking questions and full-text evidence paragraphs. The
source URLs, versions, archive hashes, transformations, and redistribution
notes are in `data/manifests/public_sources.json` and
`docs/licensing_audit_v0.1.md`.
