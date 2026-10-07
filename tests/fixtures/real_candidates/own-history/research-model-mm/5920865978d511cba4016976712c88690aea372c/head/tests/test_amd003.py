from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import amd003_session
from amd003_status import build_status, parse_latest_gpu_telemetry
from run_e014_remote import RemoteRun, package_result
from start_e014_amd003 import tmux_command


def test_gpu_status_parser_reads_latest_amd_smi_sample(tmp_path: Path) -> None:
    path = tmp_path / "gpu-monitor.jsonl"
    path.write_text(
        "'CTRL' + 'C' to stop watching output:\n"
        '[{"timestamp": 1, "gpu": 0, "gfx": {"value": 4, "unit": "%"}, "vram_used": {"value": 1.0, "unit": "GB"}, "vram_total": {"value": 191.7, "unit": "GB"}}]\n'
        '[{"timestamp": 2, "gpu": 0, "gfx": {"value": 87, "unit": "%"}, "vram_used": {"value": 42.5, "unit": "GB"}, "vram_total": {"value": 191.7, "unit": "GB"}}]\n',
        encoding="utf-8",
    )
    assert parse_latest_gpu_telemetry(path) == {
        "gpu": 0,
        "timestamp": 2,
        "gpu_utilization_percent": 87.0,
        "hbm_used_gb": 42.5,
        "hbm_total_gb": 191.7,
        "power_watts": None,
        "temperature_c": None,
    }


def test_status_reports_training_progress_and_cost_fields(tmp_path: Path) -> None:
    session = tmp_path / "AMD003"
    repo = session / "research-model/outputs/qwen3-8b-research-v0.1-qlora"
    repo.mkdir(parents=True)
    started = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    (session / "status.json").write_text(
        json.dumps({"state": "RUNNING", "started_at_utc": started, "runner_pid": 999999}) + "\n",
        encoding="utf-8",
    )
    (repo / "training_events.jsonl").write_text(
        json.dumps({"timestamp": started, "event": "progress", "global_step": 100}) + "\n",
        encoding="utf-8",
    )
    result = build_status(session)
    assert result["state"] == "RUNNING"
    assert result["current_optimizer_step"] == 100
    assert result["total_optimizer_steps"] == 2454
    assert result["process_alive"] is False
    assert result["estimated_cost_usd"] >= 0


def test_tmux_detached_command_is_explicit_and_resumable(tmp_path: Path) -> None:
    command = tmux_command("e014-amd003", tmp_path / "session", tmp_path / "repo", True)
    assert command[:6] == ["tmux", "new-session", "-d", "-s", "e014-amd003", "--"]
    assert "--resume" in command[-1]
    assert "REMOTE" not in " ".join(command)


def test_amd003_retry_classifier_rejects_authentication_failures(tmp_path: Path) -> None:
    stdout = tmp_path / "stdout"
    stderr = tmp_path / "stderr"
    stdout.write_text("")
    stderr.write_text("Permission denied (publickey).\n")
    assert not amd003_session.is_transient_ssh_failure(255, stdout, stderr)


def test_amd003_retry_recovers_from_transient_connection_refusal(tmp_path: Path, monkeypatch, capsys) -> None:
    original_runtime = amd003_session.RUNTIME_ROOT
    original_logs = amd003_session.LOG_ROOT
    calls = 0

    def fake_run_logged(label, args, **kwargs):
        nonlocal calls
        del args, kwargs
        calls += 1
        stdout = tmp_path / f"{label}.stdout"
        stderr = tmp_path / f"{label}.stderr"
        if calls == 1:
            stderr.write_text("ssh: connect to host 192.0.2.10 port 22: Connection refused\n", encoding="utf-8")
            return amd003_session.subprocess.CompletedProcess([], 255), stdout, stderr
        stdout.write_text("ok\n", encoding="utf-8")
        stderr.write_text("", encoding="utf-8")
        return amd003_session.subprocess.CompletedProcess([], 0), stdout, stderr

    try:
        amd003_session.RUNTIME_ROOT = tmp_path / "runtime"
        amd003_session.LOG_ROOT = amd003_session.RUNTIME_ROOT / "logs"
        monkeypatch.setattr(amd003_session, "run_logged", fake_run_logged)
        monkeypatch.setattr(amd003_session, "wait_for_stable_shell", lambda _: None)
        monkeypatch.setattr(amd003_session.time, "sleep", lambda _: None)
        result, _, _ = amd003_session.run_ssh_retry("192.0.2.10", "upload_dataset_archive", ["scp", "a", "b"])
    finally:
        amd003_session.RUNTIME_ROOT = original_runtime
        amd003_session.LOG_ROOT = original_logs
    assert result.returncode == 0
    assert calls == 2
    assert "SSH restored" in capsys.readouterr().out


def test_result_packaging_writes_archive_and_digest(tmp_path: Path) -> None:
    session = tmp_path / "AMD003"
    (session / "runtime/logs").mkdir(parents=True)
    (session / "research-model/outputs/qwen3-8b-research-v0.1-qlora").mkdir(parents=True)
    (session / "status.json").write_text(json.dumps({"state": "COMPLETE"}) + "\n", encoding="utf-8")
    (session / "timeline.jsonl").write_text("{}\n", encoding="utf-8")
    (session / "commands.jsonl").write_text("{}\n", encoding="utf-8")
    (session / "result/summary.json").parent.mkdir(parents=True)
    (session / "result/summary.json").write_text("{}\n", encoding="utf-8")
    (session / "research-model/outputs/qwen3-8b-research-v0.1-qlora/training_run.json").write_text("{}\n", encoding="utf-8")
    archive = package_result(session)
    assert archive.is_file()
    digest = amd003_session.sha256(archive)
    assert (session / "result/AMD003-e014-results.tar.gz.sha256").read_text(encoding="utf-8").startswith(digest)
    assert json.loads((session / "result/archive_manifest.json").read_text(encoding="utf-8"))["sha256"] == digest


def test_remote_runner_failure_preserves_state_and_packages_evidence(tmp_path: Path, monkeypatch) -> None:
    session = tmp_path / "AMD003"
    runner = RemoteRun(session)
    monkeypatch.setattr(runner, "record_environment", lambda _: None)

    def fail_command(*args, **kwargs):
        del args, kwargs
        raise RuntimeError("offline mocked failure")

    monkeypatch.setattr(runner, "run_command", fail_command)
    assert runner.run() == 1
    status = json.loads((session / "status.json").read_text(encoding="utf-8"))
    assert status["state"] == "FAILED"
    assert "offline mocked failure" in (session / "failures/failure.txt").read_text(encoding="utf-8")
    assert (session / "result/AMD003-e014-results.tar.gz").is_file()


def test_stable_shell_requires_three_clean_probes(tmp_path: Path, monkeypatch, capsys) -> None:
    original_runtime = amd003_session.RUNTIME_ROOT
    original_logs = amd003_session.LOG_ROOT
    calls = 0

    def fake_run_logged(label, args, **kwargs):
        nonlocal calls
        del args, kwargs
        calls += 1
        stdout = tmp_path / f"{label}.stdout"
        stderr = tmp_path / f"{label}.stderr"
        stdout.write_bytes(amd003_session.READY_SENTINEL.encode("ascii"))
        stderr.write_bytes(b"")
        return amd003_session.subprocess.CompletedProcess([], 0), stdout, stderr

    try:
        amd003_session.RUNTIME_ROOT = tmp_path / "runtime"
        amd003_session.LOG_ROOT = amd003_session.RUNTIME_ROOT / "logs"
        monkeypatch.setattr(amd003_session, "run_logged", fake_run_logged)
        monkeypatch.setattr(amd003_session.time, "sleep", lambda _: None)
        amd003_session.wait_for_stable_shell("192.0.2.10")
    finally:
        amd003_session.RUNTIME_ROOT = original_runtime
        amd003_session.LOG_ROOT = original_logs
    assert calls == 3
    assert "3 consecutive clean probes" in capsys.readouterr().out


def test_matching_staged_assets_are_reused_idempotently(tmp_path: Path, monkeypatch) -> None:
    original_manifest = amd003_session.TRANSFER_MANIFEST
    bundle = tmp_path / "research-model.bundle"
    archive = tmp_path / "research-data.tar.gz"
    bundle.write_bytes(b"bundle")
    archive.write_bytes(b"archive")
    manifest = {
        "source_commit": "offline-test",
        "bundle": {"path": str(bundle), "sha256": amd003_session.sha256(bundle)},
        "dataset_archive": {"path": str(archive), "sha256": amd003_session.sha256(archive)},
    }
    manifest_path = tmp_path / "transfer_manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    try:
        amd003_session.TRANSFER_MANIFEST = manifest_path
        assert amd003_session.ensure_prepared() == manifest
        assert amd003_session.ensure_prepared() == manifest
    finally:
        amd003_session.TRANSFER_MANIFEST = original_manifest
