"""Fixed native Unix proof for the already accepted late-shutdown request."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import traceback
import unittest

spec = importlib.util.spec_from_file_location('gateway_proof', Path(__file__).with_name('preview-shutdown-native-1782.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
require, sha = gateway.require, gateway.sha

SOURCE_PARENT = 'dcca581eab9a3a86c41df0f17b398ff4bba32a65'
SOURCE_PARENT_TREE = '0280ae1b4e495da5dbe17d8497343689690f60bd'
BASE_PRODUCT = 'b315f01116d64bc8a7cc1ef4312e4d14e7790dbb'
BASE_PRODUCT_TREE = '95f69cec928307e837e3e19fd401100ed7a90117'
HELPER = 'scripts/ops/preview-late-shutdown-native-1782.py'
HELPER_TEST = 'scripts/ops/preview-late-shutdown-native-1782.test.py'
FIXTURE_DIRECTORY = 'scripts/ops/fixtures/preview-late-shutdown-1782/'
CANDIDATE_FILES = {gateway.GATEWAY: FIXTURE_DIRECTORY + 'preview-gateway.py',
                   gateway.CASES: FIXTURE_DIRECTORY + 'preview-gateway.test.py'}
BASE_PINS = {
    gateway.GATEWAY: '51518b32cc9867b9808c4eaddf2032c33ae099f289577a001acde8679d5f4f18',
    gateway.CASES: '2e882eb0eae0d512dbf2bec46bfec479a90a251b75e58a1784cc10936bc8484c',
    gateway.FIREWALL: 'c6e94c350e25bf1936a4c74b9a222575bba9c02c805d9c3e264229b64fe3f3b4',
}
CANDIDATE_PINS = {
    gateway.GATEWAY: '38f3be0ebc824522ad04dd69493b2520c575a7d20589c32ec5894d586482c954',
    gateway.CASES: '6cc1ca8deecede58f56af6c423eb56d253b5f3b58ce19583f8ab1bf816c40adb',
}
PATCH_PATHS = {gateway.WORKFLOW, gateway.HELPER, gateway.HELPER_TEST, HELPER, HELPER_TEST,
               *CANDIDATE_FILES.values()}
TARGET = 'test_late_shutdown_preserves_replacement_control_socket'
FAIL_MESSAGE = 'False is not true : late shutdown must not unlink the replacement control socket'
FAIL_ASSERTION = "self.assertTrue(socket_path.exists(), 'late shutdown must not unlink the replacement control socket')"
PHASES = ('baseline_green', 'red', 'green')


def test_preservation(old, new):
    original, candidate = gateway.test_methods(old), gateway.test_methods(new)
    require(len(original) == 15 and len(candidate) == 16 and set(candidate) == set(original) | {TARGET},
            'fixture_cases_changed')
    require(all(candidate[name] == body for name, body in original.items()), 'original_case_changed')
    return sorted(original), sorted(candidate)


def validate_phase(value, phase, names):
    require(phase in PHASES and isinstance(value, dict)
            and set(value) == {'phase', 'testsRun', 'successes', 'errors', 'failures', 'skipped',
                              'expectedFailures', 'unexpectedSuccesses'}
            and value['phase'] == phase and type(value['testsRun']) is int
            and all(type(value[key]) is int and value[key] == 0
                    for key in ('skipped', 'expectedFailures', 'unexpectedSuccesses'))
            and all(isinstance(value[key], list) for key in ('successes', 'errors', 'failures')),
            'native_result_invalid')
    if phase == 'red':
        require(value['testsRun'] == 1 and value['successes'] == [] and value['errors'] == []
                and len(value['failures']) == 1, 'expected_unlink_failure_missing')
        failure = value['failures'][0]
        require(failure.get('test') == 'preview_late_shutdown_cases.PreviewAcceptance.' + TARGET
                and failure.get('type') == 'builtins.AssertionError'
                and failure.get('messageMatched') is True, 'wrong_red_failure')
        require(any(frame.get('file') == 'preview-gateway.test.py' and frame.get('function') == TARGET
                    and frame.get('replacementSocketSurvivalAssertion') is True
                    for frame in failure.get('frames', [])), 'wrong_assertion_stage')
    else:
        expected = {'preview_late_shutdown_cases.PreviewAcceptance.' + name for name in names}
        count = 15 if phase == 'baseline_green' else 16
        require(value['testsRun'] == count and value['errors'] == [] and value['failures'] == []
                and len(value['successes']) == count and set(value['successes']) == expected,
                'native_green_failed')


class EvidenceResult(gateway.EvidenceResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.observed_failures = []

    def addFailure(self, test, error):
        self.observed_failures.append({
            'test': test.id(), 'type': error[0].__module__ + '.' + error[0].__qualname__,
            'messageMatched': str(error[1]) == FAIL_MESSAGE,
            'frames': [{'file': Path(frame.filename).name, 'function': frame.name, 'line': frame.lineno,
                        'replacementSocketSurvivalAssertion': frame.name == TARGET
                        and (frame.line or '').strip() == FAIL_ASSERTION}
                       for frame in traceback.extract_tb(error[2])],
        })
        super().addFailure(test, error)


def result_evidence(result, phase):
    return {'phase': phase, 'testsRun': result.testsRun, 'successes': result.passed,
            'errors': result.observed_errors, 'failures': result.observed_failures,
            'skipped': len(result.skipped), 'expectedFailures': len(result.expectedFailures),
            'unexpectedSuccesses': len(result.unexpectedSuccesses)}


def child(phase, directory, result_path):
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location('preview_late_shutdown_cases', directory / 'preview-gateway.test.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if phase == 'red':
        suite = unittest.defaultTestLoader.loadTestsFromName('PreviewAcceptance.' + TARGET, module)
    else:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(module.PreviewAcceptance)
    result = unittest.TextTestRunner(verbosity=2, resultclass=EvidenceResult).run(suite)
    result_path.write_text(json.dumps(result_evidence(result, phase), indent=2) + '\n')
    return 0 if result.wasSuccessful() else 1


def source(repo, env):
    def git(*args):
        return subprocess.check_output(['git', '-c', 'safe.directory=' + str(repo), *args], cwd=repo)
    require(env.get('GITHUB_ACTIONS') == 'true' and env.get('GITHUB_REPOSITORY') == 'alexj11324/Mikka'
            and env.get('GITHUB_ACTOR') == env.get('GITHUB_TRIGGERING_ACTOR') == 'alexj11324'
            and env.get('GITHUB_EVENT_NAME') == 'push' and env.get('GITHUB_RUN_ATTEMPT') == '1'
            and env.get('GITHUB_REF') == 'refs/heads/' + gateway.BRANCH
            and env.get('GITHUB_JOB') == 'native_late_shutdown'
            and env.get('GITHUB_WORKFLOW_REF') == 'alexj11324/Mikka/' + gateway.WORKFLOW + '@refs/heads/' + gateway.BRANCH,
            'source_context_refused')
    head = git('rev-parse', 'HEAD').decode().strip()
    event = json.loads(Path(env['GITHUB_EVENT_PATH']).read_text())
    require(re.fullmatch('[a-f0-9]{40}', head) and head == env.get('GITHUB_SHA')
            and event.get('after') == head and event.get('ref') == env.get('GITHUB_REF')
            and event.get('repository', {}).get('id') == 1427517699
            and event.get('repository', {}).get('owner', {}).get('id') == 183887963
            and event.get('forced') is False and event.get('deleted') is False
            and git('status', '--porcelain', '--untracked-files=all') == b'', 'source_identity_refused')
    require(git('show', '-s', '--format=%P', head).decode().strip() == SOURCE_PARENT
            and git('rev-parse', SOURCE_PARENT + '^{tree}').decode().strip() == SOURCE_PARENT_TREE,
            'source_parent_changed')
    git('merge-base', '--is-ancestor', gateway.BASE, head)
    changed = set(git('diff', '--name-only', gateway.BASE, head).decode().splitlines())
    appended = set(git('diff', '--name-only', SOURCE_PARENT, head).decode().splitlines())
    require(changed == gateway.ALLOWED and appended == PATCH_PATHS, 'source_scope_changed')
    for path, digest in gateway.PIN.items():
        require(sha((repo / path).read_bytes()) == digest, 'candidate_bytes_changed')
    require(git('rev-parse', BASE_PRODUCT + '^{tree}').decode().strip() == BASE_PRODUCT_TREE,
            'baseline_source_changed')
    old = {path: git('show', BASE_PRODUCT + ':' + path) for path in BASE_PINS}
    require(all(sha(data) == BASE_PINS[path] and data == (repo / path).read_bytes()
                for path, data in old.items()), 'baseline_bytes_changed')
    candidate = {path: (repo / fixture).read_bytes() for path, fixture in CANDIDATE_FILES.items()}
    require(all(sha(data) == CANDIDATE_PINS[path] for path, data in candidate.items()), 'candidate_bytes_changed')
    original_names, names = test_preservation(old[gateway.CASES], candidate[gateway.CASES])
    return {'head': head, 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
            'sourceParent': SOURCE_PARENT, 'sourceParentTree': SOURCE_PARENT_TREE,
            'baselineProduct': BASE_PRODUCT, 'baselineProductTree': BASE_PRODUCT_TREE,
            'runId': env['GITHUB_RUN_ID'], 'runAttempt': 1,
            'changedPaths': sorted(changed), 'appendedPaths': sorted(appended),
            'files': {path: sha((repo / path).read_bytes()) for path in sorted(gateway.ALLOWED | {gateway.FIREWALL})},
            'baselineFiles': BASE_PINS, 'candidateFiles': CANDIDATE_PINS,
            'originalTestNames': original_names, 'testNames': names,
            'originalTests': 15, 'newTests': 1}, old, candidate


def run():
    repo = Path(__file__).resolve().parents[2]
    output = Path(os.environ['RUNNER_TEMP']) / 'preview-late-shutdown-native-1782'
    output.mkdir(mode=0o755, parents=True, exist_ok=True)
    report = {'version': 1, 'status': 'failed', 'productionCredentialsRead': False, 'productionAccessed': False}
    try:
        binding, old, candidate = source(repo, os.environ)
        report.update(binding)
        with tempfile.TemporaryDirectory(prefix='preview-late-shutdown-native-', dir=os.environ['RUNNER_TEMP']) as directory:
            fixture_root = Path(directory)
            report['environment'] = gateway.native_preflight(fixture_root)
            for phase in PHASES:
                location = fixture_root / phase
                location.mkdir()
                for path in [gateway.GATEWAY, gateway.CASES, gateway.FIREWALL]:
                    data = (old[path] if path == gateway.FIREWALL or phase == 'baseline_green'
                            or phase == 'red' and path == gateway.GATEWAY else candidate[path])
                    (location / Path(path).name).write_bytes(data)
                result_path = output / (phase + '.json')
                with (output / (phase + '.log')).open('w') as log:
                    completed = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'child', phase,
                        str(location), str(result_path)], stdout=log, stderr=subprocess.STDOUT,
                        timeout=30 if phase == 'red' else 60,
                        env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
                require(completed.returncode == (1 if phase == 'red' else 0) and result_path.is_file(),
                        'native_child_failed')
                raw = result_path.read_bytes()
                require(len(raw) <= 131_072, 'native_result_too_large')
                result = json.loads(raw)
                validate_phase(result, phase, binding['originalTestNames'] if phase == 'baseline_green' else binding['testNames'])
                report[phase] = {'status': 'expected_unlink_failure_observed' if phase == 'red' else 'all_cases_passed',
                    'exitCode': completed.returncode, 'testsRun': result['testsRun'],
                    'resultSha256': sha(raw), 'logSha256': sha((output / (phase + '.log')).read_bytes())}
        report['fixtureDirectoryRemoved'] = not fixture_root.exists()
        require(report['fixtureDirectoryRemoved'], 'fixture_cleanup_failed')
        report['status'] = 'native_late_shutdown_red_green_passed'
    except Exception as error:
        report['failure'] = {'type': type(error).__name__,
                             'code': str(error) if isinstance(error, RuntimeError) else 'native_gate_failed'}
        raise
    finally:
        (output / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({key: report[key] for key in ['status', 'head', 'tree', 'baselineProduct', 'runId', 'runAttempt'] if key in report}))


if __name__ == '__main__':
    if sys.argv[1:] == ['run']:
        run()
    elif len(sys.argv) == 5 and sys.argv[1] == 'child' and sys.argv[2] in PHASES:
        sys.exit(child(sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4])))
    else:
        raise SystemExit('fixed_native_operation_required')
