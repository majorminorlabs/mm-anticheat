from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from qualify_amd import _fixed_length_collator, _verify_selection
from validate_e014_invariants import validate


class TinyTokenizer:
    def pad(self, features, *, padding, max_length, return_tensors):
        assert padding == "max_length"
        assert return_tensors == "pt"
        rows = []
        masks = []
        for feature in features:
            ids = list(feature["input_ids"])
            mask = list(feature.get("attention_mask", [1] * len(ids)))
            amount = max_length - len(ids)
            rows.append(ids + [0] * amount)
            masks.append(mask + [0] * amount)
        return {"input_ids": torch.tensor(rows), "attention_mask": torch.tensor(masks)}


def test_e014_invariant_snapshot_matches_frozen_inputs() -> None:
    result = validate()
    assert result["status"] == "passed", result["failures"]


def test_amd_qualification_collator_uses_exact_length_and_masks_padding() -> None:
    collate = _fixed_length_collator(TinyTokenizer(), 8)
    batch = collate([
        {"input_ids": [11, 12, 13], "attention_mask": [1, 1, 1], "text": "ignored"},
        {"input_ids": [21, 22], "attention_mask": [1, 1]},
    ])
    assert tuple(batch["input_ids"].shape) == (2, 8)
    assert batch["labels"][0, :3].tolist() == [11, 12, 13]
    assert batch["labels"][0, 3:].tolist() == [-100] * 5
    assert batch["labels"][1, :2].tolist() == [21, 22]


def test_amd_qualification_collator_rejects_overlength_examples() -> None:
    collate = _fixed_length_collator(TinyTokenizer(), 4)
    with pytest.raises(ValueError, match="exceeds"):
        collate([{"input_ids": [1, 2, 3, 4, 5], "attention_mask": [1] * 5}])


def test_amd_qualification_rejects_tampered_selection() -> None:
    selection = {
        "selection_policy": "train split only",
        "dataset_file_sha256": "dataset-hash",
        "model_revision": "revision",
        "max_sequence_length": 4608,
        "example_ids": ["one"],
        "token_lengths": [4200],
        "selection_sha256": "not-the-hash",
    }
    with pytest.raises(RuntimeError, match="selection record hash"):
        _verify_selection(selection, {"file_sha256": "dataset-hash"}, {"model_revision": "revision"})


def test_amd_qualification_manifest_is_engineering_only() -> None:
    manifest = json.loads(
        (ROOT / "cloud_runs/AMD001_mi300x_e014_qualification/manifest.json").read_text()
    )
    assert manifest["smoke_protocol"]["qualification_only"] is True
    assert manifest["smoke_protocol"]["full_training_authorized"] is False
    assert manifest["no_model_quality_result_exists"] is True
    assert manifest["no_cloud_compute_started_at_creation"] is True
    assert manifest["provider_intent"]["actual_provider_billed_cost_usd"] is None
