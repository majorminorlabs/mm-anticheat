import json
import unittest
from pathlib import Path
from runner.adapter import AdapterError, parse_tool_plan

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "runs/raw/stage1-first-round"

class AdapterForensicsTests(unittest.TestCase):
    def raw(self, run_id):
        return (RAW / run_id / "attempt-001.stdout.log").read_text()

    def test_actual_fenced_outputs_are_extracted(self):
        for run_id in ["R001", "R002", "R007", "R010", "R015", "R023"]:
            result = parse_tool_plan(self.raw(run_id))
            self.assertIsInstance(result["calls"], list)
            self.assertGreater(len(result["calls"]), 0)

    def test_malformed_nested_call_is_not_silently_repaired(self):
        with self.assertRaises(AdapterError) as ctx:
            parse_tool_plan(self.raw("R006"))
        self.assertEqual(str(ctx.exception), "tool_plan_calls_not_canonical")

    def test_truncated_output_is_rejected(self):
        with self.assertRaises(AdapterError) as ctx:
            parse_tool_plan(self.raw("R004"))
        self.assertEqual(str(ctx.exception), "no_valid_tool_plan_json")

    def test_neutral_probe_shapes_translate_without_semantic_repair(self):
        probes = {
            "Ministral-3-3B-Instruct-2512": [{"tool": "get_weather", "arguments": {"city": "test-city"}}],
            "Phi-4-mini-instruct": {"tool": "get_weather", "arguments": {"city": "test-city"}},
            "Gemma-3-4B-IT": {"get_weather": {"city": "test-city"}},
        }
        for model, value in probes.items():
            expected = value if isinstance(value, list) else [value] if "tool" in value else [{"tool": "get_weather", "arguments": {"city": "test-city"}}]
            parsed = __import__("runner.adapter", fromlist=["parse_tool_plan"]).parse_tool_plan("```json\n" + json.dumps(value) + "\n```")
            self.assertEqual(parsed["calls"], expected)

if __name__ == "__main__":
    unittest.main()
