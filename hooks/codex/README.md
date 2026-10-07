# Codex session and Stop hooks

Install goodhart-check into an operator-controlled Python 3.11+ environment.
Merge both events into `.codex/hooks.json (or ~/.codex/hooks.json)`, replacing the Python path:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/operator-venv/bin/python -I -m goodhart.hooks --agent codex --event SessionStart",
            "timeout": 120
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/operator-venv/bin/python -I -m goodhart.hooks --agent codex --event Stop",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

The shipped `session-start.sh` and `stop.sh` alternatively use `GOODHART_PYTHON`.
Both invoke Python with `-I`, so a planted `goodhart/` package in the scanned
repository or PYTHONPATH cannot shadow the installed scanner. Avoid duplicate
hook definitions. This build does not install live hooks.

SessionStart records HEAD in the actual Git directory's
`goodhart/session-<session_id>` (including linked worktrees). Resume and compact
retain the original base. Stop compares that base to the entire working tree,
including commits made during the session and untracked files. It uses the
trusted base-side scanner configuration. The session identifier is validated.

Without a saved session base, Stop uses the merge-base with an upstream or
default branch. If neither covers the current branch, it falls back to HEAD and
prints a notice that committed changes are not covered. Install SessionStart to
cover work committed on the default branch. For manual use, run
`goodhart scan --working --base <session-start-sha> --capture-on-block`.
Git fsmonitor and untracked-cache settings are disabled. Hidden edits under
skip-worktree or assume-unchanged flags are read directly and produce GH007 high.

Unallowed high findings produce exit 2 and text feedback on stderr. A clean scan
exits 0 with JSON `{}` on stdout. On `stop_hook_active: true`, the hook still scans. Unresolved high
findings save a new capture and emit JSON `systemMessage` on stdout as a
user-visible warning, then exit 0 to prevent a continuation loop. Input/scanner
errors exit 3. Use pre-commit or CI for an additional enforcement point.

Every blocked scan saves the exact `diff.patch` and schema-v2 `findings.json` to
`.goodhart/captures/<timestamp>-<id>/`. A separate `capture.json` stores
`{"unresolved": true}` for continued unresolved stops, preserving the frozen
findings schema. First save writes `.goodhart/.gitignore` containing `*`; captures
are also excluded from scans. Private files are published atomically. Storage
failure reports a diagnostic without silencing the block or unresolved warning.

Verified 2026-10-07 against the official
[Codex hooks reference](https://learn.chatgpt.com/docs/hooks).
Both hosts support SessionStart, session_id, Stop continuation feedback and
user-visible systemMessage. Operator-controlled commands, environments and
explicit config overrides should remain outside agent-writable locations.

Review and trust the definitions through `/hooks`. Project hooks require a
trusted project; changed definitions require trust review. Enable hooks as
described in the installed Codex version’s official documentation.
