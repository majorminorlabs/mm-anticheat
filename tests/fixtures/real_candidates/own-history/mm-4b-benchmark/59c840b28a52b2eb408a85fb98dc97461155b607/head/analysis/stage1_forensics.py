"""Generate read-only forensic evidence from the preserved Stage 1 batch."""
import json, re
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "runs/raw/stage1-first-round"

def meminfo(text):
    m = {}
    for line in text.splitlines():
        k, v = line.split(":", 1); m[k] = int(v.strip().split()[0])
    return {"available_gib": m["MemAvailable"] / 1048576, "swap_used_gib": (m["SwapTotal"] - m["SwapFree"]) / 1048576}

def output_body(text):
    return text.split("> EOF by user", 1)[0].split("\n", 1)[-1][-2400:]

def template(text):
    m = re.search(r"chat template example:\n(.*?)(?:\n0\.)", text, re.S)
    return m.group(1) if m else None

def classify(text, parse_error):
    if "no_valid_calls_json" not in parse_error: return "H:shared_parser_rejected_complete_envelope"
    if '"calls"' in text and text.find("> EOF by user") >= 0: return "C/G:malformed_or_truncated_call_envelope"
    return "D:prose_or_no_tool_syntax"

def main():
    rows=[]
    for p in sorted(RAW.glob("R*/attempt-001.parsed.json")):
        x=json.loads(p.read_text()); run=p.parent.name; text=(p.parent/"attempt-001.stdout.log").read_text(errors="replace"); cmd=json.loads((p.parent/"attempt-001.command.json").read_text())
        rows.append({"run_id":run,"model":x["model"],"task":x["task"],"command":cmd,"prompt":cmd["argv"][-1],"chat_template_example":template(text),"raw_model_output_tail":output_body(text),"old_parser_error":x["parse_error"],"classification":classify(text,x["parse_error"]),"resource_before":meminfo(x["meminfo_before"])})
    out=ROOT/"runs/processed/stage1-forensics.json"; out.write_text(json.dumps({"batch_commit":"dc03660","runs":rows},indent=2,sort_keys=True)+"\n"); print(out)
if __name__ == "__main__": main()
