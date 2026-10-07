from __future__ import annotations

from pathlib import Path

import pytest

from research_model.training.profiles import apply_hardware_profile, load_hardware_profile, validate_visible_gpus
from research_model.training.config import load_toml


ROOT = Path(__file__).resolve().parents[1]
PROFILE_FILE = ROOT / "configs" / "hardware" / "nvidia_profiles.toml"
TRAINING_CONFIG = ROOT / "configs" / "training" / "qwen3_8b_v0.1_qlora.toml"


@pytest.mark.parametrize(
    ("profile_name", "world_size", "accumulation"),
    [
        ("RTX3090_SINGLE", 1, 16),
        ("RTX3090_DUAL", 2, 8),
        ("A100_80GB", 1, 16),
        ("H100_80GB", 1, 16),
        ("A100_40GB", 1, 16),
        ("L40S_48GB", 1, 16),
        ("RTX6000_ADA_48GB", 1, 16),
    ],
)
def test_profile_preserves_frozen_context_and_global_batch(profile_name: str, world_size: int, accumulation: int) -> None:
    profile = load_hardware_profile(profile_name, PROFILE_FILE)
    config = apply_hardware_profile(load_toml(TRAINING_CONFIG), profile)
    assert config["max_seq_length"] == 4608
    assert config["per_device_train_batch_size"] == 1
    assert config["gradient_accumulation_steps"] == accumulation
    assert config["execution_world_size"] == world_size
    assert config["effective_global_batch_size"] == 16


def test_profile_rejects_a_changed_scientific_batch() -> None:
    config = load_toml(TRAINING_CONFIG)
    config["gradient_accumulation_steps"] = 8
    profile = load_hardware_profile("RTX3090_SINGLE", PROFILE_FILE)
    with pytest.raises(ValueError, match="frozen training config"):
        apply_hardware_profile(config, profile)


class FakeCuda:
    def __init__(self, devices: list[tuple[str, int]]) -> None:
        self.devices = devices

    def device_count(self) -> int:
        return len(self.devices)

    def get_device_properties(self, index: int):
        name, memory_bytes = self.devices[index]
        return type("Properties", (), {"name": name, "total_memory": memory_bytes})()

    def get_device_capability(self, index: int) -> tuple[int, int]:
        del index
        return (8, 6)


class FakeTorch:
    def __init__(self, devices: list[tuple[str, int]]) -> None:
        self.cuda = FakeCuda(devices)


def test_single_profile_accepts_matching_gpu_and_memory() -> None:
    profile = load_hardware_profile("RTX3090_SINGLE", PROFILE_FILE)
    torch = FakeTorch([("NVIDIA GeForce RTX 3090", 24 * 1024**3)])
    devices = validate_visible_gpus(torch, profile, 1)
    assert devices[0]["name"].endswith("RTX 3090")


def test_3070_cannot_be_mistaken_for_a_3090_profile() -> None:
    profile = load_hardware_profile("RTX3090_SINGLE", PROFILE_FILE)
    torch = FakeTorch([("NVIDIA GeForce RTX 3070", 8 * 1024**3)])
    with pytest.raises(RuntimeError, match="expects GPU name"):
        validate_visible_gpus(torch, profile, 1)


def test_dual_profile_requires_both_visible_devices() -> None:
    profile = load_hardware_profile("RTX3090_DUAL", PROFILE_FILE)
    torch = FakeTorch([("NVIDIA GeForce RTX 3090", 24 * 1024**3)])
    with pytest.raises(RuntimeError, match="exactly 2 visible GPU"):
        validate_visible_gpus(torch, profile, 2)
