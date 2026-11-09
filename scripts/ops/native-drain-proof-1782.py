"""Fixed native daemon drain proof: original eight, exact old RED, all twelve."""
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
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('gateway_proof', Path(__file__).with_name('preview-shutdown-native-1782.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
require, sha = gateway.require, gateway.sha
BASE = gateway.BASE
DRIVER = 'apps/desktop/test/native-cleanup.mjs'
CASES = 'apps/desktop/test/native-cleanup.test.mjs'
FIXTURE = 'apps/desktop/test/fixtures/native-daemon.mjs'
BASE_PINS = {
    DRIVER: 'ab8a831c692e0fa2a2f68cdd3d853635aa9dbc784fda5bd62e255d086bb3e25b',
    CASES: 'b2dde82c6587ddb9c78389dd729c82411ccc6b00993746f50960c08e8134345a',
    FIXTURE: '9ed515ae1abf277b1db0d7c6b2d00744188cd2bd11c6703b903163210b7d7964',
}
TARGET = 'a drain reply lost to actual authenticated socket closure still requires the exact owned process to exit'
EXTRA = {
    TARGET,
    'socket closure without a drain reply cannot permit cleanup while its authenticated PID remains live',
    'a real drain RPC error with the timeout text remains a failure when that daemon subsequently closes and exits',
    'a malformed drain reply remains a failure even when that daemon subsequently closes and exits',
}


def test_names(source):
    names = re.findall(r"^test\('([^'\n]+)',", source.decode(), flags=re.M)
    require(len(names) == len(set(names)), 'duplicate_test_names')
    return sorted(names)


def validate_junit(raw, phase, expected):
    require(len(raw) <= 1_000_000 and b'<!DOCTYPE' not in raw and b'<!ENTITY' not in raw, 'junit_input_refused')
    root = ET.fromstring(raw, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
    require(root.tag == 'testsuites', 'junit_root_changed')
    cases, counts = [], {}
    for item in root:
        if item.tag is ET.Comment:
            match = re.fullmatch(r'\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9]+(?:\.[0-9]+)?)\s*', item.text or '')
            require(match is not None and match[1] not in counts, 'junit_summary_changed')
            counts[match[1]] = float(match[2])
        else:
            require(item.tag == 'testcase', 'unexpected_nested_suite')
            cases.append(item)
    require(set(counts) == {'tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'}
            and all(counts[key] == 0 for key in ['suites', 'cancelled', 'skipped', 'todo']), 'junit_incomplete_or_skipped')
    names = [item.get('name') for item in cases]
    require(len(names) == len(set(names)) and sorted(names) == sorted(expected)
            and counts['tests'] == len(expected), 'junit_wrong_cases')
    require(all(item.get('classname') == 'test' and item.get('file', '').endswith('/' + CASES) for item in cases), 'junit_wrong_source')
    if phase == 'red':
        require(expected == [TARGET] and counts['pass'] == 0 and counts['fail'] == 1, 'expected_timeout_missing')
        item = cases[0]; failures = list(item)
        require(len(failures) == 1 and failures[0].tag == 'failure'
                and failures[0].get('type') == 'testCodeFailure'
                and failures[0].get('message') == item.get('failure') == 'NATIVE_DAEMON_DRAIN_TIMEOUT', 'wrong_red_failure')
        trace = failures[0].text or ''
        require('cause: Error: NATIVE_DAEMON_DRAIN_TIMEOUT' in trace
                and re.search(r'at Timeout\.(?:_onTimeout|<anonymous>) \([^\n)]*native-cleanup\.mjs:16:39\)', trace), 'wrong_timeout_stage')
        require(float(item.get('time', '0')) >= 4.9, 'response_window_not_exercised')
    else:
        require(phase in ('baseline_green', 'green') and len(expected) == (8 if phase == 'baseline_green' else 12)
                and counts['pass'] == len(expected) and counts['fail'] == 0
                and all(len(item) == 0 and item.get('failure') is None for item in cases), 'native_green_failed')
    return {'testsRun': int(counts['tests']), 'passed': int(counts['pass']), 'failed': int(counts['fail']),
            'skipped': 0, 'cancelled': 0, 'todo': 0, 'durationMs': counts['duration_ms'],
            'cases': [{'name': item.get('name'), 'seconds': float(item.get('time', '0'))} for item in cases],
            'failure': 'NATIVE_DAEMON_DRAIN_TIMEOUT' if phase == 'red' else None}


def source(repo, env):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=repo)
    require(env.get('GITHUB_ACTIONS') == 'true' and env.get('GITHUB_REPOSITORY') == 'alexj11324/Mikka'
            and env.get('GITHUB_ACTOR') == env.get('GITHUB_TRIGGERING_ACTOR') == 'alexj11324'
            and env.get('GITHUB_EVENT_NAME') == 'push' and env.get('GITHUB_RUN_ATTEMPT') == '1'
            and env.get('GITHUB_REF') == 'refs/heads/' + gateway.BRANCH and env.get('GITHUB_JOB') == 'native_drain'
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
    git('merge-base', '--is-ancestor', BASE, head)
    changed = set(git('diff', '--name-only', BASE, head).decode().splitlines())
    require(changed == gateway.ALLOWED, 'source_scope_changed')
    for path, digest in gateway.PIN.items():
        require(sha((repo / path).read_bytes()) == digest, 'candidate_bytes_changed')
    old = {path: git('show', BASE + ':' + path) for path in BASE_PINS}
    require(all(sha(data) == BASE_PINS[path] for path, data in old.items()), 'baseline_bytes_changed')
    original, candidate = test_names(old[CASES]), test_names((repo / CASES).read_bytes())
    require(len(original) == 8 and set(candidate) == set(original) | EXTRA and len(candidate) == 12, 'test_set_changed')
    return {'head': head, 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'baseline': BASE,
        'runId': env['GITHUB_RUN_ID'], 'runAttempt': 1, 'changedPaths': sorted(changed),
        'files': {path: sha((repo / path).read_bytes()) for path in sorted(gateway.ALLOWED | {gateway.FIREWALL})},
        'baselineFiles': BASE_PINS, 'originalTestNames': original, 'testNames': candidate}, old


def native_preflight():
    version = subprocess.check_output(['node', '--version'], text=True).strip()
    require(platform.system() == 'Linux' and re.fullmatch(r'v24\.[0-9]+\.[0-9]+', version), 'native_environment_refused')
    with tempfile.TemporaryDirectory(prefix='mikka-drain-native-') as directory:
        path = Path(directory) / 'test.sock'
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(path)); listener.listen(1)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(path)); connection, _ = listener.accept()
                with connection:
                    client.sendall(b'1782'); require(connection.recv(4) == b'1782', 'native_unix_failed')
    return {'platform': 'Linux', 'node': version, 'nativeUnixRoundTrip': True,
            'helloMs': 3000, 'responseMs': 5000, 'totalExitMs': 20000}


def run():
    repo = Path(__file__).resolve().parents[2]
    output = Path(os.environ['RUNNER_TEMP']) / 'native-drain-proof-1782'; output.mkdir(parents=True, exist_ok=True)
    report = {'version': 1, 'status': 'failed', 'productionCredentialsRead': False, 'productionAccessed': False}
    candidate = None
    try:
        binding, old = source(repo, os.environ); report.update(binding)
        report['environment'] = native_preflight()
        candidate = {path: (repo / path).read_bytes() for path in BASE_PINS}
        for phase in ['baseline_green', 'red', 'green']:
            for path, data in candidate.items():
                (repo / path).write_bytes(old[path] if phase == 'baseline_green' or phase == 'red' and path == DRIVER else data)
            args = ['node', '--test', '--test-reporter=junit']
            expected = binding['originalTestNames'] if phase == 'baseline_green' else binding['testNames']
            if phase == 'red':
                args += ['--test-name-pattern=^' + re.escape(TARGET) + '$']; expected = [TARGET]
            args += [CASES]
            with (output / (phase + '.xml')).open('wb') as stdout, (output / (phase + '.log')).open('wb') as stderr:
                result = subprocess.run(args, cwd=repo, stdout=stdout, stderr=stderr, timeout=90, env=os.environ.copy())
            require(result.returncode == (1 if phase == 'red' else 0), 'native_child_failed')
            value = validate_junit((output / (phase + '.xml')).read_bytes(), phase, expected)
            value.update({'exitCode': result.returncode, 'junitSha256': sha((output / (phase + '.xml')).read_bytes()),
                          'logSha256': sha((output / (phase + '.log')).read_bytes())})
            report[phase] = value
        report['status'] = 'native_drain_red_green_passed'
    except Exception as error:
        report['failure'] = {'type': type(error).__name__, 'code': str(error) if isinstance(error, RuntimeError) else 'native_gate_failed'}
        raise
    finally:
        if candidate is not None:
            for path, data in candidate.items(): (repo / path).write_bytes(data)
            report['checkoutRestored'] = all((repo / path).read_bytes() == data for path, data in candidate.items())
            require(report['checkoutRestored'], 'checkout_restore_failed')
        (output / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({key: report[key] for key in ['status', 'head', 'tree', 'runId', 'runAttempt'] if key in report}))


if __name__ == '__main__':
    require(sys.argv[1:] == ['run'], 'fixed_native_operation_required')
    run()
