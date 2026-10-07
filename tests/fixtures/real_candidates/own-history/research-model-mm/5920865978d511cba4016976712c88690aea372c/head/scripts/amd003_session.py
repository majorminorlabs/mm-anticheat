"""Offline-stage and minimally bootstrap the detached AMD003 E014 run."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import selectors
import shlex
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parents[1]
SESSION_ID = "AMD003"
SESSION_ROOT = ROOT / "cloud_runs/AMD003_mi300x_e014_detached"
RUNTIME_ROOT = SESSION_ROOT / "runtime"
LOG_ROOT = RUNTIME_ROOT / "logs"
COLLECTED_ROOT = RUNTIME_ROOT / "collected"
TRANSFER_MANIFEST = RUNTIME_ROOT / "transfer_manifest.json"
TRANSFER_TEMPLATE = SESSION_ROOT / "transfer/manifest.template.json"
BOOTSTRAP_REMOTE = ROOT / "scripts/amd003_bootstrap_remote.sh"
REMOTE_PARENT = "/root/amd-e014-sessions"
DATASET_PATH = ROOT / "data/generated/research-data-v0.1-expanded.jsonl"
DATASET_SHA256 = "703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f"
RESEARCH_BENCHMARK = ROOT / "benchmarks/releases/research-bench-v0.1.jsonl"
RESEARCH_BENCHMARK_SHA256 = "3f1f859a10f1bb34ebb22197fadfeba08f2f812c2346a9d75c2b1b7e97b878c4"
CONTROL_BENCHMARK = ROOT / "benchmarks/control/general-capability-v0.1.jsonl"
CONTROL_BENCHMARK_SHA256 = "b9ff1050dd05eeaf062aba8e8fce1f0a39ffc7da68754d02f011779780628636"
READINESS_PROBES = 3
READINESS_MAX_ATTEMPTS = 12
READINESS_INTERVAL_SECONDS = 3
RETRY_DELAYS_SECONDS = (3, 6, 10)
READY_SENTINEL = "AMD003_REMOTE_SHELL_READY_54b9a1"


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def append_jsonl(path: Path, event: str, **fields: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {"timestamp_utc": now_utc(), "host": socket.gethostname(), "event": event, **fields}
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def progress(message: str) -> None:
    print(f"[{SESSION_ID}] {message}", flush=True)


def validate_ip(value: str) -> str:
    try:
        ipaddress.ip_address(value)
    except ValueError as exc:
        raise RuntimeError(f"expected a literal public IP address, got {value!r}") from exc
    return value


def ssh_base(ip: str) -> list[str]:
    target = f"[{ip}]" if ":" in ip else ip
    args = [
        "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=12", "-o", "ServerAliveInterval=3",
        "-o", "ServerAliveCountMax=1", "-T",
    ]
    identity = os.environ.get("AMD_SSH_IDENTITY")
    if identity:
        args.extend(["-i", identity])
    args.append(f"{os.environ.get('AMD_SSH_USER', 'root')}@{target}")
    return args


def scp_base(ip: str) -> list[str]:
    args = [
        "scp", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=12", "-o", "ServerAliveInterval=3",
        "-o", "ServerAliveCountMax=1",
    ]
    identity = os.environ.get("AMD_SSH_IDENTITY")
    if identity:
        args.extend(["-i", identity])
    return args


def remote_target(ip: str, path: str) -> str:
    target = f"[{ip}]" if ":" in ip else ip
    return f"{os.environ.get('AMD_SSH_USER', 'root')}@{target}:{path}"


def remote_root() -> str:
    return f"{os.environ.get('AMD_REMOTE_PARENT', REMOTE_PARENT)}/{SESSION_ID}"


def run_logged(
    label: str,
    args: Sequence[str],
    *,
    input_bytes: bytes | None = None,
    check: bool = True,
    live: bool = False,
) -> tuple[subprocess.CompletedProcess[bytes], Path, Path]:
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    stdout_path = LOG_ROOT / f"{stamp}-{label}.stdout.log"
    stderr_path = LOG_ROOT / f"{stamp}-{label}.stderr.log"
    command = [str(value) for value in args]
    common = {
        "label": label,
        "command": shlex.join(command),
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
    }
    append_jsonl(RUNTIME_ROOT / "commands.jsonl", "COMMAND_STARTED", **common)
    started = time.monotonic()
    if not live:
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            result = subprocess.run(command, cwd=ROOT, input=input_bytes, stdout=stdout, stderr=stderr, check=False)
    else:
        process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert process.stdin is not None and process.stdout is not None and process.stderr is not None
        if input_bytes:
            process.stdin.write(input_bytes)
        process.stdin.close()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, (stdout_path, sys.stdout))
        selector.register(process.stderr, selectors.EVENT_READ, (stderr_path, sys.stderr))
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            handles = {stdout_path: stdout, stderr_path: stderr}
            while selector.get_map():
                for key, _ in selector.select():
                    stream = key.fileobj
                    chunk = stream.read1(64 * 1024)
                    if not chunk:
                        selector.unregister(stream)
                        stream.close()
                        continue
                    path, live_handle = key.data
                    handles[path].write(chunk)
                    handles[path].flush()
                    live_handle.write(chunk.decode("utf-8", errors="replace"))
                    live_handle.flush()
        result = subprocess.CompletedProcess(command, process.wait())
    append_jsonl(
        RUNTIME_ROOT / "commands.jsonl",
        "COMMAND_COMPLETED",
        **common,
        exit_status=result.returncode,
        duration_seconds=round(time.monotonic() - started, 3),
    )
    if check and result.returncode:
        raise RuntimeError(f"{label} failed with exit status {result.returncode}; inspect {stderr_path}")
    return result, stdout_path, stderr_path


def _failure_text(stdout_path: Path, stderr_path: Path) -> str:
    return "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in (stdout_path, stderr_path)
        if path.exists()
    ).lower()


def is_transient_ssh_failure(returncode: int, stdout_path: Path, stderr_path: Path) -> bool:
    if returncode == 0:
        return False
    text = _failure_text(stdout_path, stderr_path)
    if any(marker in text for marker in ("permission denied", "host key verification failed", "no such file", "cannot stat")):
        return False
    return any(
        marker in text
        for marker in (
            "connection refused", "connection reset", "connection timed out", "operation timed out",
            "connect timed out", "broken pipe", "connection closed", "connection lost",
            "ssh_exchange_identification", "kex_exchange_identification", "connection aborted",
        )
    )


def wait_for_stable_shell(ip: str) -> None:
    progress("Waiting for AMD provider initialization and stable SSH...")
    consecutive = 0
    for attempt in range(1, READINESS_MAX_ATTEMPTS + 1):
        result, stdout_path, stderr_path = run_logged(
            f"amd003_readiness_probe_{attempt:02d}",
            [*ssh_base(ip), f"printf '%s' {shlex.quote(READY_SENTINEL)}"],
            check=False,
        )
        stdout = stdout_path.read_bytes()
        clean = result.returncode == 0 and stdout == READY_SENTINEL.encode("ascii")
        append_jsonl(
            RUNTIME_ROOT / "timeline.jsonl",
            "SSH_READINESS_PROBE",
            public_ip=ip,
            attempt=attempt,
            clean=clean,
            consecutive_clean=consecutive + 1 if clean else 0,
            exit_status=result.returncode,
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
        )
        if clean:
            consecutive += 1
            if consecutive >= READINESS_PROBES:
                append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "REMOTE_SHELL_STABLE", public_ip=ip, probes=consecutive)
                progress(f"Remote shell stable ({READINESS_PROBES} consecutive clean probes)")
                return
        else:
            consecutive = 0
        if attempt < READINESS_MAX_ATTEMPTS:
            progress("Remote shell not yet stable; retrying readiness probe...")
            time.sleep(READINESS_INTERVAL_SECONDS)
    raise RuntimeError(f"remote shell did not produce {READINESS_PROBES} consecutive clean probes")


def run_ssh_retry(
    ip: str,
    label: str,
    args: Sequence[str],
    *,
    input_bytes: bytes | None = None,
    live: bool = False,
) -> tuple[subprocess.CompletedProcess[bytes], Path, Path]:
    for attempt in range(1, len(RETRY_DELAYS_SECONDS) + 2):
        result, stdout_path, stderr_path = run_logged(
            f"{label}_attempt_{attempt:02d}", args, input_bytes=input_bytes, check=False, live=live
        )
        if result.returncode == 0:
            if attempt > 1:
                progress(f"SSH restored; {label.replace('_', ' ')} succeeded")
            return result, stdout_path, stderr_path
        transient = is_transient_ssh_failure(result.returncode, stdout_path, stderr_path)
        append_jsonl(
            RUNTIME_ROOT / "timeline.jsonl",
            "SSH_OPERATION_ATTEMPT",
            operation=label,
            attempt=attempt,
            total_attempts=len(RETRY_DELAYS_SECONDS) + 1,
            transient=transient,
            exit_status=result.returncode,
            stderr_path=str(stderr_path),
        )
        if not transient or attempt == len(RETRY_DELAYS_SECONDS) + 1:
            return result, stdout_path, stderr_path
        progress(f"{label.replace('_', ' ').capitalize()} interrupted; waiting for SSH...")
        time.sleep(RETRY_DELAYS_SECONDS[attempt - 1])
        wait_for_stable_shell(ip)
    raise AssertionError("unreachable")


def remote_file_sha256(ip: str, path: str, label: str) -> tuple[str | None, tuple[Path, Path]]:
    command = f"if [ -f {shlex.quote(path)} ]; then sha256sum {shlex.quote(path)}; fi"
    result, stdout_path, stderr_path = run_ssh_retry(ip, label, [*ssh_base(ip), command])
    if result.returncode:
        raise RuntimeError(f"{label} failed with exit status {result.returncode}")
    output = stdout_path.read_text(encoding="utf-8", errors="replace").strip().split()
    if not output:
        return None, (stdout_path, stderr_path)
    if not re.fullmatch(r"[0-9a-f]{64}", output[0]):
        raise RuntimeError(f"{label} returned invalid SHA-256 output")
    return output[0], (stdout_path, stderr_path)


def source_files() -> tuple[str, ...]:
    return (
        "configs/hardware/nvidia_profiles.toml",
        "configs/research/e014_scientific_invariants_v1.json",
        "docs/hardware/E014_AMD_qualification.md",
        "cloud_runs/AMD003_mi300x_e014_detached/manifest.json",
        "cloud_runs/AMD003_mi300x_e014_detached/transfer/manifest.template.json",
        "scripts/amd003_bootstrap_remote.sh",
        "scripts/amd003_session.py",
        "scripts/amd003_session.sh",
        "scripts/amd003_status.py",
        "scripts/amd_remote_preflight.sh",
        "scripts/prepare_amd_host.sh",
        "scripts/run_e014.sh",
        "scripts/run_e014_remote.py",
        "scripts/run_e014_remote.sh",
        "scripts/start_e014_amd003.py",
        "scripts/start_e014_amd003.sh",
        "scripts/train_transformers.py",
        "scripts/validate_e014_invariants.py",
    )


def ensure_committed_source() -> None:
    for relative in source_files():
        path = ROOT / relative
        if not path.is_file():
            raise RuntimeError(f"required AMD003 source is missing: {relative}")
        result = subprocess.run(
            ["git", "diff", "--quiet", "HEAD", "--", relative],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(f"AMD003 source has uncommitted changes; commit it before staging: {relative}")


def _load_manifest() -> dict[str, Any]:
    if not TRANSFER_MANIFEST.is_file():
        raise RuntimeError(f"AMD003 is not staged; run prepare first: {TRANSFER_MANIFEST}")
    return json.loads(TRANSFER_MANIFEST.read_text(encoding="utf-8"))


def prepare() -> dict[str, Any]:
    ensure_committed_source()
    if TRANSFER_MANIFEST.is_file():
        existing = _load_manifest()
        current = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        if existing.get("source_commit") == current:
            for record in (existing["bundle"], existing["dataset_archive"]):
                if not Path(record["path"]).is_file() or sha256(Path(record["path"])) != record["sha256"]:
                    raise RuntimeError(f"staged AMD003 asset changed: {record['path']}")
            return existing
        raise RuntimeError("AMD003 has a staged bundle from another commit; remove only that runtime manifest and rerun prepare")

    run_logged("local_invariant_validation", [sys.executable, str(ROOT / "scripts/validate_e014_invariants.py")])
    run_logged(
        "local_amd003_manifest_validation",
        [sys.executable, str(ROOT / "scripts/validate_amd_session.py"), "--manifest", str(SESSION_ROOT / "manifest.json")],
    )
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=ROOT, text=True).strip()
    if not branch:
        raise RuntimeError("a named Git branch is required for the AMD003 bundle")
    staging = Path("/tmp/research-model-amd-session") / SESSION_ID
    staging.mkdir(parents=True, exist_ok=True)
    bundle = staging / f"research-model-{commit}.bundle"
    archive = staging / f"research-data-v0.1-expanded-{DATASET_SHA256[:12]}.tar.gz"
    if bundle.exists():
        raise RuntimeError(f"refusing to overwrite existing code bundle: {bundle}")
    run_logged("create_code_bundle", ["git", "bundle", "create", str(bundle), branch])
    run_logged("verify_code_bundle", ["git", "bundle", "verify", str(bundle)])
    if not archive.exists():
        run_logged("create_dataset_archive", ["tar", "-czf", str(archive), "-C", str(DATASET_PATH.parent), DATASET_PATH.name])
    run_logged("verify_dataset_archive", ["tar", "-tzf", str(archive)])
    manifest = {
        "schema_version": "1.0",
        "record_type": "amd003_detached_transfer_manifest",
        "session_id": SESSION_ID,
        "prepared_at_utc": now_utc(),
        "source_commit": commit,
        "source_branch": branch,
        "git_dirty_paths_at_staging": subprocess.check_output(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=ROOT, text=True
        ).splitlines(),
        "bundle": {"path": str(bundle), "bytes": bundle.stat().st_size, "sha256": sha256(bundle)},
        "dataset_archive": {
            "path": str(archive),
            "bytes": archive.stat().st_size,
            "sha256": sha256(archive),
            "source_file": str(DATASET_PATH),
            "extracted_file_sha256": DATASET_SHA256,
        },
        "benchmarks": {"research_sha256": RESEARCH_BENCHMARK_SHA256, "control_sha256": CONTROL_BENCHMARK_SHA256},
        "remote_execution": {
            "runner": "scripts/run_e014_remote.py",
            "launcher": "scripts/start_e014_amd003.sh",
            "detached": True,
            "provider_rate_usd_per_hour": 1.99,
        },
        "cloud_compute_started": False,
        "training_started": False,
    }
    atomic_json(TRANSFER_MANIFEST, manifest)
    append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "AMD003_PREPARED", source_commit=commit, cloud_compute_started=False)
    return manifest


def ensure_prepared() -> dict[str, Any]:
    if not TRANSFER_MANIFEST.is_file():
        return prepare()
    manifest = _load_manifest()
    for record in (manifest["bundle"], manifest["dataset_archive"]):
        path = Path(record["path"])
        if not path.is_file() or sha256(path) != record["sha256"]:
            raise RuntimeError(f"staged AMD003 asset changed: {path}; run prepare again")
    return manifest


def start(ip_value: str, resume: bool = False) -> int:
    ip = validate_ip(ip_value)
    manifest = ensure_prepared()
    append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "AMD003_START_REQUESTED", public_ip=ip, resume=resume)
    wait_for_stable_shell(ip)
    session = remote_root()
    directory, _, _ = run_ssh_retry(ip, "remote_session_directory", [*ssh_base(ip), f"mkdir -p {shlex.quote(session)}/transfer"])
    if directory.returncode:
        raise RuntimeError(f"remote session directory failed with exit status {directory.returncode}")

    assets = (
        ("code_bundle", Path(manifest["bundle"]["path"]), manifest["bundle"]["sha256"], f"{session}/transfer/research-model.bundle"),
        ("dataset_archive", Path(manifest["dataset_archive"]["path"]), manifest["dataset_archive"]["sha256"], f"{session}/transfer/research-data.tar.gz"),
    )
    for asset, local_path, expected, remote_path in assets:
        observed, _ = remote_file_sha256(ip, remote_path, f"check_remote_{asset}")
        if observed == expected:
            progress(f"{asset.replace('_', ' ').capitalize()} already present and verified; skipping upload")
            append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "TRANSFER_SKIPPED_VERIFIED", public_ip=ip, asset=asset, remote_path=remote_path, sha256=expected)
            continue
        progress(f"Uploading {asset.replace('_', ' ')}...")
        upload, _, _ = run_ssh_retry(ip, f"upload_{asset}", [*scp_base(ip), str(local_path), remote_target(ip, remote_path)])
        if upload.returncode:
            raise RuntimeError(f"{asset} upload failed with exit status {upload.returncode}")
        verified, _ = remote_file_sha256(ip, remote_path, f"verify_remote_{asset}")
        if verified != expected:
            raise RuntimeError(f"{asset} remote SHA-256 mismatch: expected {expected}, got {verified}")
        append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "TRANSFER_VERIFIED", public_ip=ip, asset=asset, remote_path=remote_path, sha256=expected)

    progress("Starting detached AMD003 runner...")
    bootstrap_args = [
        "bootstrap", SESSION_ID, manifest["bundle"]["sha256"], manifest["dataset_archive"]["sha256"],
        manifest["source_commit"], "true" if resume else "false",
    ]
    bootstrap, stdout_path, _ = run_ssh_retry(
        ip,
        "amd003_detached_bootstrap",
        [*ssh_base(ip), "bash", "-s", "--", *bootstrap_args],
        input_bytes=BOOTSTRAP_REMOTE.read_bytes(),
        live=True,
    )
    if bootstrap.returncode:
        raise RuntimeError(f"AMD003 detached bootstrap failed with exit status {bootstrap.returncode}; inspect {stdout_path}")
    append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "AMD003_DETACHED_STARTED", public_ip=ip, resume=resume)
    print("AMD003 STARTED")
    print("REMOTE JOB IS DETACHED")
    print("SAFE TO DISCONNECT SSH")
    return 0


def status(ip_value: str) -> int:
    ip = validate_ip(ip_value)
    wait_for_stable_shell(ip)
    remote_session = remote_root()
    command = [
        *ssh_base(ip), "python3", f"{remote_session}/research-model/scripts/run_e014_remote.py",
        "status", "--session-root", remote_session,
    ]
    result, stdout_path, _ = run_ssh_retry(ip, "amd003_status", command, live=True)
    if result.returncode:
        raise RuntimeError(f"AMD003 status failed with exit status {result.returncode}")
    if not stdout_path.read_text(encoding="utf-8", errors="replace").strip():
        raise RuntimeError("AMD003 status returned no output")
    return 0


def collect(ip_value: str) -> int:
    ip = validate_ip(ip_value)
    wait_for_stable_shell(ip)
    remote_session = remote_root()
    package_command = [
        *ssh_base(ip), "python3", f"{remote_session}/research-model/scripts/run_e014_remote.py",
        "package", "--session-root", remote_session,
    ]
    package, _, _ = run_ssh_retry(ip, "amd003_remote_package", package_command, live=True)
    if package.returncode:
        raise RuntimeError(f"remote AMD003 package failed with exit status {package.returncode}")
    collection = COLLECTED_ROOT / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    collection.mkdir(parents=True, exist_ok=False)
    archive = f"{remote_session}/result/AMD003-e014-results.tar.gz"
    checksum = f"{archive}.sha256"
    for label, remote_path in (("result_archive", archive), ("result_archive_sha256", checksum)):
        result, _, _ = run_ssh_retry(ip, f"collect_{label}", [*scp_base(ip), remote_path, str(collection / Path(remote_path).name)])
        if result.returncode:
            raise RuntimeError(f"collection of {label} failed with exit status {result.returncode}")
    local_archive = collection / Path(archive).name
    local_digest = sha256(local_archive)
    remote_digest = (collection / Path(checksum).name).read_text(encoding="utf-8").split()[0]
    if local_digest != remote_digest:
        raise RuntimeError(f"collected result archive SHA-256 mismatch: expected {remote_digest}, got {local_digest}")
    atomic_json(
        collection / "collection_manifest.json",
        {"session_id": SESSION_ID, "public_ip": ip, "archive": str(local_archive), "sha256": local_digest, "collected_at_utc": now_utc()},
    )
    append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "AMD003_RESULT_COLLECTED", public_ip=ip, collection_path=str(collection), archive_sha256=local_digest)
    print(f"AMD003 RESULT COLLECTED: {local_archive}")
    print(f"SHA256: {local_digest}")
    return 0


def dry_run() -> int:
    template = json.loads(TRANSFER_TEMPLATE.read_text(encoding="utf-8"))
    print(json.dumps({
        "status": "OFFLINE_ONLY",
        "cloud_compute_contacted": False,
        "provider_instance_created": False,
        "planned_after_ip_command": "bash scripts/amd003_session.sh start <PUBLIC_IP>",
        "planned_remote_steps": [
            "three consecutive clean SSH sentinel probes",
            "idempotent code-bundle and dataset upload with bounded transient retries",
            "remote hash verification",
            "single detached tmux or start_new_session runner launch",
            "immediate detached-process verification",
        ],
        "remote_training_and_evaluation": "detached after bootstrap; Mac SSH is not a supervisor",
        "template_session_id": template.get("session_id"),
    }, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("prepare", help="build the committed-source bundle and dataset archive locally")
    subparsers.add_parser("dry-run", help="show the AMD003 offline/bootstrap plan without contacting a host")
    start_parser = subparsers.add_parser("start", help="bootstrap and detach AMD003 after the user supplies an IP")
    start_parser.add_argument("public_ip")
    start_parser.add_argument("--resume", action="store_true")
    resume_parser = subparsers.add_parser("resume", help="explicitly resume AMD003 from its latest valid checkpoint")
    resume_parser.add_argument("public_ip")
    status_parser = subparsers.add_parser("status", help="fetch one current remote status snapshot")
    status_parser.add_argument("public_ip")
    collect_parser = subparsers.add_parser("collect", help="retrieve the packaged result archive")
    collect_parser.add_argument("public_ip")
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            result = prepare()
            print(json.dumps({"status": "AMD003_OFFLINE_STAGED", "source_commit": result["source_commit"], "bundle": result["bundle"], "dataset_archive": result["dataset_archive"], "cloud_compute_contacted": False}, indent=2))
            return 0
        if args.command == "dry-run":
            return dry_run()
        if args.command == "start":
            return start(args.public_ip, args.resume)
        if args.command == "resume":
            return start(args.public_ip, True)
        if args.command == "status":
            return status(args.public_ip)
        if args.command == "collect":
            return collect(args.public_ip)
        raise RuntimeError(f"unknown command {args.command}")
    except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"amd003_session: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

