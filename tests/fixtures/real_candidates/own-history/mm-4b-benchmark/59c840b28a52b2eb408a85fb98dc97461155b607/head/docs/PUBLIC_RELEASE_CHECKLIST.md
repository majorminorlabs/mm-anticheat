# Public-release checklist

- Decide whether to publish the current four-model field or authorize a +2 amendment.
- Audit every file for third-party licenses and remove machine-local paths where publication does not require them.
- Scan for secrets, SSH aliases, usernames, tokens, private hostnames, and filesystem paths.
- Review raw logs for personal data and unintended environment details.
- Keep model weights out of Git; publish exact upstream links, revisions, filenames, and hashes.
- Confirm scored results match the frozen processed files and closure analysis.
- Confirm excluded candidates remain clearly classified as pre-exposure compatibility findings.
- Confirm the invalid original batch is labeled `INVALID — SHARED RUNNER/ADAPTER FAILURE`.
- Decide whether raw evidence is public, redacted, or distributed separately.
- Add a complete license/NOTICE file set.
- Re-run standalone tests in a clean environment without downloading models.
- Publish only after explicit authorization; this extraction has not been published to GitHub.
