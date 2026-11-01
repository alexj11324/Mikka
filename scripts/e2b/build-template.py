"""Build a plain Linux desktop template. E2B_API_KEY is read only from this process's environment.

Run from the repository root with the E2B Python SDK installed.
Never copy the repository, .env files, credentials or a whole home directory.
The key is sent only to the E2B API (by the SDK, and in the X-API-Key header of
the publish call); it is never printed, logged or written to disk.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
E2B_API = 'https://api.e2b.app'
# Everything the template packages. .github/workflows/e2b-template.yml triggers on these paths too.
WORKER_PATHS = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                'packages/daemon', 'packages/protocol', 'packages/config', 'patches')

def source_context(directory, ref):
    """Copy only selected files from an immutable Git commit, never the worktree."""
    sha = subprocess.check_output(['git', 'rev-parse', '--verify', f'{ref}^{{commit}}'], cwd=ROOT, text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Invalid source commit')
    files = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', sha, '--', *WORKER_PATHS], cwd=ROOT, text=True).splitlines()
    if any(re.search(r'(^|/)(\.env(?:\.|$)|\.npmrc$|\.git-credentials$)', path) for path in files):
        raise ValueError('Worker archive contains a credential configuration file')
    subprocess.run(['git', 'archive', '--format=tar', f'--output={directory / "worker.tar"}', sha, '--', *WORKER_PATHS], cwd=ROOT, check=True)
    bootstrap = subprocess.check_output(['git', 'show', f'{sha}:scripts/e2b/bootstrap.sh'], cwd=ROOT)
    (directory / 'bootstrap.sh').write_bytes(bootstrap)
    (directory / 'source-sha').write_text(sha + '\n')
    return sha

def build(name, ref='HEAD', api_key=None, on_build_logs=None):
    from e2b import Template
    with tempfile.TemporaryDirectory(prefix='mikka-e2b-template-') as temp:
        context = Path(temp)
        sha = source_context(context, ref)
        template = (Template(file_context_path=str(context)).from_base_image()
                    .copy('bootstrap.sh', '/tmp/mikka-bootstrap.sh')
                    .run_cmd('bash /tmp/mikka-bootstrap.sh', user='root')
                    .copy('worker.tar', '/tmp/mikka-worker.tar')
                    .copy('source-sha', '/opt/mikka/worker-source-sha')
                    .run_cmd('mkdir -p /opt/mikka/worker && tar -xf /tmp/mikka-worker.tar -C /opt/mikka/worker && rm /tmp/mikka-worker.tar && cd /opt/mikka/worker && HOME=/tmp corepack pnpm install --filter @mikka/daemon... --frozen-lockfile && chown -R root:root /opt/mikka/worker && chmod -R go-w /opt/mikka/worker && chown root:root /opt/mikka/worker-source-sha && chmod 0444 /opt/mikka/worker-source-sha', user='root')
                    # The official, version-pinned native Codex CLI, from the daemon's own pins and
                    # installer. Its authentication comes later from the owner-bound broker.
                    .run_cmd('ln -sf "$(node /opt/mikka/worker/packages/daemon/harness/cli.mjs /opt/mikka/harness codex)" /usr/local/bin/codex && chmod -R go+rX,go-w /opt/mikka/harness && /usr/local/bin/codex --version', user='root'))
        return sha, Template.build(template, name=name, cpu_count=2, memory_mb=4096,
                                   min_free_disk_mb=16384, skip_cache=True, api_key=api_key, on_build_logs=on_build_logs)

def _request(method, path, api_key, body=None, opener=urllib.request.urlopen):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(E2B_API + path, data=data, method=method,
                                     headers={'X-API-Key': api_key, 'Content-Type': 'application/json'})
    # Errors carry the HTTP status only, never the request headers.
    with opener(request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None

def publish(template_id, build_id, api_key, opener=urllib.request.urlopen):
    """Make the template public, then read it back: it must be public and this build ready."""
    if not re.fullmatch(r'[A-Za-z0-9_-]+', template_id):
        raise ValueError('Invalid template id')
    _request('PATCH', f'/templates/{template_id}', api_key, {'public': True}, opener)
    info = _request('GET', f'/templates/{template_id}', api_key, opener=opener)
    builds = {b.get('buildID'): b.get('status') for b in info.get('builds') or []}
    status = builds.get(build_id, info.get('buildStatus'))
    if info.get('public') is not True:
        raise RuntimeError('Template is not public after publishing')
    if status != 'ready':
        raise RuntimeError(f'Template build is not ready: {status}')
    return {'public': True, 'buildStatus': status}

def main(argv=None):
    parser = argparse.ArgumentParser(description='Build a versioned Mikka E2B template')
    parser.add_argument('--name', required=True, help='New versioned template name; do not reuse the production alias')
    parser.add_argument('--source-ref', default='HEAD', help='Git commit to package; defaults to HEAD')
    parser.add_argument('--public', action='store_true', help='Make the built template public and verify it is public and ready')
    parser.add_argument('--json', action='store_true', help='Print one JSON object on stdout; build logs go to stderr')
    args = parser.parse_args(argv)
    api_key = os.environ.get('E2B_API_KEY')
    if not api_key:
        raise SystemExit('E2B_API_KEY is not set')
    logs = (lambda entry: print(entry, file=sys.stderr, flush=True)) if args.json else None
    sha, result = build(args.name, args.source_ref, api_key=api_key, on_build_logs=logs)
    out = {'sourceCommit': sha, 'templateId': result.template_id, 'buildId': result.build_id, 'name': args.name}
    if args.public:
        out.update(publish(result.template_id, result.build_id, api_key))
    if args.json:
        print(json.dumps(out))
    else:
        for key, value in out.items():
            print(f'{key}={value}')

if __name__ == '__main__':
    main()
