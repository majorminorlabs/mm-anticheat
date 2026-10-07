#!/usr/bin/env python3
"""Focused privacy and reproducibility checks for release packaging."""
import importlib.util
import pathlib
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_audit', ROOT/'scripts/audit-release-artifacts.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

class ReleaseTests(unittest.TestCase):
    def test_bridge_package_reproducible_and_installable(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp)
            packages=[]
            for output in (base/'one', base/'two'):
                subprocess.run([str(ROOT/'scripts/package-bridge.sh'), '--output-dir', str(output)], check=True, capture_output=True)
                packages.append(next(output.glob('*.tar.gz')))
            self.assertEqual(packages[0].read_bytes(), packages[1].read_bytes())
            count, findings = audit.audit([packages[0]])
            self.assertGreater(count, 20)
            self.assertEqual(findings, [])
            with tarfile.open(packages[0]) as archive:
                archive.extractall(base/'extracted', filter='data')
            package_root=base/'extracted/hermes-mobile-bridge-release'
            for command in ('install', 'update', 'uninstall', 'status'):
                result=subprocess.run([str(package_root/f'scripts/{command}-bridge.sh'), '--help'], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((package_root/'hermes-mobile-bridge/src/hermes_mobile_bridge/__init__.py').exists())

    def test_detects_payload_privacy_and_signing(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifact=pathlib.Path(tmp)/'example.ipa'
            secret=b'credential-fixture-for-audit-only-123456'
            with zipfile.ZipFile(artifact, 'w') as output:
                output.writestr('Payload/App.app/content', b'/Users/example/private\x00'+secret+b'\x00host.tail01234.ts.net')
                output.writestr('Payload/App.app/embedded.mobileprovision', b'fixture')
            _, findings=audit.audit([artifact], [secret], 'example')
            reasons={reason for _,reason in findings}
            self.assertTrue({'personal absolute path','known credential value','private tailnet hostname','excluded/generated or signing file'} <= reasons)

    def test_public_namespace_is_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=pathlib.Path(tmp)/'public'
            p.write_bytes(b'com.dippo.hermes https://your-mac.your-tailnet.ts.net')
            _, findings=audit.audit([p], personal_name=__import__('getpass').getuser())
            self.assertEqual(findings, [])

    def test_rejects_archive_owner_metadata(self):
        import io
        with tempfile.TemporaryDirectory() as tmp:
            p=pathlib.Path(tmp)/'fixture.tar.gz'
            with tarfile.open(p, 'w:gz') as output:
                m=tarfile.TarInfo('runtime.py');m.uname='fixture-owner';m.size=1
                output.addfile(m, io.BytesIO(b'x'))
            _,findings=audit.audit([p])
            self.assertIn(('runtime.py','non-normalized tar metadata'),findings)

if __name__=='__main__': unittest.main()
