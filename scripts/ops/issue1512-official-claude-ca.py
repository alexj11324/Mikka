"""Observe one public CA file on one fresh official Claude VM; never a release."""
import argparse
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SOURCE_SHA = 'd63b5e1b2e70baa368cf42ec6f9b13691571b6e0'
REPOSITORY = 'alexj11324/Mikka'
BRANCH = 'refs/heads/ops/1512-git-transport'
APPLICATION = 'mikka-issue1512-official-claude-ca'
CA_PATH = '/usr/local/share/ca-certificates/e2b-ca.crt'
FAILURE_REFERENCE = {'workflowRunId': '42326876749', 'sourceCommit': SOURCE_SHA,
                     'beforeMode': 420, 'afterMode': 511,
                     'beforeSha256': 'fd1175201e861f159f0d6ae42523b0f5d754ade8a36d105e8b7110b180101862',
                     'afterSha256': '21899698fbaa1da5314e42bc049b146f16cddb2e7540822b2a15f009f8342996'}
ERROR_CODES = {'workflow_identity_invalid', 'source_mismatch', 'ops_checkout_mismatch', 'checkout_dirty',
               'key_missing', 'api_path_invalid', 'api_response_invalid', 'official_template_unverified',
               'template_identity_changed', 'sandbox_identity_invalid', 'sandbox_ownership_mismatch',
               'command_failed', 'ca_observation_invalid', 'ledger_invalid', 'cleanup_scope_exceeded',
               'sandbox_still_exists', 'diagnostic_deadline', 'interrupted', 'operation_failed'}
ERROR_TYPES = {'DiagnosticFailure', 'HTTPError', 'TimeoutException', 'TimeoutError', 'CommandExitException',
               'ConnectError', 'ReadTimeout', 'ConnectTimeout', 'NotFoundException', 'AuthenticationException',
               'ValueError', 'RuntimeError', 'OSError'}

# The guest receives no key, source checkout, task identity or installation.
# O_NOFOLLOW plus before/after identities bind these bytes to the fixed file.
CA_PROGRAM = r'''import hashlib,json,os,stat,sys
CERTIFICATE_PATH = '/usr/local/share/ca-certificates/e2b-ca.crt'
def observe():
    fd = os.open(CERTIFICATE_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 131072:
            raise ValueError('ca_file_invalid')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(131073)
        after = os.fstat(fd)
        current = os.stat(CERTIFICATE_PATH, follow_symlinks=False)
        identity = lambda value: (value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_gid,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
        if len(data) != before.st_size or identity(before) != identity(after) or identity(before) != identity(current):
            raise ValueError('ca_file_changed')
        return {'path':CERTIFICATE_PATH,'mode':stat.S_IMODE(before.st_mode),'uid':before.st_uid,'gid':before.st_gid,
                'size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'identityStable':True}
    finally:
        os.close(fd)
if __name__ == '__main__':
    try:
        print(json.dumps(observe(),separators=(',',':')))
    except Exception:
        print('{"error":"ca_observation_failed"}',file=sys.stderr)
        sys.exit(1)
'''
CA_COMMAND = "python3 -B - <<'MIKKA_PUBLIC_CA_CONTROL'\n" + CA_PROGRAM + 'MIKKA_PUBLIC_CA_CONTROL'


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
    return {'application': APPLICATION, 'repository': REPOSITORY, 'ref': BRANCH, 'sourceCommit': SOURCE_SHA,
            'opsCommit': environ['GITHUB_SHA'], 'runId': environ['GITHUB_RUN_ID'], 'runAttempt': environ['GITHUB_RUN_ATTEMPT']}


def safe_error(error):
    code = error.args[0] if isinstance(error, DiagnosticFailure) and error.args else None
    result = {'code': code if isinstance(code, str) and code in ERROR_CODES else 'operation_failed',
              'type': type(error).__name__ if type(error).__name__ in ERROR_TYPES else 'unknown'}
    if isinstance(error, HTTPError) and type(error.code) is int and 100 <= error.code <= 599:
        result['httpStatus'] = error.code
    return result


def save(output, ledger):
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(output.name + '.tmp')
    with temp.open('w', encoding='utf8') as stream:
        os.chmod(temp, 0o600)
        json.dump(ledger, stream, indent=2)
        stream.write('\n')
    temp.replace(output)


def api_get(path, key):
    if not (path == '/templates/aliases/claude' or re.fullmatch(r'/(?:templates|sandboxes)/[A-Za-z0-9_-]{1,128}', path)):
        fail('api_path_invalid')
    request = Request('https://api.e2b.app' + path, headers={'X-API-Key': key}, method='GET')
    with urlopen(request, timeout=10) as response:
        raw = response.read(262145)
    if len(raw) > 262144:
        fail('api_response_invalid')
    value = json.loads(raw)
    if not isinstance(value, dict):
        fail('api_response_invalid')
    return value


def official_template(request, key):
    alias = request('/templates/aliases/claude', key)
    template_id = alias.get('templateID')
    if alias.get('public') is not True or not opaque(template_id):
        fail('official_template_unverified')
    info = request('/templates/' + template_id, key)
    if (info.get('templateID') != template_id or info.get('public') is not True
            or info.get('isDefault') is not True or info.get('buildStatus') != 'ready'
            or not opaque(info.get('buildID'))):
        fail('official_template_unverified')
    def timestamp(value):
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})', value):
            return None
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
        except ValueError:
            return None
    builds = info.get('builds', [])
    build = next((row for row in builds if isinstance(row, dict) and row.get('buildID') == info['buildID']), {}) if isinstance(builds, list) else {}
    return {'alias': 'claude', 'templateId': template_id, 'buildId': info['buildID'],
            'public': True, 'isDefault': True, 'buildStatus': 'ready',
            'templateCreatedAt': timestamp(info.get('createdAt')), 'templateUpdatedAt': timestamp(info.get('updatedAt')),
            'buildCreatedAt': timestamp(build.get('createdAt')), 'buildUpdatedAt': timestamp(build.get('updatedAt'))}


def closed_observation(raw):
    if not isinstance(raw, str) or len(raw) > 2048:
        fail('ca_observation_invalid')
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'path', 'mode', 'uid', 'gid', 'size', 'sha256', 'identityStable'}
            or value.get('path') != CA_PATH or value.get('identityStable') is not True
            or not isinstance(value.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', value['sha256'])
            or any(type(value.get(field)) is not int or not 0 <= value[field] <= bound
                   for field, bound in [('mode', 4095), ('uid', 2**32 - 1), ('gid', 2**32 - 1), ('size', 131072)])
            or value['size'] == 0):
        fail('ca_observation_invalid')
    return value


def new_ledger(context):
    return {'version': 1, 'diagnosticOnly': True, 'releaseAccepted': False, 'policyChanged': False,
            'identity': context, 'budget': {'sandboxes': 1, 'sandboxSeconds': 60, 'commands': 1,
                'commandSeconds': 15, 'overallSeconds': 180},
            'scope': {'officialTemplate': 'claude', 'file': CA_PATH, 'mikkaInstalled': False,
                'taskCredentialsProvided': False, 'providerCalls': 0, 'templateMutations': 0},
            'buildIdentitySource': 'template_api_before_after', 'sandboxBuildIdExposedByApi': False,
            'attribution': 'observation_only_requires_matching_base_or_controlled_before_after',
            'failureReference': dict(FAILURE_REFERENCE), 'comparisonToFailure': None,
            'officialBefore': None, 'officialAfter': None, 'createStarted': False, 'sandboxId': None,
            'observation': None, 'probe': {'status': 'not_started'}, 'cleanup': {'status': 'not_started'},
            'cleanupHistory': []}


def validate_ledger(ledger, context):
    expected = new_ledger(context)
    if (not isinstance(ledger, dict) or set(ledger) != set(expected)
            or any(ledger.get(key) != expected[key] for key in ['version', 'identity', 'budget', 'scope',
                'buildIdentitySource', 'sandboxBuildIdExposedByApi', 'attribution', 'failureReference'])
            or ledger.get('diagnosticOnly') is not True or ledger.get('releaseAccepted') is not False
            or ledger.get('policyChanged') is not False or type(ledger.get('createStarted')) is not bool
            or (ledger.get('sandboxId') is not None and (not ledger['createStarted'] or not opaque(ledger['sandboxId'])))):
        fail('ledger_invalid')
    before = ledger.get('officialBefore')
    if ledger['createStarted'] and (not isinstance(before, dict) or before.get('alias') != 'claude'
            or before.get('public') is not True or before.get('isDefault') is not True
            or not opaque(before.get('templateId')) or not opaque(before.get('buildId'))):
        fail('ledger_invalid')


def assert_owned(info, sandbox_id, ledger, context):
    if (info.get('sandboxID') != sandbox_id or info.get('templateID') != ledger['officialBefore']['templateId']
            or info.get('metadata') != context):
        fail('sandbox_ownership_mismatch')


def cleanup_owned(sdk, request, context, key, ledger, output):
    validate_ledger(ledger, context)
    Sandbox, SandboxQuery, SandboxState = sdk
    receipt = {'status': 'complete', 'sandboxes': [], 'errors': [], 'metadataRecoveryUsed': False}
    try:
        if ledger['createStarted'] and ledger['sandboxId'] is None:
            receipt['metadataRecoveryUsed'] = True
            pages = Sandbox.list(query=SandboxQuery(metadata=context, state=[SandboxState.RUNNING, SandboxState.PAUSED]),
                                 api_key=key, request_timeout=10)
            rows = pages.next_items() if pages.has_next else []
            if pages.has_next or len(rows) > 1:
                fail('cleanup_scope_exceeded')
            if rows:
                row = rows[0]
                if not opaque(row.sandbox_id) or row.metadata != context or row.template_id != ledger['officialBefore']['templateId']:
                    fail('sandbox_ownership_mismatch')
                ledger['sandboxId'] = row.sandbox_id
                save(output, ledger)
        sandbox_id = ledger['sandboxId']
        if sandbox_id is not None:
            row = {'sandboxId': sandbox_id, 'killRequested': False, 'absenceConfirmedById': False}
            receipt['sandboxes'].append(row)
            try:
                info = request('/sandboxes/' + sandbox_id, key)
            except HTTPError as error:
                if error.code != 404:
                    raise
            else:
                assert_owned(info, sandbox_id, ledger, context)
                row['killRequested'] = True
                Sandbox.kill(sandbox_id, api_key=key, request_timeout=10)
                try:
                    request('/sandboxes/' + sandbox_id, key)
                except HTTPError as error:
                    if error.code != 404:
                        raise
                else:
                    fail('sandbox_still_exists')
            row['absenceConfirmedById'] = True
    except Exception as error:
        receipt['status'] = 'failed'
        receipt['errors'].append(safe_error(error))
    ledger['cleanup'] = receipt
    ledger['cleanupHistory'] = [*ledger.get('cleanupHistory', []), receipt][-2:]
    save(output, ledger)
    return receipt['status'] == 'complete'


def diagnose(sdk, request, context, key, output):
    ledger, began = new_ledger(context), time.monotonic()
    save(output, ledger)
    phase = 'official_identity'
    try:
        ledger['officialBefore'] = official_template(request, key)
        phase = 'create'
        ledger['createStarted'] = True
        save(output, ledger)
        sandbox = sdk[0].create(ledger['officialBefore']['templateId'], api_key=key,
                                timeout=60, metadata=context, request_timeout=25)
        if not opaque(sandbox.sandbox_id):
            fail('sandbox_identity_invalid')
        ledger['sandboxId'] = sandbox.sandbox_id
        save(output, ledger)
        phase = 'sandbox_identity'
        assert_owned(request('/sandboxes/' + sandbox.sandbox_id, key), sandbox.sandbox_id, ledger, context)
        phase = 'ca_read'
        result = sandbox.commands.run(CA_COMMAND, user='user', timeout=15, request_timeout=20)
        if result.exit_code != 0:
            fail('command_failed')
        ledger['observation'] = closed_observation(result.stdout)
        ledger['comparisonToFailure'] = {
            'matchesBeforeSha256': ledger['observation']['sha256'] == FAILURE_REFERENCE['beforeSha256'],
            'matchesAfterSha256': ledger['observation']['sha256'] == FAILURE_REFERENCE['afterSha256'],
            'matchesBeforeMode': ledger['observation']['mode'] == FAILURE_REFERENCE['beforeMode'],
            'matchesAfterMode': ledger['observation']['mode'] == FAILURE_REFERENCE['afterMode']}
        save(output, ledger)
        phase = 'official_identity_after'
        ledger['officialAfter'] = official_template(request, key)
        if any(ledger['officialAfter'][key] != ledger['officialBefore'][key]
               for key in ['alias', 'templateId', 'buildId', 'public', 'isDefault', 'buildStatus']):
            fail('template_identity_changed')
        ledger['probe'].update(status='passed', phase='observation_complete')
    except Exception as error:
        ledger['probe'].update(status='failed', phase=phase, error=safe_error(error))
    finally:
        ledger['probe']['elapsedMs'] = round((time.monotonic() - began) * 1000)
        cleanup_owned(sdk, request, context, key, ledger, output)
    return ledger


def verify_checkout(directory, expected, code):
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=directory, capture_output=True, text=True, check=True)
    if result.stdout.strip() != expected:
        fail(code)
    if subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=directory, check=False).returncode != 0:
        fail('checkout_dirty')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['diagnose', 'cleanup'])
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    context = identity(os.environ)
    verify_checkout(args.source, SOURCE_SHA, 'source_mismatch')
    verify_checkout(Path(__file__).resolve().parents[2], context['opsCommit'], 'ops_checkout_mismatch')
    key = os.environ.pop('E2B_API_KEY', '')
    if not key:
        fail('key_missing')
    from e2b import Sandbox, SandboxQuery, SandboxState
    sdk = (Sandbox, SandboxQuery, SandboxState)
    if args.mode == 'cleanup':
        signal.alarm(30)
        ledger = json.loads(args.output.read_text()) if args.output.exists() else new_ledger(context)
        passed = cleanup_owned(sdk, api_get, context, key, ledger, args.output)
    else:
        ledger = diagnose(sdk, api_get, context, key, args.output)
        passed = ledger['probe']['status'] == 'passed' and ledger['cleanup']['status'] == 'complete'
    print(json.dumps({'type': 'mikka_official_claude_ca', 'probe': ledger['probe'], 'cleanup': ledger['cleanup']}), flush=True)
    return 0 if passed else 1


if __name__ == '__main__':
    logging.basicConfig(level=logging.CRITICAL)
    signal.signal(signal.SIGTERM, lambda *_: fail('interrupted'))
    signal.signal(signal.SIGINT, lambda *_: fail('interrupted'))
    signal.signal(signal.SIGALRM, lambda *_: fail('diagnostic_deadline'))
    signal.alarm(150)
    try:
        exit_code = main()
    except Exception as error:
        print(json.dumps({'type': 'mikka_official_claude_ca', 'error': safe_error(error)}), flush=True)
        exit_code = 1
    finally:
        signal.alarm(0)
    sys.exit(exit_code)
