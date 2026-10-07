# JSON v1 contract

This is the historical frozen contract. Current scans emit [JSON v3](json-v3.md)
to add config provenance required by REVIEW_02 M12. All v1 fields retain their
types and meanings in v2.

Phase 4 freezes `schema_version: "1"`. Changes to the field names, types or
meanings below require a new schema version. `tool_version` follows the package
version independently. The serializer emits one JSON object and a final newline;
no notices or ANSI color codes are mixed into stdout. CLI notices use stderr.

| Top-level field | Type | Meaning |
|---|---|---|
| `schema_version` | string | Always `"1"` for this contract. |
| `tool` | string | Tool identity, currently `"mm-anticheat"`. |
| `tool_version` | string | Package version. |
| `mode` | string | `"full"` or `"patch"`. |
| `range` | object | Exactly `base` and `head`: strings in full mode, null in patch mode. Full mode resolves commit IDs; working/staged head labels are `WORKTREE`/`INDEX`. |
| `summary` | object | Exactly `high`, `medium`, `low`, `info`, `files_scanned`, each a nonnegative integer. Severity counts include allowed findings. |
| `files` | array | All changed files, sorted by repository-relative `file` path. |
| `findings` | array | All findings, including allowed findings, sorted by severity, file, line, rule ID and title. |

Each `files` entry has exactly `file` (string), `kinds`, `base_kinds` and
`head_kinds` (sorted arrays of strings). Kinds are `test`, `source`, `config`,
`snapshot` or `other`; a file can have multiple kinds. A missing side has an empty
kind array. `kinds` is the effective classification used by rules. `files_scanned`
counts changed files whose effective classification is not solely `other`,
including files that produce parse-skipped diagnostics. Ignored files remain in
`files` as `other` and do not count as scanned.

Each finding has exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `rule_id` | string | AC000–AC012. |
| `rule_name` | string | Rule name; AC000 diagnostics use `parse-skipped` or `allow-missing-reason`. |
| `severity` | string | `high`, `medium`, `low` or `info`. |
| `confidence` | string | `normal` or `reduced`. Patch counting and hardcode heuristics use reduced confidence. |
| `file` | string | Repository-relative path, using the head path when available, otherwise the deleted base path. |
| `line` | integer | One-based review location, at least 1. |
| `title` | string | Concise review flag. |
| `evidence` | string | Complete evidence, including any newlines. |
| `why_flagged` | string | Rationale, downgrade context and reviewed allowance reason when applicable. |
| `legit_if` | string | Legitimate explanation to consider. |
| `allowed` | boolean | A matching config or inline allowance with a required reason was applied. |

Allowed findings contribute to the summary but are excluded from exit thresholds.
An added allow comment still produces AC012; only a config path allowance can
allow AC012. `--quiet` and `--max-evidence-lines` affect text/Markdown presentation
only. JSON always retains every finding and the complete evidence.

`tests/test_reports.py` fixes the exact key sets and value types for full and
patch scans, including allowed findings. Git input integration tests fix resolved
range labels. No new finding fields were added during Phase 4.
