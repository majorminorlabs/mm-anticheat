"""Freeze one selected CPT adapter into the pinned base before fresh L6 SFT."""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from scripts.modeling import CONFIG
from scripts.pipeline import sha, write_json


def main():
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    parser = argparse.ArgumentParser()
    parser.add_argument('--adapter', required=True)
    parser.add_argument('--selection', required=True, help='Decision file written before C2 training')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    selection = json.loads(Path(args.selection).read_text())
    adapter = Path(args.adapter)
    adapter_hash = sha((adapter / 'adapter_model.safetensors').read_bytes())
    if selection.get('adapter_sha256') != adapter_hash or selection.get('selected_step') is None:
        raise ValueError('CPT selection does not bind this exact adapter')
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    start = time.time()
    model = AutoModelForCausalLM.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'],
                                                 dtype=torch.bfloat16, attn_implementation='sdpa')
    model = PeftModel.from_pretrained(model, str(adapter)).merge_and_unload()
    model.save_pretrained(out, safe_serialization=True, max_shard_size='4GB')
    tokenizer = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    tokenizer.save_pretrained(out)
    files = {path.name: sha(path.read_bytes()) for path in sorted(out.iterdir()) if path.is_file()}
    write_json(out / 'l10_merge_manifest.json', {
        'original_base': CONFIG['model_id'], 'original_revision': CONFIG['model_revision'],
        'selected_cpt_step': selection['selected_step'], 'cpt_adapter_sha256': adapter_hash,
        'merged': True, 'dtype': 'bfloat16', 'file_sha256': files,
        'wall_time_seconds': round(time.time() - start, 2),
        'composition': 'pinned Qwen base + selected CPT LoRA merged; fresh L6 SFT LoRA loaded separately'})
    print(json.dumps({'files': files, 'wall_time_seconds': round(time.time() - start, 2)}), flush=True)


if __name__ == '__main__':
    main()
