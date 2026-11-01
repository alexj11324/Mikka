"""Publish step of build-template.py, against a fake E2B API (no network, no SDK)."""
import importlib.util
import io
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
    def test_runtime_files_do_not_replace_requested_template_name(self):
        class Recipe:
            def from_base_image(self): return self
            def copy(self, *_): return self
            def run_cmd(self, command, **__):
                called.setdefault('commands', []).append(command)
                return self
            def set_user(self, user):
                self.user = user
                return self
            def set_start_cmd(self, start, ready):
                self.start, self.ready = start, ready
                return self
        called = {}
        def build_recipe(recipe, **options):
            called.update(options)
            called['start'], called['ready'] = recipe.start, recipe.ready
            return SimpleNamespace(template_id='tpl1', build_id='b1')
        class Template:
            def __new__(cls, **_): return Recipe()
            build = staticmethod(build_recipe)
        sdk = SimpleNamespace(Template=Template)
        with patch.dict('sys.modules', {'e2b': sdk}), patch.object(bt, 'source_context', return_value='a' * 40):
            sha, result = bt.build('mikka-versioned-worker', api_key='fixture-key')
        self.assertEqual(called['name'], 'mikka-versioned-worker')
        self.assertEqual(sha, 'a' * 40)
        self.assertEqual(result.template_id, 'tpl1')
        self.assertIn('systemctl start mikka-preload.service mikka-viewer.service', called['start'])
        self.assertTrue(any('systemctl enable mikka-preload.service mikka-viewer.service' in command for command in called['commands']))
        self.assertIn('test ! -e /run/mikka-viewer/key', called['ready'])

    def test_cold_boot_scrubs_capabilities_once_before_starting_anonymous_services(self):
        scrub = bt.BOOT_SERVICES['mikka-boot-scrub.service']
        for path in ('/home/mikka-runner/.mikka/worker', '/home/mikka-runner/.mikka/bootstrap.json', '/home/mikka-runner/.mikka/preloaded.pid', '/run/mikka-viewer'):
            self.assertIn(path, scrub)
        self.assertIn('RemainAfterExit=yes', scrub)
        self.assertIn('DefaultDependencies=no', scrub)
        self.assertIn('envd.service', scrub)
        for service in ('mikka-preload.service', 'mikka-viewer.service'):
            unit = bt.BOOT_SERVICES[service]
            self.assertIn('Requires=mikka-boot-scrub.service', unit)
            self.assertIn('After=mikka-boot-scrub.service', unit)
            self.assertIn('WantedBy=multi-user.target', unit)
            self.assertIn('DefaultDependencies=no', unit)
            self.assertNotIn('envd.service', unit)
        self.assertIn('--wait-bootstrap', bt.BOOT_SERVICES['mikka-preload.service'])

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
            self.assertEqual(Path(temp, 'source-sha').read_text(), bt.worker_hash(sha) + '\n')
            with tarfile.open(Path(temp, 'worker.tar')) as tar:
                names = [m.name for m in tar.getmembers() if m.isfile()]
            self.assertTrue(names)
            self.assertTrue(all(n in bt.WORKER_PATHS or n.split('/', 2)[0] in bt.WORKER_PATHS or '/'.join(n.split('/')[:2]) in bt.WORKER_PATHS for n in names))
            import subprocess
            for name in bt.COMPUTER_FILES:
                self.assertEqual(Path(temp, name).read_bytes(), subprocess.check_output(['git', 'show', f'{sha}:scripts/e2b/{name}'], cwd=bt.ROOT))

class WorkerHash(unittest.TestCase):
    def test_changes_only_with_what_the_template_packages(self):
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as temp:
            git = lambda *args: subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', *args], cwd=temp, check=True, capture_output=True)
            write = lambda path, text: (Path(temp, path).parent.mkdir(parents=True, exist_ok=True), Path(temp, path).write_text(text))
            git('init', '-q')
            for path in ('package.json', 'packages/daemon/a.ts', 'scripts/e2b/bootstrap.sh', 'scripts/e2b/build-template.py', 'app/page.tsx'):
                write(path, 'one')
            git('add', '-A'); git('commit', '-qm', 'one')
            root, bt.ROOT = bt.ROOT, Path(temp)
            try:
                first = bt.worker_hash('HEAD')
                self.assertRegex(first, r'^[0-9a-f]{40}$')
                write('app/page.tsx', 'two'); git('commit', '-qam', 'app only')
                self.assertEqual(bt.worker_hash('HEAD'), first)
                write('packages/daemon/a.ts', 'two'); git('commit', '-qam', 'daemon')
                second = bt.worker_hash('HEAD')
                self.assertNotEqual(second, first)
                write('scripts/e2b/bootstrap.sh', 'two'); git('commit', '-qam', 'recipe')
                recipe = bt.worker_hash('HEAD')
                self.assertNotEqual(recipe, second)
                write('scripts/e2b/viewer-gateway.py', 'guard'); git('add', '.'); git('commit', '-qm', 'viewer guard')
                self.assertNotEqual(bt.worker_hash('HEAD'), recipe)
            finally:
                bt.ROOT = root

class WorkerImports(unittest.TestCase):
    def test_packaged_code_only_imports_what_the_template_ships(self):
        # The template holds WORKER_PATHS only: a relative import that leaves them works in the
        # repository and fails in the cloud worker (ERR_MODULE_NOT_FOUND), so no worker starts.
        import os, re
        spec = re.compile(r"""(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)['"](\.{1,2}/[^'"]+)['"]""", re.M)
        roots = [bt.ROOT / path for path in bt.WORKER_PATHS if (bt.ROOT / path).is_dir()]
        shipped = [os.path.realpath(bt.ROOT / path) for path in bt.WORKER_PATHS]
        escapes = []
        for root in roots:
            for directory, dirs, files in os.walk(root):
                dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', 'test', '__tests__')]
                for name in files:
                    if not re.search(r'\.(ts|tsx|mts|cts|js|mjs|cjs)$', name) or re.search(r'\.(test|spec)\.|\.node\.ts$', name):
                        continue
                    source = Path(directory, name)
                    for target in spec.findall(source.read_text(errors='ignore')):
                        resolved = os.path.realpath(os.path.join(directory, target))
                        if not any(resolved == top or resolved.startswith(top + os.sep) for top in shipped):
                            escapes.append(f'{source.relative_to(bt.ROOT)} -> {target}')
        self.assertEqual(escapes, [])

if __name__ == '__main__':
    unittest.main()
