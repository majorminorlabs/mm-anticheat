"""Comparable completion-only loss on the frozen L3 validation/held-out probes."""
from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path

from scripts.modeling import CONFIG, load_model
from scripts.pipeline import sha, write_json
from scripts.train import batchify
from scripts.train_l3 import prepare, rows


def main():
    import torch

    p = argparse.ArgumentParser()
    p.add_argument('--adapter')
    p.add_argument('--split', choices=('validation', 'heldout'), default='heldout')
    p.add_argument('--out', required=True)
    args = p.parse_args()
    passages = rows(args.split)
    tokenizer, model = load_model(args.adapter)
    losses, work_losses = [], defaultdict(list)
    with torch.inference_mode():
        for row in passages:
            batch = batchify(tokenizer, [prepare(tokenizer, row)], model.device)
            value = float(model(**batch).loss)
            losses.append(value)
            work_losses[row['work_id']].append(value)
    source = Path('data/l3') / f'{args.split}.jsonl'
    result = {'base_id': CONFIG['model_id'], 'base_revision': CONFIG['model_revision'],
              'adapter': args.adapter, 'split': args.split,
              'dataset_sha256': sha(source.read_bytes()),
              'passages': len(passages), 'works': len(work_losses),
              'mean_passage_loss': round(statistics.mean(losses), 5),
              'mean_work_loss': round(statistics.mean(statistics.mean(x) for x in work_losses.values()), 5)}
    write_json(Path(args.out), result)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
