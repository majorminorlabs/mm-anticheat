from __future__ import annotations

import json
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import e014_controller as controller


def test_resume_command_is_canonical() -> None:
    command = controller.training_command(Path("/workspace/research-model-mm/source"), "L40S_48GB_MB4", True)
    assert command[-1] == "--resume"
    assert "--hardware-profile" in command
    assert "--config" in command


def test_failure_classifier_distinguishes_operational_failures() -> None:
    assert controller.classify_failure("RuntimeError: CUDA out of memory", 1) == "CUDA_OOM"
    assert controller.classify_failure("loss became non-finite", 1) == "NONFINITE_LOSS"
    assert controller.classify_failure("No space left on device", 1) == "DISK_EXHAUSTION"
    assert controller.classify_failure("Permission denied", 13) == "TRAINING_EXIT_13"


def test_status_parser_reads_progress_and_gpu(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "outputs/qwen3-8b-research-v0.1-qlora"
    output.mkdir(parents=True)
    (output / "training_events.jsonl").write_text(
        json.dumps({"event": "log", "global_step": 40, "epoch": 0.2, "loss": 1.5, "learning_rate": 0.0002}) + "\n",
        encoding="utf-8",
    )
    root = tmp_path / "controller"; root.mkdir()
    monkeypatch.setattr(controller, "gpu_snapshot", lambda: {"gpu_utilization_percent": 88, "vram_used_mib": 19000, "vram_total_mib": 46068})
    p = controller.Paths(root, tmp_path)
    (root / "state.json").write_text(json.dumps({"state": "RUNNING", "started_epoch_seconds": controller.time.time() - 10}), encoding="utf-8")
    status = controller.status_snapshot(p)
    assert status["state"] == "RUNNING"
    assert status["optimizer_step"] == 40
    assert status["latest_loss"] == 1.5
    assert status["gpu"]["vram_total_mib"] == 46068


def test_stop_request_is_persisted(tmp_path: Path, capsys, monkeypatch) -> None:
    root = tmp_path / "controller"; root.mkdir()
    p = controller.Paths(root, tmp_path)
    monkeypatch.setenv("E014_ALLOW_NON_WORKSPACE", "1")
    (root / "state.json").write_text(json.dumps({"state": "RUNNING"}), encoding="utf-8")
    controller.Controller(p).request_stop("budget_exhausted")
    assert p.stop.read_text(encoding="utf-8").strip() == "budget_exhausted"
    assert json.loads(p.state.read_text(encoding="utf-8"))["stop_reason"] == "budget_exhausted"
    assert "graceful stop" in capsys.readouterr().out


def test_controller_start_uses_new_session_and_records_budget(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "controller"; project = tmp_path / "project"; project.mkdir()
    p = controller.Paths(root, project)
    monkeypatch.setenv("E014_ALLOW_NON_WORKSPACE", "1")
    observed = {}

    class FakeProcess:
        pid = 4321

    def fake_popen(*args, **kwargs):
        observed["args"] = args; observed["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr(controller.subprocess, "Popen", fake_popen)
    controller.Controller(p).request_start(False, 1.0, 1.09)
    assert observed["kwargs"]["start_new_session"] is True
    config = json.loads(p.config.read_text(encoding="utf-8"))
    assert config["max_cost_usd"] == 1.09
    assert json.loads(p.state.read_text(encoding="utf-8"))["supervisor_pid"] == 4321


def test_resume_refuses_step_zero_when_artifacts_have_no_valid_checkpoint(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "controller"; project = tmp_path / "project"; project.mkdir()
    output = project / controller.OUTPUT_REL; output.mkdir(parents=True)
    (output / "adapter_config.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("E014_ALLOW_NON_WORKSPACE", "1")
    try:
        controller.Controller(controller.Paths(root, project)).request_start(True, None, None)
    except SystemExit as exc:
        assert "no valid checkpoint" in str(exc)
    else:
        raise AssertionError("resume unexpectedly accepted an incomplete output")
