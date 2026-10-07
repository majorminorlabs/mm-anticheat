"""Execution-only NVIDIA hardware profiles for the frozen training recipe."""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any


def load_hardware_profile(name: str, path: str | Path) -> dict[str, Any]:
    with Path(path).open("rb") as handle:
        document = tomllib.load(handle)
    profiles = document.get("profiles", {})
    if name not in profiles:
        raise ValueError(f"unknown NVIDIA hardware profile {name!r}; choose one of: {', '.join(sorted(profiles))}")
    profile = dict(profiles[name])
    profile.update({key: value for key, value in document.items() if key != "profiles"})
    profile["name"] = name
    return profile


def apply_hardware_profile(config: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Return runtime overrides while enforcing the preregistered global batch."""

    effective_batch = (
        int(profile["per_device_train_batch_size"])
        * int(profile["gradient_accumulation_steps"])
        * int(profile["world_size"])
    )
    expected_batch = int(profile["effective_global_batch_size"])
    if effective_batch != expected_batch:
        raise ValueError(
            f"hardware profile {profile['name']} gives global batch {effective_batch}; expected {expected_batch}"
        )
    if int(config["max_seq_length"]) != int(profile["max_sequence_length"]):
        raise ValueError("hardware profile cannot change the preregistered sequence length")
    if int(config["per_device_train_batch_size"]) * int(config["gradient_accumulation_steps"]) != expected_batch:
        raise ValueError("frozen training config does not match the profiles' effective global batch")

    result = dict(config)
    result["per_device_train_batch_size"] = int(profile["per_device_train_batch_size"])
    result["gradient_accumulation_steps"] = int(profile["gradient_accumulation_steps"])
    result["hardware_profile"] = profile["name"]
    result["execution_world_size"] = int(profile["world_size"])
    result["effective_global_batch_size"] = effective_batch
    return result


def validate_visible_gpus(torch: Any, profile: dict[str, Any], world_size: int) -> list[dict[str, Any]]:
    expected_world_size = int(profile["world_size"])
    visible_count = int(torch.cuda.device_count())
    if world_size != expected_world_size:
        raise RuntimeError(
            f"profile {profile['name']} requires world size {expected_world_size}, got {world_size}; "
            "use the matching python/torchrun command"
        )
    if visible_count != expected_world_size:
        raise RuntimeError(
            f"profile {profile['name']} requires exactly {expected_world_size} visible GPU(s), got {visible_count}; "
            "set CUDA_VISIBLE_DEVICES explicitly if the host has additional devices"
        )
    required_name = str(profile["expected_gpu_name_contains"]).casefold()
    minimum_bytes = float(profile["minimum_vram_gib"]) * (1024**3)
    devices: list[dict[str, Any]] = []
    for index in range(visible_count):
        props = torch.cuda.get_device_properties(index)
        name = str(props.name)
        memory_bytes = int(props.total_memory)
        if required_name not in name.casefold():
            raise RuntimeError(
                f"profile {profile['name']} expects GPU name containing {profile['expected_gpu_name_contains']!r}; "
                f"device {index} is {name!r}"
            )
        if memory_bytes < minimum_bytes:
            raise RuntimeError(
                f"profile {profile['name']} requires at least {profile['minimum_vram_gib']} GiB per GPU; "
                f"device {index} exposes {memory_bytes / (1024**3):.2f} GiB"
            )
        devices.append({
            "index": index,
            "name": name,
            "vram_bytes": memory_bytes,
            "compute_capability": list(torch.cuda.get_device_capability(index)),
        })
    return devices
