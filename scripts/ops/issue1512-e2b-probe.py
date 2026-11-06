"""One private desktop candidate and one anonymous catalogue probe; never a release.

The existing OIDC key stays in runner memory. The immutable source's additive
builder and ownership-checked finalizers retain their normal contracts.
"""
import argparse
import contextlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

SOURCE_SHA = 'b8045b5661bcbf51eeecc74ceef19eceead93a10'
REPOSITORY = 'alexj11324/Mikka'
BRANCH = 'refs/heads/ops/1512-git-transport'
APPLICATION = 'mikka-issue1512-desktop-probe'
PREFIX = 'mikka-model-probe '
PHASES = {'entry', 'spawn', 'spawn_throw', 'spawn_error', 'catalogue_received',
          'catalogue_scan_bounded', 'exit', 'close', 'deadline_snapshot',
          'parent_deadline_snapshot', 'parent_deadline_child', 'parent_exit'}
HARNESSES = {'claude_code', 'codex'}
SIGNALS = {'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'other'}
RESOURCES = {'PipeWrap', 'ProcessWrap', 'Timeout', 'TCPSocketWrap', 'TCPServerWrap',
             'FSWatcher', 'FSEventWrap', 'TTYWrap', 'other'}
ERROR_TYPES = {'TimeoutException', 'CommandExitException', 'ConnectError', 'HTTPError',
               'NotFoundException', 'AuthenticationException', 'TemplateException',
               'RateLimitException', 'ValueError', 'RuntimeError', 'DiagnosticFailure'}
CODES = {'workflow_identity_invalid', 'source_mismatch', 'ops_checkout_mismatch', 'source_dirty', 'ledger_invalid',
         'resource_identity_invalid', 'candidate_not_private', 'candidate_collision',
         'catalogue_invalid', 'catalogue_missing', 'command_failed', 'key_missing',
         'diagnostic_deadline', 'interrupted', 'cleanup_incomplete', 'operation_failed'}


class DiagnosticFailure(Exception):
    pass


def fail(code):
    raise DiagnosticFailure(code)


def opaque(value):
    return (isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value)
            and not re.match(r'(?i)(?:sk[-_]|ph[cx]_|gh[pousr]_|github_pat_|e2b_)', value))


def identity(environ):
    if (environ.get('GITHUB_REPOSITORY') != REPOSITORY or environ.get('GITHUB_REF') != BRANCH
            or not re.fullmatch(r'[a-f0-9]{40}', environ.get('GITHUB_SHA', ''))
            or not re.fullmatch(r'[1-9][0-9]{0,19}', environ.get('GITHUB_RUN_ID', ''))
            or not re.fullmatch(r'[1-9][0-9]{0,3}', environ.get('GITHUB_RUN_ATTEMPT', ''))):
        fail('workflow_identity_invalid')
    return {'application': APPLICATION, 'repository': REPOSITORY, 'ref': environ['GITHUB_REF'],
            'sourceCommit': SOURCE_SHA, 'opsCommit': environ['GITHUB_SHA'],
            'runId': environ['GITHUB_RUN_ID'], 'runAttempt': environ['GITHUB_RUN_ATTEMPT']}


def candidate_name(context):
    return f"mikka-i1512-{context['runId']}-{context['runAttempt']}-desktop"


def safe_error(error):
    name = type(error).__name__
    code = error.args[0] if isinstance(error, DiagnosticFailure) and error.args else None
    return {'code': code if isinstance(code, str) and code in CODES else 'operation_failed',
            'type': name if name in ERROR_TYPES else 'unknown'}


def save(path, ledger):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    with open(temp, 'w', encoding='utf8') as stream:
        os.chmod(temp, 0o600)
        json.dump(ledger, stream, indent=2)
        stream.write('\n')
    temp.replace(path)


def stage(ledger, path, phase):
    ledger['phase'] = phase
    save(path, ledger)
    print(json.dumps({'type': 'mikka_issue1512_probe', 'phase': phase}), flush=True)


def new_ledger(context):
    return {'version': 1, 'diagnosticOnly': True, 'releaseAccepted': False, 'identity': context,
            'budget': {'candidates': 1, 'probeSandboxes': 1, 'sandboxSeconds': 60,
                       'commandSeconds': 45, 'internalProbeMilliseconds': 20000},
            'candidate': {'kind': 'desktop', 'name': candidate_name(context), 'absenceConfirmed': False},
            'sandboxes': [], 'events': [], 'ignoredDiagnosticLines': 0,
            'probe': {'status': 'not_started'}, 'cleanup': {'status': 'not_started'}, 'cleanupHistory': []}


def validate_ledger(ledger, context):
    if not isinstance(ledger, dict):
        fail('ledger_invalid')
    row = ledger.get('candidate', {})
    if (set(ledger) - {'version', 'diagnosticOnly', 'releaseAccepted', 'identity', 'budget', 'candidate',
                      'sandboxes', 'events', 'ignoredDiagnosticLines', 'probe', 'cleanup', 'cleanupHistory', 'phase'}
            or not isinstance(row, dict) or set(row) - {'kind', 'name', 'absenceConfirmed', 'templateId', 'buildId'}
            or ledger.get('version') != 1 or ledger.get('diagnosticOnly') is not True
            or ledger.get('releaseAccepted') is not False or ledger.get('identity') != context
            or row.get('kind') != 'desktop' or row.get('name') != candidate_name(context)
            or type(row.get('absenceConfirmed')) is not bool
            or any(key in row and not opaque(row[key]) for key in ['templateId', 'buildId'])
            or not isinstance(ledger.get('sandboxes'), list)
            or any(not isinstance(row, dict) or set(row) - {'sandboxId', 'status'}
                   or not opaque(row.get('sandboxId')) for row in ledger['sandboxes'])):
        fail('ledger_invalid')


def closed_event(value):
    if not isinstance(value, dict) or value.get('version') != 1 or value.get('phase') not in PHASES:
        return None
    numeric = {'elapsedMs', 'stdoutBytes', 'pid', 'catalogueCount', 'exitCode', 'spawned', 'catalogues', 'exited', 'closed'}
    boolean = {'catalogueSeen', 'exited', 'closed'}
    allowed = {'version', 'phase', 'harness', 'signal', 'resources'} | numeric | boolean
    if set(value) - allowed or ('harness' in value and value['harness'] not in HARNESSES):
        return None
    for key, item in value.items():
        if key in boolean and type(item) is bool:
            continue
        if key in boolean and key not in numeric:
            return None
        if key in numeric:
            if item is None and key in {'pid', 'catalogueCount', 'exitCode'}:
                continue
            if type(item) is not int or not 0 <= item <= 2**53 - 1:
                return None
        if key == 'signal' and item is not None and item not in SIGNALS:
            return None
        if key == 'resources' and (not isinstance(item, dict) or set(item) - RESOURCES
                or any(type(count) is not int or not 0 <= count <= 100000 for count in item.values())):
            return None
    return value


class Collector:
    def __init__(self, ledger, output):
        self.ledger, self.output, self.buffer = ledger, output, ''

    def __call__(self, chunk):
        if not isinstance(chunk, str):
            return
        self.buffer += chunk
        if len(self.buffer) > 8192:
            self.buffer = ''
            self.ledger['ignoredDiagnosticLines'] += 1
            return
        while '\n' in self.buffer:
            line, self.buffer = self.buffer.split('\n', 1)
            value = None
            if line.startswith(PREFIX) and len(line) <= 4096:
                try:
                    value = closed_event(json.loads(line[len(PREFIX):]))
                except (ValueError, TypeError):
                    pass
            if value is None or len(self.ledger['events']) >= 64:
                self.ledger['ignoredDiagnosticLines'] += 1
                continue
            self.ledger['events'].append(value)
            save(self.output, self.ledger)
            print(PREFIX + json.dumps(value, separators=(',', ':')), flush=True)


def cleanup_owned(builder, cleaner, context, api_key, ledger, output):
    validate_ledger(ledger, context)
    receipt = {'status': 'complete', 'metadataScanComplete': False, 'sandboxes': [], 'templates': [], 'errors': []}
    if ledger['candidate']['absenceConfirmed']:
        try:
            rows = cleaner.cleanup_sandboxes([context], api_key)
            for row in rows:
                if not opaque(row.get('sandboxId')) or row.get('status') not in {'killed', 'failed'}:
                    fail('resource_identity_invalid')
                receipt['sandboxes'].append({'sandboxId': row['sandboxId'], 'status': row['status']})
                if not any(resource['sandboxId'] == row['sandboxId'] for resource in ledger['sandboxes']):
                    ledger['sandboxes'].append({'sandboxId': row['sandboxId'], 'status': 'recovered_by_metadata'})
            receipt['metadataScanComplete'] = True
        except Exception as error:
            receipt['errors'].append({'phase': 'sandboxes', **safe_error(error)})
        try:
            candidate = {key: value for key, value in ledger['candidate'].items() if key in {'name', 'kind', 'templateId'}}
            rows = builder.cleanup_templates([candidate], api_key)
            if len(rows) != 1:
                fail('resource_identity_invalid')
            for row in rows:
                if (row.get('name') != candidate['name'] or row.get('kind') != 'desktop'
                        or row.get('status') not in {'absent', 'deleted', 'failed', 'retained_public'}
                        or ('templateId' in row and not opaque(row['templateId']))):
                    fail('resource_identity_invalid')
                receipt['templates'].append({key: value for key, value in row.items() if key in {'name', 'kind', 'templateId', 'status'}})
                if 'templateId' in row and 'templateId' not in ledger['candidate']:
                    ledger['candidate']['templateId'] = row['templateId']
        except Exception as error:
            receipt['errors'].append({'phase': 'templates', **safe_error(error)})
    if receipt['errors'] or any(row['status'] in {'failed', 'retained_public'} for row in receipt['sandboxes'] + receipt['templates']):
        receipt['status'] = 'incomplete'
    ledger['cleanup'] = receipt
    ledger.setdefault('cleanupHistory', []).append(receipt)
    ledger['cleanupHistory'] = ledger['cleanupHistory'][-4:]
    save(output, ledger)
    return receipt['status'] == 'complete'


class Sink:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def diagnose(builder, cleaner, sandbox_factory, context, api_key, hook_source, output):
    ledger = new_ledger(context)
    stage(ledger, output, 'preflight')
    try:
        builder.assert_new_template(ledger['candidate']['name'], api_key)
        ledger['candidate']['absenceConfirmed'] = True
        stage(ledger, output, 'building_private_desktop')
        try:
            # The immutable builder performs its original-file conservation and
            # anonymous preloading. No subscription/publication function is called.
            with contextlib.redirect_stdout(Sink()), contextlib.redirect_stderr(Sink()):
                sha, built = builder.build(ledger['candidate']['name'], ref=SOURCE_SHA, api_key=api_key,
                                           kind='desktop', on_build_logs=lambda _: None)
        except ValueError as error:
            if error.args == ('template_name_already_exists',):
                ledger['candidate']['absenceConfirmed'] = False
                fail('candidate_collision')
            raise
        if sha != SOURCE_SHA:
            fail('source_mismatch')
        if not opaque(built.template_id) or not opaque(built.build_id):
            fail('resource_identity_invalid')
        ledger['candidate'].update(templateId=built.template_id, buildId=built.build_id)
        stage(ledger, output, 'candidate_built')
        info = builder._request('GET', '/templates/' + ledger['candidate']['name'], api_key)
        names = (info.get('names') or []) + (info.get('aliases') or [])
        if (info.get('templateID') != built.template_id or ledger['candidate']['name'] not in names
                or info.get('public') is not False or info.get('isDefault') is True):
            fail('candidate_not_private')
        stage(ledger, output, 'creating_anonymous_probe')
        sandbox = sandbox_factory(built.template_id, api_key=api_key, timeout=60, metadata=context)
        if not opaque(sandbox.sandbox_id):
            fail('resource_identity_invalid')
        ledger['sandboxes'].append({'sandboxId': sandbox.sandbox_id, 'status': 'created'})
        stage(ledger, output, 'probing_catalogues')
        hook_path = f"/tmp/mikka-i1512-probe-{context['runId']}-{context['runAttempt']}.mjs"
        sandbox.files.write(hook_path, hook_source, user='user')
        command = ('export PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH; '
                   f'/opt/mikka/runtime/node/bin/node --import {hook_path} '
                   '/opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js --probe-models')
        started = time.monotonic()
        try:
            result = sandbox.commands.run(command, user='user', timeout=45, on_stderr=Collector(ledger, output))
        finally:
            ledger['probe']['elapsedMs'] = round((time.monotonic() - started) * 1000)
        if result.exit_code != 0:
            fail('command_failed')
        try:
            reports = json.loads(result.stdout)
        except (ValueError, TypeError):
            fail('catalogue_invalid')
        if not isinstance(reports, list):
            fail('catalogue_invalid')
        counts = {}
        for harness in sorted(HARNESSES):
            row = next((row for row in reports if isinstance(row, dict) and row.get('harness') == harness and row.get('installed') is True), None)
            catalogue = (row.get('models') or row.get('modelSlots')) if row else None
            if not isinstance(catalogue, list) or not catalogue:
                fail('catalogue_missing')
            counts[harness] = min(len(catalogue), 500)
        ledger['probe'].update(status='passed', catalogueCounts=counts)
        stage(ledger, output, 'diagnostic_complete')
    except Exception as error:
        ledger['probe'].update(status='failed', error=safe_error(error))
        stage(ledger, output, 'diagnostic_failed')
    finally:
        cleanup_owned(builder, cleaner, context, api_key, ledger, output)
    return ledger


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_checkout(source, expected_sha, mismatch_code):
    env = {'PATH': os.environ.get('PATH', ''), 'LANG': 'C.UTF-8'}
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=source, env=env,
                            capture_output=True, text=True, check=True)
    if result.stdout.strip() != expected_sha:
        fail(mismatch_code)
    result = subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=source, env=env, check=False)
    if result.returncode != 0:
        fail('source_dirty')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['diagnose', 'cleanup'])
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    context = identity(os.environ)
    verify_checkout(args.source, SOURCE_SHA, 'source_mismatch')
    verify_checkout(Path(__file__).resolve().parents[2], context['opsCommit'], 'ops_checkout_mismatch')
    builder = load_module('issue1512_builder', args.source / 'scripts/e2b/build-template.py')
    cleaner = load_module('issue1512_cleaner', args.source / 'scripts/e2b/cleanup-template-candidates.py')
    # Subprocesses and uploaded source never inherit the E2B key.
    api_key = os.environ.pop('E2B_API_KEY', '')
    if not api_key:
        fail('key_missing')
    if args.mode == 'cleanup':
        if not args.output.exists():
            save(args.output, new_ledger(context))
        ledger = json.loads(args.output.read_text())
        return 0 if cleanup_owned(builder, cleaner, context, api_key, ledger, args.output) else 1
    from e2b import Sandbox
    hook_source = Path(__file__).with_name('issue1512-e2b-probe-hook.mjs').read_text()
    ledger = diagnose(builder, cleaner, Sandbox.create, context, api_key, hook_source, args.output)
    return 0 if ledger['probe']['status'] == 'passed' and ledger['cleanup']['status'] == 'complete' else 1


if __name__ == '__main__':
    logging.basicConfig(level=logging.CRITICAL)
    signal.signal(signal.SIGTERM, lambda *_: fail('interrupted'))
    signal.signal(signal.SIGINT, lambda *_: fail('interrupted'))
    signal.signal(signal.SIGALRM, lambda *_: fail('diagnostic_deadline'))
    signal.alarm(20 * 60)
    try:
        code = main()
    except Exception as error:
        print(json.dumps({'type': 'mikka_issue1512_probe', 'phase': 'stopped', 'error': safe_error(error)}), flush=True)
        code = 1
    finally:
        signal.alarm(0)
    sys.exit(code)
