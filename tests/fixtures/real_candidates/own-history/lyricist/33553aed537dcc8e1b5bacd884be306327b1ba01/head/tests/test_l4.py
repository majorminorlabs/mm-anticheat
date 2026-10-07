from scripts.l4_sampler import EXAMPLES_PER_STEP, sample_plan, summarize, training_rows
from scripts.train_l3 import L3
from scripts.train_l4 import L4


def test_l4_only_changes_sampling_and_checkpoint_schedule():
    assert {k: v for k, v in L4.items() if k != 'checkpoints'} == {
        k: v for k, v in L3.items() if k != 'checkpoints'}


def test_l4_sampler_deterministic_weighted_and_diverse():
    rows = training_rows()
    plan = sample_plan(rows)
    assert plan == sample_plan(rows)
    assert plan[:50 * EXAMPLES_PER_STEP] == sample_plan(rows, steps=50)
    report = summarize(rows, plan[:50 * EXAMPLES_PER_STEP])
    assert report['source_l3_examples'] == 224
    assert report['unique_source_works_observed'] == 84
    assert report['max_example_repetitions'] <= 5
    assert report['sampled_bucket_proportions']['medium'] > .35
    assert report['sampled_bucket_proportions']['longer'] > .18
    assert report['sampled_bucket_proportions']['very_short'] < .10
