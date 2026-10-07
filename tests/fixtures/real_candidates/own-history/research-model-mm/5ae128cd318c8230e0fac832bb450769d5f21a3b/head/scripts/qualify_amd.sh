#!/usr/bin/env bash
set -euo pipefail

MODE="${1:?usage: bash scripts/qualify_amd.sh check|run}"
case "$MODE" in
  check) MODE_ARGS=(--check-only) ;;
  run) MODE_ARGS=(--run) ;;
  *) echo "mode must be check or run" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
exec uv run --no-sync --extra dev --extra ml python scripts/qualify_amd.py "${MODE_ARGS[@]}"
