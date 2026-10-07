"""Freeze the already-scored L8-era baselines for the unchanged L9 audits."""
from __future__ import annotations

import json

from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json


def main():
    fixed = sha((ROOT / 'data/eval/prompts.json').read_bytes())
    novel = sha((ROOT / 'corpus/metadata/l8_novel_prompts.json').read_bytes())
    decision = json.loads((ROOT / 'corpus/metadata/l8_decision.json').read_text())
    fixed_names = {'B0': 'b0', 'L1-48': 'l1-eval-048',
                   'L6-40': 'l6-eval-040', 'L8-40': 'l8-eval-040'}
    novel_names = {'L1-48': 'l8-novel-L1-48',
                   'L6-40': 'l8-novel-L6-40', 'L8-40': 'l8-novel-L8-40'}
    digests = {}
    for expected_prompt_hash, names in ((fixed, fixed_names), (novel, novel_names)):
        for label, directory in names.items():
            path = ROOT / 'outputs' / directory
            manifest = json.loads((path / 'run.json').read_text())
            if manifest['prompts_sha256'] != expected_prompt_hash:
                raise ValueError(f'Prompt hash drifted for {directory}')
            digests[directory] = sha((path / 'generations.jsonl').read_bytes())
    result = {'fixed_prompt_sha256': fixed, 'novel_prompt_sha256': novel,
              'baseline_generation_sha256': digests,
              'fixed_constraint_audit': {name: decision['fixed_constraint_audit']['baseline'].get(name)
                                         or decision['fixed_constraint_audit']['l8'][name]
                                         for name in fixed_names},
              'novel_constraint_audit': {name: decision['novel_diagnostic'][name]
                                         for name in novel_names},
              'source': 'Previously completed L8 internal constraint audits; no L9 generations or new judgments.',
              'all_local_generation_files_verified': True}
    write_json(ROOT / 'corpus/metadata/l9_baseline_lock.json', result)
    print(json.dumps({'fixed_models': list(fixed_names), 'novel_models': list(novel_names),
                      'fixed_prompt_sha256': fixed, 'novel_prompt_sha256': novel}))


if __name__ == '__main__':
    main()
