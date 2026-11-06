"""One anonymous probe on the exact failed image; recover only recorded IDs."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('builder', HERE / 'build-template.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
SOURCE = 'be442132f7468d87a51dd9052d0bc14253cbc915'
WORKER = '33c825990d3f0ae27b71441a9db6854abab584b1'
CANDIDATES = [
    {'kind': 'claude', 'name': 'mikka-be442132f746-42304462353-1-claude', 'templateId': 'tlq998jd860bby3vvixn'},
    {'kind': 'codex', 'name': 'mikka-be442132f746-42304462353-1-codex', 'templateId': 'dz0z0z9x1le01ji2e2m0'},
    {'kind': 'desktop', 'name': 'mikka-be442132f746-42304462353-1-desktop', 'templateId': '4xcmm3p44plzgion3ti7'},
]

def main():
    from e2b import Sandbox, SandboxQuery, SandboxState
    parser = argparse.ArgumentParser()
    parser.add_argument('--cleanup-only', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    key = os.environ['E2B_API_KEY']
    metadata = {'application': 'mikka-1505-runtime-diagnostic', 'sourceCommit': SOURCE,
                'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT']}
    report = {'sourceCommit': SOURCE, 'workerSha': WORKER, 'identity': metadata, 'templatesBefore': [], 'probe': None,
              'sandboxes': [], 'templatesAfter': [], 'errors': []}
    sandbox = None
    try:
        if not args.cleanup_only:
            for candidate in CANDIDATES:
                try:
                    info = builder._request('GET', '/templates/' + candidate['templateId'], key)
                except HTTPError as error:
                    if error.code != 404: raise
                    report['templatesBefore'].append({**candidate, 'status': 'absent_by_id'})
                    continue
                if (info.get('templateID') != candidate['templateId'] or candidate['name'] not in (info.get('names') or []) + (info.get('aliases') or [])):
                    raise ValueError('recorded_identity_mismatch')
                report['templatesBefore'].append({**candidate, 'status': 'present', 'public': info.get('public')})
            desktop = next(row for row in report['templatesBefore'] if row['kind'] == 'desktop')
            if desktop.get('public') is not False: raise ValueError('private_desktop_unavailable')
            start = time.monotonic()
            sandbox = Sandbox.create(desktop['templateId'], api_key=key, timeout=300, metadata=metadata)
            probe = report['probe'] = {'sandboxId': sandbox.sandbox_id, 'createMs': round((time.monotonic() - start) * 1000)}
            if sandbox.files.read('/opt/mikka/worker-source-sha', user='root', request_timeout=30).strip() != WORKER:
                raise ValueError('worker_mismatch')
            source = sandbox.commands.run('readlink -f /opt/mikka/worker', user='root', timeout=10, request_timeout=20).stdout.strip()
            if source != '/opt/mikka/releases/' + SOURCE + '/source': raise ValueError('source_mismatch')
            manifest = json.loads(sandbox.files.read('/opt/mikka/worker/.mikka-original-cli.json', user='root', request_timeout=30))
            probe['cliManifest'] = manifest
            sandbox.files.write('/tmp/mikka1505-probe-trace.mjs', (HERE / 'probe-trace.mjs').read_text(), user='root', request_timeout=30)
            command = ('export PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH; '
                       '/opt/mikka/runtime/node/bin/node --import /tmp/mikka1505-probe-trace.mjs '
                       '/opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js --probe-models '
                       '> /tmp/mikka1505-models.json 2> /tmp/mikka1505-probe.stderr')
            began = time.monotonic()
            try:
                result = sandbox.commands.run(command, user='user', timeout=90, request_timeout=100)
                probe['commandExit'] = result.exit_code
            except Exception as error:
                probe['commandError'] = type(error).__name__
            probe['commandMs'] = round((time.monotonic() - began) * 1000)
            for path, field in [('/tmp/mikka1505-probe.trace', 'trace'), ('/tmp/mikka1505-models.json', 'catalogue')]:
                raw = sandbox.files.read(path, user='root', request_timeout=20)
                if field == 'trace': probe[field] = [json.loads(line) for line in raw.splitlines()]
                else:
                    try:
                        value = json.loads(raw)
                        probe['catalogueComplete'] = isinstance(value, list) and all(row.get('installed') and row.get('models') for row in value)
                        probe['catalogueHarnesses'] = [row.get('harness') for row in value] if isinstance(value, list) else []
                    except ValueError: probe['catalogueComplete'] = False
    except Exception as error:
        report['errors'].append(type(error).__name__)
    finally:
        if sandbox:
            try: sandbox.kill(); report['sandboxes'].append({'sandboxId': sandbox.sandbox_id, 'status': 'killed'})
            except Exception as error: report['errors'].append('sandbox_' + type(error).__name__)
        try:
            pages = Sandbox.list(query=SandboxQuery(metadata=metadata, state=[SandboxState.RUNNING, SandboxState.PAUSED]), api_key=key)
            while pages.has_next:
                for row in pages.next_items():
                    if any((row.metadata or {}).get(k) != v for k, v in metadata.items()): raise ValueError('sandbox_identity_mismatch')
                    try: Sandbox.kill(row.sandbox_id, api_key=key); report['sandboxes'].append({'sandboxId': row.sandbox_id, 'status': 'killed'})
                    except Exception as error: report['errors'].append('sandbox_' + type(error).__name__)
        except Exception as error: report['errors'].append('sandbox_list_' + type(error).__name__)
        report['templatesAfter'] = builder.cleanup_templates(CANDIDATES, key)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, separators=(',', ':')), flush=True)
    if report['errors'] or any(row['status'] == 'failed' for row in report['templatesAfter']): raise SystemExit(1)

if __name__ == '__main__': main()
