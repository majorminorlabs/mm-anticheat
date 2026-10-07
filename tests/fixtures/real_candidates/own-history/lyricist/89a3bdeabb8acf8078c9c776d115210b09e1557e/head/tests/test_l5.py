import unittest

from scripts.build_l5 import LABELS, build, load, select_no_field
from scripts.l4_sampler import sample_plan
from scripts.modeling import ROOT
from scripts.pipeline import write_jsonl
from scripts.qa_l5 import audit


class L5Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = ROOT / 'data/l5/train.jsonl'
        if not path.exists():
            write_jsonl(path, build(load()))

    def test_controlled_variant_and_sampler(self):
        original = load()
        variants = build(original)
        self.assertEqual(variants, build(original))
        self.assertEqual(len(select_no_field(original)), 45)
        self.assertEqual(sample_plan(original), sample_plan(variants))
        for before, after in zip(original, variants):
            self.assertEqual(before['prompt'], after['prompt'])
            self.assertEqual(before['target'], after['target'])
            self.assertEqual(before['target_sha256'], after['target_sha256'])
            if after['length_control'] is not None:
                self.assertEqual(after['length_control'], LABELS[after['length_bucket']])
            else:
                self.assertIsNone(before['length_control'])

    def test_materialized_dataset_passes_integrity_audit(self):
        result = audit(False)
        self.assertEqual(result['errors'], [])
        self.assertEqual((result['explicit'], result['no_field']), (179, 45))


if __name__ == '__main__':
    unittest.main()
