# Benchmark v1.0 scoring doctrine

Benchmark v1.0 freezes the human scoring contract already represented by
`schemas/human-score.schema.json`.

- Reviewers score only blind candidate packages.
- Model identity remains sealed until every required score sheet is complete
  and the score checksums are finalized.
- Each named score is an integer from 1 through 5.
- The required score fields are voice, editorial-section fit, lens fit,
  structure, specificity, narrative movement, evidence use, revision quality,
  human editing required, overall publishability, reviewer usefulness,
  evidence-selection quality, and research-plan usefulness.
- Estimated editing time is a non-negative integer number of minutes.
- Disposition is exactly one of `publish`, `light edit`, `substantial edit`, or
  `rewrite`.
- Comments are required but may be empty.
- Deterministic findings do not assign, raise, lower, weight, or aggregate a
  human score.
- The harness does not calculate a composite human score or apply hidden
  weighting.
- A score sheet is not final while any required score, editing-time estimate,
  or disposition is missing.

These are the complete machine-enforced scoring rules for Benchmark v1.0. No
model-specific interpretation, weighting, normalization, or workaround may be
added within v1.0.
