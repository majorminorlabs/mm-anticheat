"""Stage and run the AMD001 MI300X qualification without a provider API."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import shlex
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parents[1]
SESSION_ID = "AMD001"
SESSION_ROOT = ROOT / "cloud_runs" / "AMD001_mi300x_e014_qualification"
RUNTIME_ROOT = SESSION_ROOT / "runtime"
LOG_ROOT = RUNTIME_ROOT / "logs"
COLLECTED_ROOT = RUNTIME_ROOT / "collected"
TRANSFER_TEMPLATE = SESSION_ROOT / "transfer" / "manifest.template.json"
TRANSFER_MANIFEST = RUNTIME_ROOT / "transfer_manifest.json"
DATASET_PATH = ROOT / "data/generated/research-data-v0.1-expanded.jsonl"
DATASET_SHA256 = "703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f"
RESEARCH_BENCHMARK = ROOT / "benchmarks/releases/research-bench-v0.1.jsonl"
RESEARCH_BENCHMARK_SHA256 = "3f1f859a10f1bb34ebb22197fadfeba08f2f812c2346a9d75c2b1b7e97b878c4"
CONTROL_BENCHMARK = ROOT / "benchmarks/control/general-capability-v0.1.jsonl"
CONTROL_BENCHMARK_SHA256 = "b9ff1050dd05eeaf062aba8e8fce1f0a39ffc7da68754d02f011779780628636"
INVARIANTS_PATH = ROOT / "configs/research/e014_scientific_invariants_v1.json"
REMOTE_BOOTSTRAP = ROOT / "scripts/amd_remote_session.sh"
REMOTE_PARENT = "/root/amd-e014-sessions"
PROVIDER_RATE_USD_PER_HOUR = 1.99
SOURCE_COMMIT_REQUIRED_FILES = (
    "configs/research/e014_scientific_invariants_v1.json",
    "docs/hardware/E014_AMD_qualification.md",
    "cloud_runs/AMD001_mi300x_e014_qualification/manifest.json",
    "cloud_runs/AMD001_mi300x_e014_qualification/transfer/manifest.template.json",
    "scripts/amd_remote_session.sh",
    "scripts/amd_session.py",
    "scripts/amd_session.sh",
    "scripts/prepare_amd_host.sh",
    "scripts/qualify_amd.py",
    "scripts/qualify_amd.sh",
    "scripts/validate_amd_session.py",
    "scripts/validate_e014_invariants.py",
)


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def append_jsonl(path: Path, event: str, **fields: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp_utc": now_utc(),
        "timestamp_local": datetime.now().astimezone().isoformat(timespec="seconds"),
        "host": socket.gethostname(),
        "event": event,
        **fields,
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(path: Path, expected_sha256: str | None = None) -> dict[str, Any]:
    if not path.is_file():
        raise RuntimeError(f"required transfer file is missing: {path}")
    actual = sha256(path)
    if expected_sha256 and actual != expected_sha256:
        raise RuntimeError(f"SHA-256 mismatch for {path}: expected {expected_sha256}, got {actual}")
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": actual}


def git_output(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def runtime_command_log() -> Path:
    return RUNTIME_ROOT / "commands.jsonl"


def redact_args(args: Sequence[str]) -> list[str]:
    redacted: list[str] = []
    redact_next = False
    for value in args:
        if redact_next:
            redacted.append("<identity-redacted>")
            redact_next = False
        elif value == "-i":
            redacted.append(value)
            redact_next = True
        else:
            redacted.append(value)
    return redacted


def run_logged(
    label: str,
    args: Sequence[str],
    *,
    cwd: Path = ROOT,
    input_bytes: bytes | None = None,
    stdout_path: Path | None = None,
    stderr_path: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stdout_path = stdout_path or LOG_ROOT / f"{stamp}-{label}.stdout.log"
    stderr_path = stderr_path or LOG_ROOT / f"{stamp}-{label}.stderr.log"
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    stderr_path.parent.mkdir(parents=True, exist_ok=True)
    display_args = redact_args([str(value) for value in args])
    display_command = shlex.join(display_args)
    common = {
        "label": label,
        "host": socket.gethostname(),
        "command": display_command,
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
    }
    append_jsonl(runtime_command_log(), "COMMAND_STARTED", **common)
    started = time.monotonic()
    with stdout_path.open("wb") as stdout_handle, stderr_path.open("wb") as stderr_handle:
        result = subprocess.run(
            [str(value) for value in args],
            cwd=cwd,
            input=input_bytes,
            stdout=stdout_handle,
            stderr=stderr_handle,
            check=False,
        )
    duration = round(time.monotonic() - started, 3)
    append_jsonl(
        runtime_command_log(),
        "COMMAND_COMPLETED",
        **common,
        exit_status=result.returncode,
        duration_seconds=duration,
    )
    if check and result.returncode:
        raise RuntimeError(f"{label} failed with exit status {result.returncode}; inspect {stderr_path}")
    return result


def source_commit_and_dirty_state() -> tuple[str, list[str]]:
    commit = git_output("rev-parse", "HEAD")
    status = git_output("status", "--porcelain=v1", "--untracked-files=all")
    return commit, status.splitlines() if status else []


def ensure_required_source_is_committed() -> None:
    for relative in SOURCE_COMMIT_REQUIRED_FILES:
        path = ROOT / relative
        if not path.is_file():
            raise RuntimeError(f"required committed qualification source is missing: {relative}")
        result = subprocess.run(
            ["git", "diff", "--quiet", "HEAD", "--", relative],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(f"qualification source has uncommitted changes; commit it before staging: {relative}")


def prepare() -> dict[str, Any]:
    """Build local-only transfer assets and the exact runtime transfer manifest."""

    SESSION_ROOT.mkdir(parents=True, exist_ok=True)
    runtime_manifest_path = TRANSFER_MANIFEST
    ensure_required_source_is_committed()
    run_logged(
        "local_invariant_validation",
        [sys.executable, str(ROOT / "scripts/validate_e014_invariants.py")],
    )
    run_logged(
        "local_session_manifest_validation",
        [sys.executable, str(ROOT / "scripts/validate_amd_session.py")],
    )
    commit, dirty_paths = source_commit_and_dirty_state()
    source_branch = git_output("branch", "--show-current")
    if not source_branch:
        raise RuntimeError("a named Git branch is required for the portable source bundle")
    staging_root = Path("/tmp/research-model-amd-session") / SESSION_ID
    staging_root.mkdir(parents=True, exist_ok=True)
    bundle_path = staging_root / f"research-model-{commit}.bundle"
    dataset_archive = staging_root / f"research-data-v0.1-expanded-{DATASET_SHA256[:12]}.tar.gz"

    dataset_record = file_record(DATASET_PATH, DATASET_SHA256)
    research_record = file_record(RESEARCH_BENCHMARK, RESEARCH_BENCHMARK_SHA256)
    control_record = file_record(CONTROL_BENCHMARK, CONTROL_BENCHMARK_SHA256)

    if bundle_path.exists():
        raise RuntimeError(f"refusing to overwrite existing code bundle: {bundle_path}")
    run_logged(
        "create_code_bundle",
        ["git", "bundle", "create", str(bundle_path), source_branch],
    )
    run_logged("verify_code_bundle", ["git", "bundle", "verify", str(bundle_path)])
    bundle_record = file_record(bundle_path)

    if dataset_archive.exists():
        previous_manifest_hash = None
        if TRANSFER_MANIFEST.is_file():
            previous = json.loads(TRANSFER_MANIFEST.read_text(encoding="utf-8"))
            if previous.get("dataset_archive", {}).get("path") == str(dataset_archive):
                previous_manifest_hash = previous.get("dataset_archive", {}).get("sha256")
        if previous_manifest_hash and sha256(dataset_archive) != previous_manifest_hash:
            raise RuntimeError(f"existing dataset archive changed after staging: {dataset_archive}")
        run_logged("verify_existing_dataset_archive", ["tar", "-tzf", str(dataset_archive)])
    else:
        run_logged(
            "create_dataset_archive",
            [
                "tar",
                "-czf",
                str(dataset_archive),
                "-C",
                str(DATASET_PATH.parent),
                DATASET_PATH.name,
            ],
        )
    run_logged("verify_dataset_archive", ["tar", "-tzf", str(dataset_archive)])
    archive_record = file_record(dataset_archive)

    runtime_manifest = {
        "schema_version": "1.0",
        "record_type": "amd_session_transfer_manifest",
        "session_id": SESSION_ID,
        "prepared_at_utc": now_utc(),
        "source_commit": commit,
        "source_branch": source_branch,
        "git_dirty_paths_at_staging": dirty_paths,
        "bundle": {
            **bundle_record,
            "remote_filename": "research-model.bundle",
            "includes_only_committed_history": True,
        },
        "dataset_archive": {
            **archive_record,
            "source_file": dataset_record,
            "remote_filename": "research-data.tar.gz",
            "extracts_to": "data/generated/research-data-v0.1-expanded.jsonl",
            "extracted_file_sha256": DATASET_SHA256,
        },
        "remote_bootstrap": {
            "path": str(REMOTE_BOOTSTRAP),
            "bytes": REMOTE_BOOTSTRAP.stat().st_size,
            "sha256": sha256(REMOTE_BOOTSTRAP),
            "transfer_mode": "streamed over the authenticated SSH session; not a separate upload",
        },
        "benchmarks": {
            "research": {**research_record, "transfer_mode": "already included in the Git bundle"},
            "control": {**control_record, "transfer_mode": "already included in the Git bundle"},
        },
        "upload_bytes": bundle_record["bytes"] + archive_record["bytes"],
        "local_model_download": False,
        "remote_model_download": {
            "repository": "Qwen/Qwen3-8B-Base",
            "revision": "49e3418fbbbca6ecbdf9608b4d22e5a407081db4",
            "expected": True,
            "mechanism": "AutoTokenizer/AutoModelForCausalLM from_pretrained with the pinned revision and cache-aware Hugging Face cache",
        },
        "required_remote_hash_checks": [
            "Git bundle commit",
            "dataset archive SHA-256",
            "extracted dataset SHA-256",
            "all E014 invariant source and canonical hashes",
        ],
    }
    atomic_json(runtime_manifest_path, runtime_manifest)
    append_jsonl(
        RUNTIME_ROOT / "timeline.jsonl",
        "SESSION_PREPARED",
        session_id=SESSION_ID,
        source_commit=commit,
        upload_bytes=runtime_manifest["upload_bytes"],
        cloud_compute_started=False,
    )
    return runtime_manifest


def load_transfer_manifest() -> dict[str, Any]:
    if not TRANSFER_MANIFEST.is_file():
        return prepare()
    return json.loads(TRANSFER_MANIFEST.read_text(encoding="utf-8"))


def validate_ip(value: str) -> str:
    try:
        ipaddress.ip_address(value)
    except ValueError as exc:
        raise RuntimeError(f"expected a literal public IP address, got {value!r}") from exc
    return value


def ssh_base(ip: str) -> list[str]:
    target = f"[{ip}]" if ":" in ip else ip
    args = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=12",
    ]
    identity = os.environ.get("AMD_SSH_IDENTITY")
    if identity:
        args.extend(["-i", identity])
    user = os.environ.get("AMD_SSH_USER", "root")
    args.append(f"{user}@{target}")
    return args


def scp_base(ip: str) -> list[str]:
    args = [
        "scp",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=12",
    ]
    identity = os.environ.get("AMD_SSH_IDENTITY")
    if identity:
        args.extend(["-i", identity])
    return args


def remote_target(ip: str, path: str) -> str:
    user = os.environ.get("AMD_SSH_USER", "root")
    target = f"[{ip}]" if ":" in ip else ip
    return f"{user}@{target}:{path}"


def remote_root() -> str:
    return f"{REMOTE_PARENT}/{SESSION_ID}"


def qualify(ip_value: str) -> int:
    ip = validate_ip(ip_value)
    manifest = load_transfer_manifest()
    bundle_path = Path(manifest["bundle"]["path"])
    archive_path = Path(manifest["dataset_archive"]["path"])
    if sha256(bundle_path) != manifest["bundle"]["sha256"]:
        raise RuntimeError("local code bundle changed after staging; rerun prepare")
    if sha256(archive_path) != manifest["dataset_archive"]["sha256"]:
        raise RuntimeError("local dataset archive changed after staging; rerun prepare")
    append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "PUBLIC_IP_RECEIVED", public_ip=ip, manually_supplied=True)
    remote_session_root = remote_root()
    run_logged(
        "ssh_connectivity_check",
        [*ssh_base(ip), "true"],
        check=True,
    )
    append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "SSH_AVAILABLE", public_ip=ip)
    run_logged(
        "remote_session_directory",
        [*ssh_base(ip), f"mkdir -p {shlex.quote(remote_session_root)}/transfer"],
    )
    append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "TRANSFER_STARTED", public_ip=ip)
    run_logged(
        "upload_code_bundle",
        [*scp_base(ip), str(bundle_path), remote_target(ip, f"{remote_session_root}/transfer/research-model.bundle")],
    )
    run_logged(
        "upload_dataset_archive",
        [*scp_base(ip), str(archive_path), remote_target(ip, f"{remote_session_root}/transfer/research-data.tar.gz")],
    )
    append_jsonl(
        RUNTIME_ROOT / "timeline.jsonl",
        "TRANSFER_COMPLETED",
        public_ip=ip,
        upload_bytes=manifest["upload_bytes"],
        bundle_sha256=manifest["bundle"]["sha256"],
        dataset_archive_sha256=manifest["dataset_archive"]["sha256"],
    )
    bootstrap_args = [
        "bootstrap",
        SESSION_ID,
        manifest["bundle"]["sha256"],
        manifest["dataset_archive"]["sha256"],
        manifest["source_commit"],
    ]
    bootstrap_command = [*ssh_base(ip), "bash", "-s", "--", *bootstrap_args]
    bootstrap_bytes = REMOTE_BOOTSTRAP.read_bytes()
    remote_result = run_logged(
        "remote_bootstrap_and_qualification",
        bootstrap_command,
        input_bytes=bootstrap_bytes,
        check=False,
    )
    if remote_result.returncode == 0:
        append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "REMOTE_QUALIFICATION_FINISHED", status="passed")
    else:
        append_jsonl(
            RUNTIME_ROOT / "timeline.jsonl",
            "REMOTE_QUALIFICATION_FINISHED",
            status="failed",
            exit_status=remote_result.returncode,
        )

    collected = collect(ip, qualification_returncode=remote_result.returncode)
    if collected:
        print("QUALIFICATION COMPLETE" if remote_result.returncode == 0 else "QUALIFICATION FAILED")
        print("ARTIFACTS COLLECTED")
        print("SAFE TO DESTROY INSTANCE")
    else:
        print("QUALIFICATION FAILED")
        print("ARTIFACT COLLECTION FAILED; do not destroy until collection is retried")
    return 0 if remote_result.returncode == 0 and collected else 1


def collect(ip_value: str, *, qualification_returncode: int | None = None) -> bool:
    ip = validate_ip(ip_value)
    collection_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    collection_dir = COLLECTED_ROOT / collection_id
    collection_dir.mkdir(parents=True, exist_ok=False)
    archive_path = collection_dir / "AMD001_remote_artifacts.tar.gz"
    remote_session_root = remote_root()
    remote_archive_command = shlex.join(
        [
            "tar",
            "-czf",
            "-",
            "-C",
            remote_session_root,
            "collection",
            "environment",
            "telemetry",
            "logs",
            "transfer/manifest.remote.json",
            "remote_status.json",
            "timeline.jsonl",
            "commands.jsonl",
            "cost",
            "failures",
        ]
    )
    append_jsonl(RUNTIME_ROOT / "timeline.jsonl", "ARTIFACT_COLLECTION_STARTED", public_ip=ip)
    result = run_logged(
        "download_remote_artifacts",
        [*ssh_base(ip), remote_archive_command],
        stdout_path=archive_path,
        check=False,
    )
    if result.returncode:
        append_jsonl(
            RUNTIME_ROOT / "timeline.jsonl",
            "ARTIFACT_COLLECTION_FAILED",
            public_ip=ip,
            exit_status=result.returncode,
        )
        return False
    extraction_dir = collection_dir / "extracted"
    extraction_dir.mkdir()
    run_logged(
        "extract_remote_artifacts",
        ["tar", "-xzf", str(archive_path), "-C", str(extraction_dir)],
    )
    status_path = extraction_dir / "remote_status.json"
    status: dict[str, Any] = {}
    if status_path.is_file():
        status = json.loads(status_path.read_text(encoding="utf-8"))
    local_record = {
        "schema_version": "1.0",
        "session_id": SESSION_ID,
        "collected_at_utc": now_utc(),
        "public_ip": ip,
        "remote_status": status,
        "qualification_returncode": qualification_returncode,
        "archive": {
            "path": str(archive_path),
            "bytes": archive_path.stat().st_size,
            "sha256": sha256(archive_path),
        },
        "extracted_path": str(extraction_dir),
        "provider_billed_cost_usd": None,
        "cost_source": "provider invoice not retrieved by this SSH-only workflow",
    }
    atomic_json(collection_dir / "collection_manifest.json", local_record)
    append_jsonl(
        RUNTIME_ROOT / "timeline.jsonl",
        "ARTIFACT_COLLECTION_COMPLETED",
        public_ip=ip,
        collection_path=str(collection_dir),
        archive_sha256=local_record["archive"]["sha256"],
    )
    return True


def connect(ip_value: str) -> int:
    ip = validate_ip(ip_value)
    result = run_logged("ssh_connectivity_check", [*ssh_base(ip), "true"], check=False)
    if result.returncode == 0:
        print(f"SSH available: {os.environ.get('AMD_SSH_USER', 'root')}@{ip}")
    else:
        print("SSH unavailable; inspect the logged stderr path", file=sys.stderr)
    return result.returncode


def status(ip_value: str) -> int:
    ip = validate_ip(ip_value)
    remote_status_path = f"{remote_root()}/remote_status.json"
    result = run_logged("remote_status", [*ssh_base(ip), f"cat {shlex.quote(remote_status_path)}"], check=False)
    if result.returncode == 0:
        output_path = sorted(LOG_ROOT.glob("*-remote_status.stdout.log"))[-1]
        print(output_path.read_text(encoding="utf-8"))
    return result.returncode


def dry_run() -> int:
    if TRANSFER_MANIFEST.is_file():
        manifest = json.loads(TRANSFER_MANIFEST.read_text(encoding="utf-8"))
    else:
        manifest = json.loads(TRANSFER_TEMPLATE.read_text(encoding="utf-8"))
    planned = {
        "status": "DRY_RUN_ONLY",
        "cloud_compute_contacted": False,
        "provider_api_used": False,
        "provider_instance_created": False,
        "planned_after_ip_command": "bash scripts/amd_session.sh qualify <PUBLIC_IP>",
        "planned_uploads": [
            manifest["bundle"].get("path") or "<local staging bundle>",
            manifest["dataset_archive"].get("path") or "<local staging dataset archive>",
        ],
        "planned_remote_steps": [
            "SSH connectivity check",
            "upload bundle and dataset archive",
            "verify uploaded hashes",
            "checkout exact committed source",
            "install pinned uv/dependencies and the official PyTorch ROCm wheel",
            "snapshot system/GPU/ROCm environment",
            "validate all E014 invariants before model load",
            "run no-model-download MI300X preflight",
            "download Qwen/Qwen3-8B-Base remotely at the pinned revision",
            "run six-step NF4/LoRA save-and-fresh-process-resume smoke",
            "collect telemetry, logs, qualification report, and cost estimate",
        ],
        "planned_remote_destruction": False,
    }
    print(json.dumps(planned, indent=2, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("prepare", help="build local-only bundle/archive and transfer manifest")
    subparsers.add_parser("dry-run", help="show the remote plan without contacting the network")
    for name in ("connect", "qualify", "collect", "status"):
        command = subparsers.add_parser(name)
        command.add_argument("public_ip")
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            result = prepare()
            print(json.dumps({
                "status": "LOCAL_STAGING_READY",
                "code_bundle": result["bundle"],
                "dataset_archive": result["dataset_archive"],
                "upload_bytes": result["upload_bytes"],
                "transfer_manifest": str(TRANSFER_MANIFEST),
                "cloud_compute_contacted": False,
            }, indent=2, ensure_ascii=False))
            return 0
        if args.command == "dry-run":
            return dry_run()
        if args.command == "connect":
            return connect(args.public_ip)
        if args.command == "qualify":
            return qualify(args.public_ip)
        if args.command == "collect":
            return 0 if collect(args.public_ip) else 1
        if args.command == "status":
            return status(args.public_ip)
        raise RuntimeError(f"unknown command: {args.command}")
    except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"amd_session: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
