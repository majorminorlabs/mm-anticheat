# JSON v3 contract

REVIEW_02 M12 requires the effective config source in JSON. Current scans emit
`schema_version: "3"` and add one top-level object:

```json
"config": {"source": "base:0123456789abcdef0123456789abcdef01234567"}
```

`config` has exactly one key, `source`, a string. Possible sources are:

| Source | Meaning |
|---|---|
| `base:<sha>` | Root config read from the resolved Git merge base. |
| `HEAD` | Root config read from HEAD for working or staged input. |
| `--config path` | Operator-selected file, using the supplied path. |
| `defaults` | No trusted config exists, or patch input without an explicit config. |

All fields from [v1](json-v1.md) remain present with unchanged types and meanings.
The top-level keys are `schema_version`, `tool`, `tool_version`, `mode`, `range`,
`config`, `summary`, `files`, and `findings`. The serializer emits one object and
a final newline; notices go to stderr. Quiet mode and evidence presentation caps
do not remove JSON findings or evidence.

Severity summary counts include allowed findings; exit thresholds exclude them.
An inline allowance is applied only if its comment existed on the mapped base
side, or on a context line for patch input. New comments produce AC012 and do
not allow their target finding. Root `.anticheat.toml` changes audited by AC007
cannot allowlist their own modification.

`tests/test_reports.py` fixes the exact key sets and field types. The REVIEW_02
integration tests check provenance in all four modes and explicit overrides.
The separate benchmark exporter uses `base:benchmark-test.py-adapter` for its
documented test-path adapter; the CLI does not emit that adapter source.
