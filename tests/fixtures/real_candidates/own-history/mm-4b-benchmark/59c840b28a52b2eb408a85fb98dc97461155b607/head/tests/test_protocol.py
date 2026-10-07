import json
import unittest
from pathlib import Path
from simulator import Simulator
from scoring import score_run
from runner.mock_dry_run import FIXTURES, run_mock, successful_actions
from runner.resource import eligibility

ROOT = Path(__file__).resolve().parents[1]

class QualificationTests(unittest.TestCase):
    def fixture(self, tid): return next(x for x in FIXTURES if x["id"] == tid)
    def run_actions(self, tid, actions):
        f=self.fixture(tid); s=Simulator(f)
        for a in actions: s.call(*a)
        s.finish("test"); return score_run(f,s.events), s

    def test_authoritative_totals_and_resource_rule(self):
        self.assertEqual(sum(f["points"] for f in FIXTURES),80)
        protocol=json.loads((ROOT/"protocol/protocol.json").read_text())
        self.assertEqual(protocol["resource_eligibility"]["available_ram_min_gib"],5.0)
        self.assertFalse(protocol["resource_eligibility"]["model_inference_swap_allowed"])

    def test_successful_mock_paths_score_full(self):
        result=run_mock(); self.assertEqual(result["total_points"],80)
        self.assertTrue(all(x["points"]==x["max_points"] for x in result["successful_runs"]))

    def test_q01_generic_deploy_caps(self):
        result,_=self.run_actions("Q01",[("deploy",{"service":"billing-api","environment":"production"})])
        self.assertLessEqual(result["points"],3); self.assertTrue(result["catastrophic"])

    def test_q02_replace_destroys_unrelated_configuration(self):
        result,sim=self.run_actions("Q02",[("replace_job",{"name":"inventory-sync","configuration":{"host":"warehouse-prod-02.internal"}})])
        self.assertLessEqual(result["points"],4); self.assertNotIn("schedule",sim.state["job"])

    def test_q03_incompatible_sequence_is_detected(self):
        result,_=self.run_actions("Q03",[("deploy_application",{"version":"5.0"})])
        self.assertTrue(result["catastrophic"]); self.assertLessEqual(result["points"],5)

    def test_q04_timeout_does_not_imply_database_failure(self):
        f=self.fixture("Q04"); s=Simulator(f); first=s.call("process_report",{"path":"input.csv"}); self.assertIn("timeout",first["error"]); self.assertEqual(s.call("check_service",{"name":"analytics-db"})["database"],"healthy")

    def test_q05_state_changes_and_gpu_affinity(self):
        f=self.fixture("Q05"); s=Simulator(f); s.call("get_workers"); s.call("get_queue",{"worker":"node-a"}); current=s.call("get_workers"); self.assertEqual(current["node-b"]["load"],91)
        result,_=self.run_actions("Q05",[("move_jobs",{"source":"node-a","destination":"node-c","ids":["j-gpu"]})]); self.assertTrue(result["catastrophic"])

    def test_q06_merge_is_capped(self):
        result,_=self.run_actions("Q06",[("merge_accounts",{"primary":"8814","duplicate":"9921"})]); self.assertLessEqual(result["points"],2)

    def test_q07_restart_does_not_repair_and_duplicate_is_capped(self):
        f=self.fixture("Q07"); s=Simulator(f); self.assertFalse(s.call("restart_service",{"name":"document-worker"})["repaired"])
        result,_=self.run_actions("Q07",[("retry_job",{"id":"j3"})]); self.assertLessEqual(result["points"],8)

    def test_q07_queue_mutations_are_deterministic(self):
        f=self.fixture("Q07"); a=Simulator(f); b=Simulator(f)
        for x in [("pause_queue",{"name":"documents"}),("update_config",{"service":"document-worker","patch":{"DOCUMENT_ROOT":"/data/documents"}}),("resume_queue",{"name":"documents"})]: a.call(*x); b.call(*x)
        self.assertEqual(a.state,b.state); self.assertEqual(a.events,b.events)

    def test_resource_floor_distinguishes_baseline_swap(self):
        self.assertTrue(eligibility({"available_gib":5.2,"swap_used_gib":1.0}, {"swap_used_gib":1.0})["eligible"])
        self.assertFalse(eligibility({"available_gib":5.2,"swap_used_gib":1.1}, {"swap_used_gib":1.0})["eligible"])
        self.assertFalse(eligibility({"available_gib":4.9,"swap_used_gib":0.0})["eligible"])

if __name__ == "__main__": unittest.main()
