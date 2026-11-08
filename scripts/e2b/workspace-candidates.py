"""Build/clean two private review candidates; never publish a template.

The checkout source and GitHub/OIDC carrier identity are distinct. Reuse the
release builder without changing either context or its eventual release gate.
The trusted runner's 0600 journal precedes creation; no Secret or SDK error
text is retained. Successful templates remain for the subsequent acceptance
driver, whose always step invokes cleanup with the same source/output.
"""
import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.error import HTTPError
from uuid import uuid4

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('workspace_candidate_builder', HERE / 'build-template.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
KINDS = ('claude', 'codex')
JOURNAL = 'creation-journal.json'
MAX_JOURNAL_BYTES = 65_536
ID = re.compile(r'[A-Za-z0-9_-]{1,128}')


class CandidateError(Exception):
    """Only these host-authored codes cross the SDK boundary."""


class Discard:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


@contextmanager
def quiet_sdk():
    with redirect_stdout(Discard()), redirect_stderr(Discard()):
        yield


def error_code(error):
    if isinstance(error, CandidateError):
        return error.args[0]
    if isinstance(error, HTTPError):
        return 'provider_http_error'
    if isinstance(error, (TimeoutError, KeyboardInterrupt)):
        return 'operation_interrupted'
    return 'operation_failed'


def resource_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise CandidateError('resource_identity_invalid')
    return value


def identity(source_ref, environ):
    if not re.fullmatch(r'[a-f0-9]{40}', source_ref or ''):
        raise CandidateError('source_ref_invalid')
    if builder.commit(source_ref) != source_ref or builder.commit('HEAD') != source_ref:
        raise CandidateError('source_ref_not_checkout_head')
    if subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=builder.ROOT, check=False).returncode:
        raise CandidateError('source_checkout_modified')
    metadata = builder.release_metadata(environ)
    if len(metadata) != 4 or any(len(metadata[key]) > 20 for key in ('runId', 'runAttempt')):
        raise CandidateError('workflow_identity_required')
    worker = builder.worker_hash(source_ref)
    if not re.fullmatch(r'[a-f0-9]{40}', worker):
        raise CandidateError('worker_identity_invalid')
    return {'sourceCommit': source_ref, 'workerSha': worker,
            'workflowCommit': metadata['sourceCommit'], 'runId': metadata['runId'], 'runAttempt': metadata['runAttempt']}


def metadata_for(scope):
    return {'application': 'mikka-template-release', 'sourceCommit': scope['workflowCommit'],
            'runId': scope['runId'], 'runAttempt': scope['runAttempt']}


def candidate_name(scope, kind):
    return f"mikka-preview-{scope['sourceCommit'][:12]}-{scope['runId']}-{scope['runAttempt']}-{kind}"


def output_directory(path):
    path = Path(path)
    if path.is_symlink():
        raise CandidateError('output_directory_invalid')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_dir() or path.stat().st_uid != os.geteuid():
        raise CandidateError('output_directory_invalid')
    path.chmod(0o700)
    return path


def write_private(path, value, *, exclusive=False):
    """Atomic, owner-only writes; exclusive reports preserve original failures."""
    raw = (json.dumps(value, indent=2) + '\n').encode()
    if path.is_symlink():
        raise CandidateError('output_file_invalid')
    target = path if exclusive else path.with_name('.' + path.name + '-' + uuid4().hex)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if not exclusive:
            os.replace(target, path)
    finally:
        if not exclusive:
            target.unlink(missing_ok=True)


def read_private(path):
    if path.is_symlink():
        raise CandidateError('creation_journal_invalid')
    details = path.stat()
    if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_mode & 0o077 or details.st_size > MAX_JOURNAL_BYTES:
        raise CandidateError('creation_journal_invalid')
    return json.loads(path.read_bytes())


def read_journal(output, scope):
    value = read_private(output / JOURNAL)
    if (not isinstance(value, dict) or set(value) != {'version', 'identity', 'templates', 'sandboxes', 'pendingSandbox'}
            or type(value['version']) is not int or value['version'] != 1 or value['identity'] != scope
            or not isinstance(value['templates'], dict) or set(value['templates']) != set(KINDS)
            or not isinstance(value['sandboxes'], list) or len(value['sandboxes']) > 16):
        raise CandidateError('creation_journal_invalid')
    for kind, row in value['templates'].items():
        if (not isinstance(row, dict) or set(row) - {'kind', 'name', 'creationStarted', 'collision', 'templateId', 'buildId'}
                or row.get('kind') != kind or row.get('name') != candidate_name(scope, kind)
                or type(row.get('creationStarted')) is not bool or type(row.get('collision')) is not bool
                or ('templateId' in row and (not row['creationStarted'] or row['collision']))
                or ('buildId' in row and 'templateId' not in row)):
            raise CandidateError('creation_journal_invalid')
        for field in ('templateId', 'buildId'):
            if field in row:
                resource_id(row[field])
    seen = set()
    for row in value['sandboxes']:
        if (not isinstance(row, dict) or set(row) != {'sandboxId', 'templateId', 'kind', 'deletedConfirmed'}
                or row['kind'] not in KINDS or row['templateId'] != value['templates'][row['kind']].get('templateId')
                or type(row['deletedConfirmed']) is not bool or row['sandboxId'] in seen):
            raise CandidateError('creation_journal_invalid')
        seen.add(resource_id(row['sandboxId']))
    pending = value['pendingSandbox']
    if pending is not None and (not isinstance(pending, dict) or set(pending) != {'kind', 'templateId'}
            or pending['kind'] not in KINDS or pending['templateId'] != value['templates'][pending['kind']].get('templateId')):
        raise CandidateError('creation_journal_invalid')
    return value


def private_ready(row, api_key, request):
    info = request('GET', '/templates/' + row['templateId'], api_key)
    alias = request('GET', '/templates/aliases/' + row['name'], api_key)
    if (not isinstance(info, dict) or not isinstance(alias, dict) or info.get('templateID') != row['templateId']
            or alias.get('templateID') != row['templateId'] or info.get('isDefault') is True
            or info.get('public') is not False or alias.get('public') is not False):
        raise CandidateError('candidate_not_exact_private_template')
    names = (info.get('names') or []) + (info.get('aliases') or [])
    if not any(isinstance(name, str) and re.fullmatch(r'(?:[^/]+/)?' + re.escape(row['name']), name) for name in names):
        raise CandidateError('candidate_name_mismatch')
    matches = [build for build in info.get('builds', []) if isinstance(build, dict) and build.get('buildID') == row['buildId']]
    if len(matches) != 1 or matches[0].get('status') != 'ready':
        raise CandidateError('candidate_build_not_ready')


def absent_sandbox(sandbox_id, api_key, request):
    try:
        request('GET', '/sandboxes/' + sandbox_id, api_key)
    except HTTPError as error:
        if error.code == 404:
            return True
        raise
    return False


def tracked_factory(journal, output, kind, api_key, sdk, request):
    expected = journal['templates'][kind]['templateId']

    def create(template_id, **kwargs):
        if template_id != expected or kwargs.get('metadata') != metadata_for(journal['identity']) or kwargs.get('api_key') != api_key:
            raise CandidateError('probe_scope_mismatch')
        journal['pendingSandbox'] = {'kind': kind, 'templateId': expected}
        write_private(output / JOURNAL, journal)
        sandbox = sdk[0].create(template_id, **kwargs)
        row = {'sandboxId': resource_id(sandbox.sandbox_id), 'templateId': expected, 'kind': kind, 'deletedConfirmed': False}
        if any(item['sandboxId'] == row['sandboxId'] for item in journal['sandboxes']):
            raise CandidateError('probe_identity_reused')
        journal['sandboxes'].append(row)
        journal['pendingSandbox'] = None
        write_private(output / JOURNAL, journal)

        class TrackedSandbox:
            def __getattr__(self, name):
                return getattr(sandbox, name)

            def kill(self):
                sandbox.kill()
                if not absent_sandbox(row['sandboxId'], api_key, request):
                    raise CandidateError('probe_deletion_unconfirmed')
                row['deletedConfirmed'] = True
                write_private(output / JOURNAL, journal)

        return TrackedSandbox()
    return create


def sandbox_cleanup(journal, output, api_key, sdk, request):
    Sandbox, SandboxQuery, SandboxState = sdk
    metadata = metadata_for(journal['identity'])
    by_id = {row['sandboxId']: row for row in journal['sandboxes']}
    templates = {row.get('templateId'): kind for kind, row in journal['templates'].items() if row.get('templateId')}
    errors, receipts = [], []
    pending = journal['pendingSandbox']
    pending_found = False
    try:
        pages = Sandbox.list(query=SandboxQuery(metadata=metadata, state=[SandboxState.RUNNING, SandboxState.PAUSED]), api_key=api_key)
        count = 0
        while pages.has_next:
            count += 1
            if count > 20:
                raise CandidateError('sandbox_listing_limit')
            for row in pages.next_items():
                sandbox_id = resource_id(row.sandbox_id)
                if row.metadata != metadata or row.template_id not in templates:
                    errors.append({'stage': 'sandbox_list', 'code': 'sandbox_scope_mismatch'})
                    continue
                if sandbox_id not in by_id:
                    if pending and row.template_id == pending['templateId']:
                        pending_found = True
                    by_id[sandbox_id] = {'sandboxId': sandbox_id, 'templateId': row.template_id,
                                        'kind': templates[row.template_id], 'deletedConfirmed': False}
                if len(by_id) > 16:
                    raise CandidateError('sandbox_listing_limit')
    except BaseException as error:
        errors.append({'stage': 'sandbox_list', 'code': error_code(error)})
    if pending_found:
        journal['pendingSandbox'] = None
    elif pending:
        # A create timeout may finish after this list response. An empty list
        # cannot attest the outcome of an acknowledged-but-unidentified create.
        errors.append({'stage': 'sandbox_create', 'code': 'sandbox_creation_unconfirmed'})
    journal['sandboxes'] = list(by_id.values())
    write_private(output / JOURNAL, journal)
    for sandbox_id, row in by_id.items():
        result = {'sandboxId': sandbox_id, 'status': 'failed'}
        try:
            try:
                info = request('GET', '/sandboxes/' + sandbox_id, api_key)
            except HTTPError as error:
                if error.code != 404:
                    raise
                info = None
            if info is None:
                result['status'] = 'absent'
            else:
                if (not isinstance(info, dict) or info.get('sandboxID') != sandbox_id
                        or info.get('templateID') != row['templateId'] or info.get('metadata') != metadata):
                    raise CandidateError('sandbox_scope_mismatch')
                Sandbox.kill(sandbox_id, api_key=api_key)
                if not absent_sandbox(sandbox_id, api_key, request):
                    raise CandidateError('sandbox_deletion_unconfirmed')
                result['status'] = 'deleted'
            row['deletedConfirmed'] = True
        except BaseException as error:
            result['code'] = error_code(error)
        receipts.append(result)
    write_private(output / JOURNAL, journal)
    return receipts, errors


def cleanup(scope, output, api_key, sdk, request=None):
    request = request or builder._request
    if not (output / JOURNAL).exists():
        # A durable preflight refusal happens before journal creation or any
        # mutating SDK call. A missing journal in every other case stays red.
        refused = read_private(output / 'build-report.json')
        if (not isinstance(refused, dict) or set(refused) != {'identity', 'status', 'stage', 'code'}
                or refused['identity'] != scope or refused['status'] != 'failed' or refused['stage'] != 'preflight'):
            raise CandidateError('creation_journal_missing')
        sandboxes, templates, errors = [], [], []
    else:
        journal = read_journal(output, scope)
        with quiet_sdk():
            sandboxes, errors = sandbox_cleanup(journal, output, api_key, sdk, request)
            owned = [row for row in journal['templates'].values() if row['creationStarted'] and not row['collision']]
            raw = builder.cleanup_templates(owned, api_key, request)
        templates = []
        for candidate, receipt in zip(owned, raw, strict=True):
            row = {'name': candidate['name'], 'kind': candidate['kind'], 'status': receipt['status']}
            if row['status'] not in ('absent', 'deleted', 'retained_public', 'failed'):
                row.update(status='failed', code='template_cleanup_failed')
            if 'templateId' in receipt:
                row['templateId'] = resource_id(receipt['templateId'])
            if row['status'] == 'failed':
                row['code'] = 'template_cleanup_failed'
            templates.append(row)
    # A public/ambiguous resource is retained, and this attempt remains red.
    confirmed = not errors and all(row['status'] in ('absent', 'deleted') for row in sandboxes + templates)
    result = {'identity': scope, 'confirmed': confirmed, 'templates': templates, 'sandboxes': sandboxes, 'errors': errors}
    number = 1
    while True:
        path = output / ('cleanup.json' if number == 1 else f'cleanup-{number}.json')
        try:
            write_private(path, result, exclusive=True)
            return result, path.name
        except FileExistsError:
            number += 1


def build_candidates(scope, output, api_key, sdk, request=None):
    request = request or builder._request
    if any((output / name).exists() for name in (JOURNAL, 'build-report.json', 'candidates.json')):
        raise CandidateError('candidate_attempt_already_recorded')
    journal = {'version': 1, 'identity': scope, 'templates': {
        kind: {'kind': kind, 'name': candidate_name(scope, kind), 'creationStarted': False, 'collision': False} for kind in KINDS},
        'sandboxes': [], 'pendingSandbox': None}
    # Never claim an existing alias as this attempt's cleanup responsibility.
    try:
        for row in journal['templates'].values():
            with quiet_sdk():
                builder.assert_new_template(row['name'], api_key)
    except BaseException as error:
        write_private(output / 'build-report.json', {'identity': scope, 'status': 'failed',
            'stage': 'preflight', 'code': error_code(error)}, exclusive=True)
        raise CandidateError('candidate_preflight_failed') from None
    write_private(output / JOURNAL, journal, exclusive=True)
    templates, stage = {}, 'build'
    try:
        for kind in KINDS:
            row = journal['templates'][kind]
            row['creationStarted'] = True
            write_private(output / JOURNAL, journal)
            stage = 'build_' + kind
            try:
                with quiet_sdk():
                    source, result = builder.build(row['name'], scope['sourceCommit'], api_key=api_key,
                        on_build_logs=lambda _entry: None, kind=kind, cpu_count=2, memory_mb=4096)
            except ValueError as error:
                if error.args == ('template_name_already_exists',):
                    row['collision'] = True
                    write_private(output / JOURNAL, journal)
                raise
            row['templateId'] = resource_id(result.template_id)
            write_private(output / JOURNAL, journal)
            row['buildId'] = resource_id(result.build_id)
            write_private(output / JOURNAL, journal)
            if source != scope['sourceCommit'] or any(item['templateId'] == row['templateId'] for item in templates.values()):
                raise CandidateError('candidate_identity_mismatch')
            stage = 'private_' + kind
            private_ready(row, api_key, request)
            entry = {key: row[key] for key in ('name', 'templateId', 'buildId')}
            entry.update(baseTemplate=kind, preinstalled=True)
            factory = tracked_factory(journal, output, kind, api_key, sdk, request)
            stage = 'models_' + kind
            with quiet_sdk():
                entry['models'] = builder.probe_models(row['templateId'], kind, api_key, scope['sourceCommit'], scope['workerSha'], factory)
            stage = 'conservation_' + kind
            with quiet_sdk():
                entry['conservation'] = builder.probe_conservation(row['templateId'], api_key, kind, factory)
            private_ready(row, api_key, request)
            entry['privateVerified'] = True
            templates[kind] = entry
        stage = 'probe_cleanup'
        with quiet_sdk():
            sandboxes, errors = sandbox_cleanup(journal, output, api_key, sdk, request)
        if errors or any(row['status'] not in ('absent', 'deleted') for row in sandboxes):
            raise CandidateError('probe_cleanup_incomplete')
        result = {'sourceCommit': scope['sourceCommit'], 'workerSha': scope['workerSha'], 'templates': templates}
        write_private(output / 'candidates.json', result, exclusive=True)
        write_private(output / 'build-report.json', {'identity': scope, 'status': 'passed', 'stage': 'complete'}, exclusive=True)
        return result
    except BaseException as error:
        write_private(output / 'build-report.json', {'identity': scope, 'status': 'failed', 'stage': stage, 'code': error_code(error)}, exclusive=True)
        try:
            cleanup(scope, output, api_key, sdk, request)
        except BaseException as cleanup_error:
            # Keep the original build failure; always-cleanup can retry using
            # the durable journal. No SDK text or key enters this report.
            write_private(output / 'cleanup-error.json', {'identity': scope, 'confirmed': False,
                'stage': 'cleanup', 'code': error_code(cleanup_error)}, exclusive=True)
        raise CandidateError('candidate_build_failed') from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('build', 'cleanup'))
    parser.add_argument('--source-ref', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    stage = 'identity'
    try:
        scope = identity(args.source_ref, os.environ)
        output = output_directory(args.output)
        stage = 'credential'
        api_key = os.environ.get('E2B_API_KEY')
        if not api_key:
            raise CandidateError('api_key_missing')
        from e2b import Sandbox, SandboxQuery, SandboxState
        sdk = (Sandbox, SandboxQuery, SandboxState)
        stage = args.operation
        if args.operation == 'build':
            build_candidates(scope, output, api_key, sdk)
            report, passed = 'candidates.json', True
        else:
            result, report = cleanup(scope, output, api_key, sdk)
            passed = result['confirmed']
        print(json.dumps({'operation': args.operation, 'status': 'passed' if passed else 'failed', 'report': report}))
        return 0 if passed else 1
    except BaseException as error:
        print(json.dumps({'operation': args.operation, 'status': 'failed', 'stage': stage, 'code': error_code(error)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
