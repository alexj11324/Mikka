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
                'scripts/e2b/acceptance-daemon.mts', 'scripts/e2b/acceptance-bootstrap.mts',
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
ANONYMOUS_WORKER_CHECKS = (
    ('pid_file', 'test -s /home/user/.mikka/preloaded.pid'),
    ('pid_read', 'read -r mikka_preloaded_pid < /home/user/.mikka/preloaded.pid'),
    ('pid_alive', 'kill -0 "$mikka_preloaded_pid"'),
    ('worker_waiting', "tr '\\0' '\\n' < \"/proc/$mikka_preloaded_pid/cmdline\" | grep -Fxq -- '--wait-bootstrap'"),
)
ANONYMOUS_WORKER_READY = ' && '.join(command for _phase, command in ANONYMOUS_WORKER_CHECKS)
PREBUILT_START_PHASES = frozenset(('entry', 'preconditions_verified', 'guard_prepare', 'guard_prepared',
                                 'control_install', 'control_installed', 'worker_exec'))
PREBUILT_READY_PHASES = frozenset((*[phase for phase, _command in ANONYMOUS_WORKER_CHECKS],
                                 'ingress_ready', 'bootstrap_absent', 'device_absent',
                                 'viewer_key_absent', 'viewer_unauthorized', 'official_files'))


def prebuilt_ready_command(kind):
    """Preserve every original predicate/order/status and the provider deadline.

    No probe or retry is added. One closed failure line distinguishes a normal
    first PID-file race from a failing guest check after envd starts the shell.
    """
    checks = [*ANONYMOUS_WORKER_CHECKS,
              ('ingress_ready', 'python3 /opt/mikka/runtime/ingress-v1/guard.py ready "$mikka_preloaded_pid" > /opt/mikka/ingress-ready.json'),
              ('bootstrap_absent', 'test ! -e /home/user/.mikka/bootstrap.json'),
              ('device_absent', 'test ! -e /home/user/.mikka/worker/device.json')]
    if kind == 'desktop':
        checks.extend((('viewer_key_absent', 'test ! -e /run/mikka-viewer/key'),
                       ('viewer_unauthorized', 'test "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/vnc)" = 401')))
    checks.append(('official_files', f'python3 /opt/mikka/official-files.py verify /opt/mikka/official-files-before.json --e2b-finalization {kind}'
                   ' > /opt/mikka/official-files-ready.json'))
    command = ' && '.join(f'mikka_ready_phase={phase} && {predicate}' for phase, predicate in checks)
    return (command + '; mikka_ready_status=$?; '
            'if [ "$mikka_ready_status" -ne 0 ]; then '
            'printf "mikka-prebuilt-ready-failed %s %s\\n" "$mikka_ready_phase" "$mikka_ready_status" >&2; fi; '
            'exit "$mikka_ready_status"')

# One deadline includes reading/verifying selected native CLI bytes and the
# real anonymous catalogue exchange. Never warm files in a separate command.
# The standalone official-instance installer has no snapshot receipt. Its
# explicit live probe is separate from the release's completed-receipt gate.
MODEL_PROBE_COMMAND = ('export PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH; '
                       'python3 /opt/mikka/worker/scripts/e2b/official-files.py cli-verify '
                       '/opt/mikka/worker/.mikka-original-cli.json --kind {kind} && '
                       'exec /opt/mikka/runtime/node/bin/node /opt/mikka/worker/packages/daemon/dist/cloud/cloud-model-probe.js')

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
                    .run_cmd(f'bash /opt/mikka/instance-bootstrap.sh {sha} {worker_sha} {kind} prebuild', user='root')
                    .run_cmd(NPM_RUNTIME_CHECK, user='user')
                    .run_cmd('python3 /opt/mikka/official-files.py verify /opt/mikka/official-files-before.json --receipt /opt/mikka/official-files-conservation.json', user='root'))
        ready = prebuilt_ready_command(kind)
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
        # Template names are aliases, not template IDs. The ID endpoint can
        # return 404 for an existing alias and must not prove it is unused.
        _request('GET', f'/templates/aliases/{name}', api_key)
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
            template_id = candidate.get('templateId')
            if 'templateId' in candidate:
                if not isinstance(template_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', template_id):
                    raise ValueError('cleanup_candidate_identity_mismatch')
                row['templateId'] = template_id
                # A missing alias cannot prove that a known candidate was deleted.
                try:
                    info = request('GET', '/templates/' + template_id, api_key)
                except HTTPError as error:
                    if error.code == 404:
                        receipts.append({**row, 'status': 'absent'})
                        continue
                    raise
            alias = None
            try:
                alias = request('GET', '/templates/aliases/' + name, api_key)
            except HTTPError as error:
                if error.code != 404:
                    raise
                if template_id is None:
                    receipts.append({**row, 'status': 'absent'})
                    continue
                # The known ID still exists. Its exact recorded name below
                # can prove ownership even after its alias has disappeared.
            else:
                alias_id = alias.get('templateID')
                if (not isinstance(alias_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', alias_id)
                        or (template_id is not None and alias_id != template_id)):
                    raise ValueError('cleanup_candidate_identity_mismatch')
            if template_id is None:
                # Recover a build that created its alias before writing a report.
                template_id = alias_id
                row['templateId'] = template_id
                try:
                    info = request('GET', '/templates/' + template_id, api_key)
                except HTTPError as error:
                    if error.code == 404:
                        receipts.append({**row, 'status': 'absent'})
                        continue
                    raise
            names = (info.get('names') or []) + (info.get('aliases') or [])
            # Namespace-qualified names require the independent team-scoped
            # alias binding. Without an alias, require the exact recorded name.
            matches_name = (name in names if alias is None else
                any(isinstance(value, str) and re.fullmatch(r'(?:[^/]+/)?' + re.escape(name), value) for value in names))
            if (not matches_name
                    or info.get('isDefault') is True or info.get('templateID') != template_id):
                raise ValueError('cleanup_candidate_identity_mismatch')
            if info.get('public') is True or (alias is not None and alias.get('public') is True):
                receipts.append({**row, 'status': 'retained_public'})
                continue
            if info.get('public') is not False or (alias is not None and alias.get('public') is not False):
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


def validate_model_receipt(receipt, source_commit, worker_sha, manifest, kind):
    """Bind the completed anonymous probe to this immutable release and CLI selection."""
    if (not isinstance(receipt, dict)
            or set(receipt) != {'version', 'sourceCommit', 'workerSha', 'manifest', 'binaries', 'reports'}
            or type(receipt.get('version')) is not int or receipt['version'] != 1
            or receipt.get('sourceCommit') != source_commit or receipt.get('workerSha') != worker_sha):
        raise RuntimeError('model_receipt_identity_invalid')
    official_files_guard().validate_cli_manifest(manifest, kind)
    if (type(manifest['version']) is not int
            or json.dumps(receipt['manifest'], sort_keys=True) != json.dumps(manifest, sort_keys=True)):
        raise RuntimeError('model_receipt_manifest_mismatch')
    selected = {harness: binary['path'] for harness in ('claude_code', 'codex')
                if (binary := manifest['original'][harness] or manifest['added'].get(harness))}
    if not selected or receipt['binaries'] != selected:
        raise RuntimeError('model_receipt_selection_mismatch')
    reports = receipt['reports']
    if not isinstance(reports, list) or len(reports) != len(selected):
        raise RuntimeError('model_receipt_reports_invalid')
    seen = set()
    required_fields = {'harness', 'installed', 'version', 'models', 'modelSlots'}
    def text(value, limit):
        return isinstance(value, str) and 0 < len(value) <= limit and value.strip() == value
    for row in reports:
        if (not isinstance(row, dict) or not required_fields.issubset(row)
                or set(row) - (required_fields | {'defaultModelSlot'})
                or not isinstance(row['harness'], str) or row['harness'] not in selected or row['harness'] in seen
                or row['installed'] is not True or row['version'] is not None):
            raise RuntimeError('model_receipt_reports_invalid')
        models, slots = row['models'], row['modelSlots']
        if (not isinstance(models, list) or not 0 < len(models) <= 500
                or not all(text(model, 128) and model != 'auto' for model in models)
                or len(set(models)) != len(models) or not isinstance(slots, list) or len(slots) != len(models)):
            raise RuntimeError('model_receipt_reports_invalid')
        for model, slot in zip(models, slots):
            if (not isinstance(slot, dict) or set(slot) != {'slot', 'model', 'name'} or slot['slot'] != model
                    or not text(slot['model'], 128) or not text(slot['name'], 200)):
                raise RuntimeError('model_receipt_reports_invalid')
        if 'defaultModelSlot' in row and row['defaultModelSlot'] not in models:
            raise RuntimeError('model_receipt_reports_invalid')
        seen.add(row['harness'])
    required = json.loads((ROOT / 'scripts/e2b/template-capabilities.json').read_text())[kind]
    if any(harness not in seen for harness in required):
        raise RuntimeError('model_receipt_required_harness_missing')
    return [row for row in reports if row['harness'] in required]


def probe_models(template_id, kind, api_key, source_commit, worker_sha, sandbox_factory=None):
    """Read the real probe that made the snapshot ready; never launch a second cold worker."""
    if (not re.fullmatch(r'[a-f0-9]{40}', source_commit) or not re.fullmatch(r'[a-f0-9]{40}', worker_sha)
            or kind not in KINDS):
        raise ValueError('model_receipt_expected_identity_invalid')
    if sandbox_factory is None:
        from e2b import Sandbox
        sandbox_factory = Sandbox.create
    sandbox = sandbox_factory(template_id, api_key=api_key, timeout=60, metadata=release_metadata())
    began = time.monotonic()
    stage = 'ready_check'
    byte_counts = {'workerIdentity': None, 'manifest': None, 'receipt': None}
    receipt_json_received = False
    failure = None

    def read_file(key, path):
        data = sandbox.files.read(path, user='user', request_timeout=30)
        # A failed read exposes no partial count. None means unknown, not zero.
        byte_counts[key] = len(data.encode('utf-8'))
        return data

    try:
        path = '/home/user/.mikka/preloaded-models.json'
        # No identity has been handed to this disposable instance. Check that
        # the writer is still the anonymous, ready process before trusting its
        # private read-only receipt. Full fresh-image conservation follows.
        result = sandbox.commands.run(ANONYMOUS_WORKER_READY +
            ' && test ! -e /home/user/.mikka/bootstrap.json && test ! -e /home/user/.mikka/worker/device.json' +
            f' && test -f {path} && test ! -L {path} && test ! -w {path}' +
            f' && test "$(stat -c %u {path})" = "$(id -u)" && readlink -f /opt/mikka/worker', user='user', timeout=45)
        if result.exit_code != 0 or result.stdout.strip() != f'/opt/mikka/releases/{source_commit}/source':
            raise RuntimeError('model_receipt_worker_not_ready')
        stage = 'worker_identity'
        installed_sha = read_file('workerIdentity', '/opt/mikka/worker-source-sha').strip()
        if installed_sha != worker_sha:
            raise RuntimeError('model_receipt_worker_mismatch')
        stage = 'manifest_read'
        manifest_raw = read_file('manifest', '/opt/mikka/worker/.mikka-original-cli.json')
        stage = 'manifest_parse'
        manifest = json.loads(manifest_raw)
        stage = 'receipt_read'
        raw = read_file('receipt', path)
        if len(raw) > 1_048_576:
            raise RuntimeError('model_receipt_too_large')
        stage = 'receipt_parse'
        receipt = json.loads(raw)
        # Decoded JSON is not evidence that the release or catalogue is valid.
        receipt_json_received = True
        stage = 'receipt_validate'
        return validate_model_receipt(receipt, source_commit, worker_sha, manifest, kind)
    except Exception as error:
        failure = error
        try:
            codes = {
                'model_receipt_worker_not_ready': 'worker_not_ready',
                'model_receipt_worker_mismatch': 'worker_mismatch',
                'model_receipt_too_large': 'receipt_too_large',
                'model_receipt_identity_invalid': 'identity_invalid',
                'model_receipt_manifest_mismatch': 'manifest_mismatch',
                'model_receipt_selection_mismatch': 'selection_mismatch',
                'model_receipt_reports_invalid': 'reports_invalid',
                'model_receipt_required_harness_missing': 'required_harness_missing',
                'official_cli_manifest_invalid': 'manifest_invalid',
            }
            code = error.args[0] if len(error.args) == 1 and isinstance(error.args[0], str) else None
            category = codes.get(code)
            if type(error).__name__ in ('TimeoutException', 'TimeoutError', 'ReadTimeout', 'ConnectTimeout'):
                category = 'timeout'
            elif category is None:
                if isinstance(error, json.JSONDecodeError):
                    category = 'invalid_json'
                elif stage in ('worker_identity', 'manifest_read', 'receipt_read'):
                    category = 'read_failed'
                else:
                    category = 'unexpected'
            # File counts and closed categories only; never receipt text,
            # transport messages, CLI output or account/credential details.
            print(json.dumps({
                'event': 'mikka_model_probe_failed', 'kind': kind, 'stage': stage, 'error': category,
                'bytes': byte_counts, 'elapsedMs': round((time.monotonic() - began) * 1000),
                'receiptJsonReceived': receipt_json_received,
            }, separators=(',', ':')), file=sys.stderr, flush=True)
        except Exception:
            error.add_note('model_probe_diagnostic_failed')
        raise
    finally:
        # This probe created this disposable sandbox; no existing worker is touched.
        try:
            sandbox.kill()
        except Exception:
            if failure is None:
                raise
            failure.add_note('model_probe_cleanup_failed')


CONSERVATION_DIAGNOSTIC_MAX_BYTES = 262144
CONSERVATION_DIAGNOSTIC_MAX_CHANGES = 512


def fresh_conservation_command(kind):
    """Keep the fresh-create predicates, order and exit status; name a failure."""
    if kind not in KINDS:
        raise ValueError('e2b_finalization_policy_invalid')
    checks = [*ANONYMOUS_WORKER_CHECKS, ('official_files',
        f'python3 /opt/mikka/official-files.py verify /opt/mikka/official-files-before.json --e2b-finalization {kind} --receipt /opt/mikka/fresh-conservation.json >/dev/null')]
    command = ' && '.join(f'mikka_conservation_check={phase} && {predicate}' for phase, predicate in checks)
    return (command + '; mikka_conservation_status=$?; '
            'if [ "$mikka_conservation_status" -ne 0 ]; then '
            'printf "mikka-conservation-check-failed %s %s\\n" "$mikka_conservation_check" "$mikka_conservation_status" >&2; fi; '
            'exit "$mikka_conservation_status"')


def conservation_diagnostic(error, kind, stage):
    """Only the guard's bounded metadata may cross the SDK error boundary."""
    stages = {'preload_receipts', 'preload_validation', 'fresh_scan', 'fresh_receipt', 'fresh_validation'}
    codes = {'official_manifest_invalid', 'official_conservation_invalid', 'official_conservation_missing',
             'official_files_removed', 'e2b_certificate_target_invalid'}
    message = error.args[0] if error.args else None
    detail = {'kind': kind if kind in KINDS else 'unknown', 'stage': stage if stage in stages else 'unknown',
              'code': message if isinstance(message, str) and message in codes else 'conservation_failed'}
    exit_code = getattr(error, 'exit_code', None)
    if type(exit_code) is int and -255 <= exit_code <= 255:
        detail['exitCode'] = exit_code
    stderr = getattr(error, 'stderr', '')
    if not isinstance(stderr, str):
        return detail
    if len(stderr) > CONSERVATION_DIAGNOSTIC_MAX_BYTES or len(stderr.encode('utf-8', errors='replace')) > CONSERVATION_DIAGNOSTIC_MAX_BYTES:
        return {**detail, 'code': 'conservation_diagnostic_too_large'}
    checks = []
    for line in stderr.splitlines():
        match = re.fullmatch(r'mikka-conservation-check-failed (pid_file|pid_read|pid_alive|worker_waiting|official_files) ([1-9][0-9]{0,2})', line)
        if match and 1 <= int(match[2]) <= 255:
            checks.append((match[1], int(match[2])))
    if len(checks) == 1 and type(exit_code) is int and checks[0][1] == exit_code:
        detail['check'] = checks[0][0]
    kinds = {'file', 'link', 'directory', 'special'}
    fields = {'kind', 'sha256', 'mode', 'uid', 'gid', 'target', 'type', 'device'}
    def path(value, absolute=False):
        return (isinstance(value, str) and 0 < len(value) <= 2048
                and re.fullmatch(r'[A-Za-z0-9_./@+~()=: -]+', value)
                and (not absolute or (value.startswith('/') and '..' not in Path(value).parts)))
    def field(key, value):
        if value is None: return True
        if key == 'kind': return isinstance(value, str) and value in kinds
        if key == 'sha256': return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value)
        if key == 'target': return path(value)
        return type(value) is int and 0 <= value <= (4095 if key == 'mode' else 2**64 - 1)
    for line in stderr.splitlines():
        for code in ('official_files_changed', 'official_files_removed'):
            marker = 'RuntimeError: ' + code + ' '
            if not line.startswith(marker):
                continue
            try:
                parsed = json.loads(line[len(marker):])
                if code == 'official_files_removed':
                    if not isinstance(parsed, dict) or set(parsed) != {'path'} or not path(parsed['path'], absolute=True):
                        raise ValueError('conservation_metadata_invalid')
                    return {**detail, 'code': code, 'missing': parsed}
                if not isinstance(parsed, list) or not 0 < len(parsed) <= CONSERVATION_DIAGNOSTIC_MAX_CHANGES:
                    raise ValueError('conservation_metadata_invalid')
                for row in parsed:
                    if (not isinstance(row, dict) or set(row) - {'path', 'kind', 'before', 'after', 'resolvedSha256'}
                            or not {'path', 'kind', 'before', 'after'}.issubset(row)
                            or not path(row['path'], absolute=True) or not isinstance(row['kind'], str) or row['kind'] not in kinds
                            or not isinstance(row['before'], dict) or not row['before'] or not isinstance(row['after'], dict)
                            or row['before'].keys() != row['after'].keys() or set(row['before']) - fields
                            or not all(field(key, value) for side in ('before', 'after') for key, value in row[side].items())
                            or ('resolvedSha256' in row and (row['resolvedSha256'] is None or not field('sha256', row['resolvedSha256'])))):
                        raise ValueError('conservation_metadata_invalid')
                return {**detail, 'code': code, 'changes': parsed}
            except (ValueError, TypeError, KeyError, RecursionError):
                return {**detail, 'code': 'conservation_metadata_invalid'}
        if line.startswith('RuntimeError: ') and line.removeprefix('RuntimeError: ') in codes:
            detail['code'] = line.removeprefix('RuntimeError: ')
    return detail


def probe_conservation(template_id, api_key, kind, sandbox_factory=None, *, on_diagnostic=None):
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
    phase = 'preload_receipts'
    try:
        conservation = json.loads(sandbox.files.read('/opt/mikka/official-files-conservation.json', user='root', request_timeout=30))
        conservation['finalization'] = json.loads(sandbox.files.read('/opt/mikka/official-files-ready.json', user='root', request_timeout=30))
        stage('preload_receipts')
        phase = 'preload_validation'
        guard = official_files_guard()
        guard.validate_receipt(conservation, kind)
        phase = 'fresh_scan'
        result = sandbox.commands.run(fresh_conservation_command(kind),
                                      user='root', timeout=300, request_timeout=310)
        if result.exit_code != 0:
            raise RuntimeError('official_conservation_missing')
        stage('fresh_scan')
        phase = 'fresh_receipt'
        conservation['preloadFinalization'] = conservation['finalization']
        conservation['finalization'] = json.loads(sandbox.files.read('/opt/mikka/fresh-conservation.json', user='root', request_timeout=30))
        stage('fresh_receipt')
        phase = 'fresh_validation'
        return guard.validate_receipt(conservation, kind)
    except Exception as error:
        # Emit before finally destroys the disposable instance. Never print
        # SDK stdout/stderr or exception messages; keep the original failure.
        detail = conservation_diagnostic(error, kind, phase)
        if on_diagnostic is not None:
            try:
                on_diagnostic(detail)
            except BaseException:
                # Observation cannot replace the original failure or its cleanup.
                error.add_note('conservation_diagnostic_callback_failed')
        print('mikka-conservation-failed ' + json.dumps(detail, separators=(',', ':')),
              file=sys.stderr, flush=True)
        raise
    finally:
        sandbox.kill()


def observed_mcp_business_evidence(value, run_hash, harness):
    """Validate the observed business path; whole-generation coverage is unknown."""
    def count(number):
        return type(number) is int and 0 <= number <= 1_000_000

    def epoch(number):
        return type(number) is int and 0 < number <= 2**53 - 1

    def duration(number):
        return type(number) in (int, float) and math.isfinite(number) and 0 <= number <= 86_400_000

    if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] not in (1, 2, 3)
            or value.get('source') != 'mikka_mcp_physical_fetch' or value.get('scope') != 'observed_mikka_mcp_children'
            or value.get('generationCoverage') != 'unverified' or value.get('allFirstPartyHttpComplete') is not False
            or type(value.get('remoteMcpServerCount')) is not int or value['remoteMcpServerCount'] != 0
            or type(value.get('childPathAuditVersion')) is not int or value['childPathAuditVersion'] != (2 if value['version'] == 3 else 1)
            or value['version'] == 3 and ('expectedCatalogueSha256' not in value or not (value['expectedCatalogueSha256'] is None
                or isinstance(value['expectedCatalogueSha256'], str) and re.fullmatch(r'[a-f0-9]{64}', value['expectedCatalogueSha256'])))
            or value.get('runIdHash') != run_hash or value.get('harness') != harness
            or not epoch(value.get('startedAt')) or not epoch(value.get('endedAt')) or value['endedAt'] < value['startedAt']
            or type(value.get('expectedChildren')) is not int or value['expectedChildren'] != 1
            or type(value.get('observedComplete')) is not bool or type(value.get('childLifecycleComplete')) is not bool
            or value.get('truncated') is not False or type(value.get('rejectedEvents')) is not int or value['rejectedEvents'] != 0
            or not count(value.get('observedChildren')) or not 1 <= value['observedChildren'] <= 8
            or not count(value.get('closedChildren')) or value['closedChildren'] > value['observedChildren']
            or not isinstance(value.get('children'), list) or len(value['children']) != value['observedChildren']
            or not isinstance(value.get('requests'), list) or len(value['requests']) > 128):
        return False
    children, requests, seen = value['children'], value['requests'], set()
    for index, child in enumerate(children):
        if (not isinstance(child, dict) or type(child.get('child')) is not int or child['child'] != index + 1
                or not epoch(child.get('startedAt')) or not value['startedAt'] <= child['startedAt'] <= value['endedAt']
                or 'closedAt' not in child or not (child['closedAt'] is None or epoch(child['closedAt']) and child['startedAt'] <= child['closedAt'] <= value['endedAt'])
                or not all(count(child.get(key)) for key in ('lastSequence', 'sent', 'completed', 'lost'))
                or child['lastSequence'] < 1 or child['completed'] > child['sent'] or child['lost'] != 0):
            return False
        if value['version'] == 3:
            if 'catalogue' not in child:
                return False
            catalogue = child['catalogue']
            if catalogue is not None and (not isinstance(catalogue, dict) or set(catalogue) != {'source', 'sha256', 'readyAt'}
                    or catalogue['source'] != 'claim' or value['expectedCatalogueSha256'] is None
                    or catalogue['sha256'] != value['expectedCatalogueSha256'] or not epoch(catalogue['readyAt'])
                    or not child['startedAt'] <= catalogue['readyAt'] <= (child['closedAt'] or value['endedAt'])):
                return False
    if sum(child['closedAt'] is not None for child in children) != value['closedChildren']:
        return False
    for request in requests:
        if not isinstance(request, dict) or not count(request.get('child')) or not 1 <= request['child'] <= len(children):
            return False
        child = children[request['child'] - 1]
        if (not count(request.get('sequence')) or request['sequence'] < 1
                or (request['child'], request['sequence']) in seen
                or not all(key in request for key in ('status', 'endedAt', 'durationMs'))
                or request.get('operation') not in ('decision_catalogue', 'decision_record')
                or not epoch(request.get('startedAt')) or not child['startedAt'] <= request['startedAt'] <= (child['closedAt'] or value['endedAt'])
                or request.get('outcome') not in ('ok', 'error', 'pending')
                or not (request.get('status') is None or type(request['status']) is int and 100 <= request['status'] <= 599)):
            return False
        seen.add((request['child'], request['sequence']))
        if request['outcome'] == 'pending':
            if any(request.get(key) is not None for key in ('endedAt', 'durationMs', 'status')):
                return False
        elif (not epoch(request.get('endedAt')) or not request['startedAt'] <= request['endedAt'] <= (child['closedAt'] or value['endedAt'])
              or not duration(request.get('durationMs'))
              or request['outcome'] != ('ok' if type(request['status']) is int and 200 <= request['status'] < 300 else 'error')):
            return False
        if value['version'] >= 2:
            if 'body' not in request:
                return False
            body = request['body']
            if body is not None and (not isinstance(body, dict) or set(body) != {'endedAt', 'durationMs', 'outcome'}
                    or request['endedAt'] is None or request['status'] is None
                    or not epoch(body.get('endedAt')) or not request['endedAt'] <= body['endedAt'] <= (child['closedAt'] or value['endedAt'])
                    or not duration(body.get('durationMs')) or body['durationMs'] < request['durationMs']
                    or body.get('outcome') not in ('read', 'error')):
                return False
    for child in children:
        observed = sorted((request for request in requests if request['child'] == child['child']), key=lambda row: row['sequence'])
        if (len(observed) != child['sent'] or sum(row['outcome'] != 'pending' for row in observed) != child['completed']
                or child['lastSequence'] != 1 + child['sent'] + child['completed'] + int(child['closedAt'] is not None)
                    + (sum(row.get('body') is not None for row in observed) if value['version'] >= 2 else 0)
                    + int(value['version'] == 3 and child.get('catalogue') is not None)
                or any(row['sequence'] != index + 1 for index, row in enumerate(observed))):
            return False
    observed_complete = all(row['outcome'] != 'pending' for row in requests)
    if ((value['observedComplete'] and not observed_complete)
            or (value['childLifecycleComplete'] and not (observed_complete and value['closedChildren'] == len(children)))):
        return False
    remote_catalogue = any(row['operation'] == 'decision_catalogue' for row in requests)
    if value['version'] == 3 and value['expectedCatalogueSha256'] is not None:
        return not remote_catalogue and any(child['catalogue'] is not None for child in children)
    return any(row['operation'] == 'decision_catalogue' and row['outcome'] != 'pending' for row in requests)


def observed_bootstrap_adoption(value, run_id_hash, harness):
    """The actual adopted startup, distinct from ordinary FD3 fallback."""
    keys = {'version', 'runIdHash', 'harness', 'source', 'bootstrapSha256', 'hintSha256', 'startupTiming', 'preparationTiming'}
    source = 'bootstrap_claude_start' if harness == 'claude_code' else 'bootstrap_codex_initialize'
    if (not isinstance(value, dict) or set(value) != keys or type(value.get('version')) is not int or value['version'] != 1
            or value.get('runIdHash') != run_id_hash or not isinstance(run_id_hash, str) or not re.fullmatch(r'[a-f0-9]{16}', run_id_hash)
            or value.get('harness') != harness or harness not in ('claude_code', 'codex') or value.get('source') != source
            or any(not isinstance(value.get(key), str) or not re.fullmatch(r'[a-f0-9]{64}', value[key]) for key in ('bootstrapSha256', 'hintSha256'))):
        return False
    names = {'daemon.adapter.model_report', 'daemon.adapter.auth', 'daemon.adapter.auth.gate',
             'daemon.adapter.auth.context', 'daemon.adapter.auth.access', 'daemon.adapter.auth.token', 'daemon.adapter.auth.native_auth',
             'daemon.adapter.auth.refresh', 'daemon.adapter.auth.broker', 'daemon.adapter.workspace.shadow_clone',
             'daemon.adapter.workspace.read_tree', 'daemon.adapter.cli_init', 'daemon.adapter.account_check',
             'daemon.adapter.account_check.account_info', 'daemon.adapter.account_check.login'}
    duration = lambda n: type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 3600000
    epoch = lambda n: type(n) is int and 0 < n <= 9007199254740991
    def timing(row, permitted):
        if (not isinstance(row, dict) or type(row.get('version')) is not int or row['version'] != 1
                or row.get('runIdHash') != run_id_hash or row.get('harness') != harness or row.get('outcome') != 'ok'
                or row.get('truncated') is not False or not epoch(row.get('startedAt')) or not epoch(row.get('endedAt'))
                or row['endedAt'] < row['startedAt'] or not duration(row.get('ms'))
                or not isinstance(row.get('phases'), list) or len(row['phases']) > 64):
            return False
        return all(isinstance(phase, dict) and isinstance(phase.get('name'), str) and phase.get('name') in permitted and phase.get('outcome') in ('ok', 'error')
                   and all(duration(phase.get(key)) for key in ('startMs', 'endMs', 'ms'))
                   and phase['endMs'] >= phase['startMs'] and phase['endMs'] <= row['ms'] + .01
                   and abs(phase['ms'] - (phase['endMs'] - phase['startMs'])) <= .01 for phase in row['phases'])
    stage, prepared = value.get('startupTiming'), value.get('preparationTiming')
    if (not timing(stage, names) or not timing(prepared, names | {'daemon.adapter.cli_init.prewarm'})
            or prepared.get('source') != source or prepared['startedAt'] > stage['startedAt'] or prepared['endedAt'] > stage['endedAt']
            or any(phase['outcome'] != 'ok' for phase in prepared['phases'])
            or any(sum(phase['name'] == name for phase in prepared['phases']) != 1
                   for name in ('daemon.adapter.cli_init.prewarm', 'daemon.adapter.cli_init'))):
        return False
    return harness == 'codex' or (prepared.get('claimAuthentication') == 'oauth_environment'
                                 and prepared.get('observedAuthSource') == 'oauth_environment')


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
                or authorization.get('scope') != 'daemon_http_server_link_and_task_fetch'
                or authorization.get('truncated') is not False or type(authorization.get('extraRemoteCalls')) is not int or authorization['extraRemoteCalls'] != 0
                or authorization.get('hostAuthorizationComplete') is not True or authorization.get('allFirstPartyHttpComplete') is not False
                or authorization.get('basis') != 'host_authorization_census_and_closed_mcp_business_paths'
                or type(authorization.get('observedProviderEvents')) is not int or authorization['observedProviderEvents'] < 1
                or authorization.get('officialDelivery') != 'best_effort_not_a_complete_call_count'
                or not observed_mcp_business_evidence(authorization.get('mcpHttpTiming'), ack.get('runIdHash'), harness)
                or not observed_bootstrap_adoption(row.get('bootstrapAcceptance'), ack.get('runIdHash'), harness)):
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
    worker_sha = worker_hash(sha)
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
        entry['models'] = probe_models(result.template_id, kind, api_key, sha, worker_sha)
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
    out = {'sourceCommit': sha, 'workerSha': worker_sha, 'templates': templates}
    if args.json:
        print(json.dumps(out))
    else:
        for key, value in out.items():
            print(f'{key}={json.dumps(value) if isinstance(value, dict) else value}')

if __name__ == '__main__':
    main()
