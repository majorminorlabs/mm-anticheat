"""Apply only the frozen simulator and scorer to preserved first-round runs."""
import json, re, sys
from collections import defaultdict
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from simulator import Simulator
from scoring import score_run

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "runs/raw/stage1-first-round"
SCHEDULE = json.loads((ROOT / "protocol/stage1-first-round-schedule.json").read_text())
FIXTURES = {x["id"]: x for x in json.loads((ROOT / "tasks/fixtures.json").read_text())["tasks"]}

def perf(text):
    out = {}
    for label, key in [("prompt eval time", "prompt_eval_ms"), ("eval time", "eval_ms"), ("total time", "total_ms")]:
        m = re.search(rf"{re.escape(label)}\s*=\s*([0-9.]+) ms", text)
        if m: out[key] = float(m.group(1))
    return out

def main():
    rows = []
    for item in SCHEDULE["runs"]:
        run = json.loads((RAW / item["run_id"] / "attempt-001.parsed.json").read_text())
        fixture = FIXTURES[item["task"]]
        sim = Simulator(fixture)
        for call in run.get("calls", []):
            if isinstance(call, dict) and isinstance(call.get("tool"), str):
                sim.call(call["tool"], call.get("arguments") or {})
        sim.finish("model_output_parse_failure" if run.get("parse_error") else "model_plan_complete")
        scored = score_run(fixture, sim.events)
        stdout = (RAW / item["run_id"] / "attempt-001.stdout.log").read_text(errors="replace")
        rows.append({**item, **scored, "elapsed_s": run.get("elapsed_s"), "parse_error": run.get("parse_error"), "perf": perf(stdout)})
    by_model = defaultdict(list)
    for row in rows: by_model[row["model"]].append(row)
    summary = {}
    for model, entries in by_model.items():
        summary[model] = {"runs": len(entries), "points": sum(x["points"] for x in entries), "max_points": sum(x["max_points"] for x in entries), "mean_points": sum(x["points"] for x in entries) / len(entries), "catastrophic_runs": sum(bool(x["catastrophic"]) for x in entries), "parse_failures": sum(bool(x["parse_error"]) for x in entries), "mean_elapsed_s": sum(x["elapsed_s"] for x in entries) / len(entries)}
    result = {"protocol_version":"qualification-v1.0.0", "schedule_version":SCHEDULE["schedule_version"], "execution_config_commit":SCHEDULE["execution_config_commit"], "runs":rows, "by_model":summary, "total_points":sum(x["points"] for x in rows), "total_max_points":sum(x["max_points"] for x in rows)}
    out = ROOT / "runs/processed/stage1-first-round-results.json"
    out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result["by_model"], indent=2, sort_keys=True))

if __name__ == "__main__": main()
