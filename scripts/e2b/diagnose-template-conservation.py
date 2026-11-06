"""Official-only control for #1505's build/ready conservation difference.

These uniquely named private control images are diagnostics, never candidates
for publication. They add only the manifest utility under /opt/mikka and run no
worker. The report preserves exact metadata/hash differences without file bytes.
"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from concurrent.futures import ThreadPoolExecutor

HERE = Path(__file__).resolve().parent
DIAGNOSE = r'''python3 - <<'PY'
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('official_files','/opt/mikka/official-files.py')
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
try:
    receipt={'status':'preserved','conservation':guard.verify(json.loads(Path('/opt/mikka/before.json').read_text()))}
except RuntimeError as error:
    receipt={'status':'changed','detail':str(error)}
Path('/opt/mikka/ready-diagnostic.json').write_text(json.dumps(receipt)+'\n')
PY
exec sleep infinity'''


def main():
    from e2b import Sandbox, Template
    spec = importlib.util.spec_from_file_location('builder', HERE / 'build-template.py')
    builder = importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
    key = os.environ['E2B_API_KEY']
    prefix = 'mikka-1505-official-control-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
    report = {'sourceCommit': builder.commit('HEAD'), 'scope': 'official-only conservation diagnostic; never a release candidate', 'controls': {}, 'cleanup': []}
    sandboxes = set()
    def one(kind):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, 'official-files.py').write_bytes((HERE / 'official-files.py').read_bytes())
            template = (Template(file_context_path=temp).from_template(kind).set_workdir('/')
                        .run_cmd('test ! -e /opt/mikka && test ! -L /opt/mikka && mkdir -m 0755 /opt/mikka', user='root')
                        .copy('official-files.py', '/opt/mikka/official-files.py')
                        .run_cmd('python3 /opt/mikka/official-files.py capture /opt/mikka/before.json', user='root')
                        .run_cmd('python3 /opt/mikka/official-files.py verify /opt/mikka/before.json', user='root')
                        .set_user('root').set_start_cmd(DIAGNOSE, 'test -s /opt/mikka/ready-diagnostic.json'))
            built = Template.build(template, name=prefix+'-'+kind, cpu_count=2, memory_mb=4096,
                                   skip_cache=True, api_key=key,
                                   on_build_logs=lambda entry: print(f'[{kind}] {entry}', flush=True))
            sandbox = Sandbox.create(built.template_id, api_key=key, timeout=120,
                                     metadata={'application': 'mikka-1505-official-control', 'run': os.environ['GITHUB_RUN_ID']})
            sandboxes.add(sandbox.sandbox_id)
            try:
                result = json.loads(sandbox.files.read('/opt/mikka/ready-diagnostic.json', user='root'))
                versions = sandbox.commands.run("for cli in claude codex; do command -v \"$cli\" >/dev/null 2>&1 && \"$cli\" --version || true; done", user='user', timeout=30)
                result['officialCliVersions'] = versions.stdout.strip().splitlines()
                print('mikka-official-control ' + json.dumps({'kind': kind, **result}), flush=True)
                return kind, result
            finally:
                Sandbox.kill(sandbox.sandbox_id, api_key=key);sandboxes.discard(sandbox.sandbox_id)
    try:
        with ThreadPoolExecutor(max_workers=3) as executor:
            report['controls'] = dict(executor.map(one, ('claude', 'codex', 'desktop')))
    finally:
        for sandbox_id in tuple(sandboxes):
            try:
                Sandbox.kill(sandbox_id, api_key=key);sandboxes.discard(sandbox_id)
            except Exception as error:
                report['cleanup'].append({'resource':'sandbox','id':sandbox_id,'error':type(error).__name__})
        for kind in ('claude','codex','desktop'):
            name=prefix+'-'+kind
            try:
                info=builder._request('GET','/templates/'+name,key)
                if name not in info.get('names',[])+info.get('aliases',[]) or info.get('isDefault') is True:
                    raise RuntimeError('diagnostic_cleanup_name_mismatch')
                builder._request('DELETE','/templates/'+info['templateID'],key)
            except Exception as error:
                if getattr(error,'code',None)!=404:
                    report['cleanup'].append({'resource':'control-template','kind':kind,'error':type(error).__name__})
        report['remainingSandboxes']=sorted(sandboxes)
        (HERE/'component-benchmark.json').write_text(json.dumps(report,indent=2)+'\n')
        print('mikka-control-cleanup '+json.dumps({'remainingSandboxes':sorted(sandboxes),'cleanup':report['cleanup']}),flush=True)
    if sandboxes or report['cleanup']:
        raise RuntimeError('diagnostic_cleanup_incomplete')


if __name__=='__main__':
    main()
