"""Build a plain Linux desktop template. E2B_API_KEY is read only by the SDK.

Run from the repository root with the E2B Python SDK installed.
Never copy the repository, .env files, credentials or a whole home directory.
"""
import argparse
import re
import subprocess
import tempfile
from pathlib import Path

from e2b import Template

ROOT = Path(__file__).resolve().parents[2]
WORKER_PATHS = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                'patches', 'packages/daemon', 'packages/protocol', 'packages/config')

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
    with tempfile.TemporaryDirectory(prefix='mikka-e2b-template-') as temp:
        context = Path(temp)
        sha = source_context(context, ref)
        template = (Template(file_context_path=str(context)).from_base_image()
                    .copy('bootstrap.sh', '/tmp/mikka-bootstrap.sh')
                    .run_cmd('bash /tmp/mikka-bootstrap.sh', user='root')
                    .copy('worker.tar', '/tmp/mikka-worker.tar')
                    .copy('source-sha', '/opt/mikka/worker-source-sha')
                    .run_cmd('mkdir -p /opt/mikka/worker && tar -xf /tmp/mikka-worker.tar -C /opt/mikka/worker && rm /tmp/mikka-worker.tar && cd /opt/mikka/worker && HOME=/tmp corepack pnpm install --filter @mikka/daemon... --frozen-lockfile && chown -R root:root /opt/mikka/worker && chmod -R go-w /opt/mikka/worker && chown root:root /opt/mikka/worker-source-sha && chmod 0444 /opt/mikka/worker-source-sha', user='root'))
        return sha, Template.build(template, name=name, cpu_count=2, memory_mb=4096,
                                   min_free_disk_mb=16384, skip_cache=True, api_key=api_key, on_build_logs=on_build_logs)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Build a versioned Mikka E2B template')
    parser.add_argument('--name', required=True, help='New versioned template name; do not reuse the production alias')
    parser.add_argument('--source-ref', default='HEAD', help='Git commit to package; defaults to HEAD')
    args = parser.parse_args()
    sha, result = build(args.name, args.source_ref)
    print('sourceCommit=' + sha)
    print('templateId=' + result.template_id)
