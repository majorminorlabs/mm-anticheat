"""Comparable B0/L1/L2 output-shape diagnostics on the frozen 50 prompts."""
import argparse,json,statistics
from pathlib import Path
from scripts.analyze_outputs import analyze,content_lines
from scripts.evaluate import norm_words
from scripts.modeling import CONFIG
from scripts.pipeline import write_json

def quantiles(vals):
    vals=sorted(vals)
    return {'min':vals[0],'median':statistics.median(vals),'p90':vals[int(.9*(len(vals)-1))],'max':vals[-1]}
def summarize(path,tokenizer=None):
    x=analyze(path)
    rows=[json.loads(s) for s in Path(path).read_text().splitlines()]
    all_lengths=[len(norm_words(line)) for r in rows for line in content_lines(r['output'])]
    x['line_length_distribution_words']=quantiles(all_lengths)
    x['output_word_distribution']=quantiles([len(norm_words(r['output'])) for r in rows])
    x['output_token_distribution']=quantiles([len(tokenizer(r['output'],add_special_tokens=False)['input_ids']) for r in rows]) if tokenizer else None
    return x

def main():
    p=argparse.ArgumentParser();p.add_argument('--b0',required=True);p.add_argument('--l1',required=True);p.add_argument('--l2',required=True);p.add_argument('--out',required=True);p.add_argument('--tokenizer',action='store_true');a=p.parse_args()
    tok=None
    if a.tokenizer:
        from transformers import AutoTokenizer
        tok=AutoTokenizer.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision'])
    result={'B0':summarize(a.b0,tok),'L1':summarize(a.l1,tok),'L2':summarize(a.l2,tok)}
    write_json(Path(a.out),result)
    for name,x in result.items():print(name,{k:v for k,v in x.items() if k not in ('flagged_ids','per_prompt')})
if __name__=='__main__':main()
