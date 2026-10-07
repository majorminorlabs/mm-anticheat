"""Build the reviewed, train-only L9 auxiliary prompt set without changing targets."""
from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter

from scripts.l9_candidates import PROPOSALS, REJECTED, RELATION_MARKERS, REVISIONS
from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl


FORMS = {
    'rebuilding': ('rebuild', 'rebuilds', 'rebuilt', 'rebuilding'),
    'origins': ('origin', 'origins'),
    'secrets': ('secret', 'secrets', 'secrecy'),
    'rescue': ('rescue', 'rescues', 'rescued', 'rescuing'),
    'relationship': ('relationship', 'relationships'),
    'fragmentation': ('fragment', 'fragments', 'fragmented', 'fragmenting', 'fragmentation'),
    'mistake': ('mistake', 'mistakes', 'mistaken'),
    'value': ('value', 'values', 'valued', 'valuing'),
    'capture': ('capture', 'captures', 'captured', 'capturing'),
    'acknowledge': ('acknowledge', 'acknowledges', 'acknowledged', 'acknowledging'),
    'belonging': ('belong', 'belongs', 'belonged', 'belonging'),
    'perception': ('perception', 'perceptions', 'perceive', 'perceived', 'perceiving'),
    'overwhelmed': ('overwhelm', 'overwhelms', 'overwhelmed', 'overwhelming'),
    'unknown': ('unknown',),
    'music': ('music', 'musical'),
    'fear': ('fear', 'fears', 'feared', 'fearful', 'afraid', 'scared', 'frightened'),
    'abandonment': ('abandonment', 'abandon', 'abandons', 'abandoned', 'abandoning'),
    'separation': ('separation', 'separate', 'separated', 'separating'),
    'defeat': ('defeat', 'defeats', 'defeated', 'defeating'),
    'crime': ('crime', 'crimes', 'criminal'),
    'regret': ('regret', 'regrets', 'regretted', 'regretting'),
    'grief': ('grief', 'grieve', 'grieved', 'grieving'),
    'anxiety': ('anxiety', 'anxious'),
    'longing': ('longing', 'yearning'),
    'devotion': ('devotion', 'devoted'),
    'betrayal': ('betrayal', 'betray', 'betrays', 'betrayed', 'betraying'),
    'rebellion': ('rebellion', 'rebel', 'rebels', 'rebelling'),
    'loneliness': ('loneliness', 'lonely', 'alone'),
    'breakup': ('breakup', 'break-up', 'break up', 'broke up'),
    'disillusionment': ('disillusionment', 'disillusioned'),
    'obsession': ('obsession', 'obsess', 'obsessed', 'obsessive'),
    'resentment': ('resentment', 'resentful'),
    'dependence': ('dependence', 'dependent', 'depend'),
    'reconciliation': ('reconciliation', 'reconcile', 'reconciled'),
    'lost': ('lost', 'losing'),
    'avoidance': ('avoidance', 'avoid', 'avoiding'),
    'disappointment': ('disappointment', 'disappointed', 'disappointing'),
    'hopelessness': ('hopelessness', 'hopeless'),
    'danger': ('danger', 'dangerous'),
    'water': ('water', 'waters'),
    'insomnia': ('insomnia', 'insomniac'),
    'nostalgia': ('nostalgia', 'nostalgic'),
    'guilt': ('guilt', 'guilty'),
    'heartbreak': ('heartbreak', 'heartbroken'),
    'isolation': ('isolation', 'isolated', 'isolate'),
    'shame': ('shame', 'ashamed', 'shameful'),
    'writers_block': ("writer's block", 'writers block'),
    'blindness': ('blindness', 'blind'),
    'jealousy': ('jealousy', 'jealous', 'jealously'),
}


def normalize(text):
    return unicodedata.normalize('NFKC', text).casefold().replace('’', "'")


def token_present(text, forms):
    normalized = normalize(text)
    return sorted({form for form in forms if re.search(r'(?<!\w)' + re.escape(normalize(form)) + r'(?!\w)', normalized)})


def shared_phrase_words(prompt, target):
    a, b = [re.findall(r"[\w']+", normalize(x)) for x in (prompt, target)]
    lookup = {tuple(b[i:i + n]) for n in range(1, min(12, len(b)) + 1)
              for i in range(len(b) - n + 1)}
    return max((n for n in range(1, min(12, len(a)) + 1)
                for i in range(len(a) - n + 1) if tuple(a[i:i + n]) in lookup), default=0)


def intended_constraint(spec):
    logic, kind = spec['logic'], spec['constraint_type']
    if kind == 'mixed':
        relation, concept = [part.strip() for part in logic.split(';', 1)]
    elif kind == 'spatial_relation':
        relation, concept = logic, None
    else:
        relation, concept = None, logic
    out = {}
    if relation:
        subject, predicate, obj = [part.strip() for part in relation.split('>')]
        out['relation'] = {'subject': subject, 'predicate': predicate, 'object': obj}
    if concept:
        out['excluded_concept' if kind != 'lexical_prohibition' else 'forbidden_term'] = concept
        out['forbidden_forms'] = FORMS.get(concept, (concept,))
    return out


def build():
    train_path = ROOT / 'data/l5/train.jsonl'
    train = [json.loads(line) for line in train_path.read_text().splitlines()]
    outside = {row['work_id'] for split in ('validation', 'heldout')
               for row in (json.loads(line) for line in (ROOT / f'data/l3/{split}.jsonl').read_text().splitlines())}
    assert {row['work_id'] for row in train}.isdisjoint(outside)
    eval_prompts = {row['prompt'] for row in json.loads((ROOT / 'data/eval/prompts.json').read_text())}
    novel_prompts = {row['prompt'] for row in json.loads((ROOT / 'corpus/metadata/l8_novel_prompts.json').read_text())}
    proposals, decisions, final_meta, derived, private_review = [], [], [], [], []
    rejected_indices = {row['source_index'] for row in REJECTED}
    for spec in sorted(PROPOSALS, key=lambda r: r['source_index']):
        index = spec['source_index']
        source = train[index]
        assert source['work_id'] not in outside
        initial_prompt = REVISIONS.get(index, (spec['constraint_prompt'],))[0]
        final_prompt = REVISIONS.get(index, (None, spec['constraint_prompt']))[1]
        constraint = intended_constraint(spec)
        forms = constraint.get('forbidden_forms', ())
        found = token_present(source['target'], forms)
        markers = RELATION_MARKERS.get(index, [])
        missing = [marker for marker in markers if normalize(marker) not in normalize(source['target'])]
        overlap = shared_phrase_words(final_prompt, source['target'])
        automatic = {'lexical_forms_absent': not found, 'found_forbidden_forms': found,
                     'relation_markers_present': not missing if markers else None,
                     'missing_relation_markers': missing,
                     'semantic_relation_review_required': bool(markers),
                     'prompt_target_longest_shared_phrase_words': overlap,
                     'prompt_differs_from_fixed_and_novel_eval':
                         final_prompt not in eval_prompts | novel_prompts}
        base = {'id': f'l9-{index:03d}', 'source_index': index,
                'source_work': source['work_id'], 'source_target_id': source['id'],
                'source_target_sha256': source['target_sha256'],
                'source_path': source['source_path'],
                'source_line_numbers': source['source_line_numbers'],
                'original_prompt': source['prompt'], 'proposed_constraint_prompt': initial_prompt,
                'constraint_type': spec['constraint_type'], 'intended_constraint': constraint,
                'evidence_summary': spec['evidence_summary'],
                'possible_ambiguity': spec['possible_ambiguity'],
                'automatic_validation': automatic,
                'origin_prompt_class': source['prompt_class'],
                'target_length_bucket': source['length_bucket']}
        proposals.append({**base, 'manual_review_status': 'PENDING'})
        private_review.append({**base, 'target_for_private_review': source['target']})
        if index in rejected_indices:
            status, note = 'REJECT', spec['rejection_reason']
        elif index in REVISIONS:
            status, note = 'REVISE', REVISIONS[index][2]
        else:
            status, note = 'GOOD', 'Full target read; adverse interpretation considered and not material.'
        decision = {'id': base['id'], 'status': status, 'note': note,
                    'another_reasonable_reader_could_find_violation': status == 'REJECT'}
        if status == 'REVISE':
            decision['revised_prompt'] = final_prompt
        decisions.append(decision)
        if status == 'REJECT':
            continue
        if found or missing or not automatic['prompt_differs_from_fixed_and_novel_eval']:
            raise ValueError(f'Approved proposal failed an automatic check: {base["id"]}: {automatic}')
        meta = {**base, 'constraint_prompt': final_prompt,
                'manual_review_status': status, 'manual_review_note': note,
                'another_reasonable_reader_could_find_violation': False}
        final_meta.append(meta)
        row = dict(source)
        row.update({'id': base['id'], 'prompt': final_prompt,
                    'prompt_origin': 'l9_train_constraint_variant',
                    'constraint_type': spec['constraint_type']})
        assert row['target'] == source['target'] and row['target_sha256'] == source['target_sha256']
        derived.append(row)
    if len({row['source_target_id'] for row in final_meta}) != len(final_meta):
        raise ValueError('A target received multiple L9 variants')
    if max(Counter(row['source_work'] for row in final_meta).values()) > 3:
        raise ValueError('Too many variants from one work')
    write_json(ROOT / 'corpus/metadata/l9_constraint_proposals.json', proposals)
    write_json(ROOT / 'corpus/metadata/l9_constraint_review.json', {'review_type': 'internal full-target adversarial read',
                                                                     'decisions': decisions})
    write_json(ROOT / 'corpus/metadata/l9_constraint_final.json', final_meta)
    write_json(ROOT / 'outputs/l9-private-review.json', private_review)
    write_jsonl(ROOT / 'data/l9/constraints.jsonl', derived)
    summary = {'proposed': len(proposals), 'final': len(derived),
               'review_counts': dict(Counter(d['status'] for d in decisions)),
               'class_counts': dict(Counter(r['constraint_type'] for r in final_meta)),
               'source_work_coverage': len({r['source_work'] for r in final_meta}),
               'max_variants_per_target': 1,
               'max_variants_per_work': max(Counter(r['source_work'] for r in final_meta).values()),
               'base_train_sha256': sha(train_path.read_bytes()),
               'constraint_rows_sha256': sha((ROOT / 'data/l9/constraints.jsonl').read_bytes()),
               'target_text_changed': False,
               'review_limit': 'Internal manual semantic review; no independent human ratings.'}
    write_json(ROOT / 'corpus/metadata/l9_constraint_dataset.json', summary)
    return summary


if __name__ == '__main__':
    print(json.dumps(build(), indent=2))
