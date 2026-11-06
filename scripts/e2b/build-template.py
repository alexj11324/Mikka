"""Add the Mikka worker to E2B's official templates. E2B_API_KEY is read only from this process's environment.

Three templates, one per kind of machine (decision 2026-11-01-2335): the bot's
computer from E2B's `desktop` (decision 2026-11-01-2331), a Claude Code task
machine from `claude`, a Codex task machine from `codex`. Everything runs as the
template's default user `user`; there is no sandbox inside the machine.

Run from the repository root with the E2B Python SDK installed.
Fetch only the pinned public source commit; never copy a local checkout, .env
files, credentials or a whole home directory into the image.
The key is sent only to the E2B API (by the SDK, and in the X-API-Key header of
the publish call); it is never printed, logged or written to disk.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.error import HTTPError
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
E2B_API = 'https://api.e2b.app'
# Everything the template packages. .github/workflows/e2b-template.yml triggers on these paths too.
WORKER_PATHS = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
                'packages/daemon', 'packages/protocol', 'packages/config', 'patches')
# What else decides the template's contents: its bootstrap and the build steps below.
COMPUTER_FILES = ('start-desktop.sh', 'viewer-gateway.py', 'lease-driver.py')
BOOTSTRAP_FILES = ('official-files.py', 'e2b-finalization-files.json', 'e2b-certificate-relinks.json', 'start-prebuilt.sh')
INSTANCE_BOOTSTRAP = 'packages/daemon/scripts/official-e2b-instance-bootstrap.sh'
RECIPE_PATHS = (*(f'scripts/e2b/{name}' for name in BOOTSTRAP_FILES),
                'scripts/e2b/build-template.py', 'scripts/e2b/template-capabilities.json',
                'scripts/e2b/acceptance-daemon.mts',
                *(f'scripts/e2b/{name}' for name in COMPUTER_FILES))
# Each kind of machine: the official E2B template it starts from, and the
# CLIs installed on it (packages/daemon/harness/pins.json). The `claude` and
# `codex` templates keep the CLI E2B ships (any Codex works); the desktop one
# has neither, so it gets both.
KINDS = {
    'desktop': {'base': 'desktop', 'harnesses': ('claude_code', 'codex')},
    'claude': {'base': 'claude', 'harnesses': ()},
    'codex': {'base': 'codex', 'harnesses': ()},
}
ANONYMOUS_WORKER_READY = ("test -s /home/user/.mikka/preloaded.pid && "
                          "read -r mikka_preloaded_pid < /home/user/.mikka/preloaded.pid && "
                          "kill -0 \"$mikka_preloaded_pid\" && "
                          "tr '\\0' '\\n' < \"/proc/$mikka_preloaded_pid/cmdline\" | grep -Fxq -- '--wait-bootstrap'")

NPM_RUNTIME_CHECK = r'''export PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const npm = '/opt/mikka/runtime/node/bin/npm'
createRequire(realpathSync(npm))('pacote')
const directory = mkdtempSync(join(tmpdir(), 'mikka-npm-runtime-'))
try {
  const home = join(directory, 'home'), temp = join(directory, 'tmp')
  mkdirSync(home); mkdirSync(temp)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, scripts: { test: `node -e "console.log('Mikka npm runtime verified')"` } }))
  const output = execFileSync(npm, ['test'], {
    cwd: directory, encoding: 'utf8', timeout: 30_000,
    env: { PATH: '/opt/mikka/runtime/node/bin:/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: temp, LANG: 'C.UTF-8', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  })
  assert.match(output, /^Mikka npm runtime verified\r?$/m)
  console.log('Private npm runtime verified')
} finally { rmSync(directory, { recursive: true, force: true }) }
JS'''

def commit(ref):
    sha = subprocess.check_output(['git', 'rev-parse', '--verify', f'{ref}^{{commit}}'], cwd=ROOT, text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Invalid source commit')
    return sha

# Root package.json scripts and the web app's own dependencies do not enter
# `pnpm install --filter @mikka/daemon...`. A script-only edit must not rebuild.
PACKAGE_KEYS = ('name', 'version', 'private', 'type', 'packageManager', 'engines', 'pnpm',
                'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
                'dependenciesMeta', 'peerDependenciesMeta')
ROOT_PACKAGE_KEYS = ('packageManager', 'engines', 'pnpm')
DAEMON_IMPORTERS = ('packages/daemon', 'packages/protocol', 'packages/config')

def official_files_guard():
    spec = importlib.util.spec_from_file_location('official_files', ROOT / 'scripts/e2b/official-files.py')
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    return guard

def package_projection(path, raw):
    """Bytes that affect the daemon install. Invalid JSON is hashed whole so a
    non-package file still changes the digest."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if not isinstance(data, dict):
        return raw
    keys = ROOT_PACKAGE_KEYS if path == 'package.json' else PACKAGE_KEYS
    picked = {key: data[key] for key in keys if key in data}
    return json.dumps(picked, sort_keys=True, separators=(',', ':')).encode()

def _block_name(line):
    """A two-space pnpm key, including an empty `key: {}` entry."""
    if not line.startswith('  ') or line.startswith('   '):
        return None
    stripped = line.strip()
    if stripped.endswith(': {}'):
        return stripped[:-4].strip().strip("'\"")
    if stripped.endswith(':'):
        return stripped[:-1].strip("'\"")
    return None

def _child_blocks(body):
    blocks, name, buf = {}, None, []
    for line in body:
        key = _block_name(line)
        if key is not None:
            if name is not None:
                blocks[name] = buf
            name, buf = key, []
            if line.strip().endswith(': {}'):
                blocks[name] = []
                name = None
        elif name is not None:
            buf.append(line)
    if name is not None:
        blocks[name] = buf
    return blocks

def _top_sections(text):
    sections, name, buf = {}, None, []
    for line in text.splitlines():
        if line and not line.startswith(' ') and line.endswith(':') and not line[:-1].strip().startswith('#'):
            if name is not None:
                sections[name] = buf
            name = line[:-1]
            buf = []
        elif name is not None:
            buf.append(line)
        elif ':' in line and not line.startswith(' '):
            key, value = line.split(':', 1)
            sections[key.strip()] = [value.strip()]
    if name is not None:
        sections[name] = buf
    return sections

def _importer_snapshots(block):
    """`name:` then `version:` under an importer. The snapshot key is name@version."""
    keys, name = [], None
    for line in block:
        if line.startswith('      ') and not line.startswith('       ') and line.rstrip().endswith(':'):
            name = line.strip()[:-1].strip("'\"")
        elif name and line.strip().startswith('version:'):
            version = line.strip().split(':', 1)[1].strip().strip("'\"")
            if not version.startswith('link:'):
                keys.append(f'{name}@{version}')
            name = None
    return keys

def _versions(block):
    found = []
    for line in block:
        stripped = line.strip()
        if stripped.startswith('version:'):
            found.append(stripped.split(':', 1)[1].strip().strip("'\""))
    return found

def _dep_keys(block):
    """Snapshot dependency lines are `name: version`. The snapshot key is name@version."""
    keys, section = [], None
    for line in block:
        if line.startswith('    ') and not line.startswith('     ') and line.rstrip().endswith(':'):
            section = line.strip()[:-1]
            continue
        if section in ('dependencies', 'optionalDependencies') and line.startswith('      ') and ':' in line:
            name, value = line.strip().split(':', 1)
            name, value = name.strip("'\""), value.strip().strip("'\"")
            if value:
                keys.append(f'{name}@{value}')
    return keys

def lock_projection(text):
    """The lockfile entries `pnpm install --filter @mikka/daemon...` actually installs.
    A dependency added only to the web app does not change this projection."""
    sections = _top_sections(text)
    importers = _child_blocks(sections.get('importers', []))
    packages = _child_blocks(sections.get('packages', []))
    snapshots = _child_blocks(sections.get('snapshots', []))
    wanted = [name for name in DAEMON_IMPORTERS if name in importers]
    seen = set(wanted)
    # workspace: links point at another importer, not an npm snapshot.
    pending = list(wanted)
    while pending:
        name = pending.pop()
        for version in _versions(importers.get(name, [])):
            if version.startswith('link:'):
                target = 'packages/' + version.split('/')[-1]
                if target in importers and target not in seen:
                    seen.add(target)
                    pending.append(target)
    # Importer `version:` is the part after `name@` in the snapshot key.
    snapshot_keys = []
    for name in sorted(seen):
        for key in _importer_snapshots(importers[name]):
            if key in snapshots:
                snapshot_keys.append(key)
    queue = list(snapshot_keys)
    resolved, resolved_set = [], set()
    while queue:
        key = queue.pop()
        if key in resolved_set or key not in snapshots:
            continue
        resolved_set.add(key)
        resolved.append(key)
        for dep in _dep_keys(snapshots[key]):
            if dep in snapshots and dep not in resolved_set:
                queue.append(dep)
    package_keys = []
    for key in resolved:
        base = key.split('(', 1)[0]
        if base in packages:
            package_keys.append(base)
    parts = []
    for name in ('lockfileVersion', 'settings', 'overrides', 'patchedDependencies'):
        if name in sections:
            body = sections[name]
            parts.append(name + ':\n' + '\n'.join(body))
    for name in sorted(seen):
        parts.append('importer ' + name + '\n' + '\n'.join(importers[name]))
    for key in sorted(set(package_keys)):
        parts.append('package ' + key + '\n' + '\n'.join(packages[key]))
    for key in sorted(resolved_set):
        parts.append('snapshot ' + key + '\n' + '\n'.join(snapshots[key]))
    return '\n'.join(parts).encode()

def worker_hash(ref):
    """Digest of what the template installs and runs. package.json scripts and
    lockfile entries outside @mikka/daemon's install are left out, so a
    script-only or web-only edit does not rebuild."""
    sha = commit(ref)
    listing = subprocess.check_output(['git', 'ls-tree', '-r', sha, '--', *WORKER_PATHS, *RECIPE_PATHS], cwd=ROOT, text=True)
    parts = []
    for line in listing.splitlines():
        meta, path = line.split('\t', 1)
        if path == 'pnpm-lock.yaml' or path.endswith('/package.json') or path == 'package.json':
            continue
        parts.append(line)
    for line in listing.splitlines():
        path = line.split('\t', 1)[1]
        if path == 'package.json' or path.endswith('/package.json'):
            raw = subprocess.check_output(['git', 'show', f'{sha}:{path}'], cwd=ROOT)
            parts.append('package ' + path + '\n' + package_projection(path, raw).decode())
    if any(line.endswith('\tpnpm-lock.yaml') for line in listing.splitlines()):
        raw = subprocess.check_output(['git', 'show', f'{sha}:pnpm-lock.yaml'], cwd=ROOT, text=True)
        parts.append('lock\n' + lock_projection(raw).decode())
    return hashlib.sha1('\n'.join(parts).encode()).hexdigest()

def source_context(directory, ref):
    """Take the recipe only from an immutable commit; bootstrap fetches that commit.

    Source, Node and all dependencies are downloaded during the template build,
    never on the dispatch path. No local environment or home enters the image.
    """
    sha = commit(ref)
    for name in BOOTSTRAP_FILES:
        content = subprocess.check_output(['git', 'show', f'{sha}:scripts/e2b/{name}'], cwd=ROOT)
        (directory / name).write_bytes(content)
    (directory / 'instance-bootstrap.sh').write_bytes(
        subprocess.check_output(['git', 'show', f'{sha}:{INSTANCE_BOOTSTRAP}'], cwd=ROOT))
    (directory / 'source-sha').write_text(worker_hash(sha) + '\n')
    return sha


def build(name, ref='HEAD', api_key=None, on_build_logs=None, kind='desktop', cpu_count=2, memory_mb=4096):
    from e2b import Template
    assert_new_template(name, api_key)
    recipe = KINDS[kind]
    with tempfile.TemporaryDirectory(prefix='mikka-e2b-template-') as temp:
        context = Path(temp)
        sha = source_context(context, ref)
        worker_sha = (context / 'source-sha').read_text().strip()
        template = (Template(file_context_path=str(context)).from_template(recipe['base'])
                    .set_workdir('/')
                    .run_cmd('test ! -e /opt/mikka && test ! -L /opt/mikka && mkdir -m 0755 /opt/mikka', user='root'))
        for runtime_file in (*BOOTSTRAP_FILES, 'instance-bootstrap.sh'):
            template = template.copy(runtime_file, f'/opt/mikka/{runtime_file}')
        template = (template
                    .run_cmd(f'python3 /opt/mikka/official-files.py capture /opt/mikka/official-files-before.json --kind {kind} --cli-manifest /opt/mikka/original-cli.json', user='root')
                    .run_cmd(f'bash /opt/mikka/instance-bootstrap.sh {sha} {worker_sha} {kind}', user='root')
                    .run_cmd(NPM_RUNTIME_CHECK, user='user')
                    .run_cmd('python3 /opt/mikka/official-files.py verify /opt/mikka/official-files-before.json --receipt /opt/mikka/official-files-conservation.json', user='root'))
        ready = (ANONYMOUS_WORKER_READY + ' && '
                 'test ! -e /home/user/.mikka/bootstrap.json && '
                 'test ! -e /home/user/.mikka/worker/device.json')
        if kind == 'desktop':
            ready += (' && test ! -e /run/mikka-viewer/key && '
                      'test "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/vnc)" = 401')
        ready += (f' && python3 /opt/mikka/official-files.py verify /opt/mikka/official-files-before.json --e2b-finalization {kind}'
                  ' > /opt/mikka/official-files-ready.json')
        # E2B's template builder freezes the initialized process. New instances
        # resume the already imported worker and receive a fresh normal handoff.
        template = template.set_user('root').set_start_cmd('bash /opt/mikka/start-prebuilt.sh', ready)
        return sha, Template.build(template, name=name, cpu_count=cpu_count, memory_mb=memory_mb,
                                   min_free_disk_mb=16384, skip_cache=True, api_key=api_key, on_build_logs=on_build_logs)


def _request(method, path, api_key, body=None, opener=urllib.request.urlopen):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(E2B_API + path, data=data, method=method,
                                     headers={'X-API-Key': api_key, 'Content-Type': 'application/json'})
    # Errors carry the HTTP status only, never the request headers.
    with opener(request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def assert_new_template(name, api_key):
    """A versioned build must never update an existing official or Mikka alias."""
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', name) or name in KINDS:
        raise ValueError('template_name_invalid')
    try:
        _request('GET', f'/templates/{name}', api_key)
    except HTTPError as error:
        if error.code == 404:
            return
        raise
    raise ValueError('template_name_already_exists')

def release_metadata(environ=os.environ):
    """Attach only public workflow identity so a cancelled job is recoverable."""
    identity = {'application': 'mikka-template-release'}
    if (environ.get('GITHUB_REPOSITORY') == 'alexj11324/Mikka'
            and re.fullmatch(r'[a-f0-9]{40}', environ.get('GITHUB_SHA', ''))
            and re.fullmatch(r'[1-9][0-9]*', environ.get('GITHUB_RUN_ID', ''))
            and re.fullmatch(r'[1-9][0-9]*', environ.get('GITHUB_RUN_ATTEMPT', ''))):
        identity.update(sourceCommit=environ['GITHUB_SHA'], runId=environ['GITHUB_RUN_ID'], runAttempt=environ['GITHUB_RUN_ATTEMPT'])
    return identity


def cleanup_templates(candidates, api_key, request=None):
    """Remove exact private candidates, retaining public and previous images."""
    request = request or _request
    receipts = []
    for candidate in candidates:
        name = candidate['name']
        row = {'name': name, 'kind': candidate['kind']}
        try:
            if not re.fullmatch(r'[A-Za-z0-9_-]+', name) or name in KINDS:
                raise ValueError('cleanup_name_invalid')
            try:
                info = request('GET', '/templates/' + name, api_key)
            except HTTPError as error:
                if error.code == 404:
                    receipts.append({**row, 'status': 'absent'})
                    continue
                raise
            names = (info.get('names') or []) + (info.get('aliases') or [])
            template_id = info.get('templateID')
            if (name not in names or info.get('isDefault') is True or not isinstance(template_id, str)
                    or not re.fullmatch(r'[A-Za-z0-9_-]+', template_id)
                    or (candidate.get('templateId') and template_id != candidate['templateId'])):
                raise ValueError('cleanup_candidate_identity_mismatch')
            row['templateId'] = template_id
            if info.get('public') is True:
                receipts.append({**row, 'status': 'retained_public'})
                continue
            if info.get('public') is not False:
                raise ValueError('cleanup_candidate_visibility_unknown')
            request('DELETE', '/templates/' + template_id, api_key)
            try:
                request('GET', '/templates/' + template_id, api_key)
            except HTTPError as error:
                if error.code != 404:
                    raise
            else:
                raise RuntimeError('cleanup_candidate_still_exists')
            receipts.append({**row, 'status': 'deleted'})
        except Exception as error:
            receipts.append({**row, 'status': 'failed', 'error': type(error).__name__})
    return receipts


def probe_models(template_id, kind, api_key, sandbox_factory=None):
    """Read the built image's actual CLI catalogues, never a handwritten model list."""
    if sandbox_factory is None:
        from e2b import Sandbox
        sandbox_factory = Sandbox.create
    required = json.loads((ROOT / 'scripts/e2b/template-capabilities.json').read_text())[kind]
    sandbox = sandbox_factory(template_id, api_key=api_key, timeout=60, metadata=release_metadata())
    try:
        result = sandbox.commands.run('export PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH; /opt/mikka/runtime/node/bin/node /opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js --probe-models', user='user', timeout=45)
        if result.exit_code != 0:
            raise RuntimeError('model_probe_failed')
        reports = json.loads(result.stdout)
        if not isinstance(reports, list):
            raise RuntimeError('model_probe_invalid')
        for harness in required:
            found = next((row for row in reports if isinstance(row, dict) and row.get('harness') == harness and row.get('installed') is True), None)
            if not found or not (found.get('models') or found.get('modelSlots')):
                raise RuntimeError(f'model_probe_missing {harness}')
        return [row for row in reports if row.get('harness') in required]
    finally:
        # This probe created this disposable sandbox; no existing worker is touched.
        sandbox.kill()


def probe_conservation(template_id, api_key, kind, sandbox_factory=None):
    """Check the final image on a disposable instance, never a timed instance.

    E2B also performs provider setup after its start/ready command. Keep the
    preloaded receipt and independently verify the image a fresh create sees.
    """
    if sandbox_factory is None:
        from e2b import Sandbox
        sandbox_factory = Sandbox.create
    began = time.perf_counter()
    sandbox = sandbox_factory(template_id, api_key=api_key, timeout=600, metadata=release_metadata())
    def stage(name):
        nonlocal began
        now = time.perf_counter()
        print('mikka-conservation-stage ' + json.dumps({'kind': kind, 'phase': name, 'elapsedMs': round((now - began) * 1000)}, separators=(',', ':')), file=sys.stderr, flush=True)
        began = now
    stage('create')
    try:
        conservation = json.loads(sandbox.files.read('/opt/mikka/official-files-conservation.json', user='root', request_timeout=30))
        conservation['finalization'] = json.loads(sandbox.files.read('/opt/mikka/official-files-ready.json', user='root', request_timeout=30))
        stage('preload_receipts')
        guard = official_files_guard()
        guard.validate_receipt(conservation, kind)
        result = sandbox.commands.run(ANONYMOUS_WORKER_READY + f' && python3 /opt/mikka/official-files.py verify /opt/mikka/official-files-before.json --e2b-finalization {kind} --receipt /opt/mikka/fresh-conservation.json >/dev/null',
                                      user='root', timeout=300, request_timeout=310)
        if result.exit_code != 0:
            raise RuntimeError('official_conservation_missing')
        stage('fresh_scan')
        conservation['preloadFinalization'] = conservation['finalization']
        conservation['finalization'] = json.loads(sandbox.files.read('/opt/mikka/fresh-conservation.json', user='root', request_timeout=30))
        stage('fresh_receipt')
        return guard.validate_receipt(conservation, kind)
    finally:
        sandbox.kill()


def verify_release_evidence(report):
    """Publishing cannot substitute a model-list probe for subscription execution."""
    if not re.fullmatch(r'[a-f0-9]{40}', report.get('sourceCommit', '')) or not re.fullmatch(r'[a-f0-9]{40}', report.get('workerSha', '')):
        raise ValueError('release_source_invalid')
    for kind in KINDS:
        template = report.get('templates', {}).get(kind, {})
        if (template.get('baseTemplate') != kind or template.get('preinstalled') is not True
                or not re.fullmatch(r'[A-Za-z0-9_-]+', template.get('templateId', ''))
                or not template.get('buildId')):
            raise ValueError(f'release_template_invalid {kind}')
        proof = template.get('conservation', {})
        try:
            official_files_guard().validate_receipt(proof, kind)
        except (ValueError, KeyError, TypeError):
            raise ValueError(f'release_conservation_invalid {kind}') from None
    subscriptions = report.get('subscriptionAcceptance', {})
    for kind, harness, model in [('claude', 'claude_code', 'claude-haiku-5-5'), ('codex', 'codex', 'gpt-6-luna')]:
        row = subscriptions.get(kind, {})
        ack, authorization, tool = row.get('agentAcceptance', {}), row.get('runtimeAuthorization', {}), row.get('toolEvidence')
        if (row.get('status') != 'passed' or row.get('templateId') != report['templates'][kind]['templateId']
                or row.get('sourceCommit') != report['sourceCommit'] or row.get('workerSha') != report['workerSha']
                or row.get('harness') != harness or row.get('model') != model
                or row.get('credentialRoute') != 'subscription' or row.get('replyVerified') is not True
                or row.get('replyVerifiedAfterTool') is not True or not isinstance(tool, dict)
                or set(tool) != {'toolCallHash', 'outcome'} or tool.get('outcome') != 'ok'
                or not isinstance(tool.get('toolCallHash'), str) or not re.fullmatch(r'[a-f0-9]{16}', tool['toolCallHash'])
                or not re.fullmatch(r'[a-f0-9]{64}', row.get('officialBinarySha256', ''))
                or not isinstance(row.get('officialCliVersion'), str) or not row['officialCliVersion']
                or not row.get('runId') or not row.get('deviceId')
                or ack.get('harness') != harness or ack.get('runIdHash') != hashlib.sha256(row['runId'].encode()).hexdigest()[:16]
                or ack.get('kind') != ('claude_user_ack' if harness == 'claude_code' else 'codex_turn_start_ack')
                or type(ack.get('at')) is not int or ack['at'] <= 0
                or type(ack.get('ms')) not in (int, float) or not math.isfinite(ack['ms']) or ack['ms'] < 0
                or authorization.get('source') != 'http_server_link' or authorization.get('complete') is not True
                or authorization.get('truncated') is not False or authorization.get('extraRemoteCalls') != 0):
            raise ValueError(f'release_subscription_acceptance_missing {kind}')
    return report

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
    parser.add_argument('--publish-verified', type=Path, help='Publish only a release report that includes conservation and both real subscription passes')
    parser.add_argument('--json', action='store_true', help='Print one JSON object on stdout; build logs go to stderr')
    parser.add_argument('--worker-hash', action='store_true', help='Only print the worker hash of --source-ref; builds nothing')
    args = parser.parse_args(argv)
    if args.worker_hash:
        print(worker_hash(args.source_ref))
        return
    api_key = os.environ.get('E2B_API_KEY')
    if not api_key:
        raise SystemExit('E2B_API_KEY is not set')
    if args.publish_verified:
        report = verify_release_evidence(json.loads(args.publish_verified.read_text()))
        for template in report['templates'].values():
            template.update(publish(template['templateId'], template['buildId'], api_key))
        print(json.dumps(report))
        return
    if not args.name:
        parser.error('--name is required to build')
    kinds = list(dict.fromkeys(args.kind or KINDS))
    sha = commit(args.source_ref)
    # Confirm absence before claiming cleanup ownership. A manual collision
    # must never turn into deletion of a previous candidate.
    candidates = [{'kind': kind, 'name': f'{args.name}-{kind}'} for kind in kinds]
    for candidate in candidates:
        assert_new_template(candidate['name'], api_key)

    def one(kind):
        name = f'{args.name}-{kind}'
        logs = (lambda entry: print(f'[{kind}] {entry}', file=sys.stderr, flush=True)) if args.json else None
        _, result = build(name, sha, api_key=api_key, on_build_logs=logs, kind=kind)
        entry = {'templateId': result.template_id, 'buildId': result.build_id, 'name': name,
                 'baseTemplate': kind, 'preinstalled': True}
        entry['models'] = probe_models(result.template_id, kind, api_key)
        entry['conservation'] = probe_conservation(result.template_id, api_key, kind)
        return kind, entry

    # The templates share nothing at build time; build them side by side.
    from concurrent.futures import ThreadPoolExecutor
    try:
        with ThreadPoolExecutor(max_workers=len(kinds)) as pool:
            templates = dict(pool.map(one, kinds))
    except BaseException:
        cleanup = cleanup_templates(candidates, api_key)
        print('mikka-template-cleanup ' + json.dumps(cleanup, separators=(',', ':')), file=sys.stderr, flush=True)
        raise
    out = {'sourceCommit': sha, 'workerSha': worker_hash(sha), 'templates': templates}
    if args.json:
        print(json.dumps(out))
    else:
        for key, value in out.items():
            print(f'{key}={json.dumps(value) if isinstance(value, dict) else value}')

if __name__ == '__main__':
    main()
