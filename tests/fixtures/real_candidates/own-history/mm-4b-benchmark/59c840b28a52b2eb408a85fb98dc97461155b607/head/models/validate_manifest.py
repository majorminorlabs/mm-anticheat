import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    "ministral-3b-instruct-2512": "mistralai_Ministral-3-3B-Instruct-2512-Q4_K_M.gguf",
    "qwen3-4b": "Qwen_Qwen3-4B-Q4_K_M.gguf",
    "phi-4-mini-instruct": "microsoft_Phi-4-mini-instruct-Q4_K_M.gguf",
    "gemma-3-4b-it": "google_gemma-3-4b-it-Q4_K_M.gguf",
}

def validate(manifest=None):
    manifest = manifest or json.loads((ROOT / "models/manifest.json").read_text())
    assert manifest["status"] == "frozen"
    assert len(manifest["candidates"]) == 4
    tracked = subprocess.run(["git", "ls-files", "*.gguf"], cwd=ROOT, text=True, capture_output=True, check=True).stdout.splitlines()
    assert not tracked
    for candidate in manifest["candidates"]:
        assert candidate["quantization"] == "Q4_K_M"
        assert candidate["gguf_filename"] == EXPECTED[candidate["benchmark_model_id"]]
        assert candidate["sha256"] and len(candidate["sha256"]) == 64
        assert candidate["filesystem_path"].startswith("/home/")
        assert not candidate["filesystem_path"].startswith(str(ROOT))
        assert candidate["runtime_compatibility"]["commit"] == manifest["llama_cpp_commit"]
        assert candidate["chat_template_audit"]["gguf_template"] == "present"
    return True

if __name__ == "__main__":
    print("manifest validation: PASS" if validate() else "manifest validation: FAIL")
