"""Validate the committed AMD001 session record and optional local transfer assets."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SESSION_MANIFEST = ROOT / "cloud_runs/AMD001_mi300x_e014_qualification/manifest.json"
INVARIANTS = ROOT / "configs/research/e014_scientific_invariants_v1.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate(manifest_path: Path = SESSION_MANIFEST, transfer_path: Path | None = None) -> dict[str, Any]:
    failures: list[str] = []
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    invariants = json.loads(INVARIANTS.read_text(encoding="utf-8"))
    if manifest.get("session_id") != "AMD001":
        failures.append("session_id must be AMD001")
    if manifest.get("status") != "READY_TO_CLICK_CREATE":
        failures.append("session status must remain READY_TO_CLICK_CREATE before provisioning")
    if manifest.get("no_cloud_compute_started_at_creation") is not True:
        failures.append("manifest must assert that no cloud compute had started at creation")
    if manifest.get("no_model_quality_result_exists") is not True:
        failures.append("manifest must assert that no model-quality result exists")
    if manifest.get("private_keys_or_secrets_committed") is not False:
        failures.append("manifest must assert that private keys and secrets were not committed")
    if manifest.get("provider_intent", {}).get("displayed_rate_usd_per_hour") != 1.99:
        failures.append("provider displayed rate must be the observed 1.99 USD/hour")
    expected_invariant_hash = sha256(INVARIANTS)
    if manifest.get("frozen_e014", {}).get("invariants_sha256_at_record_creation") != expected_invariant_hash:
        failures.append("E014 invariant snapshot hash in session record does not match the file")
    for field, expected in (
        ("dataset", "703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f"),
        ("research_benchmark", "3f1f859a10f1bb34ebb22197fadfeba08f2f812c2346a9d75c2b1b7e97b878c4"),
        ("control_benchmark", "b9ff1050dd05eeaf062aba8e8fce1f0a39ffc7da68754d02f011779780628636"),
    ):
        path = manifest.get("frozen_e014", {}).get(field, {}).get("path")
        if not path or sha256(ROOT / path) != expected:
            failures.append(f"frozen E014 {field} hash does not match")

    transfer: dict[str, Any] | None = None
    if transfer_path:
        transfer = json.loads(transfer_path.read_text(encoding="utf-8"))
        bundle = Path(transfer["bundle"]["path"])
        archive = Path(transfer["dataset_archive"]["path"])
        for label, path, expected in (
            ("bundle", bundle, transfer["bundle"]["sha256"]),
            ("dataset archive", archive, transfer["dataset_archive"]["sha256"]),
        ):
            if not path.is_file():
                failures.append(f"{label} is missing: {path}")
            elif sha256(path) != expected:
                failures.append(f"{label} SHA-256 changed after staging")
        if transfer.get("upload_bytes") != transfer["bundle"]["bytes"] + transfer["dataset_archive"]["bytes"]:
            failures.append("transfer upload byte total is inconsistent")

    return {
        "status": "passed" if not failures else "failed",
        "session_id": manifest.get("session_id"),
        "manifest": str(manifest_path.relative_to(ROOT)),
        "transfer_manifest": str(transfer_path) if transfer_path else None,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=SESSION_MANIFEST)
    parser.add_argument("--transfer", type=Path)
    args = parser.parse_args()
    try:
        result = validate(args.manifest, args.transfer)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        result = {"status": "failed", "failures": [f"{type(exc).__name__}: {exc}"]}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
