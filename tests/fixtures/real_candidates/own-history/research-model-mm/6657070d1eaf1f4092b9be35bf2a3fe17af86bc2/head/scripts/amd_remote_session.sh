#!/usr/bin/env bash
set -euo pipefail

# This script is streamed by scripts/amd_session.py before the Git bundle has
# been unpacked. It never provisions or destroys an instance. All paths below
# are session-scoped so a failed run is recoverable without overwriting data.

MODE="${1:-}"
if [[ "$MODE" != "bootstrap" ]]; then
  echo "usage: amd_remote_session.sh bootstrap SESSION_ID BUNDLE_SHA256 DATA_ARCHIVE_SHA256 SOURCE_COMMIT" >&2
  exit 2
fi

SESSION_ID="${2:?missing session id}"
BUNDLE_SHA256="${3:?missing bundle sha256}"
DATA_ARCHIVE_SHA256="${4:?missing dataset archive sha256}"
SOURCE_COMMIT="${5:?missing source commit}"

case "$SESSION_ID" in
  AMD[0-9][0-9][0-9]) ;;
  *) echo "invalid session id" >&2; exit 2 ;;
esac

REMOTE_PARENT="${AMD_REMOTE_PARENT:-/root/amd-e014-sessions}"
SESSION_ROOT="$REMOTE_PARENT/$SESSION_ID"
TRANSFER_ROOT="$SESSION_ROOT/transfer"
REPO_ROOT="$SESSION_ROOT/research-model"
LOG_ROOT="$SESSION_ROOT/logs"
ENV_ROOT="$SESSION_ROOT/environment"
TELEMETRY_ROOT="$SESSION_ROOT/telemetry"
COST_ROOT="$SESSION_ROOT/cost"
FAILURE_ROOT="$SESSION_ROOT/failures"
COLLECTION_ROOT="$SESSION_ROOT/collection"
TIMELINE="$SESSION_ROOT/timeline.jsonl"
COMMAND_LOG="$SESSION_ROOT/commands.jsonl"
BUNDLE_PATH="$TRANSFER_ROOT/research-model.bundle"
DATA_ARCHIVE_PATH="$TRANSFER_ROOT/research-data.tar.gz"
QUALIFICATION_ROOT="$REPO_ROOT/outputs/hardware-qualification/E014/AMD_MI300X"
TELEMETRY_PID=""
SESSION_STARTED_EPOCH="$(date +%s.%N)"
SETUP_STARTED_EPOCH=""
QUALIFICATION_STARTED_EPOCH=""

mkdir -p "$TRANSFER_ROOT" "$LOG_ROOT" "$ENV_ROOT" "$TELEMETRY_ROOT" "$COST_ROOT" "$FAILURE_ROOT" "$COLLECTION_ROOT"
touch "$TIMELINE" "$COMMAND_LOG"

append_jsonl() {
  local path="$1"
  local event="$2"
  local fields="${3:-{}}"
  python3 - "$path" "$event" "$fields" <<'PY'
import json
import socket
import sys
from datetime import datetime, timezone

path, event, raw_fields = sys.argv[1:]
try:
    fields = json.loads(raw_fields)
except json.JSONDecodeError:
    fields = {"detail": raw_fields}
record = {
    "timestamp_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "timestamp_local": datetime.now().astimezone().isoformat(timespec="seconds"),
    "host": socket.gethostname(),
    "event": event,
    **fields,
}
with open(path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n")
    handle.flush()
PY
}

append_command() {
  local event="$1"
  local label="$2"
  local command="$3"
  local status="$4"
  local duration="$5"
  local stdout_path="$6"
  local stderr_path="$7"
  local fields
  fields="$(python3 - "$label" "$command" "$status" "$duration" "$stdout_path" "$stderr_path" <<'PY'
import json
import sys

label, command, status, duration, stdout_path, stderr_path = sys.argv[1:]
print(json.dumps({
    "label": label,
    "command": command,
    "exit_status": int(status),
    "duration_seconds": float(duration),
    "stdout_path": stdout_path,
    "stderr_path": stderr_path,
}))
PY
)"
  append_jsonl "$COMMAND_LOG" "$event" "$fields"
}

run_logged() {
  local label="$1"
  shift
  local command_display
  command_display="$(printf '%q ' "$@")"
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local stdout_path="$LOG_ROOT/${stamp}-${label}.stdout.log"
  local stderr_path="$LOG_ROOT/${stamp}-${label}.stderr.log"
  local start_ns
  start_ns="$(date +%s%N)"
  append_command "COMMAND_STARTED" "$label" "$command_display" 0 0 "$stdout_path" "$stderr_path"
  set +e
  "$@" >"$stdout_path" 2>"$stderr_path"
  local status=$?
  set -e
  local end_ns
  end_ns="$(date +%s%N)"
  local duration
  duration="$(python3 - "$start_ns" "$end_ns" <<'PY'
import sys
print(round((int(sys.argv[2]) - int(sys.argv[1])) / 1_000_000_000, 3))
PY
)"
  append_command "COMMAND_COMPLETED" "$label" "$command_display" "$status" "$duration" "$stdout_path" "$stderr_path"
  return "$status"
}

system_snapshot() {
  local label="$1"
  mkdir -p "$ENV_ROOT" "$TELEMETRY_ROOT"
  uname -a >"$ENV_ROOT/${label}.uname.txt" 2>&1 || true
  if [[ -f /etc/os-release ]]; then cp /etc/os-release "$ENV_ROOT/${label}.os-release.txt"; fi
  lscpu >"$ENV_ROOT/${label}.lscpu.txt" 2>&1 || true
  free -b >"$ENV_ROOT/${label}.memory.txt" 2>&1 || true
  df -B1 >"$ENV_ROOT/${label}.disk.txt" 2>&1 || df -k >"$ENV_ROOT/${label}.disk.txt" 2>&1 || true
  python3 --version >"$ENV_ROOT/${label}.python.txt" 2>&1 || true
  if command -v uv >/dev/null 2>&1; then uv --version >"$ENV_ROOT/${label}.uv.txt" 2>&1 || true; fi
  env | LC_ALL=C sort | awk -F= '{key=$1; if (key ~ /(TOKEN|PASSWORD|SECRET|PRIVATE|CREDENTIAL|AUTH|ACCESS_KEY)/) print key"=<redacted>"; else print}' >"$ENV_ROOT/${label}.environment.txt" 2>&1 || true
  if [[ -x "$REPO_ROOT/.venv/bin/python" ]]; then
    "$REPO_ROOT/.venv/bin/python" - <<'PY' >"$ENV_ROOT/${label}.packages.json" 2>&1 || true
import importlib.metadata
import json
import platform
import sys

names = ["torch", "transformers", "peft", "trl", "bitsandbytes", "accelerate", "datasets"]
versions = {}
for name in names:
    try:
        versions[name] = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        versions[name] = None
try:
    import torch
    versions["torch_version"] = torch.__version__
    versions["torch_hip_version"] = torch.version.hip
    versions["torch_cuda_version"] = torch.version.cuda
except Exception as exc:
    versions["torch_import_error"] = f"{type(exc).__name__}: {exc}"
print(json.dumps({"python": sys.version, "platform": platform.platform(), "packages": versions}, indent=2))
PY
  fi
  if command -v amd-smi >/dev/null 2>&1; then
    amd-smi --json >"$TELEMETRY_ROOT/${label}.amd-smi.json" 2>&1 || true
    amd-smi static --json >"$TELEMETRY_ROOT/${label}.amd-smi-static.json" 2>&1 || true
    amd-smi metric --json >"$TELEMETRY_ROOT/${label}.amd-smi-metric.json" 2>&1 || true
  elif command -v rocm-smi >/dev/null 2>&1; then
    rocm-smi --showallinfo >"$TELEMETRY_ROOT/${label}.rocm-smi.txt" 2>&1 || true
  fi
  if command -v rocminfo >/dev/null 2>&1; then
    rocminfo >"$ENV_ROOT/${label}.rocminfo.txt" 2>&1 || true
  fi
}

telemetry_snapshot() {
  local label="$1"
  if command -v amd-smi >/dev/null 2>&1; then
    amd-smi list --json >"$TELEMETRY_ROOT/${label}.list.json" 2>&1 || true
    amd-smi monitor --json >"$TELEMETRY_ROOT/${label}.monitor.json" 2>&1 || true
    amd-smi metric --json >"$TELEMETRY_ROOT/${label}.metric.json" 2>&1 || true
  elif command -v rocm-smi >/dev/null 2>&1; then
    rocm-smi --showuse --showmemuse --showpwr --showtemp --showclocks >"$TELEMETRY_ROOT/${label}.rocm-smi.txt" 2>&1 || true
  fi
}

start_telemetry() {
  local output="$TELEMETRY_ROOT/during_smoke.amd-smi-monitor.jsonl"
  local errors="$TELEMETRY_ROOT/during_smoke.amd-smi-monitor.stderr.log"
  if command -v amd-smi >/dev/null 2>&1; then
    amd-smi monitor --json --watch 2 --watch_time 86400 >"$output" 2>"$errors" &
    TELEMETRY_PID=$!
  elif command -v rocm-smi >/dev/null 2>&1; then
    rocm-smi --showuse --showmemuse --showpwr --showtemp --showclocks --csv --logfile "$TELEMETRY_ROOT/during_smoke.rocm-smi.csv" >/dev/null 2>"$errors" &
    TELEMETRY_PID=$!
  fi
  if [[ -n "$TELEMETRY_PID" ]]; then
    echo "$TELEMETRY_PID" >"$TELEMETRY_ROOT/during_smoke.pid"
  fi
}

stop_telemetry() {
  if [[ -n "$TELEMETRY_PID" ]]; then
    kill "$TELEMETRY_PID" 2>/dev/null || true
    wait "$TELEMETRY_PID" 2>/dev/null || true
    TELEMETRY_PID=""
  fi
}

write_cost_estimate() {
  local report="$QUALIFICATION_ROOT/$(find "$QUALIFICATION_ROOT" -maxdepth 2 -name qualification_report.json -type f -print -quit 2>/dev/null | sed "s#^$QUALIFICATION_ROOT/##")"
  python3 - "$COST_ROOT/cost_estimate.json" "$SESSION_STARTED_EPOCH" "$QUALIFICATION_STARTED_EPOCH" "$report" <<'PY'
import json
import sys
import time
from pathlib import Path

output, session_started_raw, qualification_started_raw, report_raw = sys.argv[1:]
rate = 1.99
session_started = float(session_started_raw) if session_started_raw else None
qualification_started = float(qualification_started_raw) if qualification_started_raw else None
finished = time.time()
session_elapsed = max(0.0, finished - session_started) if session_started is not None else None
qualification_elapsed = max(0.0, finished - qualification_started) if qualification_started is not None else None
record = {
    "classification": "CALCULATED_LOWER_BOUND",
    "provider_displayed_rate_usd_per_hour": rate,
    "provider_billed_cost_usd": None,
    "billing_start_timestamp_utc": None,
    "billing_end_timestamp_utc": None,
    "session_wall_seconds": session_elapsed,
    "session_elapsed_cost_usd": (session_elapsed / 3600.0 * rate) if session_elapsed is not None else None,
    "qualification_wall_seconds": qualification_elapsed,
    "qualification_elapsed_cost_usd": (qualification_elapsed / 3600.0 * rate) if qualification_elapsed is not None else None,
    "report_path": report_raw or None,
    "projected_full_training_hours": None,
    "projected_full_training_cost_usd": None,
    "projected_evaluation_hours": None,
    "notes": [
        "The provider billing start is not inferred from SSH availability.",
        "The displayed rate is not a provider invoice.",
        "Full-training projection is populated only after a passed smoke report supplies a median step time.",
    ],
}
if report_raw and Path(report_raw).is_file():
    try:
        report = json.loads(Path(report_raw).read_text(encoding="utf-8"))
        median_step = report.get("median_optimizer_step_seconds")
        if median_step is not None:
            hours = float(median_step) * 2454.0 / 3600.0
            record["projected_full_training_hours"] = hours
            record["projected_full_training_cost_usd"] = hours * rate
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        record["report_parse_error"] = True
Path(output).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
PY
}

finalize() {
  local status="$1"
  local detail="${2:-}"
  stop_telemetry
  system_snapshot "after_${status}" || true
  telemetry_snapshot "after_${status}" || true
  if [[ -d "$QUALIFICATION_ROOT" ]]; then
    mkdir -p "$COLLECTION_ROOT/qualification"
    cp -a "$QUALIFICATION_ROOT/." "$COLLECTION_ROOT/qualification/" || true
  fi
  write_cost_estimate || true
  python3 - "$SESSION_ROOT/remote_status.json" "$status" "$detail" "$SOURCE_COMMIT" <<'PY'
import json
import sys
from datetime import datetime, timezone

path, status, detail, commit = sys.argv[1:]
record = {
    "status": status,
    "detail": detail,
    "finished_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "source_commit": commit,
    "model_quality_result": False,
    "full_training_started": False,
    "safe_to_destroy_instance_after_artifact_collection": True,
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2)
    handle.write("\n")
PY
  if [[ "$status" == "passed" ]]; then
    append_jsonl "$TIMELINE" "SMOKE_COMPLETED" '{"status":"passed"}'
    echo "QUALIFICATION COMPLETE"
  else
    append_jsonl "$TIMELINE" "SMOKE_FAILED" "$(python3 -c 'import json,sys; print(json.dumps({"status":"failed","detail":sys.argv[1]}))' "$detail")"
    echo "QUALIFICATION FAILED" >&2
  fi
  echo "REMOTE ARTIFACTS READY FOR COLLECTION"
  echo "SAFE TO DESTROY INSTANCE AFTER LOCAL ARTIFACT COLLECTION"
}

fail() {
  local detail="$1"
  append_jsonl "$TIMELINE" "FAILURE" "$(python3 -c 'import json,sys; print(json.dumps({"detail":sys.argv[1]}))' "$detail")"
  printf '%s\n' "$detail" >"$FAILURE_ROOT/failure.txt"
  finalize failed "$detail"
  exit 1
}

system_snapshot "before_transfer"
if [[ ! -f "$BUNDLE_PATH" || "$(sha256sum "$BUNDLE_PATH" | awk '{print $1}')" != "$BUNDLE_SHA256" ]]; then
  fail "code bundle SHA-256 mismatch or missing on remote host"
fi
if [[ ! -f "$DATA_ARCHIVE_PATH" || "$(sha256sum "$DATA_ARCHIVE_PATH" | awk '{print $1}')" != "$DATA_ARCHIVE_SHA256" ]]; then
  fail "dataset archive SHA-256 mismatch or missing on remote host"
fi
append_jsonl "$TIMELINE" "TRANSFER_COMPLETED" "$(python3 - "$BUNDLE_PATH" "$DATA_ARCHIVE_PATH" <<'PY'
import json
import os
import sys
print(json.dumps({"bundle_path": sys.argv[1], "dataset_archive_path": sys.argv[2], "verified": True, "bytes": {"bundle": os.path.getsize(sys.argv[1]), "dataset_archive": os.path.getsize(sys.argv[2])}}))
PY
)"

if [[ -e "$REPO_ROOT" ]]; then
  fail "refusing to overwrite an existing remote checkout"
fi
mkdir -p "$(dirname "$REPO_ROOT")"
if ! run_logged checkout_bundle git clone --quiet "$BUNDLE_PATH" "$REPO_ROOT"; then
  fail "Git bundle checkout failed"
fi
if ! run_logged checkout_commit git -C "$REPO_ROOT" checkout --quiet --detach "$SOURCE_COMMIT"; then
  fail "remote checkout could not select the expected source commit"
fi
if [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$SOURCE_COMMIT" ]]; then
  fail "remote checkout commit mismatch"
fi

mkdir -p "$REPO_ROOT/data/generated"
if ! run_logged extract_dataset tar -xzf "$DATA_ARCHIVE_PATH" -C "$REPO_ROOT/data/generated" --no-same-owner --no-same-permissions; then
  fail "dataset archive extraction failed"
fi
DATA_PATH="$REPO_ROOT/data/generated/research-data-v0.1-expanded.jsonl"
if [[ ! -f "$DATA_PATH" || "$(sha256sum "$DATA_PATH" | awk '{print $1}')" != "703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f" ]]; then
  fail "frozen dataset SHA-256 mismatch after extraction"
fi
python3 - "$TRANSFER_ROOT/manifest.remote.json" "$BUNDLE_PATH" "$DATA_ARCHIVE_PATH" "$SOURCE_COMMIT" <<'PY'
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

output, bundle, archive, commit = sys.argv[1:]
def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return {"path": path, "bytes": os.path.getsize(path), "sha256": h.hexdigest()}
record = {
    "record_type": "remote_transfer_verification",
    "verified_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "source_commit": commit,
    "bundle": digest(bundle),
    "dataset_archive": digest(archive),
    "extracted_dataset_sha256": "703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f",
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(record, handle, indent=2)
    handle.write("\n")
PY
append_jsonl "$TIMELINE" "TRANSFER_HASHES_VERIFIED" '{"dataset_sha256":"703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f","benchmark_files_in_git":true}'

if ! command -v uv >/dev/null 2>&1 || [[ "$(uv --version 2>/dev/null)" != uv\ 0.11.3* ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    fail "uv 0.11.3 is unavailable and curl cannot install the pinned standalone uv"
  fi
  mkdir -p "$SESSION_ROOT/bin"
  append_jsonl "$TIMELINE" "UV_INSTALL_STARTED" '{"version":"0.11.3"}'
  if ! run_logged install_uv bash -c "curl -LsSf https://astral.sh/uv/0.11.3/install.sh | env UV_UNMANAGED_INSTALL='$SESSION_ROOT/bin' sh"; then
    fail "pinned uv installation failed"
  fi
  export PATH="$SESSION_ROOT/bin:$PATH"
fi
if ! command -v uv >/dev/null 2>&1; then
  fail "uv was not available after installation"
fi

SETUP_STARTED_EPOCH="$(date +%s.%N)"
append_jsonl "$TIMELINE" "ENV_SETUP_STARTED" '{"image":"ROCm Software 10.0","python":"3.13"}'
cd "$REPO_ROOT"
if ! run_logged environment_setup bash "$REPO_ROOT/scripts/prepare_amd_host.sh"; then
  fail "pinned AMD environment setup failed"
fi
append_jsonl "$TIMELINE" "ENV_SETUP_COMPLETED" '{}'
system_snapshot "after_setup"

append_jsonl "$TIMELINE" "INVARIANT_CHECK_STARTED" '{}'
if ! run_logged invariant_check "$REPO_ROOT/.venv/bin/python" "$REPO_ROOT/scripts/validate_e014_invariants.py"; then
  fail "frozen E014 invariant validation failed"
fi
append_jsonl "$TIMELINE" "INVARIANT_CHECK_PASSED" '{}'
if ! run_logged hardware_preflight bash "$REPO_ROOT/scripts/qualify_amd.sh" check; then
  fail "MI300X/ROCm preflight failed"
fi

QUALIFICATION_STARTED_EPOCH="$(date +%s.%N)"
append_jsonl "$TIMELINE" "SMOKE_STARTED" '{"steps":6,"fresh_process_resume":true}'
system_snapshot "before_model_load"
telemetry_snapshot "before_model_load"
start_telemetry
if run_logged qualification bash "$REPO_ROOT/scripts/qualify_amd.sh" run; then
  finalize passed "six-step smoke and fresh-process resume passed"
  exit 0
else
  finalize failed "six-step smoke or fresh-process resume failed"
  exit 1
fi
