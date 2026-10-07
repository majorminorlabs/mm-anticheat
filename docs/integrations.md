# Integrations and local validation

## GitHub Action

Use the composite `action.yml` from a trusted pinned checkout. It installs from
its own action path, not the target repo, and scans the PR base SHA against
GITHUB_SHA (the PR merge commit). The caller must fetch full history and provide
a pull_request event. Do not use pull_request_target to execute untrusted PR code.

```yaml
on: pull_request
permissions:
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: OWNER/GOODHART_REPO@PINNED_COMMIT
        with:
          fail-on: high
          comment: 'false'
          config: ''
```

Replace the repository and pinned revision when Dippo chooses the private home.
Inputs: fail-on (high/medium/low/never), comment (true/false), config (empty for
trusted base-side settings; an explicit path is the operator's trust decision).
Inputs become environment variables and subprocess arguments, never shell code.
The Markdown report reaches the job summary before the scan's exit code is
returned, including when findings block the job. Non-PR events are a usage error.

Optional `comment: 'true'` requires `pull-requests: write` and GITHUB_TOKEN. The
adapter paginates PR comments, updates its marked github-actions[bot] comment,
and creates one only if none exists. It never updates a human's matching comment.
Fork PR tokens may be read-only; comment/API failures are reported as exit 3.
For reports above the comment size budget it posts a short job-summary pointer.
No comment is sent unless explicitly enabled. The REST implementation follows
[GitHub's issue-comment API](https://docs.github.com/en/rest/issues/comments).

## pre-commit

The root `.pre-commit-hooks.yaml` registers staged-only scanning, passes no file
names and runs even when pre-commit's file filters select no files. Blocked
staged scans also save their diff and findings JSON under .goodhart/captures/. Configure:

```yaml
repos:
  - repo: https://github.com/OWNER/GOODHART_REPO
    rev: PINNED_COMMIT
    hooks:
      - id: goodhart
```

Use `pre-commit try-repo /path/to/cheat-detector goodhart` for local installation
validation. The hook exits 1 on unallowed high findings by default; unstaged
changes are not included. It reads config from HEAD, not the changed index.

## Agent hooks and captures

Setup: [Claude Code](../hooks/claude-code/README.md) and
[Codex](../hooks/codex/README.md). Both have native Stop adapters. Findings block
with exit 2 and text feedback; loop-protected invocations rescan, save unresolved captures and warn the user,
then permit completion. SessionStart preserves a base covering agent commits.
Blocked scans save exact diff plus complete JSON under .goodhart/captures/.
Captures are automatically excluded from Git ingestion; keep them gitignored too.
No live agent settings are installed by these examples.

## Reproduced validation

`tests/test_integrations.py` runs actual subprocess scans in fresh scratch repos:
existing-test skip blocks both adapters with exit 2; captures contain the exact
untracked and tracked diff plus high GH003 JSON; repeats make distinct captures;
loop-protected invocations capture unresolved highs and emit systemMessage; reverting permits
completion even with captures left on disk. Codex success output is valid JSON.
A symlinked capture destination cannot silence a finding: the storage error is
reported and the hook still blocks. Staged scanning still fails when the worktree
has an unstaged revert. Root-history export works and existing labels survive reruns.

The Action helper is run against a real scratch Git PR range and writes its job
summary on both exit 1 and exit 0. Comment pagination and bot-only update behavior
are tested with a fake transport; no live comment is posted. Actual classic-cheat scratch runs blocked both Stop adapters at exit 2, then
passed after reset at exit 0. A pre-commit try-repo install also blocked and saved
the staged capture, then passed after reset. The fresh-clone install and README
examples passed on Python 3.11.15. Details are recorded in PROGRESS.md.

Hosted validation is pending: this checkout has no Git remote, so there is no
private repository/sample PR on which to execute the composite Action. A private
repo was requested from Dippo. Local helper checks do not establish a hosted
workflow result. `.github/workflows/test.yml` is ready for that verification.

## REVIEW_03 integration regression

The installed hook, both isolated shell wrappers and the Action scanner still
block with a planted goodhart package. SessionStart preserves its original base
across resume/compact; a committed skip blocks at Stop. Direct index-flag reads
block skip-worktree and assume-unchanged edits in working and staged modes.
Repository fsmonitor commands never execute. Captures create their own gitignore
and remain absent from git add -A. Repeated Stop warnings use systemMessage on
both hosts; capture.json records unresolved state while findings.json retains
schema v2. See tests/test_review_03.py and the hook READMEs.
