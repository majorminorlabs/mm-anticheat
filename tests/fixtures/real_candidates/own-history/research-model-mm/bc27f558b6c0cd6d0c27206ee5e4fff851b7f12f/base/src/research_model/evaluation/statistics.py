"""Small deterministic paired-bootstrap utilities for experiment reports."""

from __future__ import annotations

import random
from typing import Any


def paired_bootstrap(base_scores: list[dict[str, Any]], tuned_scores: list[dict[str, Any]], metrics: list[str] | None = None, samples: int = 2000, seed: int = 17) -> dict[str, Any]:
    base = {row.get("example_id"): row for row in base_scores}
    tuned = {row.get("example_id"): row for row in tuned_scores}
    ids = sorted(set(base) & set(tuned))
    if not ids:
        return {"n": 0, "samples": samples, "seed": seed, "metrics": {}}
    candidate_metrics = metrics or sorted({key for row in base_scores + tuned_scores for key, value in row.items() if isinstance(value, (int, float))})
    rng = random.Random(seed)
    result: dict[str, Any] = {}
    for metric in candidate_metrics:
        differences = [float(tuned[item].get(metric, 0.0)) - float(base[item].get(metric, 0.0)) for item in ids if isinstance(tuned[item].get(metric, 0.0), (int, float)) and isinstance(base[item].get(metric, 0.0), (int, float))]
        if not differences:
            continue
        estimates = []
        for _ in range(samples):
            draw = [differences[rng.randrange(len(differences))] for _ in differences]
            estimates.append(sum(draw) / len(draw))
        estimates.sort()
        lo = estimates[max(0, int(samples * 0.025) - 1)]
        hi = estimates[min(len(estimates) - 1, int(samples * 0.975))]
        result[metric] = {"n": len(differences), "mean_delta": sum(differences) / len(differences), "ci95": [lo, hi]}
    return {"n": len(ids), "samples": samples, "seed": seed, "metrics": result}
