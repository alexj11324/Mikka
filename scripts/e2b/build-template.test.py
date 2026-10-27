import importlib.util
from pathlib import Path
import sys
import tarfile
import tempfile
import types
import unittest

# The archive test needs no SDK, network or E2B credential.
sys.modules.setdefault('e2b', types.SimpleNamespace(Template=object))
spec = importlib.util.spec_from_file_location('build_template', Path(__file__).with_name('build-template.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class WorkerArchiveTest(unittest.TestCase):
    def test_locked_patch_is_in_the_immutable_worker_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            sha = builder.source_context(directory, 'HEAD')
            self.assertEqual(len(sha), 40)
            with tarfile.open(directory / 'worker.tar') as archive:
                names = set(archive.getnames())
            self.assertIn('patches/@novnc__novnc@1.6.0.patch', names)
            self.assertFalse(any('/.env' in name or name.endswith('/.npmrc') for name in names))

if __name__ == '__main__':
    unittest.main()
