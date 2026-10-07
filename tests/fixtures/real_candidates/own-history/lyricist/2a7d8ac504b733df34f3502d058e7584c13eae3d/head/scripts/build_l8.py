"""Curated, train-work-only prompt variants for the L8 constraint experiment."""
from __future__ import annotations

import json
import re
from collections import Counter

from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl

# Indexes refer to the pinned L5 train file. Every proposal is reviewed against
# its complete target; no target text is changed or included in the metadata.
LEXICAL = {
    1: 'finality', 7: 'disbelief', 20: 'rebuilding', 22: 'hiding',
    27: 'origins', 28: 'overflowing', 30: 'secrets', 32: 'trust',
    41: 'hiding', 48: 'rescue', 55: 'relationship', 59: 'language',
    62: 'public', 64: 'watched', 79: 'fragmentation', 83: 'secrets',
    87: 'relationship', 93: 'mistake', 95: 'authenticity', 102: 'value',
    110: 'actions', 114: 'appearances', 115: 'capture', 117: 'threatened',
    121: 'scared', 127: 'acknowledge', 133: 'familiar', 134: 'belonging',
    139: 'wealth', 141: 'haunted', 143: 'perception', 145: 'aftermath',
    146: 'secrets', 148: 'concealing', 150: 'connection',
    151: 'reconciliation', 161: 'purpose', 165: 'overwhelmed',
    169: 'similarities', 176: 'unable', 177: 'confidence',
    191: 'unknown', 193: 'unreal', 199: 'distance',
    201: 'expectations', 207: 'hardship', 214: 'music',
    220: 'sensation', 223: 'surrender',
}
EXCLUSION = {
    12: 'isolation', 80: 'regret', 81: 'grief', 84: 'anxiety',
    129: 'betrayal', 138: 'disillusionment', 156: 'anxiety',
    219: 'embarrassment',
}
# Each relation has direct target evidence; "required" is checked literally.
# A manual read is still needed to decide whether the proposition is supported.
RELATIONS = {
    15: ('Keep the voice inside the lock, rather than elsewhere in the room.', ['inside', 'lock']),
    29: ('Keep the moving limbs below the undertow.', ['below', 'undertow']),
    38: ('Place the pulse beneath the door, not above it.', ['under', 'door']),
    61: ('The speaker moves toward the mother after the harm to her son.', ['towards', 'mother', 'son']),
    71: ('Place the house on a pebble driveway.', ['driveway', 'house']),
    72: ('Keep the destination at a frozen creek.', ['frozen', 'creek']),
    77: ('Keep the speaker in a room with no window before the air outside becomes easier to breathe.', ['room', 'without a window', 'daylight']),
    111: ('Place the mind above words.', ['mind', 'above', 'words']),
    112: ('The hiding place should be inside other people\'s thoughts, not a physical shelter.', ['hide', 'minds']),
    157: ('Keep the speaker trapped inside the room.', ['trapped', 'room']),
    173: ('Put the ledger in the waterfall rather than beside it.', ['ledger', 'waterfall']),
    181: ('The realization happens on the way down; the decision to believe comes on the way out.', ['way down', 'way out', 'believe']),
    197: ('Keep the fragments above the sleeping giant.', ['above', 'giant']),
}

INFLECTIONS = {
    'hiding': ('hide', 'hides', 'hid', 'hidden', 'hiding'),
    'watched': ('watch', 'watches', 'watching', 'watched'),
    'threatened': ('threaten', 'threatens', 'threatening', 'threatened'),
    'scared': ('scare', 'scares', 'scaring', 'scared'),
    'acknowledge': ('acknowledge', 'acknowledges', 'acknowledged', 'acknowledging'),
    'haunted': ('haunt', 'haunts', 'haunting', 'haunted'),
    'concealing': ('conceal', 'conceals', 'concealed', 'concealing'),
    'overwhelmed': ('overwhelm', 'overwhelms', 'overwhelming', 'overwhelmed'),
    'unable': ('unable',),
    'surrender': ('surrender', 'surrenders', 'surrendered', 'surrendering'),
    'anxiety': ('anxiety', 'anxious'),
    'grief': ('grief', 'grieve', 'grieves', 'grieved', 'grieving'),
    'regret': ('regret', 'regrets', 'regretted', 'regretting'),
    'isolation': ('isolation', 'isolate', 'isolated', 'isolating'),
    'embarrassment': ('embarrassment', 'embarrass', 'embarrassed', 'embarrassing'),
    'envy': ('envy', 'envies', 'envied', 'envying'),
    'envious': ('envious', 'enviously'),
    'dread': ('dread', 'dreads', 'dreaded', 'dreading'),
    'forget': ('forget', 'forgets', 'forgetting', 'forgot', 'forgotten'),
    'forgot': ('forget', 'forgets', 'forgetting', 'forgot', 'forgotten'),
    'forgotten': ('forget', 'forgets', 'forgetting', 'forgot', 'forgotten'),
    'remorse': ('remorse', 'remorseful'),
    'jealousy': ('jealousy', 'jealous', 'jealously'),
    'jealous': ('jealousy', 'jealous', 'jealously'),
    'letter': ('letter', 'letters'),
    'gift': ('gift', 'gifts'),
    'rain': ('rain', 'rains', 'rained', 'raining'),
    'sea': ('sea', 'seas'),
    'shore': ('shore', 'shores'),
    'recognize': ('recognize', 'recognizes', 'recognized', 'recognizing', 'recognition'),
    'recognition': ('recognize', 'recognizes', 'recognized', 'recognizing', 'recognition'),
}


def forbidden_forms(term):
    if term in INFLECTIONS:
        return INFLECTIONS[term]
    stem = term[:-3] if term.endswith('ing') else term[:-1] if term.endswith('s') else term
    return tuple(dict.fromkeys((term, stem, stem + 's', stem + 'ed', stem + 'ing')))


def token_present(text, forms):
    normalized = text.casefold().replace('’', "'")
    return sorted({form for form in forms if re.search(r'(?<!\w)' + re.escape(form) + r'(?!\w)', normalized)})


def build():
    train_path = ROOT / 'data/l5/train.jsonl'
    originals = [json.loads(line) for line in train_path.read_text().splitlines()]
    valid_works = {row['work_id'] for row in originals}
    for split in ('validation', 'heldout'):
        other = [json.loads(line) for line in (ROOT / f'data/l3/{split}.jsonl').read_text().splitlines()]
        assert valid_works.isdisjoint({row['work_id'] for row in other})
    proposals, review = [], []
    for index in sorted(set(LEXICAL) | set(EXCLUSION) | set(RELATIONS)):
        row = originals[index]
        if index in LEXICAL or index in EXCLUSION:
            typ = 'lexical_prohibition' if index in LEXICAL else 'indirect_exclusion'
            term = (LEXICAL | EXCLUSION)[index]
            forms = forbidden_forms(term)
            found = token_present(row['target'], forms)
            suffix = (f'Do not use the word "{term}" or a form of it.' if typ == 'lexical_prohibition'
                      else f'Imply "{term}" without naming it or using a form of that word.')
            intended = {'forbidden_term': term, 'forbidden_forms': forms}
            automatic = {'type': 'case_insensitive_whole_word_and_inflections', 'passed': not found,
                         'matches': found}
        else:
            typ = 'spatial_relation'
            suffix, required = RELATIONS[index]
            found = [phrase for phrase in required if phrase.casefold() not in row['target'].casefold()]
            intended = {'relation': suffix, 'required_evidence': required}
            automatic = {'type': 'required_relation_evidence_phrases', 'passed': not found,
                         'missing': found, 'semantic_review_required': True}
        prompt = row['prompt'].rstrip(' .') + '. ' + suffix
        record = {'id': f"l8-{index:03d}", 'source_index': index,
                  'source_work': row['work_id'], 'source_target_id': row['id'],
                  'source_target_sha256': row['target_sha256'],
                  'original_prompt': row['prompt'], 'constraint_prompt': prompt,
                  'constraint_type': typ, 'intended_constraint': intended,
                  'automatic_validation': automatic,
                  'manual_review_status': 'PENDING', 'manual_review_note': ''}
        proposals.append(record)
        review.append({**record, 'target_for_private_review': row['target']})
    write_json(ROOT / 'corpus/metadata/l8_constraint_proposals.json', proposals)
    write_json(ROOT / 'outputs/l8-private-review.json', review)
    return proposals, originals


def finalize():
    proposals, originals = build()
    review_path = ROOT / 'corpus/metadata/l8_constraint_review.json'
    if not review_path.exists():
        print(json.dumps({'proposed': len(proposals), 'automatic_pass': sum(p['automatic_validation']['passed'] for p in proposals),
                          'types': dict(Counter(p['constraint_type'] for p in proposals))}))
        return
    decisions = {row['id']: row for row in json.loads(review_path.read_text())['decisions']}
    if set(decisions) != {p['id'] for p in proposals}:
        raise ValueError('Every proposed example needs a review decision')
    final = []
    for p in proposals:
        decision = decisions[p['id']]
        status = decision['status']
        if status not in ('GOOD', 'REVISE', 'REJECT'):
            raise ValueError(f"Invalid review status {status}")
        if status == 'REJECT' or not p['automatic_validation']['passed']:
            continue
        if status == 'REVISE':
            p['constraint_prompt'] = decision['revised_prompt']
        p['manual_review_status'] = status
        p['manual_review_note'] = decision['note']
        row = dict(originals[p['source_index']])
        row['id'] = p['id']
        row['prompt'] = p['constraint_prompt']
        row['prompt_origin'] = 'l8_train_constraint_variant'
        row['constraint_type'] = p['constraint_type']
        assert row['target_sha256'] == p['source_target_sha256']
        final.append(row)
    write_jsonl(ROOT / 'data/l8/constraints.jsonl', final)
    write_json(ROOT / 'corpus/metadata/l8_constraint_final.json',
               [{key: p[key] for key in ('id', 'source_index', 'source_work', 'source_target_id',
                                          'source_target_sha256', 'original_prompt', 'constraint_prompt',
                                          'constraint_type', 'intended_constraint', 'automatic_validation',
                                          'manual_review_status', 'manual_review_note')}
                for p in proposals if p['manual_review_status'] in ('GOOD', 'REVISE')])
    write_json(ROOT / 'corpus/metadata/l8_constraint_dataset.json', {
        'l5_train_sha256': sha((ROOT / 'data/l5/train.jsonl').read_bytes()),
        'constraint_rows_sha256': sha((ROOT / 'data/l8/constraints.jsonl').read_bytes()),
        'proposed': len(proposals), 'final': len(final),
        'by_type': dict(Counter(row['constraint_type'] for row in final)),
        'review': dict(Counter(x['status'] for x in decisions.values())),
        'train_work_overlap_only': True, 'target_text_changed': False,
        'review_scope': 'all proposals, internal manual review',
    })
    print(json.dumps({'proposed': len(proposals), 'final': len(final),
                      'types': dict(Counter(row['constraint_type'] for row in final))}))


if __name__ == '__main__':
    finalize()
