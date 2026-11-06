"""Finalizer for only this isolated component workflow attempt, even on timeout."""
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('release_cleanup', HERE / 'cleanup-template-candidates.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
builder = cleanup.builder


def main():
    identity = builder.release_metadata()
    if len(identity) != 4:
        raise ValueError('component_cleanup_workflow_identity_required')
    key = os.environ['E2B_API_KEY']
    prefix = f"mikka-1505-component-{identity['runId']}-{identity['runAttempt']}-"
    receipt = {'sourceCommit': identity['sourceCommit'], 'runId': identity['runId'],
               'runAttempt': identity['runAttempt'], 'sandboxes': [], 'templates': [], 'errors': []}
    try:
        for metadata in (identity, {**identity, 'application': 'mikka-1505-component'}):
            try:
                receipt['sandboxes'] += cleanup.cleanup_sandboxes([metadata], key)
            except Exception as error:
                receipt['errors'].append({'phase': 'sandboxes', 'error': type(error).__name__})
        receipt['templates'] = builder.cleanup_templates(
            [{'kind': kind, 'name': prefix + kind} for kind in builder.KINDS], key)
    finally:
        (HERE / 'component-cleanup.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print('mikka-component-finalizer ' + json.dumps(receipt, separators=(',', ':')), flush=True)
    if receipt['errors'] or any(row['status'] == 'failed' for row in receipt['sandboxes'] + receipt['templates']):
        raise RuntimeError('component_cleanup_incomplete')


if __name__ == '__main__':
    main()
