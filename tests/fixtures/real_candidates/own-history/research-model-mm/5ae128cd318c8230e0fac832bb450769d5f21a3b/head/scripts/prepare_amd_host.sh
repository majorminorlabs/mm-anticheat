#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required; install it on the AMD host using Astral's official instructions" >&2
  exit 1
fi
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "AMD qualification requires Linux x86_64" >&2
  exit 1
fi

# uv.lock's Linux torch artifact is the PyPI CUDA build. Keep every other
# dependency locked, skip that torch artifact, then install the official ROCm wheel.
uv sync --python 3.13 --locked --extra dev --extra ml --no-install-package torch
uv pip install --python "$REPO_ROOT/.venv/bin/python" \
  --index-url https://download.pytorch.org/whl/rocm7.14 \
  'torch==2.14.0+rocm7.14'

uv run --no-sync python -c 'import torch; import transformers, peft, trl, bitsandbytes, accelerate, datasets; print({"torch": torch.__version__, "hip": torch.version.hip, "transformers": transformers.__version__, "peft": peft.__version__, "trl": trl.__version__, "bitsandbytes": bitsandbytes.__version__, "accelerate": accelerate.__version__, "datasets": datasets.__version__})'
uv run --no-sync python scripts/validate_e014_invariants.py
echo "Pinned AMD environment installed. No model weights or training were started."
