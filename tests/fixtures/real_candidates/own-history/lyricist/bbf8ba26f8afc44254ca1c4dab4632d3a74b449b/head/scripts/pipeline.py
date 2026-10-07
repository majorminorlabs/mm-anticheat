"""Deterministic, work-level corpus preparation; the source Markdown is never edited."""
from __future__ import annotations
import hashlib, json, re, unicodedata
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'lyrics'
ANCHORS = {'translating-the-name','they-perched-on-their-stilts','always-getting-what-you-want','house-of-leaves','the-difference-between-medicine-and-poison-is-in-the-dose','holding-someones-hair-back','kicking-your-crosses-down','in-fear-and-faith','were-all-thieves'}
WORD = re.compile(r"\b[\w]+(?:[’'][\w]+)*\b", re.UNICODE)
SECTION = re.compile(r'^\s*\[([^\]]+)\]\s*$')


def sha(data: bytes) -> str: return hashlib.sha256(data).hexdigest()
def words(text: str) -> list[str]: return WORD.findall(text)
def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n')
def write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(json.dumps(x, ensure_ascii=False, sort_keys=True) + '\n' for x in rows))


def parse(path: Path) -> dict:
    raw = path.read_bytes()
    text = raw.decode('utf-8-sig')
    m = re.fullmatch(r'# ([^\n]+)\n\nArtist: ([^\n]+)\n\n## Lyrics\n\n```text\n(.*?)\n```(?:\n\n(Note: .*?))?\s*', text, re.S)
    if not m: raise ValueError(f'Unexpected Markdown wrapper: {path}')
    title, artist, body, source_note = m.groups()
    body = unicodedata.normalize('NFC', body).replace('\r\n','\n').replace('\r','\n')
    body = '\n'.join(line.rstrip() for line in body.split('\n')).strip()
    lines = body.splitlines()
    lyric_lines = [line for line in lines if line.strip() and not SECTION.fullmatch(line)]
    labels = [SECTION.fullmatch(line).group(1) for line in lines if SECTION.fullmatch(line)]
    counts = Counter(unicodedata.normalize('NFC', line.strip()).casefold() for line in lyric_lines)
    repeated = sum(n-1 for n in counts.values() if n>1)
    section_texts = [s['text'].casefold() for s in sections(body)]
    section_counts = Counter(section_texts)
    repeated_sections = sum(n-1 for n in section_counts.values() if n>1)
    slug = path.stem.removeprefix('circa-survive-').removeprefix('saosin-')
    return {'work_id': path.stem, 'title': title, 'artist': artist, 'source_path': str(path.relative_to(ROOT)),
        'source_sha256': sha(raw), 'clean_sha256': sha(body.encode()), 'style_anchor': slug in ANCHORS,
        'body': body, 'source_note': source_note, 'word_count': len(words('\n'.join(lyric_lines))), 'line_count': len(lyric_lines),
        'repeated_line_count': repeated, 'section_count': len(section_texts),
        'repeated_section_count': repeated_sections, 'section_labels': labels}


def sections(body: str) -> list[dict]:
    result=[]; current=[]; label=None
    def flush():
        if current: result.append({'label':label, 'text':'\n'.join(current).strip()})
    for line in body.splitlines():
        hit=SECTION.fullmatch(line)
        if hit:
            flush(); current=[]; label=hit.group(1)
        else: current.append(line)
    flush()
    return [s for s in result if s['text']]


def collapse_repeated_sections(body: str) -> str:
    """Retain first occurrence of exact repeated section; preserve local line repetition."""
    seen=set(); out=[]
    for s in sections(body):
        key='\n'.join(x.strip().casefold() for x in s['text'].splitlines()).strip()
        if key in seen: continue
        seen.add(key); out.append(s['text'])
    return '\n\n'.join(out)


def split_works(works: list[dict], seed: int) -> dict[str,str]:
    anchored=[w for w in works if w['style_anchor']]
    other=[w for w in works if not w['style_anchor']]
    other.sort(key=lambda w: sha(f"{seed}:{w['work_id']}".encode()))
    n=len(works); validation=max(1,round(n*0.1)); heldout=max(1,round(n*0.1))
    assign={w['work_id']:'train' for w in anchored}
    for i,w in enumerate(other): assign[w['work_id']] = 'validation' if i<validation else 'heldout' if i<validation+heldout else 'train'
    return assign


def request_for(work:dict) -> str:
    subject=work['title'].strip().rstrip('.?!').lower()
    return f'write about {subject}'


def build(root:Path=ROOT):
    config=json.loads((root/'config/experiment.json').read_text())
    paths=sorted(p for p in (root/'lyrics').glob('*.md') if not p.name.startswith('._'))
    works=[parse(p) for p in paths]
    if len({w['source_sha256'] for w in works}) != len(works): raise ValueError('Exact duplicate source file')
    if len({w['clean_sha256'] for w in works}) != len(works): raise ValueError('Exact duplicate work body')
    anchors={w['work_id'].removeprefix('circa-survive-').removeprefix('saosin-') for w in works if w['style_anchor']}
    if anchors!=ANCHORS: raise ValueError(f'Style anchors missing: {ANCHORS-anchors}')
    assignments=split_works(works,config['seed'])
    manifest=[]; raw_rows={s:[] for s in ('train','validation','heldout')}; sft_rows={s:[] for s in raw_rows}
    for w in works:
        split=assignments[w['work_id']]
        clean=collapse_repeated_sections(w['body'])
        (root/'corpus/cleaned').mkdir(parents=True,exist_ok=True)
        (root/'corpus/cleaned'/f"{w['work_id']}.txt").write_text(w['body']+'\n')
        provenance={'work_id':w['work_id'],'source_path':w['source_path'],'source_sha256':w['source_sha256'],'clean_sha256':w['clean_sha256']}
        raw_rows[split].append({**provenance,'representation':'raw_style','text':clean})
        sft_rows[split].append({**provenance,'representation':'generation','prompt':request_for(w),'completion':clean})
        manifest.append({k:v for k,v in w.items() if k!='body'} | {'split':split,'training_text_sha256':sha(clean.encode()),'training_word_count':len(words(clean))})
    for split in raw_rows:
        base='data/heldout' if split=='heldout' else 'data/pretrain'
        raw_name='raw.jsonl' if split=='heldout' else f'{split}.jsonl'
        write_jsonl(root/base/raw_name, raw_rows[split])
        base='data/heldout' if split=='heldout' else 'data/sft'
        write_jsonl(root/base/f'{split}.jsonl', sft_rows[split])
    stats={'source_files':len(works),'unique_works':len(works),'lyric_words':sum(w['word_count'] for w in works),
      'content_lines':sum(w['line_count'] for w in works),'repeated_line_occurrences':sum(w['repeated_line_count'] for w in works),
      'repeated_section_occurrences':sum(w['repeated_section_count'] for w in works),
      'style_anchors':sum(w['style_anchor'] for w in works),'split_counts':dict(Counter(assignments.values())),
      'training_words_after_section_dedup':sum(len(words(r['text'])) for r in raw_rows['train']),
      'source_tree_sha256':sha(''.join(w['source_sha256'] for w in works).encode())}
    write_json(root/'corpus/metadata/manifest.json',manifest)
    write_json(root/'corpus/metadata/stats.json',stats)
    write_json(root/'corpus/metadata/dataset_hashes.json',{str(p.relative_to(root)):sha(p.read_bytes()) for p in sorted((root/'data').rglob('*.jsonl'))})
    return stats

if __name__=='__main__': print(json.dumps(build(),indent=2))
