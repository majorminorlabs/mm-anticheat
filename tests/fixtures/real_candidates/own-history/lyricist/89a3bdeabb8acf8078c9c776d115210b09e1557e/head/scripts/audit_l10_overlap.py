"""Aggregate full-raw-source exact/fuzzy overlap without publishing passages."""
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

from scripts.evaluate import score_text
from scripts.fuzzy_memorization import audit as fuzzy_audit
from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--generations', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--private-detail', help='Ignored path for source windows and per-output leads')
    args = p.parse_args()
    source_path = ROOT / 'data/l10/raw-train.jsonl'
    source = [json.loads(line) for line in source_path.read_text().splitlines()]
    rows = [json.loads(line) for line in Path(args.generations).read_text().splitlines()]
    exact = [score_text(row['output'], source, row.get('length')) for row in rows]
    fuzzy = fuzzy_audit(args.generations, source_path)
    if args.private_detail:
        write_json(Path(args.private_detail), {'fuzzy': fuzzy, 'exact_per_output': [
            {'id': row['id'], 'metrics': metric} for row, metric in zip(rows, exact)]})
    result = {'source_sha256': sha(source_path.read_bytes()),
              'generations_sha256': sha(Path(args.generations).read_bytes()),
              'outputs': len(rows),
              'max_longest_exact_train_phrase_words': max(m['longest_train_phrase_words'] for m in exact),
              'exact_memorization_flags': sum(m['memorization_flag'] for m in exact),
              'mean_shared_5grams': round(statistics.mean(m['overlap_5gram_count'] for m in exact), 4),
              'max_nearest_source_trigram_overlap': max(m['nearest_train_trigram_overlap'] for m in exact),
              'fuzzy_suspicious_outputs': fuzzy['suspicious_outputs'],
              'interpretation': 'Flags are conservative review leads, not proof of copying or originality.'}
    write_json(Path(args.out), result)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
