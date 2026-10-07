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
