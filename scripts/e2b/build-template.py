"""Add the Mikka worker to E2B's official templates. E2B_API_KEY is read only from this process's environment.

Three templates, one per kind of machine (decision 2026-11-01-2335): the bot's
computer from E2B's `desktop` (decision 2026-11-01-2331), a Claude Code task
machine from `claude`, a Codex task machine from `codex`. Everything runs as the
template's default user `user`; there is no sandbox inside the machine.

Run from the repository root with the E2B Python SDK installed.
Never copy the repository, .env files, credentials or a whole home directory.
The key is sent only to the E2B API (by the SDK, and in the X-API-Key header of
the publish call); it is never printed, logged or written to disk.
"""
import argparse
import hashlib
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
# What else decides the template's contents: its bootstrap and the build steps below.
COMPUTER_FILES = ('start-desktop.sh', 'viewer-gateway.py', 'lease-driver.py')
BOOTSTRAP_FILES = ('bootstrap.sh', 'bootstrap-desktop.sh')
RECIPE_PATHS = (*(f'scripts/e2b/{name}' for name in BOOTSTRAP_FILES), 'scripts/e2b/build-template.py',
                *(f'scripts/e2b/{name}' for name in COMPUTER_FILES))
# Each kind of machine: the official E2B template it starts from, and the
# daemon-pinned CLIs installed on it (packages/daemon/harness/pins.json).
# The `claude` template's worker runs the Agent SDK's own Claude Code build;
# the `codex` one gets the pinned Codex, whose interface the daemon audited.
KINDS = {
    'desktop': {'base': 'desktop', 'harnesses': ('claude_code', 'codex')},
    'claude': {'base': 'claude', 'harnesses': ()},
    'codex': {'base': 'codex', 'harnesses': ('codex',)},
}

NPM_RUNTIME_CHECK = r'''node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
createRequire(realpathSync('/usr/local/bin/npm'))('pacote')
const directory = mkdtempSync(join(tmpdir(), 'mikka-npm-runtime-'))
try {
  const home = join(directory, 'home'), temp = join(directory, 'tmp')
  mkdirSync(home); mkdirSync(temp)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, scripts: { test: `node -e "console.log('Mikka npm runtime verified')"` } }))
  const output = execFileSync('/usr/local/bin/npm', ['test'], {
    cwd: directory, encoding: 'utf8', timeout: 30_000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: temp, LANG: 'C.UTF-8', NPM_CONFIG_UPDATE_NOTIFIER: 'true' },
  })
  assert.match(output, /^Mikka npm runtime verified\r?$/m)
  console.log('npm dependency graph and first fresh-HOME command verified')
} finally { rmSync(directory, { recursive: true, force: true }) }
JS'''

# Filesystem snapshots reboot without template memory. Start the anonymous
# runtime beside E2B's boot services; only capability cleanup precedes envd.
# Scrubbing is a separate once-per-boot job: a later worker restart must keep
# a fresh control-plane handoff, and a memory resume must keep its identity.
BOOT_SERVICES = {
    'mikka-boot-scrub.service': '''[Unit]
Description=Remove copied Mikka worker capabilities before cold boot
DefaultDependencies=no
After=local-fs.target
Before=mikka-preload.service mikka-viewer.service envd.service shutdown.target
Conflicts=shutdown.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -ec 'rm -rf /home/user/.mikka/worker /run/mikka-viewer /run/mikka-subagents; install -d -m 700 -o user -g user /home/user/.mikka; rm -f /home/user/.mikka/bootstrap.json /home/user/.mikka/bootstrap.next /home/user/.mikka/preloaded.pid; install -m 600 -o user -g user /dev/null /home/user/.mikka/worker-preload.log; install -d -m 710 -o root -g user /run/mikka-viewer'
''',
    'mikka-preload.service': '''[Unit]
Description=Preload the anonymous Mikka worker
DefaultDependencies=no
Requires=mikka-boot-scrub.service
After=mikka-boot-scrub.service
Before=shutdown.target
Conflicts=shutdown.target
[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=45
ExecStart=/bin/sh -ec 'runuser -u user -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/user LANG=C.UTF-8 node /opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js --wait-bootstrap >>/home/user/.mikka/worker-preload.log 2>&1 & for i in $(seq 1 600); do test -s /home/user/.mikka/preloaded.pid && exit 0; sleep .05; done; exit 1'
[Install]
WantedBy=multi-user.target
''',
    'mikka-viewer.service': '''[Unit]
Description=Start the Mikka viewer without a signing key
DefaultDependencies=no
Requires=mikka-boot-scrub.service
After=mikka-boot-scrub.service
Before=shutdown.target
Conflicts=shutdown.target
[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=45
ExecStart=/bin/sh -ec 'flock -n /run/mikka-viewer/gateway.lock /usr/bin/python3 /opt/mikka/computer/viewer-gateway.py >>/run/mikka-viewer/gateway.log 2>&1 & for i in $(seq 1 600); do test "$(curl -s -o /dev/null -w "%%{http_code}" http://127.0.0.1:6080/vnc)" = 401 && exit 0; sleep .05; done; exit 1'
[Install]
WantedBy=multi-user.target
''',
}

def commit(ref):
    sha = subprocess.check_output(['git', 'rev-parse', '--verify', f'{ref}^{{commit}}'], cwd=ROOT, text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Invalid source commit')
    return sha

def worker_hash(ref):
    """A 40-hex digest of the template's inputs at a commit: Git object ids of WORKER_PATHS and
    RECIPE_PATHS. Commits that leave them alone give the same hash, so nothing is rebuilt."""
    listing = subprocess.check_output(['git', 'ls-tree', '-r', commit(ref), '--', *WORKER_PATHS, *RECIPE_PATHS], cwd=ROOT)
    return hashlib.sha1(listing).hexdigest()

def source_context(directory, ref):
    """Copy only selected files from an immutable Git commit, never the worktree."""
    sha = commit(ref)
    files = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', sha, '--', *WORKER_PATHS], cwd=ROOT, text=True).splitlines()
    if any(re.search(r'(^|/)(\.env(?:\.|$)|\.npmrc$|\.git-credentials$)', path) for path in files):
        raise ValueError('Worker archive contains a credential configuration file')
    subprocess.run(['git', 'archive', '--format=tar', f'--output={directory / "worker.tar"}', sha, '--', *WORKER_PATHS], cwd=ROOT, check=True)
    for name in (*BOOTSTRAP_FILES, *COMPUTER_FILES):
        content = subprocess.check_output(['git', 'show', f'{sha}:scripts/e2b/{name}'], cwd=ROOT)
        (directory / name).write_bytes(content)
    for name, unit in BOOT_SERVICES.items():
        (directory / name).write_text(unit)
    # The worker checks this against MIKKA_CLOUD_WORKER_SHA before it starts.
    (directory / 'source-sha').write_text(worker_hash(sha) + '\n')
    return sha

CLI_COMMANDS = {'claude_code': 'claude', 'codex': 'codex'}

def harness_command(harnesses):
    """Install the pinned CLIs and put them on PATH; nothing for a template that needs none."""
    if not harnesses:
        return None
    names = ' '.join(harnesses)
    return ('node /opt/mikka/worker/packages/daemon/harness/cli.mjs /opt/mikka/harness ' + names + ' > /tmp/mikka-harnesses && '
            'while read -r binary; do ln -sf "$binary" "/usr/local/bin/$(basename "$binary")"; done < /tmp/mikka-harnesses && '
            'rm /tmp/mikka-harnesses && chmod -R go+rX,go-w /opt/mikka/harness && '
            + ' && '.join(f'{CLI_COMMANDS[harness]} --version' for harness in harnesses))

def build(name, ref='HEAD', api_key=None, on_build_logs=None, kind='desktop'):
    from e2b import Template
    recipe = KINDS[kind]
    desktop = kind == 'desktop'
    with tempfile.TemporaryDirectory(prefix='mikka-e2b-template-') as temp:
        context = Path(temp)
        sha = source_context(context, ref)
        template = (Template(file_context_path=str(context)).from_template(recipe['base'])
                    # Build checks and envd runtime commands start outside any home.
                    .set_workdir('/')
                    .copy('bootstrap.sh', '/tmp/mikka-bootstrap.sh')
                    .run_cmd('bash /tmp/mikka-bootstrap.sh', user='root'))
        if desktop:
            template = (template.copy('bootstrap-desktop.sh', '/tmp/mikka-bootstrap-desktop.sh')
                        .run_cmd('bash /tmp/mikka-bootstrap-desktop.sh', user='root'))
        template = (template.run_cmd(NPM_RUNTIME_CHECK, user='user')
                    .copy('worker.tar', '/tmp/mikka-worker.tar')
                    .copy('source-sha', '/opt/mikka/worker-source-sha')
                    .run_cmd('mkdir -p /opt/mikka/worker && tar -xf /tmp/mikka-worker.tar -C /opt/mikka/worker && rm /tmp/mikka-worker.tar && cd /opt/mikka/worker && HOME=/tmp corepack pnpm install --filter @mikka/daemon... --frozen-lockfile && node packages/daemon/scripts/build-cloud-worker.mjs && chown -R root:root /opt/mikka/worker && chmod -R go-w /opt/mikka/worker && chown root:root /opt/mikka/worker-source-sha && chmod 0444 /opt/mikka/worker-source-sha', user='root'))
        # Authentication for any CLI arrives later from the owner-bound broker.
        install = harness_command(recipe['harnesses'])
        if install:
            template = template.run_cmd(install, user='root')
        services = ['mikka-preload.service']
        ready = ('test -s /home/user/.mikka/preloaded.pid && '
                 'test ! -e /home/user/.mikka/bootstrap.json')
        if desktop:
            for runtime_file in COMPUTER_FILES:
                template = template.copy(runtime_file, f'/opt/mikka/computer/{runtime_file}')
            template = template.run_cmd('chown root:root /opt/mikka/computer/start-desktop.sh /opt/mikka/computer/viewer-gateway.py /opt/mikka/computer/lease-driver.py && chmod 0755 /opt/mikka/computer/start-desktop.sh /opt/mikka/computer/viewer-gateway.py /opt/mikka/computer/lease-driver.py', user='root')
            services.append('mikka-viewer.service')
            ready += (' && test ! -e /run/mikka-viewer/key && '
                      'test "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/vnc)" = 401')
        for service in ('mikka-boot-scrub.service', *services):
            template = template.copy(service, f'/etc/systemd/system/{service}')
        template = template.run_cmd('systemctl daemon-reload && systemctl enable ' + ' '.join(services), user='root')
        # Freeze imported modules (and on the desktop the unauthenticated viewer)
        # into the template's ready state. No identity or signing key exists at
        # build time: the control plane hands those to each instance afterwards.
        template = template.set_user('root').set_start_cmd(
            'systemctl start ' + ' '.join(services) + ' && exec sleep infinity', ready)
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
    parser = argparse.ArgumentParser(description='Build versioned Mikka E2B templates')
    parser.add_argument('--name', help='Prefix for the new versioned template names (<prefix>-<kind>); do not reuse a production alias')
    parser.add_argument('--kind', action='append', choices=sorted(KINDS), help='Template to build; repeat for several (default: all)')
    parser.add_argument('--source-ref', default='HEAD', help='Git commit to package; defaults to HEAD')
    parser.add_argument('--public', action='store_true', help='Make each built template public and verify it is public and ready')
    parser.add_argument('--json', action='store_true', help='Print one JSON object on stdout; build logs go to stderr')
    parser.add_argument('--worker-hash', action='store_true', help='Only print the worker hash of --source-ref; builds nothing')
    args = parser.parse_args(argv)
    if args.worker_hash:
        print(worker_hash(args.source_ref))
        return
    if not args.name:
        parser.error('--name is required to build')
    api_key = os.environ.get('E2B_API_KEY')
    if not api_key:
        raise SystemExit('E2B_API_KEY is not set')
    kinds = args.kind or list(KINDS)
    sha = commit(args.source_ref)

    def one(kind):
        name = f'{args.name}-{kind}'
        logs = (lambda entry: print(f'[{kind}] {entry}', file=sys.stderr, flush=True)) if args.json else None
        _, result = build(name, sha, api_key=api_key, on_build_logs=logs, kind=kind)
        entry = {'templateId': result.template_id, 'buildId': result.build_id, 'name': name}
        if args.public:
            entry.update(publish(result.template_id, result.build_id, api_key))
        return kind, entry

    # The templates share nothing at build time; build them side by side.
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=len(kinds)) as pool:
        templates = dict(pool.map(one, kinds))
    out = {'sourceCommit': sha, 'workerSha': worker_hash(sha), 'templates': templates}
    if args.json:
        print(json.dumps(out))
    else:
        for key, value in out.items():
            print(f'{key}={json.dumps(value) if isinstance(value, dict) else value}')

if __name__ == '__main__':
    main()
