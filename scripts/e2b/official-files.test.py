import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('official_files', Path(__file__).with_name('official-files.py'))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class OfficialFiles(unittest.TestCase):
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
