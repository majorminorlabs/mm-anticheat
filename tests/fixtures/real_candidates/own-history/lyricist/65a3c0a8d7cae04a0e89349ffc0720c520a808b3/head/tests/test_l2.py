import json
from collections import Counter
from scripts.build_l2 import build,prompt_for,source_sections
from scripts.modeling import ROOT
from scripts.qa_l2 import longest_overlap,load
from scripts.pipeline import sha

def test_l2_deterministic_work_boundaries_and_provenance():
    first=build();second=build()
    assert first['hashes']==second['hashes']
    manifest={x['work_id']:x for x in json.loads((ROOT/'corpus/metadata/manifest.json').read_text())}
    train=load('train');validation=load('validation');heldout=load('heldout')
    assert {x['work_id'] for x in train}=={w for w,m in manifest.items() if m['split']=='train'}
    assert not ({x['work_id'] for x in train}&{x['work_id'] for x in validation+heldout})
    assert len({x['id'] for x in train+validation+heldout})==len(train+validation+heldout)
    for row in train+validation+heldout:
        source=(ROOT/row['source_path']).read_text(encoding='utf-8-sig').splitlines()
        assert row['target'].splitlines()==[source[n-1] for n in row['source_line_numbers']]
        assert sha(row['target'].encode())==row['target_sha256']
        assert 2<=row['target_line_count']<=8
        assert longest_overlap(row['prompt'],row['target'])<4

def test_l2_prompt_classes_and_grounding():
    rows=load('train');classes=Counter(x['prompt_class'] for x in rows)
    assert .6 <= classes['descriptive']/len(rows) <= .7
    assert .3 <= classes['sparse']/len(rows) <= .4
    assert all(x['prompt'] and x['target'] and x['source_line_start']<=x['source_line_end'] for x in rows)
    prompt,klass,tags,evidence=prompt_for('sample:1-2','Rain in a room, your hand at the door')
    assert tags and all(evidence.values())
    assert prompt and klass in ('descriptive','sparse')
