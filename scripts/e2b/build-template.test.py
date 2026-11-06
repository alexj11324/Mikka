"""Publish step of build-template.py, against a fake E2B API (no network, no SDK)."""
import importlib.util
import io
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError

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
    def test_conservation_reads_build_receipts_and_rechecks_a_fresh_disposable_image(self):
        calls = []
        digest = {'entries': 5, 'sha256': 'f' * 64}
        final = {'kind': 'codex', 'policySha256': bt.official_files_guard().finalization_policy('codex')[1],
                 'before': digest, 'after': digest, 'originalBefore': digest, 'originalAfter': digest, 'providerChanges': []}
        class Probe:
            def __init__(self): self.files = self.commands = self
            def read(self, path, **options):
                calls.append(('read', path))
                return json.dumps(final if path.endswith(('ready.json', 'fresh-conservation.json')) else {'before': digest, 'after': digest})
            def run(self, command, **options):
                calls.append(('run', command))
                return SimpleNamespace(exit_code=0, stdout=json.dumps(final))
            def kill(self): calls.append(('kill',))
        result = bt.probe_conservation('candidate', 'fixture-key', 'codex', lambda *_, **__: Probe())
        self.assertEqual(result['preloadFinalization'], final)
        self.assertEqual(result['finalization'], final)
        self.assertEqual([call[0] for call in calls], ['read', 'read', 'run', 'read', 'kill'])
        self.assertIn('verify /opt/mikka/official-files-before.json --e2b-finalization codex', calls[2][1])

    def test_build_name_must_be_absent_and_never_an_official_alias(self):
        with patch.object(bt, '_request', return_value={'templateID': 'previous-version'}):
            with self.assertRaisesRegex(ValueError, 'template_name_already_exists'):
                bt.assert_new_template('mikka-old-claude', 'fixture-key')
        for name in ('claude', 'codex', 'desktop', '../other'):
            with self.assertRaisesRegex(ValueError, 'template_name_invalid'):
                bt.assert_new_template(name, 'fixture-key')
        with patch.object(bt, '_request', side_effect=HTTPError('https://api.e2b.app/templates/new', 404, 'Not found', {}, None)):
            bt.assert_new_template('mikka-new-claude', 'fixture-key')
        with patch.object(bt, '_request', side_effect=HTTPError('https://api.e2b.app/templates/new', 503, 'Unavailable', {}, None)):
            with self.assertRaises(HTTPError):
                bt.assert_new_template('mikka-new-claude', 'fixture-key')

    def test_model_probe_requires_each_declared_harness_and_kills_only_its_sandbox(self):
        calls = []
        class Probe:
            def __init__(self, reports):
                self.commands = self
                self.reports = reports
            def run(self, command, **options):
                calls.append((command, options))
                return SimpleNamespace(exit_code=0, stdout=json.dumps(self.reports))
            def kill(self): calls.append('killed')
        reports = [{'harness': 'codex', 'installed': True, 'version': None, 'models': ['fixture-model']}]
        factory = lambda *args, **kwargs: Probe(reports)
        self.assertEqual(bt.probe_models('tpl1', 'codex', 'fixture-key', factory), reports)
        self.assertIn('--probe-models', calls[0][0])
        self.assertEqual(calls[-1], 'killed')
        with self.assertRaisesRegex(RuntimeError, 'model_probe_missing claude_code'):
            bt.probe_models('tpl1', 'desktop', 'fixture-key', factory)
        self.assertEqual(calls[-1], 'killed')

    def test_capability_manifest_matches_template_kinds_and_task_environment(self):
        manifest = json.loads((bt.ROOT / 'scripts/e2b/template-capabilities.json').read_text())
        self.assertEqual(set(manifest), set(bt.KINDS))
        self.assertEqual(manifest, {'desktop': ['claude_code', 'codex'], 'claude': ['claude_code'], 'codex': ['codex']})
        runtime = (bt.ROOT / 'lib/secrets/e2b-runtime.ts').read_text()
        for harness, variable in [('claude_code', 'E2B_CLAUDE_TEMPLATE'), ('codex', 'E2B_CODEX_TEMPLATE')]:
            self.assertIn(harness, runtime)
            self.assertIn(variable, runtime)

    def fake_build(self, kind):
        called = {'commands': [], 'copies': [], 'users': []}
        class Recipe:
            def from_template(self, name):
                called['base_template'] = name
                return self
            def copy(self, source, destination):
                called['copies'].append((source, destination))
                return self
            def set_workdir(self, _): return self
            def run_cmd(self, command, user=None, **__):
                called['commands'].append(command)
                called['users'].append((command, user))
                return self
            def set_user(self, _): return self
            def set_start_cmd(self, start, ready):
                self.start, self.ready = start, ready
                return self
        def build_recipe(recipe, **options):
            called.update(options)
            called['start'], called['ready'] = recipe.start, recipe.ready
            return SimpleNamespace(template_id='tpl1', build_id='b1')
        def context(directory, _):
            (directory / 'source-sha').write_text('b' * 40)
            return 'a' * 40
        class Template:
            def __new__(cls, **_): return Recipe()
            build = staticmethod(build_recipe)
        with patch.dict('sys.modules', {'e2b': SimpleNamespace(Template=Template)}), patch.object(bt, 'source_context', side_effect=context), patch.object(bt, 'assert_new_template'):
            sha, result = bt.build(f'mikka-test-{kind}', api_key='fixture-key', kind=kind)
        self.assertEqual(sha, 'a' * 40)
        self.assertEqual(result.template_id, 'tpl1')
        return called

    def test_build_is_additive_and_original_file_gate_surrounds_installation(self):
        for kind in bt.KINDS:
            called = self.fake_build(kind)
            self.assertEqual(called['base_template'], kind)
            self.assertEqual(called['name'], f'mikka-test-{kind}')
            self.assertTrue(all(destination.startswith('/opt/mikka/') for _, destination in called['copies']))
            commands = called['commands']
            capture = next(i for i, command in enumerate(commands) if 'official-files.py capture' in command)
            install = next(i for i, command in enumerate(commands) if 'bash /opt/mikka/instance-bootstrap.sh' in command)
            verify = next(i for i, command in enumerate(commands) if 'official-files.py verify' in command)
            self.assertLess(capture, install)
            self.assertLess(install, verify)
            self.assertIn(' '.join(['a' * 40, 'b' * 40, kind]), commands[install])
            self.assertFalse(any('apt-get' in command or 'ln -sf' in command or 'systemctl' in command for command in commands))
            self.assertEqual(called['start'], 'bash /opt/mikka/start-prebuilt.sh')
            self.assertIn('test ! -e /home/user/.mikka/bootstrap.json', called['ready'])
            self.assertIn('test ! -e /home/user/.mikka/worker/device.json', called['ready'])
            if kind == 'desktop': self.assertIn('test ! -e /run/mikka-viewer/key', called['ready'])
            self.assertIn((bt.NPM_RUNTIME_CHECK, 'user'), called['users'])

    def test_template_start_preloads_only_anonymous_private_runtime(self):
        text = (bt.ROOT / 'scripts/e2b/start-prebuilt.sh').read_text()
        self.assertIn('--wait-bootstrap', text)
        self.assertNotIn('env -i', text)
        self.assertIn('/opt/mikka/runtime/node/bin/node', text)
        self.assertNotIn('rm ', text)
        self.assertNotIn('sleep ', text)
        self.assertNotIn('systemctl', text)

    def test_release_gate_rejects_missing_stale_and_non_subscription_receipts(self):
        proof = {'entries': 4, 'sha256': 'f' * 64}
        def conservation(kind):
            return {'before': proof.copy(), 'after': proof.copy(), 'finalization': {
                'kind': kind, 'policySha256': bt.official_files_guard().finalization_policy(kind)[1],
                'before': proof.copy(), 'after': proof.copy(), 'originalBefore': proof.copy(),
                'originalAfter': proof.copy(), 'providerChanges': []}}
        report = {'sourceCommit': 'a' * 40, 'workerSha': 'b' * 40, 'templates': {
            kind: {'templateId': 'tpl-' + kind, 'buildId': 'build-' + kind, 'baseTemplate': kind, 'preinstalled': True,
                   'conservation': conservation(kind)} for kind in bt.KINDS}}
        with self.assertRaisesRegex(ValueError, 'release_subscription_acceptance_missing'):
            bt.verify_release_evidence(report)
        report['subscriptionAcceptance'] = {
            kind: {'status': 'passed', 'templateId': 'tpl-' + kind, 'sourceCommit': report['sourceCommit'],
                   'workerSha': report['workerSha'], 'harness': harness, 'model': model, 'credentialRoute': 'subscription',
                   'officialBinarySha256': 'e' * 64, 'officialCliVersion': 'fixture-version',
                   'replyVerified': True, 'runId': 'run-' + kind, 'deviceId': 'device-' + kind}
            for kind, harness, model in [('claude', 'claude_code', 'claude-haiku-5-5'), ('codex', 'codex', 'gpt-6-luna')]}
        self.assertIs(bt.verify_release_evidence(report), report)
        for field, value in [('templateId', 'old-template'), ('sourceCommit', 'c' * 40), ('credentialRoute', 'api_key'), ('replyVerified', False), ('model', 'other')]:
            invalid = json.loads(json.dumps(report))
            invalid['subscriptionAcceptance']['codex'][field] = value
            with self.assertRaisesRegex(ValueError, 'release_subscription_acceptance_missing codex'):
                bt.verify_release_evidence(invalid)
        invalid = json.loads(json.dumps(report))
        invalid['templates']['desktop']['conservation']['after']['sha256'] = 'e' * 64
        with self.assertRaisesRegex(ValueError, 'release_conservation_invalid desktop'):
            bt.verify_release_evidence(invalid)

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

    def test_recipe_comes_from_immutable_commit_not_the_worktree(self):
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as context:
            root = Path(repo)
            git = lambda *args: subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', *args], cwd=root, check=True, capture_output=True)
            git('init', '-q')
            paths = [*(f'scripts/e2b/{name}' for name in bt.BOOTSTRAP_FILES), bt.INSTANCE_BOOTSTRAP]
            for path in paths:
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('committed recipe')
            git('add', '.'); git('commit', '-qm', 'immutable recipe')
            for path in paths: (root / path).write_text('uncommitted replacement')
            with patch.object(bt, 'ROOT', root):
                sha = bt.source_context(Path(context), 'HEAD')
                self.assertEqual(Path(context, 'source-sha').read_text(), bt.worker_hash(sha) + '\n')
                for name in (*bt.BOOTSTRAP_FILES, 'instance-bootstrap.sh'):
                    self.assertEqual(Path(context, name).read_text(), 'committed recipe')
            self.assertEqual({file.name for file in Path(context).iterdir()}, {*bt.BOOTSTRAP_FILES, 'instance-bootstrap.sh', 'source-sha'})

class WorkerHash(unittest.TestCase):
    def test_changes_only_with_what_the_template_packages(self):
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as temp:
            git = lambda *args: subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', *args], cwd=temp, check=True, capture_output=True)
            write = lambda path, text: (Path(temp, path).parent.mkdir(parents=True, exist_ok=True), Path(temp, path).write_text(text))
            git('init', '-q')
            for path in ('package.json', 'packages/daemon/a.ts', 'scripts/e2b/official-files.py', 'scripts/e2b/build-template.py', 'app/page.tsx'):
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
                write('scripts/e2b/official-files.py', 'two'); git('commit', '-qam', 'recipe')
                recipe = bt.worker_hash('HEAD')
                self.assertNotEqual(recipe, second)
                write('scripts/e2b/viewer-gateway.py', 'guard'); git('add', '.'); git('commit', '-qm', 'viewer guard')
                self.assertNotEqual(bt.worker_hash('HEAD'), recipe)
            finally:
                bt.ROOT = root

    def test_script_and_unrelated_lock_entries_do_not_change_the_hash(self):
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as temp:
            git = lambda *args: subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', *args], cwd=temp, check=True, capture_output=True)
            write = lambda path, text: (Path(temp, path).parent.mkdir(parents=True, exist_ok=True), Path(temp, path).write_text(text))
            git('init', '-q')
            write('package.json', '{"packageManager":"pnpm@10.34.3","scripts":{"test":"one"},"dependencies":{"next":"1.0.0"}}')
            write('packages/daemon/package.json', '{"name":"@mikka/daemon","dependencies":{"zod":"1.0.0"}}')
            write('pnpm-lock.yaml', '''lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      next:
        specifier: 1.0.0
        version: 1.0.0

  packages/daemon:
    dependencies:
      zod:
        specifier: 1.0.0
        version: 1.0.0

packages:

  next@1.0.0:
    resolution: {integrity: web}

  zod@1.0.0:
    resolution: {integrity: daemon}

snapshots:

  next@1.0.0: {}

  zod@1.0.0: {}
''')
            write('packages/daemon/a.ts', 'one')
            git('add', '-A'); git('commit', '-qm', 'base')
            root, bt.ROOT = bt.ROOT, Path(temp)
            try:
                first = bt.worker_hash('HEAD')
                write('package.json', '{"packageManager":"pnpm@10.34.3","scripts":{"test":"two"},"dependencies":{"next":"1.0.0"}}')
                git('commit', '-qam', 'script only')
                self.assertEqual(bt.worker_hash('HEAD'), first)
                write('pnpm-lock.yaml', Path(temp, 'pnpm-lock.yaml').read_text().replace('integrity: web', 'integrity: web2'))
                git('commit', '-qam', 'web package only')
                self.assertEqual(bt.worker_hash('HEAD'), first, 'a web-only lockfile entry stays out of the worker hash')
                text = Path(temp, 'pnpm-lock.yaml').read_text().replace('integrity: daemon', 'integrity: daemon2')
                write('pnpm-lock.yaml', text)
                git('commit', '-qam', 'daemon package')
                self.assertNotEqual(bt.worker_hash('HEAD'), first)
            finally:
                bt.ROOT = root

    def test_real_lockfile_projects(self):
        digest = bt.worker_hash('HEAD')
        self.assertRegex(digest, r'^[0-9a-f]{40}$')

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
