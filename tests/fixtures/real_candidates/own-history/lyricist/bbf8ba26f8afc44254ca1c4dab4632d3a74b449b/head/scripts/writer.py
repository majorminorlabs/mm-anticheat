"""Local text-only writer CLI."""
from __future__ import annotations
import argparse
import subprocess
from pathlib import Path
from scripts.modeling import ROOT,LENGTH_TOKENS,format_prompt,generate,load_model

def generate_gguf(model_path,request,length,mood,form,temperature,seed):
    cmd=['llama-completion','--model',str(model_path),'--prompt',format_prompt(request,length,mood,form),
         '--n-predict',str(LENGTH_TOKENS[length]),'--temp',str(temperature),'--top-p','0.92',
         '--repeat-penalty','1.08','--seed',str(seed),'--gpu-layers','99',
         '--no-conversation','--no-display-prompt','--color','off']
    result=subprocess.run(cmd,text=True,capture_output=True,check=True)
    output=result.stdout.strip()
    if output and output[-1].isalnum() and '\n\n' in output:
        last=max(output.rfind(mark) for mark in '.!?')
        if last>len(output)*0.45: output=output[:last+1]
    return output

def main(argv=None):
    p=argparse.ArgumentParser(prog='writer')
    p.add_argument('request');p.add_argument('--adapter',default=str(ROOT/'models/best'))
    p.add_argument('--model',default=str(ROOT/'models/best.gguf'))
    p.add_argument('--length',choices=('short','medium','long'),default='medium')
    p.add_argument('--mood');p.add_argument('--form');p.add_argument('--samples',type=int,default=1)
    p.add_argument('--temperature',type=float,default=0.85);p.add_argument('--seed',type=int,default=0)
    a=p.parse_args(argv)
    if a.samples<1: p.error('--samples must be positive')
    if not 0<a.temperature<=2: p.error('--temperature must be in (0, 2]')
    gguf=Path(a.model)
    if not gguf.exists(): tok,model=load_model(a.adapter)
    for i in range(a.samples):
        if i: print('\n---\n')
        if gguf.exists(): print(generate_gguf(gguf,a.request,a.length,a.mood,a.form,a.temperature,a.seed+i))
        else: print(generate(tok,model,a.request,a.length,a.mood,a.form,a.temperature,a.seed+i))
if __name__=='__main__':main()
