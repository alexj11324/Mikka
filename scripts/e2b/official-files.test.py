import importlib.util
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('official_files', Path(__file__).with_name('official-files.py'))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class OfficialFiles(unittest.TestCase):
    def test_only_control_proven_fields_may_change_during_e2b_finalization(self):
        original = {'path': '/.e2b', 'kind': 'file', 'mode': 0o644, 'uid': 0, 'gid': 0, 'sha256': 'a' * 64}
        baseline = {'version': 1, 'entries': [original]}
        updated = {**original, 'sha256': 'b' * 64}
        with patch.object(files, 'entry', return_value=updated):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)
            final = files.verify(baseline, 'codex')
            self.assertEqual(final['before'], final['after'])
            self.assertNotEqual(final['originalBefore'], final['originalAfter'])
            self.assertEqual(final['providerChanges'][0]['path'], '/.e2b')
        for path, update in [('/usr/local/bin/codex', {'sha256': 'b' * 64}),
                             ('/.e2b', {'uid': 1000}),
                             ('/usr/local/share/e2b/ssl-certs.tar', {'mode': 0o666}),
                             ('/etc/ssl/certs/ca-certificates.crt', {'sha256': 'b' * 64})]:
            before = {**original, 'path': path}
            with patch.object(files, 'entry', return_value={**before, **update}):
                with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                    files.verify({'version': 1, 'entries': [before]}, 'codex')
        certificate = {**original, 'path': '/usr/local/share/e2b/ssl-certs.tar'}
        with patch.object(files, 'entry', return_value={**certificate, 'mode': 0o777}):
            self.assertEqual(files.verify({'version': 1, 'entries': [certificate]}, 'codex')['providerChanges'][0]['after'], {'mode': 0o777})

    def test_finalization_receipt_cannot_replace_strict_installation_proof(self):
        original = {'path': '/.e2b', 'kind': 'file', 'mode': 0o644, 'uid': 0, 'gid': 0, 'sha256': 'a' * 64}
        baseline = {'version': 1, 'entries': [original]}
        with patch.object(files, 'entry', return_value=original):
            proof = files.verify(baseline)
            with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                files.validate_receipt(proof, 'claude')
            proof['finalization'] = files.verify(baseline, 'claude')
        self.assertIs(files.validate_receipt(proof, 'claude'), proof)
        with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
            files.validate_receipt(proof, 'desktop')
        proof['after'] = {**proof['after'], 'sha256': 'c' * 64}
        with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
            files.validate_receipt(proof, 'claude')

    def test_an_unreadable_original_directory_cannot_be_silently_skipped(self):
        with tempfile.TemporaryDirectory() as name:
            with patch.object(files.os, 'scandir', side_effect=PermissionError('fixture unreadable directory')):
                with self.assertRaises(PermissionError):
                    files.capture([name])

    def test_persistent_paths_outside_package_directories_are_protected(self):
        self.assertEqual(files.ROOTS, ('/',))
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            for relative in ('var/lib/official-runtime/state', 'srv/official/cli', 'data/base/vendor.js'):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original')
            baseline = files.capture([str(root)])
            (root / 'var/lib/official-runtime/state').write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)

    def test_addition_is_allowed_but_modifying_or_removing_an_original_fails(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            cli = root / 'claude'
            cli.write_text('official complete CLI')
            cli.chmod(0o755)
            (root / 'codex').symlink_to('claude')
            baseline = files.capture([str(root)])
            (root / 'mikka').mkdir()
            (root / 'mikka' / 'node').write_text('private runtime')
            proof = files.verify(baseline)
            self.assertEqual(proof['before'], proof['after'])
            cli.write_text('broken replacement')
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)
            cli.write_text('official complete CLI')
            cli.chmod(0o700)
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)
            cli.chmod(0o755)
            cli.unlink()
            with self.assertRaisesRegex(RuntimeError, 'official_files_removed'):
                files.verify(baseline)

    def test_private_root_is_excluded_but_original_links_and_packages_are_protected(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            private = root / 'mikka'
            private.mkdir()
            (private / 'cache').write_text('before')
            official = root / 'package'
            official.mkdir()
            (official / 'dependency.js').write_text('dependency')
            link = root / 'cli'
            link.symlink_to('package/dependency.js')
            baseline = files.capture([str(root)], private)
            (private / 'cache').write_text('after')
            self.assertEqual(files.verify(baseline)['before'], files.verify(baseline)['after'])
            link.unlink()
            link.symlink_to('mikka/cache')
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)


if __name__ == '__main__':
    unittest.main()
