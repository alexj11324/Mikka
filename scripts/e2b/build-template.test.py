"""Publish step of build-template.py, against a fake E2B API (no network, no SDK)."""
import importlib.util
import io
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('build_template', Path(__file__).with_name('build-template.py'))
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)

class FakeResponse(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *_): return False

def fake(template):
    calls = []
    def opener(request, timeout):
        calls.append((request.get_method(), request.full_url, request.get_header('X-api-key'), request.data))
        return FakeResponse(b'' if request.get_method() == 'PATCH' else json.dumps(template).encode())
    return opener, calls

class Publish(unittest.TestCase):
    def test_patches_public_and_verifies_ready(self):
        opener, calls = fake({'public': True, 'buildStatus': 'ready', 'builds': [{'buildID': 'b1', 'status': 'ready'}]})
        self.assertEqual(bt.publish('tpl1', 'b1', 'k', opener), {'public': True, 'buildStatus': 'ready'})
        self.assertEqual(calls[0], ('PATCH', 'https://api.e2b.app/templates/tpl1', 'k', b'{"public": true}'))
        self.assertEqual(calls[1][:2], ('GET', 'https://api.e2b.app/templates/tpl1'))

    def test_refuses_private_template(self):
        opener, _ = fake({'public': False, 'buildStatus': 'ready', 'builds': [{'buildID': 'b1', 'status': 'ready'}]})
        with self.assertRaisesRegex(RuntimeError, 'not public'):
            bt.publish('tpl1', 'b1', 'k', opener)

    def test_refuses_build_that_is_not_ready(self):
        opener, _ = fake({'public': True, 'buildStatus': 'ready', 'builds': [{'buildID': 'b1', 'status': 'error'}]})
        with self.assertRaisesRegex(RuntimeError, 'not ready'):
            bt.publish('tpl1', 'b1', 'k', opener)

    def test_refuses_odd_template_id(self):
        with self.assertRaises(ValueError):
            bt.publish('../x', 'b1', 'k', fake({})[0])

    def test_archive_only_holds_worker_paths(self):
        import tarfile, tempfile
        with tempfile.TemporaryDirectory() as temp:
            sha = bt.source_context(Path(temp), 'HEAD')
            self.assertEqual(Path(temp, 'source-sha').read_text(), sha + '\n')
            with tarfile.open(Path(temp, 'worker.tar')) as tar:
                names = [m.name for m in tar.getmembers() if m.isfile()]
            self.assertTrue(names)
            self.assertTrue(all(n in bt.WORKER_PATHS or n.split('/', 2)[0] in bt.WORKER_PATHS or '/'.join(n.split('/')[:2]) in bt.WORKER_PATHS for n in names))

if __name__ == '__main__':
    unittest.main()
