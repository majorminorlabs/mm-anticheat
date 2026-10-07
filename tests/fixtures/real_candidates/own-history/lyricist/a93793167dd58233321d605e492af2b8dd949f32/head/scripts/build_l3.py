"""Build provenance-preserving, varied-length L3 passage supervision.

Passage selection is deterministic. Audited local-model labels and manual review
overrides describe the selected passages; targets contain only source text.
"""
from __future__ import annotations

import difflib
import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from scripts.build_l2 import ANNOTATION, normalized, source_sections
from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import sha, words, write_json, write_jsonl

BUCKETS = {'very_short': (2, 3), 'short': (4, 6), 'medium': (7, 10), 'longer': (11, 16)}
TRAIN_TARGETS = {'very_short': 50, 'short': 100, 'medium': 75, 'longer': 25}
MAX_PER_WORK = 5
BAD_TAIL = {'and', 'but', 'or', 'if', 'because', 'while', 'to', 'the', 'a', 'an', 'of', 'for', 'with', 'when', 'that', 'as'}

# Specific, passage-evidenced subjects precede broad concepts. Each entry is
# (request wording, evidence tokens); the target never supplies the wording.
EVENTS = [
    ('trying to believe something', {'believe', 'deceive', 'deceived'}),
    ('waiting', {'wait', 'waiting', 'await'}),
    ('leaving', {'leave', 'leaving', 'left', 'escape', 'exit'}),
    ('returning home', {'return', 'returning'}),
    ('searching', {'search', 'searching'}),
    ('keeping something hidden', {'hide', 'hiding', 'hidden', 'buried'}),
    ('sleep or sleeplessness', {'sleep', 'sleeping', 'awake', 'insomnia'}),
    ('remembering', {'remember', 'remembering', 'memory', 'memories', 'recall'}),
    ('forgetting', {'forget', 'forgot', 'forgotten'}),
    ('watching', {'watch', 'watched', 'watching', 'stare', 'staring'}),
    ('hearing something', {'hear', 'heard'}),
    ('trying to speak', {'speak', 'speaking', 'words'}),
    ('holding on', {'hold', 'holding', 'held', 'grip'}),
    ('forgiveness', {'forgive', 'forgiven', 'forgiveness'}),
    ('a lie', {'lie', 'lies', 'lying', 'lied'}),
    ('whether to stay', {'stay', 'staying'}),
    ('trying to get away', {'flee', 'escape', 'escaping'}),
    ('walking', {'walk', 'walking'}),
    ('something breaking', {'break', 'breaking', 'broken', 'crack', 'cracked'}),
    ('change', {'change', 'changed', 'changing', 'different'}),
    ('needing help', {'help', 'rescue'}),
    ('looking for proof', {'proof', 'prove', 'evidence'}),
]
IMAGES = [
    ('a compass', {'compass'}), ('a fountain', {'fountain'}),
    ('concrete', {'concrete'}), ('an anchor', {'anchor'}),
    ('a hospital', {'hospital'}), ('a train', {'train'}), ('a river', {'river', 'creek'}),
    ('the ocean', {'ocean', 'sea'}), ('a door', {'door', 'doors'}),
    ('a room', {'room', 'rooms'}), ('a house', {'house', 'home'}),
    ('a window', {'window', 'windows'}), ('a bed', {'bed', 'beds'}),
    ('a road', {'road', 'roads', 'street', 'streets'}),
    ('a car', {'car', 'cars'}), ('a bridge', {'bridge'}),
    ('a photograph', {'photograph', 'photo', 'picture'}),
    ('a mirror', {'mirror', 'reflection'}), ('a clock', {'clock', 'clocks'}),
    ('a voice', {'voice', 'voices'}), ('a name', {'name', 'names'}),
    ('a hand', {'hand', 'hands'}), ('a face', {'face', 'faces'}),
    ('a heart', {'heart', 'hearts'}),
    ('blood', {'blood', 'bleed', 'bleeding'}), ('skin', {'skin'}),
    ('fire', {'fire', 'flame', 'burning'}), ('rain', {'rain', 'raining'}),
    ('snow', {'snow', 'snowing'}), ('ice', {'ice', 'frozen', 'freeze'}),
    ('water', {'water', 'wet', 'waves'}), ('sunlight', {'sun', 'sunlight'}),
    ('the night', {'night', 'darkness'}), ('a shadow', {'shadow', 'shadows'}),
    ('a song', {'song', 'sing', 'singing'}), ('a radio', {'radio'}),
    ('a letter', {'letter', 'letters'}), ('a phone', {'phone', 'telephone'}),
    ('a child', {'child', 'children', 'kid'}), ('a father', {'father', 'dad'}),
    ('a mother', {'mother', 'mom'}), ('a stranger', {'stranger', 'strangers'}),
    ('a crowd', {'crowd', 'people'}), ('a wound', {'wound', 'wounds', 'scar'}),
    ('the ground', {'ground', 'floor'}), ('a cross', {'cross', 'crosses'}),
    ('a dream', {'dream', 'dreaming', 'dreams'}),
]
TENSIONS = [
    ('not being able to trust someone', {'trust', 'distrust', 'mistrust', 'believe'}),
    ('feeling guilty', {'guilt', 'guilty', 'blame', 'fault', 'sorry', 'regret'}),
    ('being afraid', {'afraid', 'fear', 'scared', 'panic', 'terror'}),
    ('being alone', {'alone', 'lonely', 'loneliness'}),
    ('wanting to disappear', {'disappear', 'disappearing', 'vanish', 'vanishing'}),
    ('doubting a memory', {'memory', 'memories', 'remember', 'forget'}),
    ('being unable to decide', {'decide', 'decision', 'choose', 'choice'}),
    ('feeling trapped', {'trapped', 'stuck', 'prison', 'cage'}),
    ('being misunderstood', {'misunderstood', 'understand', 'understood'}),
    ('something ending', {'end', 'ending', 'over', 'last', 'goodbye'}),
]


def bucket_for(count: int) -> str | None:
    return next((name for name, (lo, hi) in BUCKETS.items() if lo <= count <= hi), None)


def _stanzas(records):
    result, current = [], []
    for number, line in records:
        if line.strip():
            current.append((number, line))
        elif current:
            result.append(current)
            current = []
    if current:
        result.append(current)
    return result


def _candidate_spans(records):
    stanzas = _stanzas(records)
    for i, stanza in enumerate(stanzas):
        if 2 <= len(stanza) <= 16:
            yield stanza[0][0], stanza[-1][0], 1
        for width in (2, 3):
            if i + width > len(stanzas):
                continue
            group = stanzas[i:i + width]
            count = sum(len(s) for s in group)
            if 7 <= count <= 16:
                yield group[0][0][0], group[-1][-1][0], width


def _concepts(text: str):
    tokens = normalized(text)
    counts = Counter(tokens)
    result = {}
    for kind, entries in (('event', EVENTS), ('image', IMAGES), ('tension', TENSIONS)):
        matches = []
        for rank, (phrase, evidence) in enumerate(entries):
            hits = sorted(set(counts) & evidence)
            if hits:
                # Frequency helps identify the passage's main subject; rank breaks ties.
                matches.append({'phrase': phrase, 'hits': hits, 'score': sum(counts[h] for h in hits), 'rank': rank})
        result[kind] = sorted(matches, key=lambda x: (-(min(x['score'], 3) + (1 if kind == 'image' and x['rank'] < 16 else 0)), x['rank']))
    return result


def _prompt(text: str, passage_id: str, length_bucket: str):
    concepts = _concepts(text)
    event = concepts['event'][0] if concepts['event'] else None
    image = concepts['image'][0] if concepts['image'] else None
    tension = concepts['tension'][0] if concepts['tension'] else None
    if not (event or image):
        return None
    seed = int(sha(f'l3-class:{CONFIG["seed"]}:{passage_id}'.encode())[:8], 16)
    klass = 'descriptive' if seed % 100 < 70 else 'sparse'
    selected = []
    if klass == 'descriptive':
        if event and image and not set(event['hits']) & set(image['hits']):
            base = f'write about {event["phrase"]}, involving {image["phrase"]}'
            selected = [('event', event), ('image', image)]
        elif event and tension and not set(event['hits']) & set(tension['hits']):
            base = f'write about {event["phrase"]} while {tension["phrase"]}'
            selected = [('event', event), ('tension', tension)]
        elif image and tension and not set(image['hits']) & set(tension['hits']):
            base = f'write about {image["phrase"]} and {tension["phrase"]}'
            selected = [('image', image), ('tension', tension)]
        elif event:
            base = f'write about {event["phrase"]}'
            selected = [('event', event)]
        else:
            base = f'write about {image["phrase"]}'
            selected = [('image', image)]
    elif event and image and not set(event['hits']) & set(image['hits']):
        base = f'{event["phrase"]} and {image["phrase"]}'
        selected = [('event', event), ('image', image)]
    elif event:
        base = event['phrase']
        selected = [('event', event)]
    else:
        base = image['phrase']
        selected = [('image', image)]
    # Natural length requests and the existing format field are both represented;
    # many examples have neither, so plain requests stay in distribution.
    length_mode = ('none', 'field', 'natural')[seed // 100 % 10 % 3]
    length_control = None
    if length_mode == 'field':
        length_control = 'short' if length_bucket in ('very_short', 'short') else 'medium' if length_bucket == 'medium' else 'long'
    elif length_mode == 'natural':
        natural = {'very_short': 'very short', 'short': 'short', 'medium': 'medium-length', 'longer': 'longer'}[length_bucket]
        if base.startswith('write about '):
            base = f'write a {natural} piece about ' + base[len('write about '):]
        else:
            base = f'write something {natural} about {base}'
    return {'prompt': base, 'prompt_class': klass, 'length_mode': length_mode,
            'length_control': length_control,
            'prompt_evidence': {kind: item['hits'] for kind, item in selected},
            'prompt_concepts': {kind: item['phrase'] for kind, item in selected}}


def _similar(a: str, b: str) -> float:
    aa, bb = normalized(a), normalized(b)
    return difflib.SequenceMatcher(None, aa, bb, autojunk=False).ratio() if aa and bb else 0.0


def _quality(row):
    tokens = normalized(row['target'])
    tail = tokens[-1] if tokens else ''
    concept_count = len(row['prompt_evidence'])
    word_count = len(tokens)
    return (concept_count * 3 + min(word_count, 60) / 30
            + (1.2 if row['stanza_count'] == 1 else 0)
            + (0.8 if tail not in BAD_TAIL and not row['target'].rstrip().endswith(',') else -1.5)
            + (0.5 if len(row['prompt_evidence'].get('image', [])) else 0))


def _build_candidates(work, audit):
    path = ROOT / work['source_path']
    source, source_lines = source_sections(path)
    seen_sections = []
    candidates = []
    for section_index, section in enumerate(source):
        text = '\n'.join(line for _, line in section['records'] if line.strip())
        if not text:
            continue
        if any(_similar(text, old) >= .88 for old in seen_sections):
            audit['repeated_sections_skipped'] += 1
            continue
        seen_sections.append(text)
        for start, end, stanza_count in _candidate_spans(section['records']):
            lines = [line.rstrip() for line in source_lines[start - 1:end]]
            target = '\n'.join(lines)
            content = [line for line in lines if line.strip()]
            bucket = bucket_for(len(content))
            if not bucket or len(words(target)) < 9:
                continue
            if any(ANNOTATION.fullmatch(line) or re.fullmatch(r'\s*\((?:verse|chorus|bridge).*\)\s*', line, re.I) for line in content):
                audit['annotation_skipped'] += 1
                continue
            distinct = []
            for line in content:
                if not any(_similar(line, old) >= .85 for old in distinct):
                    distinct.append(line)
            if len(distinct) / len(content) < .75:
                audit['internally_repetitive_skipped'] += 1
                continue
            passage_id = f'{work["work_id"]}:{start}-{end}'
            prompt = _prompt(target, passage_id, bucket)
            if not prompt:
                audit['ungrounded_skipped'] += 1
                continue
            row = {'id': passage_id, 'work_id': work['work_id'], 'split': work['split'],
                   'source_path': work['source_path'], 'source_sha256': work['source_sha256'],
                   'source_line_start': start, 'source_line_end': end,
                   'source_line_numbers': list(range(start, end + 1)),
                   'section_index': section_index, 'section_label': section['label'],
                   'target': target, 'target_sha256': sha(target.encode()),
                   'target_line_count': len(content), 'length_bucket': bucket,
                   'stanza_count': stanza_count, **prompt}
            row['quality_score'] = round(_quality(row), 3)
            candidates.append(row)
    return candidates


def _overlaps(row, chosen):
    for old in chosen:
        if row['work_id'] != old['work_id']:
            continue
        a = set(row['source_line_numbers'])
        b = set(old['source_line_numbers'])
        if len(a & b) / min(len(a), len(b)) > .55:
            return True
        if _similar(row['target'], old['target']) >= .88:
            return True
    return False


def _select_train(by_work, audit):
    chosen = []
    counts = Counter()
    per_work = Counter()
    # First guarantee one well-grounded passage per training work.
    for work_id, candidates in sorted(by_work.items()):
        if not candidates:
            raise ValueError(f'No grounded L3 passage: {work_id}')
        best = max(candidates, key=lambda r: (r['quality_score'] + (1 if r['length_bucket'] in ('medium', 'longer') else 0), -r['source_line_start']))
        chosen.append(best)
        counts[best['length_bucket']] += 1
        per_work[work_id] += 1
    # Fill underrepresented buckets, preferring strong prompts and balanced works.
    pool = [row for rows in by_work.values() for row in rows if row not in chosen]
    # Long windows are scarce and overlap shorter windows, so reserve them first.
    for bucket in ('longer', 'medium', 'short', 'very_short'):
        pool_bucket = sorted((r for r in pool if r['length_bucket'] == bucket),
            key=lambda r: (-r['quality_score'], per_work[r['work_id']], sha(f'select:{r["id"]}'.encode())))
        for row in pool_bucket:
            if counts[bucket] >= TRAIN_TARGETS[bucket]:
                break
            if per_work[row['work_id']] >= MAX_PER_WORK or _overlaps(row, chosen):
                continue
            chosen.append(row)
            counts[bucket] += 1
            per_work[row['work_id']] += 1
    audit['quota_shortfalls'] = {b: max(0, TRAIN_TARGETS[b] - counts[b]) for b in BUCKETS}
    return sorted(chosen, key=lambda r: (r['work_id'], r['source_line_start']))


def _select_probes(by_work):
    chosen = []
    for work_id, candidates in sorted(by_work.items()):
        local = []
        for bucket in ('short', 'medium', 'very_short', 'longer'):
            matches = sorted((r for r in candidates if r['length_bucket'] == bucket),
                             key=lambda r: (-r['quality_score'], r['source_line_start']))
            for row in matches:
                if not _overlaps(row, local):
                    local.append(row)
                    break
            if len(local) >= 4:
                break
        if not local:
            raise ValueError(f'No L3 probe: {work_id}')
        chosen.extend(local)
    return sorted(chosen, key=lambda r: (r['work_id'], r['source_line_start']))


def _apply_labels(selected, audit):
    path = ROOT / 'corpus/metadata/l3_prompt_labels.json'
    if not path.exists():
        raise FileNotFoundError('L3 prompt labels missing; run build_l3 --unlabeled, then label_l3')
    metadata = json.loads(path.read_text())
    labels = metadata['labels']
    expected = {r['id'] for rows in selected.values() for r in rows}
    if set(labels) != expected:
        raise ValueError(f'L3 prompt labels do not match selected passages: missing {len(expected - set(labels))}, extra {len(set(labels) - expected)}')
    overrides_path = ROOT / 'corpus/metadata/l3_review_overrides.json'
    overrides = json.loads(overrides_path.read_text())['decisions'] if overrides_path.exists() else {}
    audit['manual_revisions'] = 0
    audit['manual_rejections'] = 0
    for split, rows in selected.items():
        kept = []
        for row in rows:
            label = labels[row['id']]
            if label['target_sha256'] != row['target_sha256'] or label['prompt_class'] != row['prompt_class']:
                raise ValueError(f'Stale L3 prompt label: {row["id"]}')
            decision = overrides.get(row['id'], {})
            if decision.get('status') == 'REJECT':
                audit['manual_rejections'] += 1
                continue
            if decision.get('status') == 'NEEDS_REVISION':
                prompt = decision['prompt']
                audit['manual_revisions'] += 1
                row['prompt_origin'] = 'manual_revision'
                row['prompt_evidence'] = {'manual': decision.get('evidence', label['evidence'])}
            else:
                if not label['evidence_valid'] or not label['class_valid']:
                    raise ValueError(f'Unreviewed invalid L3 label: {row["id"]}')
                prompt = label['prompt']
                row['prompt_origin'] = 'local_llm_label'
                row['prompt_evidence'] = {'local_llm': label['evidence']}
            if row['length_mode'] == 'natural':
                natural = {'very_short': 'very short', 'short': 'short',
                           'medium': 'medium-length', 'longer': 'longer'}[row['length_bucket']]
                if prompt.startswith('write about '):
                    prompt = f'write a {natural} piece about ' + prompt[len('write about '):]
                else:
                    prompt = f'write something {natural} about {prompt}'
            row['prompt'] = prompt
            row['prompt_concepts'] = {'label': prompt}
            row['quality_score'] = round(_quality(row), 3)
            kept.append(row)
        selected[split] = kept
    audit['label_model'] = metadata['model']
    audit['label_model_id'] = metadata['model_id']


def build(use_labels=True):
    manifest = json.loads((ROOT / 'corpus/metadata/manifest.json').read_text())
    by_split = {s: defaultdict(list) for s in ('train', 'validation', 'heldout')}
    audit = {'source_works': len(manifest), 'repeated_sections_skipped': 0,
             'internally_repetitive_skipped': 0, 'annotation_skipped': 0,
             'ungrounded_skipped': 0}
    for work in manifest:
        by_split[work['split']][work['work_id']] = _build_candidates(work, audit)
    selected = {'train': _select_train(by_split['train'], audit),
                'validation': _select_probes(by_split['validation']),
                'heldout': _select_probes(by_split['heldout'])}
    if use_labels:
        _apply_labels(selected, audit)
    for split, rows in selected.items():
        write_jsonl(ROOT / 'data/l3' / f'{split}.jsonl', rows)
    hashes = {s: sha((ROOT / 'data/l3' / f'{s}.jsonl').read_bytes()) for s in selected}
    result = {'config': {'buckets': BUCKETS, 'train_targets': TRAIN_TARGETS,
                         'max_passages_per_work': MAX_PER_WORK,
                         'section_dedup_threshold': .88,
                         'candidate_overlap_limit': .55},
              'audit': audit,
              'counts': {s: len(rows) for s, rows in selected.items()},
              'train_buckets': dict(Counter(r['length_bucket'] for r in selected['train'])),
              'train_classes': dict(Counter(r['prompt_class'] for r in selected['train'])),
              'labels_applied': use_labels,
              'hashes': hashes}
    write_json(ROOT / 'corpus/metadata/l3_dataset.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--unlabeled', action='store_true')
    args = parser.parse_args()
    print(json.dumps(build(use_labels=not args.unlabeled), indent=2))
