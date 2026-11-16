"""Official-only control: E2B provider CA files across build, ready and fresh create.

Builds one private template per official base with only a metadata observer
(no Mikka install, no model or CLI calls), creates one instance, reads the
observations, then deletes the instance and the template. Outputs metadata
(path, kind, mode, owner, sha256, link target) only; never file contents.
"""
import json, os, re, sys, tempfile, time, urllib.request
from pathlib import Path

KINDS = ('claude', 'codex', 'desktop')
ROOTS = ('/usr/local/share/ca-certificates', '/etc/ssl/certs')
API = 'https://api.e2b.app'
OBSERVER = r'''
import hashlib, json, os, stat, sys
from pathlib import Path
kind, phase = sys.argv[1], sys.argv[2]
rows = []
for root in %r:
    base = Path(root)
    if not base.exists():
        continue
    for path in sorted([base, *base.rglob('*')]):
        info = path.lstat()
        row = {'path': str(path), 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
        if stat.S_ISLNK(info.st_mode):
            row.update(kind='link', target=os.readlink(path))
        elif stat.S_ISDIR(info.st_mode):
            row['kind'] = 'directory'
        else:
            row.update(kind='file', sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        rows.append(row)
out = json.dumps({'kind': kind, 'phase': phase, 'entries': rows}, separators=(',', ':'))
if phase == 'fresh':
    print(out)
else:
    Path('/opt/mikka-control/' + phase + '.json').write_text(out)
''' % (ROOTS,)


def request(method, path, key):
    req = urllib.request.Request(API + path, method=method, headers={'X-API-Key': key})
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read()
        return json.loads(body) if body else None


def one(kind, key, run):
    from e2b import Template, Sandbox
    name = f'mikka-ca-control-{run}-{kind}'
    result = {'kind': kind, 'name': name, 'observations': {}}
    template_id = sandbox = None
    try:
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, 'observe.py').write_text(OBSERVER)
            image = (Template(file_context_path=temp).from_template(kind).set_workdir('/')
                     .run_cmd('mkdir -m 0755 /opt/mikka-control', user='root')
                     .copy('observe.py', '/opt/mikka-control/observe.py')
                     .run_cmd(f'python3 -B /opt/mikka-control/observe.py {kind} build', user='root')
                     .set_user('root')
                     .set_start_cmd(f'python3 -B /opt/mikka-control/observe.py {kind} ready && exec sleep infinity',
                                    'test -s /opt/mikka-control/ready.json'))
            built = Template.build(image, name=name, cpu_count=2, memory_mb=4096, skip_cache=True, api_key=key)
            template_id = built.template_id
        result['templateId'] = template_id
        sandbox = Sandbox.create(template_id, api_key=key, timeout=180, metadata={'purpose': 'ca-control', 'run': run})
        for phase in ('build', 'ready'):
            result['observations'][phase] = json.loads(sandbox.files.read(f'/opt/mikka-control/{phase}.json', user='root'))['entries']
        fresh = sandbox.commands.run(f'python3 -B /opt/mikka-control/observe.py {kind} fresh', user='root', timeout=60)
        result['observations']['fresh'] = json.loads(fresh.stdout)['entries']
        result['status'] = 'observed'
    except Exception as error:  # metadata only
        result['status'] = 'failed'
        result['error'] = type(error).__name__ + ': ' + str(error)[:300]
    finally:
        cleanup = {}
        if sandbox is not None:
            try:
                sandbox.kill(); cleanup['sandbox'] = 'killed'
            except Exception as error:
                cleanup['sandbox'] = 'failed: ' + type(error).__name__
        try:
            alias = request('GET', '/templates/aliases/' + name, key)
            template_id = template_id or alias.get('templateID')
        except Exception:
            pass
        if template_id:
            try:
                request('DELETE', '/templates/' + template_id, key); cleanup['template'] = 'deleted'
            except Exception as error:
                cleanup['template'] = 'failed: ' + type(error).__name__
        result['cleanup'] = cleanup
    return result


def changes(result):
    """Entries whose metadata differs between the build and the ready/fresh phases."""
    out = []
    obs = result.get('observations', {})
    build = {row['path']: row for row in obs.get('build', [])}
    for phase in ('ready', 'fresh'):
        current = {row['path']: row for row in obs.get(phase, [])}
        for path in sorted(set(build) | set(current)):
            before, after = build.get(path), current.get(path)
            if before != after:
                fields = sorted(k for k in set(before or {}) | set(after or {}) if (before or {}).get(k) != (after or {}).get(k))
                out.append({'phase': phase, 'path': path, 'fields': fields,
                            'before': {k: (before or {}).get(k) for k in fields}, 'after': {k: (after or {}).get(k) for k in fields}})
    return out


def main():
    key = os.environ['E2B_API_KEY']
    run = f"{os.environ.get('GITHUB_RUN_ID', 'local')}-{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}"
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=len(KINDS)) as pool:
        results = list(pool.map(lambda kind: one(kind, key, run), KINDS))
    summary = {'version': 1, 'scope': 'official-only E2B provider CA control; no Mikka install, no model calls',
               'run': run, 'sdk': 'e2b==2.62.0', 'roots': ROOTS,
               'kinds': {r['kind']: {'status': r['status'], 'error': r.get('error'), 'cleanup': r['cleanup'],
                                     'changes': changes(r)} for r in results}}
    for r in results:
        (out / (r['kind'] + '.json')).write_text(json.dumps(r, separators=(',', ':')))
    (out / 'summary.json').write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
    if any(r['status'] != 'observed' for r in results):
        sys.exit(1)


if __name__ == '__main__':
    main()
