from __future__ import annotations

import sys
from pathlib import Path

import pytest
torch = pytest.importorskip("torch")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from qualify_nvidia import _fixed_length_collator


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


def test_qualification_batches_are_exact_length_with_masked_padding() -> None:
    collate = _fixed_length_collator(TinyTokenizer(), 8)
    batch = collate([
        {"input_ids": [11, 12, 13], "attention_mask": [1, 1, 1], "text": "unused"},
        {"input_ids": [21, 22], "attention_mask": [1, 1]},
    ])
    assert tuple(batch["input_ids"].shape) == (2, 8)
    assert tuple(batch["labels"].shape) == (2, 8)
    assert batch["labels"][0, :3].tolist() == [11, 12, 13]
    assert batch["labels"][0, 3:].tolist() == [-100] * 5
    assert batch["labels"][1, :2].tolist() == [21, 22]


def test_qualification_rejects_sequence_longer_than_profile_cap() -> None:
    collate = _fixed_length_collator(TinyTokenizer(), 4)
    with pytest.raises(ValueError, match="exceeds"):
        collate([{"input_ids": [1, 2, 3, 4, 5], "attention_mask": [1] * 5}])
