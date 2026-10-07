#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:?usage: bash scripts/run_e014.sh PROFILE run|resume}"
ACTION="${2:?usage: bash scripts/run_e014.sh PROFILE run|resume}"
case "$ACTION" in
  run) RESUME_ARGS=() ;;
  resume) RESUME_ARGS=(--resume) ;;
  *) echo "action must be run or resume" >&2; exit 2 ;;
esac

case "$PROFILE" in
  RTX3090_SINGLE|A100_80GB|H100_80GB|A100_40GB|L40S_48GB|RTX6000_ADA_48GB|AMD_MI300X_SINGLE)
    WORLD_SIZE=1
    ;;
  RTX3090_DUAL)
    WORLD_SIZE=2
    ;;
  *) echo "unknown E014 NVIDIA profile: $PROFILE" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
if [[ "$WORLD_SIZE" == "1" ]]; then
  exec uv run --locked --extra dev --extra ml python scripts/train_transformers.py \
    --config configs/training/qwen3_8b_v0.1_qlora.toml \
    --hardware-profile "$PROFILE" "${RESUME_ARGS[@]}"
fi
exec uv run --locked --extra dev --extra ml python -m torch.distributed.run \
  --standalone --nproc_per_node="$WORLD_SIZE" scripts/train_transformers.py \
  --config configs/training/qwen3_8b_v0.1_qlora.toml \
  --hardware-profile "$PROFILE" "${RESUME_ARGS[@]}"
