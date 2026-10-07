"""Check L11's source-only scoring and unchanged L6 training boundary."""
import json

from scripts.blind_quality_l11 import PAIRS, RATING_INSTRUCTIONS
from scripts.build_l11 import eligible
from scripts.pipeline import sha, write_jsonl
from scripts.score_l11_targets import build as build_score_packet
from scripts.train_l6 import L6
from scripts.train_l11 import L11


def test_source_only_scoring_packet_is_train_only(tmp_path, monkeypatch):
    monkeypatch.setattr('scripts.score_l11_targets.ROOT', tmp_path)
    (tmp_path/'data/l5').mkdir(parents=True)
    (tmp_path/'L11_RUBRIC.md').write_text('frozen test rubric')
    original = [{'id': f'id-{i}', 'target': f'private passage {i}',
                 'target_sha256': sha(f'private passage {i}'.encode())} for i in range(224)]
    write_jsonl(tmp_path/'data/l5/train.jsonl', original)
    write_jsonl(tmp_path/'audit.jsonl', [{'id': row['id']} for row in original])
    build_score_packet(tmp_path)
    packet = [json.loads(line) for line in (tmp_path/'blind_packet.jsonl').read_text().splitlines()]
    assert len(packet) == len(original) == 224
    assert all(set(item) == {'label', 'text'} for item in packet)
    assert {sha(item['text'].encode()) for item in packet} == {row['target_sha256'] for row in original}


def test_selection_rejects_incomplete_or_prose_candidate():
    item = {'composite': 12, 'scores': dict(zip('ABCDEFGHI', [3, 3, 3, 3, 3, 3, 0, 0, 0])),
            'audit': {'natural_source_end_boundary_proxy': True, 'dangling_terminal_proxy': False}}
    assert eligible(item, 12)
    item['scores']['A'] = 1
    assert not eligible(item, 12)
    item['scores']['A'] = 3
    item['scores']['G'] = 3
    assert not eligible(item, 12)
    item['scores']['G'] = 0
    item['audit']['natural_source_end_boundary_proxy'] = False
    assert not eligible(item, 12)


def test_l11_keeps_l6_core_recipe_and_l7_output_rubric():
    assert {k: v for k, v in L11.items() if k != 'checkpoints'} == \
           {k: v for k, v in L6.items() if k != 'checkpoints'}
    assert L11['checkpoints'] == [15, 25, 35, 40, 50]
    assert len(PAIRS) == 4 and all(pair[1] == 'L11' for pair in PAIRS)
    assert 'overall CREATIVE quality' in RATING_INSTRUCTIONS
