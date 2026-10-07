"""Transparent diagnostics for fixed-prompt output shape; lexical hits are only hints."""
from __future__ import annotations
import argparse,json,re,statistics
from collections import Counter
from pathlib import Path
from scripts.evaluate import norm_words
from scripts.pipeline import write_json

STOP={'write','about','something','short','long','medium','the','a','an','and','or','to','from','in','on','at','of','with','without','your','you','someone','somewhere','that','this','it','its','after','before','who','how','what','when','where','use','single','stanza','verse','chorus','refrain','feeling','feel','being','unable','not','no','one'}
GENERIC=('there was','it was','i remember','i don’t know','i don\'t know','in my life','once upon','a long time','the world','the sun','the air','the darkness')
META=('no dialogue','make it feel','the first part of the refrain','write a poem','here is','i will write','as an ai')

def content_lines(text):return [x.strip() for x in text.splitlines() if x.strip()]
def meaningful_words(prompt):
    return {w for w in norm_words(prompt) if len(w)>=4 and w not in STOP}
def analyze_row(row):
    out=row['output'];lines=content_lines(out);lengths=[len(norm_words(x)) for x in lines]
    words=norm_words(out);key=meaningful_words(row['prompt']);hits=key&set(words)
    explicit_form=bool(row.get('form'))
    return {'id':row['id'],'line_count':len(lines),'mean_line_words':round(statistics.mean(lengths),2) if lengths else 0,
      'long_line_count':sum(n>25 for n in lengths),'prose_like':len(lines)<=3 or (statistics.mean(lengths)>20 if lengths else False),
      'prompt_terms':sorted(key),'prompt_term_hits':sorted(hits),'no_prompt_term_hit':bool(key) and not hits,
      'generic_phrase_hits':sum(out.casefold().count(g) for g in GENERIC),
      'unexpected_section_label':not explicit_form and bool(re.search(r'(?im)^\s*(?:verse|chorus|bridge)(?:\s*\d+)?\s*:',out)),
      'meta_instruction_hit':any(m in out.casefold() for m in META),
      'unfinished_tail':bool(out) and out.rstrip()[-1].isalnum(),
      'duplicate_lines':sum(n-1 for n in Counter(x.casefold() for x in lines).values() if n>1)}

def analyze(path):
    rows=[json.loads(x) for x in Path(path).read_text().splitlines()]
    measures=[analyze_row(r) for r in rows]
    return {'count':len(rows),'prose_like':sum(x['prose_like'] for x in measures),
      'mean_content_lines':round(statistics.mean(x['line_count'] for x in measures),2),
      'mean_line_words':round(statistics.mean(x['mean_line_words'] for x in measures),2),
      'outputs_with_long_line':sum(x['long_line_count']>0 for x in measures),
      'no_prompt_term_hit':sum(x['no_prompt_term_hit'] for x in measures),
      'generic_phrase_hits':sum(x['generic_phrase_hits'] for x in measures),
      'unexpected_section_labels':sum(x['unexpected_section_label'] for x in measures),
      'meta_instruction_hits':sum(x['meta_instruction_hit'] for x in measures),
      'unfinished_tails':sum(x['unfinished_tail'] for x in measures),
      'duplicate_lines':sum(x['duplicate_lines'] for x in measures),
      'flagged_ids':{k:[x['id'] for x in measures if x[k]] for k in ('prose_like','no_prompt_term_hit','meta_instruction_hit','unfinished_tail')},
      'per_prompt':measures}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--b0',required=True);p.add_argument('--l1',required=True);p.add_argument('--out',required=True);a=p.parse_args()
    result={'B0':analyze(a.b0),'L1':analyze(a.l1)}
    write_json(Path(a.out),result)
    for name,x in result.items(): print(name,{k:v for k,v in x.items() if k not in ('flagged_ids','per_prompt')})
