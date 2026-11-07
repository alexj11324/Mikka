"""One bounded recovery of three recorded candidates from a failed release."""
import argparse
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

SOURCE = '6adc26c6eab10deb0a873272de502cbc88828f53'
REPOSITORY = 'alexj11324/Mikka'
OPS_REF = 'refs/heads/ops/1512-git-transport'
TARGET_RUN = 42328947041
TARGET_SHA = 'd72227c94eb25174c92d77e4c74e55abe578aa99'
TARGET_WORKER = '60ea0edacca350a3a088836d9c96e8f09e76d1d9'
TARGET_METADATA = {'application': 'mikka-template-release', 'sourceCommit': TARGET_SHA,
                   'runId': str(TARGET_RUN), 'runAttempt': '1'}
TARGETS = [
    {'kind': 'desktop', 'templateId': '0a5qaq69lrw2bn7iz7pj',
     'buildId': '8f58fa18-b373-4aca-8b3b-813cf1bd06e0',
     'name': 'mikka-d72227c94eb2-42328947041-1-desktop'},
    {'kind': 'claude', 'templateId': 'g249155wp8lskmgydask',
     'buildId': '5601b5f1-36d7-4dfd-835f-52e8b055e727',
     'name': 'mikka-d72227c94eb2-42328947041-1-claude'},
    {'kind': 'codex', 'templateId': 'xjvt6dck202q4jpaabby',
     'buildId': 'b998290e-bf7a-461c-a4c4-7b3ac383c217',
     'name': 'mikka-d72227c94eb2-42328947041-1-codex'},
]
CODES = {'operator_identity_invalid', 'source_mismatch', 'ops_checkout_mismatch',
         'checkout_dirty', 'key_missing', 'target_run_changed', 'api_response_invalid',
         'api_path_invalid', 'inventory_nonempty', 'inventory_truncated', 'inventory_scope_mismatch',
         'template_identity_changed', 'template_build_changed', 'template_public',
         'template_visibility_unknown', 'template_default', 'template_name_changed',
         'alias_unavailable', 'alias_rebound', 'delete_without_binding',
         'builder_cleanup_failed', 'deadline', 'interrupted', 'operation_failed'}


class RecoveryFailure(Exception):
    pass


def fail(code):
    raise RecoveryFailure(code)


def opaque(value):
    return (isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value)
            and not re.match(r'(?i)(sk[-_]|ph[cx]_|gh[pousr]_|github_pat_|e2b_)', value))


def safe_error(error):
    code = error.args[0] if isinstance(error, RecoveryFailure) and error.args else None
    result = {'code': code if code in CODES else 'operation_failed'}
    if isinstance(error, HTTPError) and type(error.code) is int:
        result['httpStatus'] = error.code
    return result


def save(output, ledger):
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + '.tmp')
    with temporary.open('w', encoding='utf8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(ledger, stream, indent=2)
        stream.write('\n')
    temporary.replace(output)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http_json(url, headers, method='GET'):
    with build_opener(NoRedirect).open(Request(url, headers=headers, method=method), timeout=10) as response:
        raw = response.read(262145)
    if len(raw) > 262144:
        fail('api_response_invalid')
    value = json.loads(raw) if raw else None
    if value is not None and not isinstance(value, dict):
        fail('api_response_invalid')
    return value


def terminal_run(info):
    if (not isinstance(info, dict) or type(info.get('id')) is not int or info['id'] != TARGET_RUN
            or info.get('repository', {}).get('full_name') != REPOSITORY
            or info.get('path') != '.github/workflows/e2b-official-runtime.yml'
            or info.get('head_branch') != 'main' or info.get('event') != 'push'
            or info.get('head_sha') != TARGET_SHA or type(info.get('run_attempt')) is not int
            or info['run_attempt'] != 1 or info.get('status') != 'completed'
            or info.get('conclusion') != 'failure'):
        fail('target_run_changed')
    return {'id': TARGET_RUN, 'path': info['path'], 'branch': 'main', 'sourceCommit': TARGET_SHA,
            'runAttempt': 1, 'status': 'completed', 'conclusion': 'failure'}


def inventory(sdk, key):
    Sandbox, SandboxQuery, SandboxState = sdk
    pages = Sandbox.list(query=SandboxQuery(metadata=TARGET_METADATA,
                         state=[SandboxState.RUNNING, SandboxState.PAUSED]),
                         limit=10, api_key=key, request_timeout=10)
    rows = pages.next_items() if pages.has_next else []
    result = {'pageLimit': 1, 'rows': [], 'truncated': bool(pages.has_next), 'status': 'empty'}
    if len(rows) > 10:
        result['truncated'] = True
    for row in rows[:10]:
        if (not opaque(row.sandbox_id) or row.template_id not in {item['templateId'] for item in TARGETS}
                or any((row.metadata or {}).get(name) != value for name, value in TARGET_METADATA.items())):
            fail('inventory_scope_mismatch')
        state = getattr(row.state, 'value', row.state)
        result['rows'].append({'sandboxId': row.sandbox_id, 'templateId': row.template_id,
                               'state': state if state in ('running', 'paused') else 'unknown'})
    if result['truncated']:
        result['status'] = 'truncated'
    elif rows:
        result['status'] = 'active'
    return result


def template_binding(info, expected):
    if not isinstance(info, dict) or info.get('templateID') != expected['templateId']:
        fail('template_identity_changed')
    if info.get('public') is True:
        fail('template_public')
    if info.get('public') is not False:
        fail('template_visibility_unknown')
    if info.get('isDefault') is True:
        fail('template_default')
    if info.get('buildID') != expected['buildId'] or info.get('buildStatus') != 'ready':
        fail('template_build_changed')
    names = (info.get('names') or []) + (info.get('aliases') or [])
    if not any(isinstance(name, str) and re.fullmatch(r'(?:[^/]+/)?' + re.escape(expected['name']), name)
               for name in names):
        fail('template_name_changed')


def alias_binding(info, expected):
    if not isinstance(info, dict) or info.get('templateID') != expected['templateId']:
        fail('alias_rebound')
    if info.get('public') is not False:
        fail('template_visibility_unknown')


def recover(builder, github_read, e2b_request, sdk, key, output, operator):
    ledger = {'version': 1, 'operator': operator, 'sourceCodeCommit': SOURCE,
              'targetRun': None, 'targetWorkerSha': TARGET_WORKER,
              'scope': {'templates': 3, 'sandboxPages': 1, 'sandboxMutations': 0,
                        'providerCalls': 0, 'templateCreates': 0, 'configurationWrites': 0},
              'inventory': None, 'status': 'running', 'errors': [],
              'candidates': [{**item, 'status': 'not_attempted', 'deleteRequested': False,
                              'absenceConfirmedById': False} for item in TARGETS]}
    save(output, ledger)
    try:
        ledger['targetRun'] = terminal_run(github_read())
        ledger['inventory'] = inventory(sdk, key)
        save(output, ledger)
        if ledger['inventory']['status'] != 'empty':
            fail('inventory_truncated' if ledger['inventory']['truncated'] else 'inventory_nonempty')
        for expected, receipt in zip(TARGETS, ledger['candidates']):
            id_path = '/templates/' + expected['templateId']
            alias_path = '/templates/aliases/' + expected['name']
            bound = {'id': False, 'alias': False}
            last_error = None

            def checked(method, path, supplied_key):
                nonlocal last_error
                try:
                    if supplied_key != key or (method, path) not in {
                            ('GET', id_path), ('GET', alias_path), ('DELETE', id_path)}:
                        fail('api_path_invalid')
                    if method == 'DELETE':
                        if not all(bound.values()):
                            fail('delete_without_binding')
                        # Revalidate the failed run and both identities at the write boundary.
                        terminal_run(github_read())
                        template_binding(e2b_request('GET', id_path, key), expected)
                        alias_binding(e2b_request('GET', alias_path, key), expected)
                        receipt['deleteRequested'] = True
                        save(output, ledger)
                        return e2b_request(method, path, key)
                    try:
                        result = e2b_request(method, path, key)
                    except HTTPError as error:
                        if error.code == 404 and path == id_path:
                            receipt['absenceConfirmedById'] = True
                        if error.code == 404 and path == alias_path:
                            fail('alias_unavailable')
                        raise
                    if path == id_path:
                        template_binding(result, expected)
                        bound['id'] = True
                    else:
                        alias_binding(result, expected)
                        bound['alias'] = True
                    return result
                except Exception as error:
                    last_error = safe_error(error)
                    raise

            result = builder.cleanup_templates([expected], key, request=checked)[0]
            if result.get('status') in ('deleted', 'absent') and receipt['absenceConfirmedById']:
                receipt['status'] = result['status']
                receipt['absenceHttpStatus'] = 404
            else:
                receipt['status'] = 'retained'
                receipt['error'] = last_error or {'code': 'builder_cleanup_failed'}
            save(output, ledger)
            if (last_error or {}).get('code') in ('target_run_changed', 'deadline', 'interrupted'):
                break
        ledger['status'] = ('complete' if all(row['status'] in ('deleted', 'absent')
                                             for row in ledger['candidates']) else 'incomplete')
    except Exception as error:
        ledger['status'] = 'blocked'
        ledger['errors'].append(safe_error(error))
    finally:
        save(output, ledger)
    return ledger


def verify_checkout(directory, expected, code):
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=directory, check=True,
                            capture_output=True, text=True)
    if result.stdout.strip() != expected:
        fail(code)
    if subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=directory, check=False).returncode:
        fail('checkout_dirty')


def load_builder(source):
    spec = importlib.util.spec_from_file_location('fixed_recovery_builder', source / 'scripts/e2b/build-template.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    return builder


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    env = os.environ
    if (env.get('GITHUB_REPOSITORY') != REPOSITORY or env.get('GITHUB_REF') != OPS_REF
            or not re.fullmatch(r'[a-f0-9]{40}', env.get('GITHUB_SHA', ''))
            or not re.fullmatch(r'[1-9][0-9]*', env.get('GITHUB_RUN_ID', ''))
            or not re.fullmatch(r'[1-9][0-9]*', env.get('GITHUB_RUN_ATTEMPT', ''))
            or env['GITHUB_RUN_ID'] == str(TARGET_RUN)):
        fail('operator_identity_invalid')
    verify_checkout(args.source, SOURCE, 'source_mismatch')
    verify_checkout(Path(__file__).resolve().parents[2], env['GITHUB_SHA'], 'ops_checkout_mismatch')
    operator = {name: env[key] for name, key in [('repository', 'GITHUB_REPOSITORY'), ('ref', 'GITHUB_REF'),
                ('opsCommit', 'GITHUB_SHA'), ('runId', 'GITHUB_RUN_ID'), ('runAttempt', 'GITHUB_RUN_ATTEMPT')]}
    token, key = env.pop('GITHUB_TOKEN', ''), env.pop('E2B_API_KEY', '')
    if not token or not key:
        fail('key_missing')
    github_read = lambda: http_json(f'https://api.github.com/repos/{REPOSITORY}/actions/runs/{TARGET_RUN}',
                                   {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json'})
    from e2b import Sandbox, SandboxQuery, SandboxState
    def e2b_request(method, path, supplied_key):
        return http_json('https://api.e2b.app' + path, {'X-API-Key': supplied_key}, method)
    ledger = recover(load_builder(args.source), github_read, e2b_request,
                     (Sandbox, SandboxQuery, SandboxState), key, args.output, operator)
    print(json.dumps({'event': 'issue1512_candidate_recovery', 'status': ledger['status'],
                      'errors': ledger['errors'], 'candidates': ledger['candidates']}), flush=True)
    return 0 if ledger['status'] == 'complete' else 1


if __name__ == '__main__':
    logging.basicConfig(level=logging.CRITICAL)
    signal.signal(signal.SIGALRM, lambda *_: fail('deadline'))
    signal.signal(signal.SIGTERM, lambda *_: fail('interrupted'))
    signal.signal(signal.SIGINT, lambda *_: fail('interrupted'))
    signal.alarm(120)
    try:
        code = main()
    except Exception as error:
        print(json.dumps({'event': 'issue1512_candidate_recovery', 'error': safe_error(error)}), flush=True)
        code = 1
    finally:
        signal.alarm(0)
    sys.exit(code)
