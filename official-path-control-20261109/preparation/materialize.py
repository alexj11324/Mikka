"""Derive an inactive, local-only path control from the fixed reviewed sources."""
import ast
import difflib
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parent
BUNDLE = ROOT / 'bundle'
OLD_NAME = 'issue1506-e2b-official-control'
NEW_NAME = 'issue1505-official-path-control'
OLD_BRANCH = 'ops/issue1506-e2b-conservation-control-4'
NEW_BRANCH = 'ops/1505-smoke-github-readonly-20261109'
SOURCE = '5ba1f9e2359ce714d83cd16fc040f2567c40a6d0'
CARRIER_PARENT = 'e93477fe401c70dca532784e71b76d56877b6899'
GO = 'root-reviewed-1505-official-path-control-20261109-v1'
old = (ROOT / 'upstream/08d822da/observer.py').read_text()
apt = (ROOT / 'upstream/1e351dcf/observer.py').read_text()
old_tests = (ROOT / 'upstream/08d822da/tests.py').read_text()
old_workflow = (ROOT / 'upstream/08d822da/workflow.yml.source').read_text()


def segment(source, name):
    tree = ast.parse(source)
    node = next(x for x in tree.body if isinstance(x, (ast.FunctionDef, ast.ClassDef)) and x.name == name)
    return '\n'.join(source.splitlines()[node.lineno-1:node.end_lineno])


def literal(source, name):
    assignment = next(x for x in ast.parse(source).body if isinstance(x, ast.Assign)
                      and any(isinstance(t, ast.Name) and t.id == name for t in x.targets))
    return ast.literal_eval(assignment.value)


def rename(text):
    return (text.replace(OLD_NAME, NEW_NAME).replace(OLD_BRANCH, NEW_BRANCH)
            .replace('mikka-1506-official-control', 'mikka-1505-official-path-control')
            .replace('issue1506-official-control', 'issue1505-official-path-control')
            .replace('issue1506-official-sdk', 'issue1505-official-path-sdk')
            .replace('issue1506_official_targeted_control', 'issue1505_official_path_control')
            .replace('issue 1506', 'issue 1505').replace('111a8dfb8b227ac0441324339ff42e4328ea609a', SOURCE))


schema = '''OBSERVED_PATHS={'desktop':('/var/lib/apt/extended_states','/var/backups/apt.extended_states.0'),
                'codex':('/usr/local/share/ca-certificates/e2b-ca.crt',)}
UNITS=('apt-daily.service','apt-daily-upgrade.service','apt-daily.timer','apt-daily-upgrade.timer')
SERVICE_FIELDS=('ActiveState','SubState','MainPID','ExecMainStartTimestamp',
                'ExecMainExitTimestamp','InvocationID','Result')

def closed_codex_root(row):
    if not isinstance(row,dict) or row.get('path')!=OBSERVED_PATHS['codex'][0]:
        fail('observation_invalid')
    if row=={'path':OBSERVED_PATHS['codex'][0],'status':'absent'}:
        return
    base={'path','status','kind','mode','uid','gid'}
    if (row.get('status') not in ('present','too_large','changed_during_read')
        or row.get('kind') not in ('file','link','directory','special')
        or not base<=set(row)
        or any(type(row[k]) is not int or not 0<=row[k]<2**64 for k in ('mode','uid','gid'))
        or row['mode']>4095):
        fail('observation_invalid')
    expected=base|({'sha256'} if row['kind']=='file' and row['status']=='present' else set())
    if set(row)!=expected or ('sha256' in row and not re.fullmatch(r'[a-f0-9]{64}',row['sha256'])):
        fail('observation_invalid')

def observation(raw,kind,phase):
    if kind not in KINDS or phase not in ('before','pre_finalization','ready','fresh'):
        fail('observation_invalid')
    if not isinstance(raw,str) or len(raw)>32768:
        fail('observation_invalid')
    value=json.loads(raw)
    if (not isinstance(value,dict) or set(value)!={'version','kind','phase','utcNs','monotonicNs','bootId','nodes','apt'}
        or type(value['version']) is not int or value['version']!=1 or value['kind']!=kind or value['phase']!=phase
        or any(type(value[k]) is not int or value[k]<=0 for k in ('utcNs','monotonicNs'))
        or not re.fullmatch(r'[a-f0-9-]{36}',value['bootId'])):
        fail('observation_invalid')
    if not isinstance(value['nodes'],list) or len(value['nodes'])!=len(OBSERVED_PATHS[kind]):
        fail('observation_invalid')
    for row,path in zip(value['nodes'],OBSERVED_PATHS[kind]):
        if kind=='codex':
            closed_codex_root(row)
        else:
            closed_node(row,path)
    if kind=='codex':
        if value['apt'] is not None:
            fail('observation_invalid')
    else:
        apt=value['apt']
        if not isinstance(apt,dict) or set(apt)!={'units'} or not isinstance(apt['units'],dict) or set(apt['units'])!=set(UNITS):
            fail('observation_invalid')
        for unit,row in apt['units'].items():
            if row=={'status':'unsupported'}:
                continue
            fields=set(SERVICE_FIELDS) if unit.endswith('.service') else {'LastTriggerUSec'}
            if (not isinstance(row,dict) or set(row)!={'status','values'} or row['status']!='observed'
                or not isinstance(row['values'],dict) or set(row['values'])!=fields
                or any(not isinstance(v,str) or len(v)>128 or not re.fullmatch(r'[A-Za-z0-9_ .:+/()-]*',v) for v in row['values'].values())):
                fail('observation_invalid')
            if unit.endswith('.service') and (not re.fullmatch(r'[0-9]+',row['values']['MainPID'])
                or row['values']['InvocationID'] and not re.fullmatch(r'[a-f0-9]{32}',row['values']['InvocationID'])):
                fail('observation_invalid')
    return value
'''

guest_source = literal(apt, 'GUEST_PROGRAM')
guest = '''"""Only fixed Desktop APT metadata and the Codex public root CA node."""
import hashlib,json,os,re,signal,stat,subprocess,sys,time
from pathlib import Path
PATHS={'desktop':('/var/lib/apt/extended_states','/var/backups/apt.extended_states.0'),
       'codex':('/usr/local/share/ca-certificates/e2b-ca.crt',)}
PHASES=('before','pre_finalization','ready','fresh')
SERVICE_FIELDS=('ActiveState','SubState','MainPID','ExecMainStartTimestamp',
                'ExecMainExitTimestamp','InvocationID','Result')
UNITS=('apt-daily.service','apt-daily-upgrade.service','apt-daily.timer','apt-daily-upgrade.timer')

'''
guest += '\n\n'.join(segment(guest_source, name) for name in ('identity', 'node', 'command', 'systemd'))
guest += '''

def codex_root(path):
    # Preserve bounded/stable reading internally, export only the requested fields.
    fields={'path','status','kind','mode','uid','gid','sha256'}
    return {key:value for key,value in node(path).items() if key in fields}

def observe(kind,phase):
    if kind not in PATHS or phase not in PHASES:
        raise ValueError('observation_arguments_invalid')
    boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if not re.fullmatch(r'[a-f0-9-]{36}',boot):
        raise ValueError('boot_identity_invalid')
    nodes=([codex_root(Path(PATHS[kind][0]))] if kind=='codex'
           else [node(Path(path)) for path in PATHS[kind]])
    return {'version':1,'kind':kind,'phase':phase,'utcNs':time.time_ns(),
            'monotonicNs':time.monotonic_ns(),'bootId':boot,'nodes':nodes,
            'apt':{'units':systemd()} if kind=='desktop' else None}

'''
guest += segment(guest_source, 'main') + '\n\n'
guest += guest_source[guest_source.index("if __name__=='__main__':"):]

observer = rename(old)
observer = observer.replace("SOURCE='" + SOURCE + "'", "SOURCE='" + SOURCE + "'\nCARRIER_PARENT='" + CARRIER_PARENT + "'\nGO='" + GO + "'")
observer = observer.replace("if env.get('CONTROL_GO')!='true':", "if env.get('CONTROL_GO')!=GO:")
guard = '''def checkouts(source,ops,ctx):
    if git(source,'rev-parse','HEAD')!=SOURCE:
        fail('source_mismatch')
    if git(ops,'rev-parse','HEAD')!=ctx['opsCommit']:
        fail('ops_mismatch')
    for directory in (source,ops):
        if subprocess.run(['git','diff','--quiet','HEAD','--'],cwd=directory,check=False).returncode:
            fail('source_dirty')
    if git(ops,'rev-list','--parents','-n','1','HEAD').split()!=[ctx['opsCommit'],SOURCE,CARRIER_PARENT]:
        fail('overlay_invalid')
    if set(git(ops,'diff','--name-only',SOURCE,'HEAD','--').splitlines())!=set(PATHS):
        fail('overlay_invalid')
    # The second parent preserves only closed carrier ancestry. The tree adds
    # these three regular files to SOURCE and cannot restore any old C9 entry.
    changes=git(ops,'diff','--raw','--no-abbrev',SOURCE,'HEAD','--').splitlines()
    added=[]
    for change in changes:
        metadata,separator,path=change.partition('\\t')
        fields=metadata.split()
        if (not separator or len(fields)!=5 or fields[:3]!=[':000000','100644','0'*40]
            or not re.fullmatch(r'[a-f0-9]{40}',fields[3]) or fields[4]!='A'):
            fail('overlay_invalid')
        added.append(path)
    if len(added)!=len(PATHS) or set(added)!=set(PATHS):
        fail('overlay_invalid')
    if hashlib.sha256((source/'scripts/e2b/build-template.py').read_bytes()).hexdigest()!=BUILDER_SHA:
        fail('source_mismatch')'''
observer = observer.replace(segment(observer, 'checkouts'), guard)
observer = observer.replace("KINDS=('claude','desktop','codex')", "KINDS=('desktop','codex')")
observer = observer.replace("'observation_invalid','cli_changed'", "'observation_invalid'")
start, end = observer.index('CERT_PATHS='), observer.index('def request(')
observer = observer[:start] + schema + '\n' + observer[end:]
observer = observer.replace("        baseline=cli_identity(value['observations']['before']['cli'])\n        if any(cli_identity(row['cli'])!=baseline for row in value['observations'].values()):\n            fail('cli_changed')\n", '')
observer = observer.replace("'desktopNoopSeconds':0,'buildObservationSeconds':600", "'desktopNoopSeconds':0,'modelCalls':0,'workerInstallCommands':0,'buildObservationSeconds':600")
old_guest_line = next(x for x in observer.splitlines() if x.startswith('GUEST_PROGRAM='))
observer = observer.replace(old_guest_line, "GUEST_PROGRAM=r'''" + guest + "'''")
ast.parse(observer)
ast.parse(guest)

workflow = rename(old_workflow)
workflow = workflow.replace('Issue 1506 official certificate fresh-boot control', 'Issue 1505 official Codex and Desktop path control')
workflow = workflow.replace('issue1506-official-conservation-control', 'issue1505-official-path-control')
workflow = workflow.replace("    if: github.ref == 'refs/heads/" + NEW_BRANCH + "' && github.run_attempt == 1", '    if: false')
workflow = workflow.replace('    timeout-minutes: 15', '    # Observation remains 900s; this ceiling leaves the 150s cleanup-only recheck.\n    timeout-minutes: 20')
workflow = workflow.replace("CONTROL_GO: 'true'", "CONTROL_GO: 'false'").replace('2026-11-09T13:43:39Z', 'UNBOUND').replace('2026-11-09T13:58:39Z', 'UNBOUND')
workflow = workflow.replace('Observe only official Desktop and Codex certificate nodes', 'Observe only fixed Desktop APT and Codex root CA metadata')
workflow = workflow.replace("        if: always() && steps.key.outcome == 'success'\n", "        if: always() && steps.key.outcome == 'success'\n        timeout-minutes: 3\n")
old_oidc = old_workflow[old_workflow.index('        uses: Infisical/'):old_workflow.index('      - name: Observe only')]
new_oidc = workflow[workflow.index('        uses: Infisical/'):workflow.index('      - name: Observe only')]
assert old_oidc == new_oidc

tests = old_tests
drop = {'test_real_certificate_files_then_exact_relative_absolute_chain',
        'test_certificate_chain_refuses_other_destination_and_linked_root',
        'test_closed_certificate_reference_cannot_forge_hash_path_or_chain',
        'test_original_cli_identity_keeps_bytes_permissions_and_presence'}
test_ast = ast.parse(tests)
test_class = next(x for x in test_ast.body if isinstance(x, ast.ClassDef) and x.name == 'Tests')
lines = tests.splitlines(keepends=True)
for node in sorted((x for x in test_class.body if isinstance(x, ast.FunctionDef) and x.name in drop), key=lambda x:x.lineno, reverse=True):
    del lines[node.lineno-1:node.end_lineno]
tests = rename(''.join(lines)).replace("('claude','desktop','codex')", "('desktop','codex')")
tests = tests.replace("'claude'", "'codex'").replace('-claude', '-codex').replace('fixed_111a', 'fixed_5ba')
tests = tests.replace("'CONTROL_GO':'true'", "'CONTROL_GO':control.GO")
tests = tests.replace('self.assertEqual(go,"\'true\'")', 'self.assertEqual(go,repr(control.GO))')
tests = tests.replace('test_source_guard_does_not_accept_second_parent', 'test_source_guard_rejects_unapproved_second_parent')
tests = tests.replace("return CTX['opsCommit']+' '+control.SOURCE\n", "return CTX['opsCommit']+' '+control.SOURCE+' '+control.CARRIER_PARENT\n")
tests = tests.replace("            return '\\n'.join(control.PATHS)\n", "            if args[:2]==('diff','--raw'):\n                return '\\n'.join(':000000 100644 '+'0'*40+' '+'c'*40+' A\\t'+path for path in control.PATHS)\n            return '\\n'.join(control.PATHS)\n")
tests = tests.replace("self.assertEqual(calls,[('GET','/templates/owned-codex')])", "self.assertEqual(calls,[('GET','/templates/owned-desktop')])")
observed = '''def observed(kind,phase):
    return {'version':1,'kind':kind,'phase':phase,'utcNs':1,'monotonicNs':1,
            'bootId':'00000000-1111-2222-3333-444444444444',
            'nodes':[{'path':path,'status':'absent'} for path in guest['PATHS'][kind]],
            'apt':{'units':{unit:{'status':'unsupported'} for unit in guest['UNITS']}} if kind=='desktop' else None}'''
tests = tests.replace(segment(tests, 'observed'), observed)
needle = "        workflow=HERE.parents[1]/'.github/workflows/" + NEW_NAME + ".yml'\n"
assert needle in tests
tests = tests.replace(needle, needle + "        if not workflow.exists():\n            workflow=workflow.with_name(workflow.name+'.in')\n")
tests = tests.replace('import hashlib,', 'import ast,copy,hashlib,')
extra = (ROOT / 'extra-tests.txt').read_text()
tests = tests.replace("if __name__=='__main__':", extra + "\nif __name__=='__main__':")
ast.parse(tests)

items = {'.github/workflows/' + NEW_NAME + '.yml.in': workflow,
         'scripts/ops/' + NEW_NAME + '.py': observer,
         'scripts/ops/' + NEW_NAME + '.test.py': tests}
for relative, text in items.items():
    path = BUNDLE / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)

unchanged = ('context','git','builder','save','name_for','new_ledger','validate_ledger',
             'request','assert_owned','cleanup_one','install_alarm')
assert all(segment(observer, name) == segment(rename(old), name) for name in unchanged)
diffs = []
for relative, previous in [('.github/workflows/' + NEW_NAME + '.yml.in', old_workflow),
                           ('scripts/ops/' + NEW_NAME + '.py', old),
                           ('scripts/ops/' + NEW_NAME + '.test.py', old_tests)]:
    diffs.extend(difflib.unified_diff(previous.splitlines(keepends=True), items[relative].splitlines(keepends=True),
                                    fromfile='fixed-08d/' + relative.replace(NEW_NAME, OLD_NAME).removesuffix('.in'), tofile='bundle/' + relative))
(ROOT / 'candidate.diff').write_text(''.join(diffs))
identity = {'source': SOURCE, 'tree': 'a59d2e3ff90594a2625b131ab5a403393715cf40',
            'plannedBranch': NEW_BRANCH, 'orderedParents': [SOURCE,CARRIER_PARENT], 'expectedCarrierHead': CARRIER_PARENT,
            'goForFutureBinding': GO, 'active': False, 'timePins': {'notBefore': None, 'deadline': None},
            'sourceMustBeFreshlyConfirmedByRoot': True, 'upstream': {'control': '08d822da081190364530343bf918bbcc2fbbf624',
            'aptMetadata': '1e351dcfe9a4c93430f8e67fabef5b3dc97385e0'},
            'oidcBlockUnchanged': True, 'carrierTrust': 'root-confirmed existing owned subject; no identity or trust changes',
            'unchangedGuardAndCleanupFunctions': list(unchanged), 'removedOutOfScopeTests': sorted(drop),
            'deployableFiles': list(items)}
(ROOT / 'source-bindings.json').write_text(json.dumps(identity, indent=2) + '\n')
print(json.dumps({'materialized': list(items), 'oidcBlockUnchanged': True, 'guardCleanupFunctionsPreserved': len(unchanged)}))
