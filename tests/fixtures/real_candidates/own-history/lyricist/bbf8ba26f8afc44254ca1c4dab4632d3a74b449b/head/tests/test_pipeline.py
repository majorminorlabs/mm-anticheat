import json
from pathlib import Path
from scripts.pipeline import ROOT,ANCHORS,build,parse,sections,collapse_repeated_sections,split_works
from scripts.modeling import format_prompt,CONFIG
from scripts.evaluate import score_text

def test_corpus_and_provenance():
    stats=build();manifest=json.loads((ROOT/'corpus/metadata/manifest.json').read_text())
    assert stats['unique_works']==106
    assert len(manifest)==106
    assert len({x['source_sha256'] for x in manifest})==106
    assert sum(x['style_anchor'] for x in manifest)==len(ANCHORS)
    assert all(x['split']=='train' for x in manifest if x['style_anchor'])
    assert all((ROOT/x['source_path']).exists() for x in manifest)
    assert all((ROOT/x['source_path']).read_bytes() for x in manifest)

def test_deterministic_split_and_leakage():
    works=[parse(p) for p in sorted((ROOT/'lyrics').glob('*.md'))]
    a=split_works(works,CONFIG['seed']);assert a==split_works(list(reversed(works)),CONFIG['seed'])
    ids={}
    for split in ('train','validation','heldout'):
        base='data/heldout' if split=='heldout' else 'data/sft'
        rows=[json.loads(x) for x in (ROOT/base/f'{split}.jsonl').read_text().splitlines()]
        ids[split]={r['work_id'] for r in rows}
        assert ids[split]=={k for k,v in a.items() if v==split}
    assert not(ids['train']&ids['validation'] or ids['train']&ids['heldout'] or ids['validation']&ids['heldout'])
    heldout_raw=[json.loads(x) for x in (ROOT/'data/heldout/raw.jsonl').read_text().splitlines()]
    assert {r['work_id'] for r in heldout_raw}==ids['heldout']
    assert all(r['representation']=='raw_style' and r['source_sha256'] for r in heldout_raw)

def test_sections_and_repetition():
    body='[Verse]\nA\nB\n\n[Chorus]\nC\nD\n\n[Chorus]\nC\nD'
    assert len(sections(body))==3
    assert collapse_repeated_sections(body)=='A\nB\n\nC\nD'

def test_dataset_format_and_eval_prompts():
    rows=[json.loads(x) for x in (ROOT/'data/sft/train.jsonl').read_text().splitlines()]
    assert all(x['prompt'].startswith('write about ') and x['completion'] and x['source_sha256'] for x in rows)
    prompts=json.loads((ROOT/'data/eval/prompts.json').read_text())
    assert len(prompts)==50 and len({x['id'] for x in prompts})==50
    assert not {x['prompt'] for x in prompts}&{x['prompt'] for x in rows}
    assert 'Text:\n' in format_prompt('write about rain')

def test_memorization_detector():
    train=[{'work_id':'a','text':'The crimson stair descends into a room where every window holds a mouth'}]
    copied=score_text('The crimson stair descends into a room where every window holds a mouth',train,'short')
    fresh=score_text('Quiet birds scatter beyond our garden after dark',train,'short')
    assert copied['memorization_flag'] and copied['longest_train_phrase_words']>=10
    assert not fresh['memorization_flag']

def test_model_config():
    assert CONFIG['model_id'].endswith('-Base')
    assert len(CONFIG['model_revision'])==40
    assert CONFIG['lora_rank']<=16 and CONFIG['max_sequence_length']<=1024
