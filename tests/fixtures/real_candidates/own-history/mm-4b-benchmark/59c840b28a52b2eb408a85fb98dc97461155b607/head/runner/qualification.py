"""ThinkPad-side Stage 1 first-round runner.

The model sees only the public task objective, initial state, and tool names.
The deterministic simulator remains the sole external tool and the frozen
scorer is used unchanged by the controller after raw evidence is synced.
"""
import argparse, json, os, subprocess, time
from pathlib import Path
from runner.adapter import AdapterError, parse_tool_plan

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = {x["id"]: x for x in json.loads((ROOT / "tasks/fixtures.json").read_text())["tasks"]}
MANIFEST = json.loads((ROOT / "models/manifest.json").read_text())
MODEL_FILES = {
    "Ministral-3-3B-Instruct-2512": "/home/dippo/research-inference/models/mm-agent/mistralai_Ministral-3-3B-Instruct-2512-Q4_K_M.gguf",
    "Qwen3-4B": "/home/dippo/research-inference/models/mm-agent/Qwen_Qwen3-4B-Q4_K_M.gguf",
    "Phi-4-mini-instruct": "/home/dippo/research-inference/models/mm-agent/microsoft_Phi-4-mini-instruct-Q4_K_M.gguf",
    "Gemma-3-4B-IT": "/home/dippo/research-inference/models/mm-agent/google_gemma-3-4b-it-Q4_K_M.gguf",
}

def prompt_for(fixture):
    public = {"objective": fixture["objective"], "initial_state": fixture["initial_state"], "available_tools": fixture["available_tools"]}
    return ("You are operating a deterministic tool-use benchmark. Do not explain your reasoning. "
            "Return only one JSON object of the form {\"calls\":[{\"tool\":\"name\",\"arguments\":{}}],\"done\":true}. "
            "Use only listed tools, preserve state, and stop when the objective is verified. "
            "The tool argument objects must be valid JSON. Public task data follows:\n" + json.dumps(public, sort_keys=True))

def parse_calls(text):
    try:
        return parse_tool_plan(text)["calls"], None
    except AdapterError as exc:
        return [], str(exc)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schedule", required=True)
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--llama", default="/tmp/mm-agent-llama-build/bin/llama-completion")
    args = ap.parse_args()
    out = Path(args.raw_dir) / args.run_id
    out.mkdir(parents=True, exist_ok=True)
    fixture = FIXTURES[args.task]
    model = MODEL_FILES[args.model]
    prompt = prompt_for(fixture)
    cmd = [args.llama, "-m", model, "-ngl", "99", "-c", "16384", "-n", "768", "--temp", "0", "--seed", "0", "--jinja", "--simple-io", "--no-display-prompt"]
    if args.model == "Qwen3-4B":
        cmd += ["--reasoning", "off"]
    cmd += ["-p", prompt]
    start = time.time()
    before = Path("/proc/meminfo").read_text()
    proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900)
    elapsed = time.time() - start
    (out / "attempt-001.stdout.log").write_text(proc.stdout)
    (out / "attempt-001.command.json").write_text(json.dumps({"argv": cmd, "returncode": proc.returncode, "elapsed_s": elapsed}, indent=2, sort_keys=True) + "\n")
    calls, parse_error = parse_calls(proc.stdout)
    result = {"run_id": args.run_id, "model": args.model, "task": args.task, "attempt": 1, "calls": calls, "parse_error": parse_error, "returncode": proc.returncode, "elapsed_s": elapsed, "meminfo_before": before}
    (out / "attempt-001.parsed.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, sort_keys=True))

if __name__ == "__main__":
    main()
