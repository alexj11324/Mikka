"""Fixed, credential-free native Unix regression proof for PR1782."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import socket
import subprocess
import sys
import tempfile
import traceback
import unittest

BASE = '06a3ec1e6567dcd5da95757ad11b1b7db46a127b'
BRANCH = 'ops/1782-preview-shutdown-20261109'
WORKFLOW = '.github/workflows/issue1782-preview-shutdown-native.yml'
GATEWAY = 'scripts/e2b/preview-gateway.py'
CASES = 'scripts/e2b/preview-gateway.test.py'
FIREWALL = 'scripts/e2b/preview_firewall.py'
HELPER = 'scripts/ops/preview-shutdown-native-1782.py'
HELPER_TEST = 'scripts/ops/preview-shutdown-native-1782.test.py'
PIN = {
    GATEWAY: '51518b32cc9867b9808c4eaddf2032c33ae099f289577a001acde8679d5f4f18',
    CASES: '2e882eb0eae0d512dbf2bec46bfec479a90a251b75e58a1784cc10936bc8484c',
    FIREWALL: 'c6e94c350e25bf1936a4c74b9a222575bba9c02c805d9c3e264229b64fe3f3b4',
}
BASE_GATEWAY = 'b911ccb7bb7a7db2c23114694a91145bd7359db4a99791296f9c579d109991a8'
BASE_CASES = '540c6ced3d64edc792481192ef283367d1c5bfdcbb605f5c90e582563dbffdc7'
SELF_WAIT = 'test_shutdown_replies_after_revoking_lease_without_waiting_on_its_own_client'
RACE = 'test_shutdown_refuses_accepted_and_discovering_controls_before_they_can_reopen'
# The only follow-up scope is the separately reviewed native drain proof.
APPLE = {
    'apps/desktop/test/native-cleanup.mjs': 'cf115bb73361f049d2560f2950785d7465dcfa80cd267d124b477304248b42d8',
    'apps/desktop/test/native-cleanup.test.mjs': '3750fa89a42002c953f4822268f74bb8fdcec53fb5b05635e10ee495bae79f93',
    'apps/desktop/test/fixtures/native-daemon.mjs': '3708c5edf3399bb686c22de51d27bff93cc6baa9fa46fbe6b9c7a36e08c1dd1d',
}
PIN.update(APPLE)
ALLOWED = {GATEWAY, CASES, HELPER, HELPER_TEST, WORKFLOW, *APPLE,
           'scripts/ops/native-drain-proof-1782.py', 'scripts/ops/native-drain-proof-1782.test.py'}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def test_methods(source):
    classes = [item for item in ast.parse(source).body if isinstance(item, ast.ClassDef) and item.name == 'PreviewAcceptance']
    require(len(classes) == 1, 'fixture_class_changed')
    return {item.name: ast.dump(item, include_attributes=False) for item in classes[0].body
            if isinstance(item, ast.AsyncFunctionDef) and item.name.startswith('test_')}


def test_preservation(old, new):
    original, candidate = test_methods(old), test_methods(new)
    require(len(original) == 13 and set(candidate) == set(original) | {SELF_WAIT, RACE}, 'fixture_cases_changed')
    require(all(candidate[name] == body for name, body in original.items()), 'original_case_changed')
    return sorted(candidate)


def validate_phase(value, phase, names):
    require(value.get('phase') == phase and value.get('skipped') == 0 and value.get('expectedFailures') == 0
            and value.get('unexpectedSuccesses') == 0 and value.get('failures') == [], 'native_result_invalid')
    if phase == 'red':
        require(value.get('testsRun') == 1 and value.get('successes') == [] and len(value.get('errors', [])) == 1,
                'expected_timeout_missing')
        error = value['errors'][0]
        require(error.get('test') == 'preview_shutdown_cases.PreviewAcceptance.' + SELF_WAIT
                and error.get('type') == 'builtins.TimeoutError', 'wrong_red_failure')
        frames = {(frame.get('file'), frame.get('function')) for frame in error.get('frames', [])}
        require(('preview-gateway.test.py', SELF_WAIT) in frames and ('preview-gateway.test.py', 'unix_control') in frames,
                'wrong_timeout_stage')
        require(any(frame.get('file') == 'preview-gateway.test.py' and frame.get('function') == 'unix_control'
                    and frame.get('awaitingControlReadline') is True for frame in error.get('frames', [])), 'wrong_timeout_stage')
    else:
        expected = {'preview_shutdown_cases.PreviewAcceptance.' + name for name in names}
        count = 13 if phase == 'baseline_green' else 15
        require(value.get('testsRun') == count and value.get('errors') == []
                and len(value.get('successes', [])) == count and set(value['successes']) == expected, 'native_green_failed')


class EvidenceResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.passed = []
        self.observed_errors = []

    def addSuccess(self, test):
        self.passed.append(test.id())
        super().addSuccess(test)

    def addError(self, test, error):
        self.observed_errors.append({'test': test.id(), 'type': error[0].__module__ + '.' + error[0].__qualname__,
            'frames': [{'file': Path(frame.filename).name, 'function': frame.name, 'line': frame.lineno,
                        'awaitingControlReadline': frame.name == 'unix_control' and 'reader.readline()' in (frame.line or '')
                        and 'wait_for' in (frame.line or '')}
                       for frame in traceback.extract_tb(error[2])]})
        super().addError(test, error)


def child(phase, directory, result_path):
    # Isolated child: the actual test imports its sibling Gateway and firewall.
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location('preview_shutdown_cases', directory / 'preview-gateway.test.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if phase == 'red':
        suite = unittest.defaultTestLoader.loadTestsFromName('PreviewAcceptance.' + SELF_WAIT, module)
    else:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(module.PreviewAcceptance)
    result = unittest.TextTestRunner(verbosity=2, resultclass=EvidenceResult).run(suite)
    evidence = {'phase': phase, 'testsRun': result.testsRun, 'successes': result.passed,
        'errors': result.observed_errors, 'failures': [test.id() for test, _error in result.failures],
        'skipped': len(result.skipped), 'expectedFailures': len(result.expectedFailures),
        'unexpectedSuccesses': len(result.unexpectedSuccesses)}
    result_path.write_text(json.dumps(evidence, indent=2) + '\n')
    return 0 if result.wasSuccessful() else 1


def source(repo, env):
    def git(*args):
        return subprocess.check_output(['git', '-c', 'safe.directory=' + str(repo), *args], cwd=repo)
    require(env.get('GITHUB_ACTIONS') == 'true' and env.get('GITHUB_REPOSITORY') == 'alexj11324/Mikka'
            and env.get('GITHUB_ACTOR') == env.get('GITHUB_TRIGGERING_ACTOR') == 'alexj11324'
            and env.get('GITHUB_EVENT_NAME') == 'push' and env.get('GITHUB_RUN_ATTEMPT') == '1'
            and env.get('GITHUB_REF') == 'refs/heads/' + BRANCH and env.get('GITHUB_JOB') == 'native_shutdown'
            and env.get('GITHUB_WORKFLOW_REF') == 'alexj11324/Mikka/' + WORKFLOW + '@refs/heads/' + BRANCH,
            'source_context_refused')
    head = git('rev-parse', 'HEAD').decode().strip()
    event = json.loads(Path(env['GITHUB_EVENT_PATH']).read_text())
    require(re.fullmatch('[a-f0-9]{40}', head) and head == env.get('GITHUB_SHA')
            and event.get('after') == head and event.get('ref') == env.get('GITHUB_REF')
            and event.get('repository', {}).get('id') == 1427517699
            and event.get('repository', {}).get('owner', {}).get('id') == 183887963
            and event.get('forced') is False and event.get('deleted') is False
            and git('status', '--porcelain', '--untracked-files=all') == b'', 'source_identity_refused')
    git('merge-base', '--is-ancestor', BASE, head)
    changed = set(git('diff', '--name-only', BASE, head).decode().splitlines())
    require({GATEWAY, CASES}.issubset(changed) and changed <= ALLOWED, 'source_scope_changed')
    for path, digest in PIN.items():
        require(sha((repo / path).read_bytes()) == digest, 'candidate_bytes_changed')
    baseline = git('show', BASE + ':' + GATEWAY)
    baseline_cases = git('show', BASE + ':' + CASES)
    require(sha(baseline) == BASE_GATEWAY and sha(baseline_cases) == BASE_CASES
            and git('show', BASE + ':' + FIREWALL) == (repo / FIREWALL).read_bytes(), 'baseline_bytes_changed')
    names = test_preservation(baseline_cases, (repo / CASES).read_bytes())
    return {'head': head, 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'baseline': BASE,
        'runId': env['GITHUB_RUN_ID'], 'runAttempt': 1, 'changedPaths': sorted(changed),
        'files': {path: sha((repo / path).read_bytes()) for path in sorted(ALLOWED | {FIREWALL})},
        'baselineGatewaySha256': BASE_GATEWAY, 'baselineCasesSha256': BASE_CASES,
        'testNames': names, 'originalTestNames': sorted(test_methods(baseline_cases)),
        'originalTests': 13, 'newTests': 2}, baseline, baseline_cases


def native_preflight(directory):
    import aiohttp
    require(platform.system() == 'Linux' and os.geteuid() == 0 and sys.version_info[:2] == (3, 12)
            and aiohttp.__version__ == '3.14.0', 'native_environment_refused')
    path = directory / 'native-preflight.sock'
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(str(path)); listener.listen(1)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(str(path))
            connection, _ = listener.accept()
            with connection:
                client.sendall(b'1782'); require(connection.recv(4) == b'1782', 'unix_transport_failed')
    path.unlink()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, 1782)
        require(listener.getsockopt(socket.SOL_SOCKET, socket.SO_MARK) == 1782, 'socket_mark_refused')
        listener.bind(('127.0.0.1', 0)); listener.listen(1)
    return {'platform': 'Linux', 'python': platform.python_version(), 'aiohttp': aiohttp.__version__,
            'uid': 0, 'nativeUnixRoundTrip': True, 'nativeLoopbackAndSocketMark': True}


def run():
    repo = Path(__file__).resolve().parents[2]
    output = Path(os.environ['RUNNER_TEMP']) / 'preview-shutdown-native-1782'
    output.mkdir(mode=0o755, parents=True, exist_ok=True)
    report = {'version': 1, 'status': 'failed', 'productionCredentialsRead': False, 'productionAccessed': False}
    try:
        binding, baseline, baseline_cases = source(repo, os.environ)
        report.update(binding)
        with tempfile.TemporaryDirectory(prefix='preview-shutdown-native-', dir=os.environ['RUNNER_TEMP']) as directory:
            fixture_root = Path(directory)
            report['environment'] = native_preflight(fixture_root)
            for phase in ['baseline_green', 'red', 'green']:
                location = fixture_root / phase; location.mkdir()
                for path in [GATEWAY, CASES, FIREWALL]:
                    data = baseline if phase != 'green' and path == GATEWAY else baseline_cases if phase == 'baseline_green' and path == CASES else (repo / path).read_bytes()
                    (location / Path(path).name).write_bytes(data)
                result_path = output / (phase + '.json')
                with (output / (phase + '.log')).open('w') as log:
                    completed = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'child', phase,
                        str(location), str(result_path)], stdout=log, stderr=subprocess.STDOUT,
                        timeout=30 if phase == 'red' else 60, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
                # A process timeout, environment error, import failure, skip or
                # any non-target error is a failed gate, never an expected RED.
                require(completed.returncode == (1 if phase == 'red' else 0) and result_path.is_file(), 'native_child_failed')
                result = json.loads(result_path.read_text())
                validate_phase(result, phase, binding['originalTestNames'] if phase == 'baseline_green' else binding['testNames'])
                report[phase] = {'status': 'expected_timeout_observed' if phase == 'red' else 'all_cases_passed',
                    'exitCode': completed.returncode, 'testsRun': result['testsRun'],
                    'resultSha256': sha(result_path.read_bytes()), 'logSha256': sha((output / (phase + '.log')).read_bytes())}
        report['fixtureDirectoryRemoved'] = not fixture_root.exists()
        require(report['fixtureDirectoryRemoved'], 'fixture_cleanup_failed')
        report['status'] = 'native_unix_red_green_passed'
    except Exception as error:
        # Only closed classifications, never inherited environment values.
        report['failure'] = {'type': type(error).__name__, 'code': str(error) if isinstance(error, RuntimeError) else 'native_gate_failed'}
        raise
    finally:
        (output / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({key: report[key] for key in ['status', 'head', 'tree', 'baseline', 'runId', 'runAttempt'] if key in report}))


if __name__ == '__main__':
    if sys.argv[1:] == ['run']:
        run()
    elif len(sys.argv) == 5 and sys.argv[1] == 'child' and sys.argv[2] in ('baseline_green', 'red', 'green'):
        sys.exit(child(sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4])))
    else:
        raise SystemExit('fixed_native_operation_required')
