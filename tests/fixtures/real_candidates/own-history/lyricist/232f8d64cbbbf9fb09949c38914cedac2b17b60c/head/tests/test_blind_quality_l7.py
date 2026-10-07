"""Verification of L7 frozen scoring formulas and deterministic checks."""
from __future__ import annotations

import unittest

from scripts.analyze_blind_l7 import composite, machine_checks
from scripts.blind_quality_l7 import valid_pair, valid_rating


class BlindQualityL7Tests(unittest.TestCase):
    def test_predeclared_composites(self):
        scores = dict(zip('ABCDEFGHIJ', (3, 2, 4, 3, 2, 1, 4, 3, 2, 3)))
        style, utility = composite(scores)
        self.assertEqual(style, (4 + 3 + 2 + 1) / 4)
        self.assertAlmostEqual(utility, (3 + 2 + 4 + 3 + 2 + 1 + 3 + 2 + 3) / 9 - 1)

    def test_rating_validation(self):
        valid_rating({'scores': dict.fromkeys('ABCDEFGHIJ', 2), 'tags': [], 'evidence': 'short note'})
        with self.assertRaises(ValueError):
            valid_rating({'scores': dict.fromkeys('ABCDEFGHIJ', 5), 'tags': [], 'evidence': 'bad'})
        with self.assertRaises(ValueError):
            valid_rating({'scores': dict.fromkeys('ABCDEFGHIJ', 2), 'tags': ['unknown'], 'evidence': 'bad'})
        valid_pair({'outcome': 'A slightly better', 'reasons': ['imagery'], 'evidence': 'short note'})
        with self.assertRaises(ValueError):
            valid_pair({'outcome': 'A wins', 'reasons': [], 'evidence': 'bad'})

    def test_constraint_proxies_remain_separate(self):
        forbidden = machine_checks({'id': 'p07', 'length': 'short', 'text': 'Jealousy is named.'})
        self.assertTrue(forbidden['forbidden_jealous_stem'])
        self.assertEqual(forbidden['length_position'], 'under')
        self.assertFalse(machine_checks({'id': 'p07', 'length': 'short', 'text': 'I want what you have.'})
                         ['forbidden_jealous_stem'])
        structured = machine_checks({'id': 'p48', 'length': 'medium',
                                     'text': 'Verse 1:\nThe dog ran.\n\nChorus:\nCome home.'})
        self.assertTrue(structured['verse_and_chorus_label_proxy'])
        self.assertEqual(machine_checks({'id': 'p49', 'length': 'short',
                                         'text': 'line one\nline two'})['stanza_count_by_blank_lines'], 1)
        self.assertTrue(machine_checks({'id': 'p50', 'length': 'long',
                                        'text': 'Come back\nanother line\nCome back'})
                        ['exact_repeated_line_proxy'])


if __name__ == '__main__':
    unittest.main()
