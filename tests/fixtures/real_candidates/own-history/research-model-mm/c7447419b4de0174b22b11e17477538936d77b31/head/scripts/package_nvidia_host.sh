#!/usr/bin/env bash
set -euo pipefail

BUNDLE_PATH="${1:?usage: bash scripts/package_nvidia_host.sh /path/to/output.bundle}"
BRANCH="codex/e014-prereg-ready-for-compute"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "$(git branch --show-current)" != "$BRANCH" ]]; then
  echo "expected branch $BRANCH; found $(git branch --show-current)" >&2
  exit 1
fi
if ! git diff --quiet HEAD --; then
  echo "tracked source changes must be committed before packaging" >&2
  exit 1
fi
UNTRACKED_SOURCE="$(git ls-files --others --exclude-standard | sed '/^data\/generated\//d')"
if [[ -n "$UNTRACKED_SOURCE" ]]; then
  echo "untracked source files must be committed before packaging:" >&2
  echo "$UNTRACKED_SOURCE" >&2
  exit 1
fi
if [[ -e "$BUNDLE_PATH" ]]; then
  echo "refusing to overwrite existing bundle: $BUNDLE_PATH" >&2
  exit 1
fi

git bundle create "$BUNDLE_PATH" "$BRANCH"
git bundle verify "$BUNDLE_PATH"
printf 'Portable Git bundle: %s\n' "$BUNDLE_PATH"
printf 'Frozen branch: %s\n' "$BRANCH"
printf 'Frozen commit: %s\n' "$(git rev-parse "$BRANCH")"
printf 'The generated training dataset is intentionally outside Git; copy data/generated/research-data-v0.1-expanded.jsonl separately and verify the frozen SHA-256 in the host preparation step.\n'
