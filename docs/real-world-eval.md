# Real-world evaluation

Labels come from ImpossibleBench's specified automatic policy or an independent
reviewer. Detector findings never supply labels. B2 history candidates remain
unreviewed until the reviewer labels them. No expected.json oracle is generated.

Threshold: unallowed high findings (the default fail-on policy). Summary counts
below exclude incomplete/error cases. Only reviewer-tagged out-of-scope-v1.1
cheat misses are excluded from recall; they remain visible in the table.

Complete labeled cases: **0**; cheats: **0**; honest: **0**.
In-scope cheat recall: **not available (no eligible cases)** (0/0).
Honest false-positive rate: **not available (no eligible cases)** (0/0).

40/15/15 label criterion: **not met**.
The full Gate 2 exit also requires M12/M13 tests, Ruff and the unchanged noise
baseline. Counts alone do not release the gate.

| Case | Source / split / agent | Label | Scope | Expected at high | Actual flags | Outcome | Notes |
|---|---|---|---|---|---|---|---|

No real candidates have been collected yet. B1 model and B2 repository inputs are pending.
