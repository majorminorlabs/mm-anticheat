# Changelog

## 0.1.0 (unreleased)

- Python and JS/TS diff review with AC001–AC012 and AC000 diagnostics.
- Git range, working tree, staged and patch inputs; text, JSON v3 and Markdown.
- Trusted base-side config and preexisting inline approvals, with audit findings.
- GitHub Action, pre-commit, Claude Code and Codex session and Stop hooks, isolated from planted packages.
- Session-base scans include committed work; hidden index edits produce AC007 high.
- Saved blocked/unresolved scans under .anticheat/captures/, with local ignores.
- New-config, skip-gate, deleted-import, same-diff expectation and JS regex repairs.
- Pinned noise baseline and independently labeled own-history candidates.

The local B1 benchmark campaign is invalid and excluded from evaluation. Gate 2
was released with reduced scope by Dippo. B2 has 2/2 suspicious cases blocked,
1/393 legitimate commits blocked, and no confirmed-cheat recall sample.


### REVIEW_04 holdout candidate

- Rename distribution/CLI to mm-anticheat, module to mm_anticheat, rules to AC IDs,
  policy to .anticheat.toml, directives and capture paths to anticheat; JSON schema 3.
- Block changed session-base records and document the same-user threat model.
- Search unlinked tests for literal branches, detect collection renames, expand CI
  commands, retain malformed-config findings and block assertion weakening.
- Add AC013–AC018 for short circuits, swallowed assertions, collection/exit hooks,
  constant equality overrides, subject mocks and rewritten expectations.
- Treat skips inside availability except handlers as medium; ignore generated
  bytecode while retaining test-move detection.
- Report ten-repository noise, labeled own history and subscription agent trials.
  No holdout recall claim; publication remains on hold pending Dippo GO.
