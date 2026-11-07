"""Close only resources owned by this exact GitHub runtime release attempt.

The workflow always runs this finalizer, including after an obsolete source,
failed real subscription or partial build. Public templates remain available
for the matched deployment and rollback. Receipts never contain API keys.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('build_template', HERE / 'build-template.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
IDENTITY_MAX_BYTES = 2048


def identities(environ, report=None):
    metadata = builder.release_metadata(environ)
    if len(metadata) != 4:
        raise ValueError('cleanup_workflow_identity_required')
    prefix = f"mikka-{metadata['sourceCommit'][:12]}-{metadata['runId']}-"
    attempts = {metadata['runAttempt']}
    candidates = []
    for kind in builder.KINDS:
        row = (report or {}).get('templates', {}).get(kind)
        if row:
            match = re.fullmatch(re.escape(prefix) + r'([1-9][0-9]*)-' + kind, row.get('name', ''))
            if ((report or {}).get('sourceCommit') != metadata['sourceCommit'] or not match
                    or int(match[1]) > int(metadata['runAttempt']) or row.get('baseTemplate') != kind
                    or not re.fullmatch(r'[A-Za-z0-9_-]+', row.get('templateId', ''))):
                raise ValueError('cleanup_candidate_identity_mismatch')
            attempts.add(match[1])
            candidates.append({'kind': kind, 'name': row['name'], 'templateId': row['templateId']})
        else:
            candidates.append({'kind': kind, 'name': prefix + metadata['runAttempt'] + '-' + kind})
    return [{**metadata, 'runAttempt': attempt} for attempt in sorted(attempts, key=int)], candidates


def identity_receipt(raw, environ):
    """Accept only the producer's bounded resource list, never proof contents."""
    if len(raw) > IDENTITY_MAX_BYTES:
        raise ValueError('cleanup_identity_too_large')
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'version', 'sourceCommit', 'runId', 'runAttempt', 'templates'}
            or type(value['version']) is not int or value['version'] != 1
            or value['sourceCommit'] != environ['GITHUB_SHA'] or value['runId'] != environ['GITHUB_RUN_ID']
            or not isinstance(value['runAttempt'], str) or not re.fullmatch(r'[1-9][0-9]*', value['runAttempt'])
            or int(value['runAttempt']) > int(environ['GITHUB_RUN_ATTEMPT'])
            or not isinstance(value['templates'], dict) or set(value['templates']) != set(builder.KINDS)):
        raise ValueError('cleanup_identity_receipt_invalid')
    prefix = f"mikka-{value['sourceCommit'][:12]}-{value['runId']}-{value['runAttempt']}-"
    ids = set()
    for kind, row in value['templates'].items():
        if (not isinstance(row, dict) or set(row) != {'baseTemplate', 'name', 'templateId'}
                or row['baseTemplate'] != kind or row['name'] != prefix + kind
                or not isinstance(row['templateId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', row['templateId'])
                or row['templateId'] in ids):
            raise ValueError('cleanup_identity_receipt_invalid')
        ids.add(row['templateId'])
    return value


def cleanup_plan(environ, report_path=None, identity_path=None, identities_required=False):
    """A missing/bad artifact cannot prevent cleanup of our trusted run scope.

    Invalid supplied metadata leaves a failed receipt, and contributes no IDs.
    The short producer list is independent of a large artifact download and can
    identify an older attempt for cleanup without accepting its release proof.
    """
    metadata, candidates = identities(environ)
    errors = []
    try:
        if identity_path:
            raw = b''
            if identity_path.exists():
                with identity_path.open('rb') as stream:
                    raw = stream.read(IDENTITY_MAX_BYTES + 1)
            if raw:
                receipt = identity_receipt(raw, environ)
                metadata, candidates = identities(environ, receipt)
                if receipt['runAttempt'] != environ['GITHUB_RUN_ATTEMPT']:
                    # A failed-job rerun may return older successful builder
                    # outputs after this attempt also created partial images.
                    candidates += identities(environ)[1]
            elif identities_required:
                raise ValueError('cleanup_identity_missing')
        elif report_path:
            metadata, candidates = identities(environ, json.loads(report_path.read_text()))
    except Exception as error:
        errors.append({'phase': 'candidate_identity', 'error': type(error).__name__})
    return metadata, candidates, errors


def cleanup_sandboxes(metadata, api_key, sdk=None):
    if sdk is None:
        from e2b import Sandbox, SandboxQuery, SandboxState
    else:
        Sandbox, SandboxQuery, SandboxState = sdk
    receipts = []
    for identity in metadata:
        paginator = Sandbox.list(query=SandboxQuery(metadata=identity, state=[SandboxState.RUNNING, SandboxState.PAUSED]), api_key=api_key)
        while paginator.has_next:
            for row in paginator.next_items():
                # Query filtering is a convenience, never ownership proof.
                if any((row.metadata or {}).get(key) != value for key, value in identity.items()):
                    raise ValueError('cleanup_sandbox_identity_mismatch')
                try:
                    Sandbox.kill(row.sandbox_id, api_key=api_key)
                    receipts.append({'sandboxId': row.sandbox_id, 'status': 'killed'})
                except Exception as error:
                    receipts.append({'sandboxId': row.sandbox_id, 'status': 'failed', 'error': type(error).__name__})
    return receipts


def main():
    parser = argparse.ArgumentParser()
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument('--report', type=Path)
    inputs.add_argument('--identities-file', type=Path)
    parser.add_argument('--identities-required', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sandboxes-only', action='store_true')
    args = parser.parse_args()
    metadata, candidates, errors = cleanup_plan(os.environ, args.report, args.identities_file, args.identities_required)
    receipt = {'sourceCommit': os.environ['GITHUB_SHA'], 'runId': os.environ['GITHUB_RUN_ID'],
               'sandboxes': [], 'templates': [], 'errors': errors}
    api_key = os.environ['E2B_API_KEY']
    try:
        try:
            receipt['sandboxes'] = cleanup_sandboxes(metadata, api_key)
        except Exception as error:
            receipt['errors'].append({'phase': 'sandboxes', 'error': type(error).__name__})
        if not args.sandboxes_only:
            receipt['templates'] = builder.cleanup_templates(candidates, api_key)
    finally:
        args.output.write_text(json.dumps(receipt, indent=2) + '\n')
        print('mikka-release-cleanup ' + json.dumps(receipt, separators=(',', ':')), flush=True)
    if receipt['errors'] or any(row['status'] == 'failed' for row in receipt['sandboxes'] + receipt['templates']):
        raise RuntimeError('release_cleanup_incomplete')


if __name__ == '__main__':
    main()
