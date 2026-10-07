from research_model.datasets.splits import assign_source_group_splits, dataset_hash


def test_source_group_stays_together():
    rows = [{"example_id": str(i), "source_ids": ["S1" if i < 2 else "S2"], "split": "unassigned"} for i in range(4)]
    split = assign_source_group_splits(rows, seed=3)
    by_source = {}
    for row in split:
        by_source.setdefault(row["source_ids"][0], set()).add(row["split"])
    assert all(len(splits) == 1 for splits in by_source.values())
    assert dataset_hash(split) == dataset_hash(split)

