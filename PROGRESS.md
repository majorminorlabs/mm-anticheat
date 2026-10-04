# PROGRESS

## Current phase
Phase 2: Counting rules. Status: in progress

## Done
- [x] Read the full handoff before writing code; preserve it in `docs/HANDOFF.md`.
- [x] Created local Git repository, Python src layout, CLI entry point and development checks.

- [x] Phase 1 exit: four input modes, merge-base/upstream/fallback resolution,
  staged vs working content, new/deleted/renamed/binary files, classification; 19 tests pass.

## Next up
- [x] Phase 0 exit: editable install, version, ruff and pytest passed (1 test).
- [ ] Complete Phases 1–3 in order and stop at Gate 1 for Dippo and Claude.

## Decisions made (with reason)
- 2026-10-04: Use all supplied defaults: goodhart-check/goodhart, Python 3.11+, MIT,
  default fail-on high. Use setuptools and unidiff as the only runtime dependency.
- 2026-10-04: The checkout was empty and had no Git remote. Initialize a local repository
  and prepare a ZIP at Gate 1 rather than inventing a remote or publishing anything.

## Open questions for Dippo
- Private repository remote can be provided at Gate 1; ZIP delivery is available meanwhile.
- GH001 matching-source deletion and GH002 consolidation are called negative fixtures
  in section 8 but still emit downgraded findings in section 6. Follow section 6 and
  include explicit downgrade fixtures as well as true negative fixtures.

## Known risks / false-positive concerns
- JS/TS parsing will use documented regex heuristics.
- GH006 literal matching may flag legitimate shared constants; constrain high findings
  to input-condition/output combinations and report legitimate explanations.

## Session log
- 2026-10-04: Began Phase 0 from empty checkout. Phase 0 complete; Ruff clean, pytest 1 passed.

- 2026-10-04: Phase 1 complete; Ruff clean, pytest 19 passed. Working mode also
  includes untracked supported-language files, so hooks can review newly created code.
