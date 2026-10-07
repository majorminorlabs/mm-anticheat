import json
import unittest
from pathlib import Path

from models.validate_manifest import validate

ROOT = Path(__file__).resolve().parents[1]

class ManifestTests(unittest.TestCase):
    def test_frozen_manifest_contract(self):
        self.assertTrue(validate())
        manifest=json.loads((ROOT/"models/manifest.json").read_text())
        self.assertEqual({x["quantization"] for x in manifest["candidates"]},{"Q4_K_M"})
        self.assertEqual(len({x["sha256"] for x in manifest["candidates"]}),4)
