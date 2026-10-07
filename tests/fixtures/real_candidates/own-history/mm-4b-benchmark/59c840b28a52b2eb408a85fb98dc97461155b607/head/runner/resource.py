"""Resource eligibility helpers; model runs must record baseline and run snapshots."""

def eligibility(snapshot, baseline=None):
    """Return eligibility without conflating pre-existing baseline swap with inference swap."""
    baseline = baseline or {}
    available = snapshot.get("available_gib")
    inference_swap = snapshot.get("inference_swap_gib", 0.0)
    instability = bool(snapshot.get("memory_instability", False))
    baseline_swap = baseline.get("swap_used_gib", 0.0)
    total_swap = snapshot.get("swap_used_gib", baseline_swap)
    attributable = max(0.0, total_swap - baseline_swap) if snapshot.get("swap_attribution") != "explicit" else inference_swap
    return {"eligible": available is not None and available >= 5.0 and attributable == 0.0 and not instability, "available_ok": available is not None and available >= 5.0, "inference_swap_gib": attributable, "baseline_swap_gib": baseline_swap, "memory_instability": instability}
