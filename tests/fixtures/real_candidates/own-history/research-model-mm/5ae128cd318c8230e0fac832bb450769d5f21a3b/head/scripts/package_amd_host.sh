#!/usr/bin/env bash
set -euo pipefail

BUNDLE_PATH="${1:?usage: bash scripts/package_amd_host.sh /path/to/output.bundle}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "a named Git branch is required" >&2
  exit 1
fi
if [[ -e "$BUNDLE_PATH" ]]; then
  echo "refusing to overwrite existing bundle: $BUNDLE_PATH" >&2
  exit 1
fi

# Bundles contain committed history only. They do not include the dirty index,
# working tree, ignored files, credentials, or the untracked frozen dataset.
git bundle create "$BUNDLE_PATH" "$BRANCH"
git bundle verify "$BUNDLE_PATH"
printf 'Portable Git bundle: %s\n' "$BUNDLE_PATH"
printf 'Branch: %s\n' "$BRANCH"
printf 'Committed source revision: %s\n' "$(git rev-parse HEAD)"
printf 'Copy data/generated/research-data-v0.1-expanded.jsonl separately; expected SHA-256: 703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f\n'
