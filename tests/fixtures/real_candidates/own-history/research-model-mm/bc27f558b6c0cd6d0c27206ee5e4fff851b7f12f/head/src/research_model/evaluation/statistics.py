"""Small deterministic paired-bootstrap utilities for experiment reports."""

from __future__ import annotations

import random
from typing import Any


def paired_bootstrap(base_scores: list[dict[str, Any]], tuned_scores: list[dict[str, Any]], metrics: list[str] | None = None, samples: int = 2000, seed: int = 17, id_key: str = "example_id") -> dict[str, Any]:
    base = {row.get(id_key): row for row in base_scores if row.get(id_key) is not None}
    tuned = {row.get(id_key): row for row in tuned_scores if row.get(id_key) is not None}
    ids = sorted(set(base) & set(tuned))
    if not ids:
        return {"n": 0, "samples": samples, "seed": seed, "id_key": id_key, "metrics": {}}
    candidate_metrics = metrics or sorted({key for row in base_scores + tuned_scores for key, value in row.items() if isinstance(value, (int, float))})
    rng = random.Random(seed)
    result: dict[str, Any] = {}
    for metric in candidate_metrics:
        paired_values = [
            (float(base[item][metric]), float(tuned[item][metric]))
            for item in ids
            if isinstance(tuned[item].get(metric), (int, float))
            and isinstance(base[item].get(metric), (int, float))
        ]
        differences = [tuned_value - base_value for base_value, tuned_value in paired_values]
        if not differences:
            continue
        estimates = []
        for _ in range(samples):
            draw = [differences[rng.randrange(len(differences))] for _ in differences]
            estimates.append(sum(draw) / len(draw))
        estimates.sort()
        lo = estimates[max(0, int(samples * 0.025) - 1)]
        hi = estimates[min(len(estimates) - 1, int(samples * 0.975))]
        base_mean = sum(value[0] for value in paired_values) / len(paired_values)
        tuned_mean = sum(value[1] for value in paired_values) / len(paired_values)
        mean_delta = tuned_mean - base_mean
        result[metric] = {
            "n": len(differences),
            "base_mean": base_mean,
            "tuned_mean": tuned_mean,
            "mean_delta": mean_delta,
            "relative_delta": mean_delta / abs(base_mean) if base_mean != 0 else None,
            "ci95": [lo, hi],
        }
    return {"n": len(ids), "samples": samples, "seed": seed, "id_key": id_key, "metrics": result}
