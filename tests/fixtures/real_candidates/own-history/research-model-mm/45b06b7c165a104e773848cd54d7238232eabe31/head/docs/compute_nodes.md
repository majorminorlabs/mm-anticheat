# Managed compute nodes

The small Mac-side node control surface is `scripts/node_control.py` plus
`configs/compute_nodes.json`. It is deliberately separate from
`scripts/e014_controller.py`, which remains the checkpoint-safe E014 training
supervisor and is not a node manager.

## Model

Each registry entry has a stable logical `id`, OS and hardware metadata, an SSH
transport, an inference endpoint/backend, power-management metadata, and a
dispatch capability. Status queries keep transport reachability separate from
inference health. This allows a reachable machine with no installed inference
runtime to be reported accurately.

The registry currently contains:

- `rtx3070`: existing Windows 11 host, SSH alias `research-win`, existing
  llama.cpp server at `http://100.118.128.27:8080`.
- `thinkpad`: Pop!_OS 24.04 LTS host, SSH alias `thinkpad`, no inference
  runtime installed yet.

The current power strategy is `manual` for both nodes. No wake, suspend,
reboot, firewall, Tailscale, or SSH-authentication operation is implemented.
Dispatch is metadata-only in this phase; the controller does not submit jobs.

## Commands

```sh
python3 scripts/node_control.py list
python3 scripts/node_control.py status
python3 scripts/node_control.py status rtx3070
python3 scripts/node_control.py status thinkpad
```

All commands are read-only. The status command performs one bounded SSH probe
and one bounded HTTP health query per selected node.

## Audit findings, 2026-09-17

The ThinkPad is a Lenovo ThinkPad T14 Gen 2a running Pop!_OS 24.04 LTS on an
AMD Ryzen 7 PRO 5850U: 8 cores / 16 threads, approximately 14.5 GiB RAM, 18
GiB zram plus a 4 GiB encrypted swap partition, and roughly 421 GiB free on a
477 GiB Samsung NVMe. Its Radeon Vega iGPU is using the kernel `amdgpu`
driver. `vulkaninfo`, Ollama, llama.cpp, CMake, and Ninja were not installed
at audit time. GCC 13.3, G++, Python 3.12.3, and Git 2.43 were present.

The machine was reachable through passwordless `ssh thinkpad`. It had no
listener on the usual local inference ports and no Ollama API response. The
current desktop workload was using about 4.9 GiB of RAM with about 9.6 GiB
available; this is a desktop-idle observation, not a benchmark baseline.
System76 Power Daemon was active. No power-policy change was made.

The Windows node was independently queried over `research-win`: Windows 11
Home, RTX 3070 8 GiB with driver 591.86, existing `llama-server` PID 21888,
and a healthy Tailscale-bound endpoint on port 8080 serving the existing Q4_K_M
Qwen3-8B GGUF. Its existing configuration was not modified.

## Inference plan

The first ThinkPad comparison should be CPU-only llama.cpp using a small GGUF
that fits comfortably beside the desktop. Vulkan is a separate candidate only
after installing the ordinary Vulkan loader/tools and building a Vulkan-enabled
llama.cpp binary. The Vega path is not presumed faster: record cold start,
prompt processing, generation tokens/second, RSS, swap, temperature, and
stability for CPU and Vulkan under identical model/context/request settings.
No model weights were downloaded and no inference readiness is claimed by this
audit.
