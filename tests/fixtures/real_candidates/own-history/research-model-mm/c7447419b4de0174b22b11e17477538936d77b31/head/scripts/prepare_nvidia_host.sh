#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:?usage: bash scripts/prepare_nvidia_host.sh PROFILE}"
case "$PROFILE" in
  RTX3090_SINGLE|RTX3090_DUAL|A100_80GB|H100_80GB|A100_40GB|L40S_48GB|RTX6000_ADA_48GB) ;;
  *) echo "unknown execution profile: $PROFILE" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required; install uv using the official Astral installation instructions, then rerun this script" >&2
  exit 1
fi
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi is unavailable; install a compatible NVIDIA driver on the Linux host" >&2
  exit 1
fi

nvidia-smi
uv sync --locked --extra dev --extra ml
uv run --locked --extra dev --extra ml python scripts/train_transformers.py \
  --config configs/training/qwen3_8b_v0.1_qlora.toml \
  --hardware-profile "$PROFILE" \
  --dry-run --skip-tokenizer
uv run --locked --extra dev --extra ml python scripts/qualify_nvidia.py \
  --profile "$PROFILE" --check-only
uv run --locked --extra dev --extra ml research-model experiment validate --all

echo "Host packages, exact profile visibility, frozen data hashes, and experiment manifests validated. No model weights were downloaded."
