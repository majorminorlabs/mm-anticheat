#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
SESSION_ID="${2:-}"
BUNDLE_SHA256="${3:-}"
DATASET_ARCHIVE_SHA256="${4:-}"
SOURCE_COMMIT="${5:-}"
RESUME_MODE="${6:-false}"

if [[ "$MODE" != "bootstrap" || "$SESSION_ID" != "AMD003" || -z "$BUNDLE_SHA256" || -z "$DATASET_ARCHIVE_SHA256" || -z "$SOURCE_COMMIT" ]]; then
  echo "usage: amd003_bootstrap_remote.sh bootstrap AMD003 BUNDLE_SHA256 DATASET_ARCHIVE_SHA256 SOURCE_COMMIT [true]" >&2
  exit 2
fi

REMOTE_PARENT="${AMD_REMOTE_PARENT:-/root/amd-e014-sessions}"
SESSION_ROOT="$REMOTE_PARENT/$SESSION_ID"
TRANSFER_ROOT="$SESSION_ROOT/transfer"
REPO_ROOT="$SESSION_ROOT/research-model"
BUNDLE_PATH="$TRANSFER_ROOT/research-model.bundle"
DATA_ARCHIVE_PATH="$TRANSFER_ROOT/research-data.tar.gz"
DATASET_NAME="research-data-v0.1-expanded.jsonl"
DATASET_PATH="$REPO_ROOT/data/generated/$DATASET_NAME"

sha256() {
  sha256sum "$1" | awk '{print $1}'
}

mkdir -p "$TRANSFER_ROOT" "$SESSION_ROOT/runtime/logs" "$SESSION_ROOT/runtime/telemetry" "$SESSION_ROOT/failures" "$SESSION_ROOT/result"
[[ -f "$BUNDLE_PATH" ]] || { echo "missing transferred code bundle: $BUNDLE_PATH" >&2; exit 1; }
[[ -f "$DATA_ARCHIVE_PATH" ]] || { echo "missing transferred dataset archive: $DATA_ARCHIVE_PATH" >&2; exit 1; }
[[ "$(sha256 "$BUNDLE_PATH")" == "$BUNDLE_SHA256" ]] || { echo "code bundle SHA-256 mismatch" >&2; exit 1; }
[[ "$(sha256 "$DATA_ARCHIVE_PATH")" == "$DATASET_ARCHIVE_SHA256" ]] || { echo "dataset archive SHA-256 mismatch" >&2; exit 1; }

if [[ -e "$REPO_ROOT" ]]; then
  [[ -d "$REPO_ROOT/.git" ]] || { echo "refusing to overwrite non-Git remote checkout: $REPO_ROOT" >&2; exit 1; }
  [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" == "$SOURCE_COMMIT" ]] || {
    echo "existing remote checkout commit differs from requested AMD003 source commit" >&2
    exit 1
  }
else
  git clone --quiet "$BUNDLE_PATH" "$REPO_ROOT"
  git -C "$REPO_ROOT" checkout --quiet --detach "$SOURCE_COMMIT"
fi

mkdir -p "$REPO_ROOT/data/generated"
if [[ ! -f "$DATASET_PATH" || "$(sha256 "$DATASET_PATH")" != "703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f" ]]; then
  STAGE_DIR="$REPO_ROOT/.amd003-dataset-stage-$$"
  mkdir "$STAGE_DIR"
  trap 'rm -rf "$STAGE_DIR"' EXIT
  tar -xzf "$DATA_ARCHIVE_PATH" -C "$STAGE_DIR" --no-same-owner --no-same-permissions
  [[ -f "$STAGE_DIR/$DATASET_NAME" ]] || { echo "dataset archive did not contain $DATASET_NAME" >&2; exit 1; }
  [[ "$(sha256 "$STAGE_DIR/$DATASET_NAME")" == "703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f" ]] || {
    echo "extracted dataset SHA-256 mismatch" >&2
    exit 1
  }
  mv "$STAGE_DIR/$DATASET_NAME" "$DATASET_PATH"
  rm -rf "$STAGE_DIR"
  trap - EXIT
fi

python3 - "$SESSION_ROOT/transfer/manifest.remote.json" "$BUNDLE_PATH" "$DATA_ARCHIVE_PATH" "$SOURCE_COMMIT" "$BUNDLE_SHA256" "$DATASET_ARCHIVE_SHA256" <<'PY'
import json
import os
import socket
import sys
from datetime import datetime, timezone

output, bundle, archive, commit, bundle_sha, archive_sha = sys.argv[1:]
record = {
    "schema_version": "1.0",
    "session_id": "AMD003",
    "prepared_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "host": socket.gethostname(),
    "source_commit": commit,
    "bundle": {"path": bundle, "bytes": os.path.getsize(bundle), "sha256": bundle_sha},
    "dataset_archive": {"path": archive, "bytes": os.path.getsize(archive), "sha256": archive_sha},
    "dataset": {"path": "data/generated/research-data-v0.1-expanded.jsonl", "sha256": "703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f"},
    "model": {"name": "Qwen/Qwen3-8B-Base", "revision": "49e3418fbbbca6ecbdf9608b4d22e5a407081db4"},
    "detached_execution": True,
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2)
    handle.write("\n")
PY

chmod +x "$REPO_ROOT/scripts/start_e014_amd003.sh" "$REPO_ROOT/scripts/run_e014_remote.sh"
start_args=(--session-root "$SESSION_ROOT" --repo-root "$REPO_ROOT")
if [[ "$RESUME_MODE" == "true" ]]; then
  start_args+=(--resume)
fi
bash "$REPO_ROOT/scripts/start_e014_amd003.sh" "${start_args[@]}"
