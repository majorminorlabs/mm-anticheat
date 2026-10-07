# Gate 1 release record

[REVIEW_01.md](../REVIEW_01.md) M1–M10 and S1–S9 were addressed with regression
fixtures and a pinned maintainer-history noise corpus. The first revised package
had 223 tests, 133 individual rule fixtures and six cross-rule fixtures. Its
`dist/mm-anticheat-gate1.zip` is retained as a historical snapshot.

[REVIEW_01b.md](../REVIEW_01b.md) released Gate 1 conditional on M11. M11 now
rejects same-name empty stubs as move evidence in both full and patch mode;
destinations with fewer assertions yield medium; full substantive matches retain
at least the removed assertion count. The real Pydantic move still passes.

All five pinned histories were rerun after M11. The result is 10/680 high commits,
AC006 highs 0, scan/rule errors 0 and stderr lines 0. REVIEW_01b waived the old
eight-commit target and set the regression limit to at most ten. No repository or
commit exceptions were introduced. See [the baseline](noise-baseline.md) for pins,
commands, complete output and every high commit's justification.

Gate 1 is released and Phase 4 is complete. Use the current
[Gate 2 package and review instructions](GATE_2.md) for M11 and all subsequent
changes. The updated [handoff](HANDOFF.md), per-item resolutions, fixture counts
and remaining scope are recorded in [PROGRESS.md](../PROGRESS.md).
