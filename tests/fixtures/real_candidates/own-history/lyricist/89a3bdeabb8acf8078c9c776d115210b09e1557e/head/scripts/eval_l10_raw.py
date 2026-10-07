"""Token-weighted raw-LM loss on frozen L10 work splits for reference models."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from scripts.build_l10_cpt import SPLITS
from scripts.modeling import CONFIG, ROOT, load_model
from scripts.pipeline import sha, write_json
from scripts.train_l10_cpt import make_batch, read_split, token_loss, verify_data


def main():
    import torch

    p = argparse.ArgumentParser()
    p.add_argument('--adapter')
    p.add_argument('--base-path')
    p.add_argument('--out', required=True)
    args = p.parse_args()
    metadata = json.loads((ROOT / 'corpus/metadata/l10_cpt_dataset.json').read_text())
    splits = {split: read_split(split) for split in SPLITS}
    verify_data(metadata, splits)
    tokenizer, model = load_model(args.adapter, base_path=args.base_path)
    result = {'model_id': CONFIG['model_id'], 'model_revision': CONFIG['model_revision'],
              'adapter': args.adapter, 'base_path': args.base_path,
              'cpt_metadata_sha256': sha((ROOT / 'corpus/metadata/l10_cpt_dataset.json').read_bytes()),
              'splits': {}}
    with torch.inference_mode():
        for split, rows in splits.items():
            total, tokens = 0.0, 0
            for row in rows:
                with torch.autocast('cuda', dtype=torch.bfloat16):
                    loss, count = token_loss(model, make_batch([row], tokenizer.pad_token_id, model.device))
                total += float(loss)
                tokens += count
            result['splits'][split] = {'raw_lm_loss': round(total / tokens, 6), 'supervised_tokens': tokens}
    write_json(Path(args.out), result)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
