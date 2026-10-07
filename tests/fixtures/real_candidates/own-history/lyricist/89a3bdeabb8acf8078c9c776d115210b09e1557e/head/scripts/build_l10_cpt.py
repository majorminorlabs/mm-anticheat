"""Build a one-pass, work-split raw-CPT corpus without SFT framing."""
from __future__ import annotations

import argparse
import json
import math
import random
from collections import Counter
from pathlib import Path

from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import SECTION, parse, sha, words, write_json, write_jsonl

CONTEXT_LENGTH = 512
EFFECTIVE_BATCH = 8
SPLITS = ('train', 'validation', 'heldout')


def raw_writing(body: str) -> tuple[str, int]:
    """Remove transcript section headings, retaining every lyric and blank line."""
    lines = body.split('\n')
    kept = [line for line in lines if not SECTION.fullmatch(line)]
    text = '\n'.join(kept).strip('\n')
    if not text.strip():
        raise ValueError('A raw-CPT work became empty')
    return text, len(lines) - len(kept)


def pack_documents(documents: list[dict], context_length: int, cross_documents: bool) -> list[dict]:
    """Partition each token exactly once; EOS is already the last token of each work."""
    if context_length < 2:
        raise ValueError('Context length must include a next-token target')
    streams = []
    if cross_documents:
        streams = [[(token, doc['work_id']) for doc in documents for token in doc['input_ids']]]
    else:
        streams = [[(token, doc['work_id']) for token in doc['input_ids']] for doc in documents]
    chunks = []
    for stream in streams:
        start = 0
        while start < len(stream):
            take = min(context_length, len(stream) - start)
            if len(stream) - start - take == 1:
                take -= 1
            if take < 2:
                raise ValueError('A work is too short for causal training')
            part = stream[start:start + take]
            ids = [token for token, _ in part]
            owners = list(dict.fromkeys(owner for _, owner in part))
            chunks.append({'input_ids': ids, 'work_ids': owners})
            start += take
    if sum(len(row['input_ids']) for row in chunks) != sum(len(doc['input_ids']) for doc in documents):
        raise AssertionError('Packing lost or repeated tokens')
    return chunks


def checkpoint_steps(sequences: list[dict], effective_batch: int = EFFECTIVE_BATCH) -> list[dict]:
    steps = math.ceil(len(sequences) / effective_batch)
    if steps < 4:
        raise ValueError('The CPT corpus is too small for four distinct checkpoints')
    total = sum(len(row['input_ids']) - 1 for row in sequences)
    checkpoints = []
    for fraction in (.25, .5, .75, 1.0):
        first = (checkpoints[-1]['step'] + 1) if checkpoints else 1
        # Choose the nearest *actual token exposure*, not rounded update count.
        # With 43 chunks and effective batch 8, the final update is partial.
        step = min(range(first, steps + 1), key=lambda n: (
            abs(sum(len(r['input_ids']) - 1 for r in sequences[:n * effective_batch]) / total - fraction), n))
        used = sequences[:step * effective_batch]
        checkpoints.append({'step': step, 'target_pass': fraction,
                            'supervised_tokens_seen': sum(len(row['input_ids']) - 1 for row in used),
                            'effective_supervised_passes': round(
                                sum(len(row['input_ids']) - 1 for row in used) / total, 6)})
    if checkpoints[-1]['step'] != steps:
        raise AssertionError('Final CPT checkpoint must be exactly one corpus pass')
    return checkpoints


def microbatch_padding_fraction(sequences: list[dict], microbatch_size: int = 2) -> float:
    padded = actual = 0
    for start in range(0, len(sequences), microbatch_size):
        batch = sequences[start:start + microbatch_size]
        padded += max(len(row['input_ids']) for row in batch) * len(batch)
        actual += sum(len(row['input_ids']) for row in batch)
    return (padded - actual) / padded


def build(root: Path = ROOT, tokenizer=None) -> dict:
    if tokenizer is None:
        from transformers import AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    eos = tokenizer.eos_token_id
    if eos is None:
        raise ValueError('Pinned tokenizer has no native EOS token')
    manifest = json.loads((root / 'corpus/metadata/manifest.json').read_text())
    if len(manifest) != 106 or Counter(row['split'] for row in manifest) != {
            'train': 84, 'validation': 11, 'heldout': 11}:
        raise ValueError('Unexpected work-level split')
    documents = {split: [] for split in SPLITS}
    removed_labels = Counter()
    source_hashes = {}
    for row in sorted(manifest, key=lambda item: item['work_id']):
        source = root / row['source_path']
        parsed = parse(source)
        if (parsed['work_id'] != row['work_id'] or parsed['source_sha256'] != row['source_sha256']
                or parsed['clean_sha256'] != row['clean_sha256']):
            raise ValueError(f'Source/manifest mismatch: {row["work_id"]}')
        text, removed = raw_writing(parsed['body'])
        ids = tokenizer(text, add_special_tokens=False)['input_ids']
        if not ids or eos in ids:
            raise ValueError(f'Unexpected empty or embedded EOS: {row["work_id"]}')
        split = row['split']
        removed_labels[split] += removed
        source_hashes[row['work_id']] = {'source_sha256': row['source_sha256'],
                                         'cpt_text_sha256': sha(text.encode()),
                                         'model_tokens': len(ids)}
        documents[split].append({'work_id': row['work_id'], 'source_sha256': row['source_sha256'],
                                 'text': text, 'input_ids': ids + [eos], 'word_count': len(words(text))})
    random.Random(CONFIG['seed'] + 10).shuffle(documents['train'])
    out = root / 'data/l10'
    out.mkdir(parents=True, exist_ok=True)
    stats = {}
    for split in SPLITS:
        docs = documents[split]
        write_jsonl(out / f'raw-{split}.jsonl', [
            {key: value for key, value in doc.items() if key != 'input_ids'} for doc in docs])
        chunks = pack_documents(docs, CONTEXT_LENGTH, cross_documents=(split == 'train'))
        write_jsonl(out / f'packed-{split}.jsonl', chunks)
        eos_count = sum(row['input_ids'].count(eos) for row in chunks)
        if eos_count != len(docs):
            raise AssertionError('Each work must terminate in exactly one EOS')
        stats[split] = {'works': len(docs), 'words': sum(doc['word_count'] for doc in docs),
                        'raw_model_tokens': sum(len(doc['input_ids']) - 1 for doc in docs),
                        'tokens_with_eos': sum(len(doc['input_ids']) for doc in docs),
                        'supervised_tokens': sum(len(chunk['input_ids']) - 1 for chunk in chunks),
                        'sequences': len(chunks),
                        'document_crossing_sequences': sum(len(chunk['work_ids']) > 1 for chunk in chunks),
                        'eos_boundaries': eos_count, 'section_label_lines_removed': removed_labels[split],
                        'microbatch_padding_fraction': round(microbatch_padding_fraction(chunks), 6),
                        'raw_docs_sha256': sha((out / f'raw-{split}.jsonl').read_bytes()),
                        'packed_sha256': sha((out / f'packed-{split}.jsonl').read_bytes())}
    train_chunks = pack_documents(documents['train'], CONTEXT_LENGTH, cross_documents=True)
    schedule = checkpoint_steps(train_chunks)
    result = {'model_id': CONFIG['model_id'], 'model_revision': CONFIG['model_revision'],
              'tokenizer_eos_id': eos, 'context_length': CONTEXT_LENGTH,
              'boundary_method': 'native EOS after every complete work; packed sequences may cross works only across EOS',
              'normalization': ['UTF-8 BOM decoding, NFC, CRLF/CR to LF, line-end trailing whitespace removal and outer whitespace trim inherited from scripts.pipeline.parse',
                                'remove transcript-only bracketed section heading lines',
                                'retain original lyric lines, internal blank lines, capitalization, punctuation, and repeated sections'],
              'training_source': 'only manifest train split; validation and heldout are loss/probe inputs only',
              'train_document_order_seed': CONFIG['seed'] + 10,
              'effective_batch': EFFECTIVE_BATCH, 'peak_cpt_lr': 2e-5,
              'splits': stats, 'checkpoint_schedule': schedule,
              'max_effective_supervised_passes': 1.0,
              'source_hashes': source_hashes}
    write_json(root / 'corpus/metadata/l10_cpt_dataset.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    report = build(args.root)
    print(json.dumps({'splits': report['splits'], 'checkpoint_schedule': report['checkpoint_schedule']}, indent=2))
