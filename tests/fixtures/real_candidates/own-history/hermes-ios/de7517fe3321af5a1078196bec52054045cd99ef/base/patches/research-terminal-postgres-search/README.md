# Research Terminal PostgreSQL search delivery

This folder contains Track A handoff artifacts.

- research-terminal-track-a.patch is a complete unified patch for the eight scoped paths, generated relative to the captured pre-edit worktree state. It includes new route, service, and documentation files.
- baseline-manifest.json records SHA-256 for every captured existing file and the resulting source file hashes.
- validation.md records the root cause, implementation, safety boundaries, validation, and the current deployment requirement.

The patch was applied to an isolated copy of the captured baseline and the resulting files matched the current scoped files byte-for-byte. It is not a patch against clean Git HEAD: main.py and api/routes/hermes.py already contained unrelated dirty user work at capture time. The Research Terminal checkout itself remains unstaged and uncommitted by this task.
