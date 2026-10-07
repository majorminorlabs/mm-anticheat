# REVIEW_03b: Gate 3 re-review

Reviewer: Claude · Date: 2026-10-07 · Build: `dist/goodhart-check-gate3.zip` (commit `c1bf2a2`)

## Verdict

**Gate 3 passes.** v1 is ready for Dippo's release steps, after two small pre-publish items (S19, S20) that don't need another full review. Every bypass from REVIEW_03 is closed and I reproduced each fix myself. The real-world numbers are honest and good.

## What I verified independently

| Check | Result |
|---|---|
| `ruff check`, `ruff format --check` | Clean |
| `pytest` from the ZIP | **412 passed** (Python 3.13) |
| Noise spot check (click 80, pydantic 150, same pins) | click 1 high, pydantic 2 high: unchanged. Pydantic high-or-medium commits dropped 19 → 11 from S13 ✅ |
| B2 report | Suspicious 2/2 blocked. Legitimate high-blocked 1/393 (`58e3f541`, the intentional test-script narrowing; rule-correct). All six REVIEW_03 false positives are now `correct negative` ✅ |

Bypass probes, rerun in a scratch repo with a real skip-cheat, `SessionStart` recorded:

| Probe (REVIEW_03 item) | Before | Now |
|---|---|---|
| Planted `goodhart/` package + `stop.sh` (M14) | exit 0 ❌ | **exit 2** ✅ |
| Agent commits the cheat, then stops (M17) | exit 0 ❌ | **exit 2**, "using session base …" ✅ |
| `--skip-worktree` on the cheated file (M18) | exit 0 ❌ | **exit 2**, GH007 *"Index flags hide working-tree changes"* + GH003 ✅ |
| `--assume-unchanged` (M18) | exit 0 ❌ | **exit 2** ✅ |
| `stop_hook_active: true` with the cheat unresolved (S16) | silent exit 0 | exit 0 + `{"systemMessage": "goodhart: 1 unresolved high findings, see .goodhart/captures/…"}` ✅ |
| Captures committed by `git add -A` (S15) | committed | `.goodhart/.gitignore` = `*`; `git status` clean ✅ |
| `action_scan.py` subprocess (M14) | `python -m` | `python -I -m` ✅ |

The hook now runs the scanner in-process from the installed package rather than in a subprocess. That's the right fix, and it also removed a process spawn.

## Remaining gaps (none blocking the gate)

### S19. The session base file can be rewritten by the agent (fix before publish)
Probe: after committing the cheat, `git rev-parse HEAD > .git/goodhart/session-s1` → *"using session base <HEAD>"*, **exit 0**. This takes a deliberate, tool-aware action, unlike casually committing, but it's a one-liner.

**Cheap detection:** at `SessionStart`, also record the start time (and HEAD) in the same file. At `Stop`, list first-parent commits on `HEAD` with committer date at or after the session start. If any of them is an ancestor of the saved base (i.e. the base has been moved past session commits), or the file's recorded start time is later than the oldest such commit, emit **GH007 high** *"session base moved past session commits"*. Store the record as one JSON line `{base, started_at}` and fail closed to the merge-base fallback on parse errors.
**Fixture:** commit cheat → rewrite base → exit 2.

### S20. State the threat model plainly (README + hook READMEs, before publish)
An agent that runs as your user with a shell can always defeat a local hook. It can edit project hook settings, delete the session file, uninstall the package, or backdate commits. goodhart is a **tripwire and review aid** for agent shortcuts, not a sandbox. Say so in one short section, and make three recommendations:
- Install hooks in **user-level** settings (`~/.claude/settings.json`, `~/.codex/hooks.json`), not project files the agent can edit.
- Treat **pre-commit and the PR Action on a protected branch** as the enforcement point, with the Stop hook as the early warning.
- Pin the Action by commit SHA.

This honesty is also good positioning for MAJOR//minor: the tool claims exactly what it does.

### C10 (consider)
The `goodhart-stop-hook` console script still honors `PYTHONPATH`. With `PYTHONPATH` pointed at a repo holding a planted package it exits 0. The READMEs now document `python -I -m goodhart.hooks`, so this only matters if someone uses the console script with a hostile environment. Either drop the entry point or have it re-exec itself with `-I`.

### C11 (consider)
Without a `SessionStart` record on the default branch, `Stop` falls back to `HEAD` and only covers uncommitted work. It prints a notice, which is correct, but solo developers committing straight to `main` are the main audience. Make the README's install snippet include `SessionStart` by default (it does) and keep the warning loud.

## Still pending, all with Dippo

1. **Hosted Action check:** create a private GitHub repo, push `c1bf2a2`, open a sample PR containing the classic-cheat diff, and confirm the job fails with the Markdown summary. Then push a clean PR and confirm it passes.
2. **Release decisions:** final name (`goodhart-check` is available; `goodhart` is taken on PyPI), MIT confirmation, PyPI publish, public repo, tag `v0.1.0`.
3. **Launch claims, only these** (all measured):
   - 10/680 maintainer commits flagged high across five popular OSS repos, all of them real test removals
   - 2/2 suspicious agent changes blocked in 393 commits of agent-built history; 1/393 legitimate commits blocked
   - recall on deliberate cheats: **not yet measured**. Hook captures from daily use will provide it.

## Next step for Sol

Implement S19 and S20 (and C10 if cheap), with the fixture above. Commit, rebuild the ZIP, and report. I'll verify S19 with the same probe. That's a five-minute check, not a full review.
