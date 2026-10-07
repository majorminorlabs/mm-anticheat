#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:?usage: bash scripts/qualify_gpu.sh PROFILE [check]}"
MODE="${2:-run}"
case "$PROFILE" in
  RTX3090_SINGLE|RTX3090_DUAL|A100_80GB|H100_80GB|A100_40GB|L40S_48GB|RTX6000_ADA_48GB) ;;
  *) echo "unknown execution profile: $PROFILE" >&2; exit 2 ;;
esac
case "$MODE" in
  run) EXTRA_ARGS=() ;;
  check) EXTRA_ARGS=(--check-only) ;;
  *) echo "mode must be run or check" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
exec uv run --locked --extra dev --extra ml python scripts/qualify_nvidia.py \
  --profile "$PROFILE" "${EXTRA_ARGS[@]}"
