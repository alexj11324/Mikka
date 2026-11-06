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
    parser.add_argument('--report', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sandboxes-only', action='store_true')
    args = parser.parse_args()
    report = json.loads(args.report.read_text()) if args.report and args.report.exists() else None
    metadata, candidates = identities(os.environ, report)
    receipt = {'sourceCommit': os.environ['GITHUB_SHA'], 'runId': os.environ['GITHUB_RUN_ID'],
               'sandboxes': [], 'templates': [], 'errors': []}
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
