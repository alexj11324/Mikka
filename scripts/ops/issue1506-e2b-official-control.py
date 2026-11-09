"""Bounded official-only targeted control for issue 1506. Not a release gate."""
import argparse,hashlib,importlib.metadata,importlib.util,json,logging,multiprocessing,os,re,signal,subprocess,sys,tempfile,time,urllib.request
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError

SOURCE='76537e4c2996f717cbd19589e1efae328028aa4a'
REPOSITORY='alexj11324/Mikka'
BRANCH='refs/heads/ops/issue1506-e2b-conservation-control-5'
APPLICATION='mikka-1506-official-control'
KINDS=('claude','desktop','codex')
ACTIVE_KINDS=('codex',)
PATHS=('.github/workflows/issue1506-e2b-official-control.yml',
       'scripts/ops/issue1506-e2b-official-control.py','scripts/ops/issue1506-e2b-official-control.test.py')
BUILDER_SHA='0adb53fbdd6cbcd61f1d1804aee3e2df1538997c0724556062f2741c5ac1cdb1'
ERROR_CODES={'identity_invalid','source_mismatch','ops_mismatch','source_dirty','overlay_invalid',
             'unbound','deadline','key_missing','sdk_mismatch','ledger_invalid','already_started',
             'template_identity_invalid','sandbox_identity_invalid','sandbox_unreturned','build_unreturned',
             'command_failed','observation_invalid','workload_invalid','workload_failed','cli_changed','cleanup_incomplete','interrupted','operation_failed'}
ERROR_TYPES={'Failure','Deadline','HTTPError','TimeoutError','TimeoutException','CommandExitException',
             'SandboxNotFoundException','NotFoundException','AuthenticationException','BuildException',
             'OSError','ValueError','RuntimeError','JSONDecodeError','KeyError','TypeError','ConnectError','ReadTimeout','ConnectTimeout'}

class Failure(Exception):
    pass

class Deadline(BaseException):
    pass

def fail(code):
    raise Failure(code)

def safe(error):
    code=error.args[0] if isinstance(error,(Failure,Deadline)) and error.args else None
    result={'code':code if code in ERROR_CODES else 'operation_failed',
            'type':type(error).__name__ if type(error).__name__ in ERROR_TYPES else 'unknown'}
    if isinstance(error,HTTPError) and type(error.code) is int:
        result['httpStatus']=error.code
    return result

def opaque(value):
    return isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}',value) and not re.match(r'(?i)(sk[-_]|gh[pousr]_|github_pat_|e2b_)',value)

def context(env):
    if (env.get('GITHUB_REPOSITORY')!=REPOSITORY or env.get('GITHUB_REF')!=BRANCH
        or not re.fullmatch(r'[a-f0-9]{40}',env.get('GITHUB_SHA',''))
        or not re.fullmatch(r'[1-9][0-9]{0,19}',env.get('GITHUB_RUN_ID',''))
        or env.get('GITHUB_RUN_ATTEMPT')!='1'):
        fail('identity_invalid')
    return {'application':APPLICATION,'repository':REPOSITORY,'ref':BRANCH,'sourceCommit':SOURCE,
            'opsCommit':env['GITHUB_SHA'],'runId':env['GITHUB_RUN_ID'],'runAttempt':env['GITHUB_RUN_ATTEMPT']}

def window(env,now=None,cleanup=False):
    if env.get('CONTROL_GO')!='true':
        fail('unbound')
    try:
        start=datetime.strptime(env['CONTROL_NOT_BEFORE'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=__import__('datetime').timezone.utc).timestamp()
        end=datetime.strptime(env['CONTROL_DEADLINE'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=__import__('datetime').timezone.utc).timestamp()
    except (KeyError,ValueError):
        fail('unbound')
    now=time.time() if now is None else now
    if not 0<end-start<=900 or now<start or (not cleanup and now>=end):
        fail('deadline')
    return end

def git(directory,*args):
    return subprocess.check_output(['git',*args],cwd=directory,text=True,stderr=subprocess.DEVNULL).strip()

def checkouts(source,ops,ctx):
    if git(source,'rev-parse','HEAD')!=SOURCE:
        fail('source_mismatch')
    if git(ops,'rev-parse','HEAD')!=ctx['opsCommit']:
        fail('ops_mismatch')
    for directory in (source,ops):
        if subprocess.run(['git','diff','--quiet','HEAD','--'],cwd=directory,check=False).returncode:
            fail('source_dirty')
    if git(ops,'rev-list','--parents','-n','1','HEAD').split()!=[ctx['opsCommit'],SOURCE]:
        fail('overlay_invalid')
    if set(git(ops,'diff','--name-only',SOURCE,'HEAD','--').splitlines())!=set(PATHS):
        fail('overlay_invalid')
    if hashlib.sha256((source/'scripts/e2b/build-template.py').read_bytes()).hexdigest()!=BUILDER_SHA:
        fail('source_mismatch')

def builder(source):
    spec=importlib.util.spec_from_file_location('fixed_builder',source/'scripts/e2b/build-template.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

def save(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix('.tmp')
    with temp.open('w') as stream:
        os.chmod(temp,0o600);json.dump(data,stream,sort_keys=True,indent=2);stream.write('\n')
    temp.replace(path)

def name_for(ctx,kind):
    if kind not in KINDS:
        fail('ledger_invalid')
    return f"mikka-1506-official-control-{ctx['runId']}-{ctx['runAttempt']}-{kind}"

def new_ledger(ctx,kind):
    return {'version':1,'identity':ctx,'kind':kind,'name':name_for(ctx,kind),
            'targetedOnly':True,'releaseAccepted':False,'policyChanged':False,
            'buildStarted':False,'templateId':None,'buildId':None,'createStarted':False,'sandboxId':None,
            'observations':{},'probe':{'status':'not_started'},'cleanup':{'status':'not_started'}}

def validate_ledger(value,ctx,kind):
    expected=new_ledger(ctx,kind)
    if not isinstance(value,dict) or set(value)!=set(expected):
        fail('ledger_invalid')
    if any(value[k]!=expected[k] for k in ('version','identity','kind','name','targetedOnly','releaseAccepted','policyChanged')):
        fail('ledger_invalid')
    for field in ('buildStarted','createStarted'):
        if type(value[field]) is not bool:
            fail('ledger_invalid')
    for field in ('templateId','buildId','sandboxId'):
        if value[field] is not None and not opaque(value[field]):
            fail('ledger_invalid')
    if (value['templateId'] is not None and not value['buildStarted']
        or value['createStarted'] and value['templateId'] is None
        or value['sandboxId'] is not None and not value['createStarted']):
        fail('ledger_invalid')
    return value

def closed_node(value,expected=None):
    base={'path','status'}
    metadata={'mode','uid','gid','device','inode','size','mtimeNs','ctimeNs','kind'}
    if not isinstance(value,dict) or value.get('path')!=expected and expected is not None:
        fail('observation_invalid')
    path=value.get('path')
    if not isinstance(path,str) or not path.startswith('/') or '..' in Path(path).parts or len(path)>4096 or any(ord(c)<32 for c in path):
        fail('observation_invalid')
    status=value.get('status')
    if status=='absent' and set(value)==base:
        return
    if status not in ('present','too_large','changed_during_read') or not base|metadata<=set(value):
        fail('observation_invalid')
    if any(type(value[k]) is not int or not 0<=value[k]<2**64 for k in metadata-{'kind'}):
        fail('observation_invalid')
    kind=value['kind']
    extra={'file':{'sha256'} if status=='present' else set(),'link':{'target'},'directory':set(),'special':{'type','rdev'}}.get(kind)
    if extra is None or set(value)!=base|metadata|extra or value['mode']>4095:
        fail('observation_invalid')
    if 'sha256' in value and not re.fullmatch(r'[a-f0-9]{64}',value['sha256']):
        fail('observation_invalid')
    if 'target' in value and (not isinstance(value['target'],str) or len(value['target'])>4096 or any(ord(c)<32 for c in value['target'])):
        fail('observation_invalid')

CERT_PATHS=('/etc/ssl/certs/1560546e.0','/etc/ssl/certs/e2b-ca.pem','/usr/local/share/ca-certificates/e2b-ca.crt')
CERT_TARGETS={CERT_PATHS[0]:'e2b-ca.pem',CERT_PATHS[1]:CERT_PATHS[2]}

def certificate_references(nodes):
    rows={row['path']:row for row in nodes}
    if len(nodes)!=3 or set(rows)!=set(CERT_PATHS):
        raise ValueError('certificate_nodes_invalid')
    for path,row in rows.items():
        if row['status']=='present':
            if row['kind']=='link':
                if path not in CERT_TARGETS or row['target']!=CERT_TARGETS[path]:
                    raise ValueError('certificate_target_invalid')
            elif row['kind']!='file':
                raise ValueError('certificate_type_invalid')
    references=[]
    for origin in CERT_PATHS[:2]:
        current=origin;chain=[]
        for _ in range(3):
            row=rows[current]
            if row['status']!='present':
                references.append({'path':origin,'status':'unresolved'})
                break
            chain.append(current)
            if row['kind']=='file':
                references.append({'path':origin,'status':'observed','chain':chain,
                                   'terminalPath':current,'terminalSha256':row['sha256']})
                break
            current=CERT_PATHS[1] if current==CERT_PATHS[0] else CERT_PATHS[2]
        else:
            raise ValueError('certificate_chain_invalid')
    return references

def closed_cli(cli):
    if cli=={'status':'absent'}:
        return
    if not isinstance(cli,dict) or set(cli)!={'status','discovered','canonical'} or cli['status']!='observed':
        fail('observation_invalid')
    for key in ('discovered','canonical'):
        closed_node(cli[key])
        if Path(cli[key]['path']).is_relative_to('/opt/mikka'):
            fail('observation_invalid')
    if cli['canonical'].get('kind')!='file' or cli['canonical'].get('status')!='present':
        fail('observation_invalid')

def cli_identity(value):
    if value=={'status':'absent'}:
        return value
    if isinstance(value,dict) and set(value)=={'claude','codex'}:
        return {name:cli_identity(row) for name,row in value.items()}
    fields={'path','status','kind','mode','uid','gid','sha256','target','type','rdev'}
    return {'status':value['status'],**{name:{k:v for k,v in value[name].items() if k in fields}
                                      for name in ('discovered','canonical')}}


WORKLOAD_READER_SHA='6191212b14205c7cb8043efcfb85eaff05670f8cb65c4c801052cf9d3a28babe'
WORKLOAD_FILES=('/opt/mikka/official-files-before.json','/opt/mikka/original-cli.json','/opt/mikka/official-files-conservation.json')

def workload_source(source):
    path=source/'scripts/e2b/official-files.py'
    if hashlib.sha256(path.read_bytes()).hexdigest()!=WORKLOAD_READER_SHA:
        fail('source_mismatch')
    return path

def closed_workload(value):
    if not isinstance(value,dict) or set(value)!={'capture','strict','files','manifestTargets','manifestError'}:
        fail('observation_invalid')
    def error(row):
        names={'TimeoutExpired','FileNotFoundError','PermissionError','OSError','ValueError','JSONDecodeError','RuntimeError','unknown','ReaderExit','CaptureFailed'}
        if row is not None and (not isinstance(row,dict) or set(row)!={'type','causeType'} or row['type'] not in names or row['causeType'] is not None and row['causeType'] not in names):
            fail('observation_invalid')
    if not isinstance(value['files'],list) or len(value['files'])!=3:
        fail('observation_invalid')
    for row,path in zip(value['files'],WORKLOAD_FILES):
        closed_node(row,path)
    error(value['manifestError'])
    targets=value['manifestTargets']
    if targets is not None:
        if not isinstance(targets,list) or len(targets)!=3:
            fail('observation_invalid')
        for row,path in zip(targets,CERT_PATHS):
            if not isinstance(row,dict) or set(row)!={'path','entry'} or row['path']!=path:
                fail('observation_invalid')
            entry=row['entry']
            if entry is not None:
                if not isinstance(entry,dict) or entry.get('path')!=path or entry.get('kind') not in ('file','link','directory','special'):
                    fail('observation_invalid')
                allowed={'path','kind','mode','uid','gid'}|({'sha256'} if entry['kind']=='file' else {'target'} if entry['kind']=='link' else {'type','device'} if entry['kind']=='special' else set())
                if set(entry)!=allowed or any(type(entry[k]) is not int or entry[k]<0 for k in ('mode','uid','gid')):
                    fail('observation_invalid')
                if entry['kind']=='file' and not re.fullmatch(r'[a-f0-9]{64}',entry['sha256']):
                    fail('observation_invalid')
                if entry['kind']=='link' and (not isinstance(entry['target'],str) or len(entry['target'])>4096 or any(ord(c)<32 for c in entry['target'])):
                    fail('observation_invalid')
    for stage in ('capture','strict'):
        row=value[stage]
        if row is None:
            continue
        if (not isinstance(row,dict) or set(row)!={'stage','status','exitCode','startedUtcNs','finishedUtcNs','durationNs','error','manifestBefore','manifestAfter','stdout','stderr'}
            or row['stage']!=stage or row['status'] not in ('completed','failed','skipped')
            or row['exitCode'] is not None and type(row['exitCode']) is not int
            or any(type(row[k]) is not int or row[k]<0 for k in ('startedUtcNs','finishedUtcNs','durationNs'))):
            fail('observation_invalid')
        if row['status']=='completed' and (row['exitCode']!=0 or row['error'] is not None):
            fail('observation_invalid')
        error(row['error'])
        closed_node(row['manifestBefore'],WORKLOAD_FILES[0]);closed_node(row['manifestAfter'],WORKLOAD_FILES[0])
        closed_node(row['stdout'],'/opt/mikka/'+stage+'-stdout');closed_node(row['stderr'],'/opt/mikka/'+stage+'-stderr')
    return value

def bind_workload(source,observations,raw_files):
    result={'status':'failed','error':None,'rawFiles':{},'manifestReceipt':None,'manifestTargets':None,'strictReceipt':None}
    try:
        for phase in ('before','after_capture','pre_finalization','ready','fresh'):
            closed_workload(observations[phase]['workload'])
        current=observations['fresh']['workload']
        for index,name in enumerate(('manifest','cliManifest','strictReceipt')):
            raw=raw_files.get(name)
            if raw is None:
                fail('workload_invalid')
            data=raw.encode()
            metadata=current['files'][index]
            if metadata.get('kind')!='file' or metadata.get('status')!='present' or len(data)!=metadata['size'] or hashlib.sha256(data).hexdigest()!=metadata.get('sha256'):
                fail('workload_invalid')
            result['rawFiles'][name]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        manifest=json.loads(raw_files['manifest'])
        if manifest.get('version')!=1 or manifest.get('roots')!=['/'] or not isinstance(manifest.get('entries'),list) or not manifest['entries']:
            fail('workload_invalid')
        rows={row['path']:row for row in manifest['entries']}
        if len(rows)!=len(manifest['entries']):
            fail('workload_invalid')
        spec=importlib.util.spec_from_file_location('capture_reader',workload_source(source))
        reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
        canonical=reader.receipt(manifest['entries'])
        targets=[{'path':path,'entry':rows.get(path)} for path in CERT_PATHS]
        result['manifestReceipt']=canonical;result['manifestTargets']=targets
        reader.validate_cli_manifest(json.loads(raw_files['cliManifest']),'codex',complete=False)
        strict=json.loads(raw_files['strictReceipt']);result['strictReceipt']=strict
        if not isinstance(strict,dict) or set(strict)!={'before','after'} or strict['before']!=canonical or strict['after']!=canonical:
            fail('workload_invalid')
        def identity(node):
            return {key:node.get(key) for key in ('status','kind','size','sha256')}
        initial=observations['after_capture']['workload']
        for phase in ('after_capture','pre_finalization','ready','fresh'):
            phase_value=observations[phase]['workload']
            if phase_value['manifestError'] is not None or phase_value['manifestTargets']!=targets:
                fail('workload_invalid')
            if any(identity(phase_value['files'][i])!=identity(initial['files'][i]) for i in (0,1)):
                fail('workload_invalid')
        for phase in ('pre_finalization','ready','fresh'):
            phase_value=observations[phase]['workload']
            for stage in ('capture','strict'):
                if phase_value[stage] is None or phase_value[stage]['status']!='completed' or phase_value[stage]['exitCode']!=0:
                    fail('workload_failed')
            if identity(phase_value['files'][2])!=identity(current['files'][2]):
                fail('workload_invalid')
            for key in ('manifestBefore','manifestAfter'):
                if identity(phase_value['strict'][key])!=identity(initial['files'][0]):
                    fail('workload_invalid')
        result['status']='complete'
    except Exception as error:
        result['error']={**safe(error),'causeType':safe(error.__cause__)['type'] if error.__cause__ is not None else None}
    return result

def collect_workload(source,instance,path,observations):
    names=('manifest','cliManifest','strictReceipt')
    raw_files={}
    for index,name in enumerate(names):
        metadata=observations['fresh']['workload']['files'][index]
        if metadata.get('status')=='absent':
            raw_files[name]=None;continue
        maximum=67108864 if index==0 else 1048576
        if metadata.get('status')!='present' or metadata.get('kind')!='file' or metadata['size']>maximum:
            fail('workload_invalid')
        raw=instance.files.read(WORKLOAD_FILES[index],user='root',request_timeout=10)
        if not isinstance(raw,str) or len(raw.encode())>maximum:
            fail('workload_invalid')
        raw_files[name]=raw
        with (path.parent/('codex-'+Path(WORKLOAD_FILES[index]).name)).open('xb') as output:
            output.write(raw.encode())
    raw_logs={}
    for stage in ('capture','strict'):
        status=observations['fresh']['workload'][stage]
        for stream in ('stdout','stderr'):
            key=stage+'.'+stream
            metadata=status[stream] if status is not None else {'status':'absent'}
            if metadata.get('status')=='absent':
                raw_logs[key]={'status':'absent'};continue
            expected='/opt/mikka/'+stage+'-'+stream
            if metadata.get('path')!=expected or metadata.get('status')!='present' or metadata.get('kind')!='file' or metadata['size']>1048576:
                fail('workload_invalid')
            raw=instance.files.read(expected,user='root',request_timeout=10)
            if not isinstance(raw,str) or len(raw.encode())>1048576:
                fail('workload_invalid')
            data=raw.encode();digest=hashlib.sha256(data).hexdigest()
            with (path.parent/('codex-'+stage+'-'+stream)).open('xb') as output:
                output.write(data)
            raw_logs[key]={'status':'preserved','bytes':len(data),'sha256':digest,
                           'matchesObserved':len(data)==metadata['size'] and digest==metadata['sha256']}
    binding=bind_workload(source,observations,raw_files)
    binding['rawLogs']=raw_logs
    if any(row.get('matchesObserved') is False for row in raw_logs.values()):
        binding['status']='failed'
        binding['error']={'code':'workload_invalid','type':'Failure','causeType':None}
    save(path.parent/'codex-workload-binding.json',binding)
    if binding['status']!='complete':
        fail('workload_failed')
    return binding

def observation(raw,kind,phase):
    if kind not in KINDS or phase not in ('before','after_capture','pre_finalization','ready','fresh'):
        fail('observation_invalid')
    if not isinstance(raw,str) or len(raw)>32768:
        fail('observation_invalid')
    value=json.loads(raw)
    if (not isinstance(value,dict) or set(value)!={'version','kind','phase','utcNs','monotonicNs','bootId','nodes','cli','apt','certificates','workload'}
        or value['version']!=1 or value['kind']!=kind or value['phase']!=phase
        or any(type(value[k]) is not int or value[k]<=0 for k in ('utcNs','monotonicNs'))
        or not re.fullmatch(r'[a-f0-9-]{36}',value['bootId'])):
        fail('observation_invalid')
    target=('/usr/local/share/e2b','/usr/local/share/e2b/ssl-certs.tar') if kind=='claude' else CERT_PATHS
    if not isinstance(value['nodes'],list) or len(value['nodes'])!=len(target):
        fail('observation_invalid')
    for row,path in zip(value['nodes'],target):
        closed_node(row,path)
    if value['apt'] is not None:
        fail('observation_invalid')
    if kind=='claude':
        if value['certificates']!=[]:
            fail('observation_invalid')
        closed_cli(value['cli'])
    else:
        if not isinstance(value['cli'],dict) or set(value['cli'])!={'claude','codex'}:
            fail('observation_invalid')
        for cli in value['cli'].values():
            closed_cli(cli)
        try:
            expected=certificate_references(value['nodes'])
        except (ValueError,KeyError,TypeError):
            fail('observation_invalid')
        if value['certificates']!=expected:
            fail('observation_invalid')
    if kind=='codex':
        closed_workload(value['workload'])
    elif value['workload'] is not None:
        fail('observation_invalid')
    return value

def request(method,path,key,body=None):
    # Same API and alias-safe fixed builder cleanup; tighter per-request deadline.
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request('https://api.e2b.app'+path,data=data,method=method,
        headers={'X-API-Key':key,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=10) as response:
        raw=response.read(1048577)
        if len(raw)>1048576:
            fail('template_identity_invalid')
        return json.loads(raw) if raw else None

def assert_owned(info,ledger,ctx):
    if (getattr(info,'sandbox_id',None)!=ledger['sandboxId']
        or getattr(info,'template_id',None)!=ledger['templateId']
        or getattr(info,'metadata',None)!={**ctx,'kind':ledger['kind']}):
        fail('sandbox_identity_invalid')

def cleanup_one(source,key,ctx,kind,path,sdk=None):
    value=validate_ledger(json.loads(path.read_text()) if path.exists() else new_ledger(ctx,kind),ctx,kind)
    receipt={'status':'complete','sandbox':None,'templates':[],'errors':[]}
    try:
        if sdk is None:
            from e2b import Sandbox
            from e2b.exceptions import SandboxNotFoundException
        else:
            Sandbox,SandboxNotFoundException=sdk
        if value['createStarted'] and value['sandboxId'] is None:
            receipt['errors'].append({'code':'sandbox_unreturned','type':'Failure'})
        if value['sandboxId']:
            try:
                info=Sandbox.get_info(value['sandboxId'],api_key=key,request_timeout=10)
            except SandboxNotFoundException:
                pass
            else:
                assert_owned(info,value,ctx)
                Sandbox.kill(value['sandboxId'],api_key=key,request_timeout=10)
                try:
                    Sandbox.get_info(value['sandboxId'],api_key=key,request_timeout=10)
                except SandboxNotFoundException:
                    pass
                else:
                    fail('cleanup_incomplete')
            receipt['sandbox']={'id':value['sandboxId'],'absenceConfirmedById':True}
    except Exception as error:
        receipt['errors'].append(safe(error))
    # Instance failure must not skip cleanup of an in-flight private build.
    try:
        if value['buildStarted']:
            item={'name':value['name'],'kind':kind}
            if value['templateId']:
                item['templateId']=value['templateId']
            receipt['templates']=builder(source).cleanup_templates([item],key,request=request)
            for row in receipt['templates']:
                if 'error' in row and row['error'] not in ERROR_TYPES:
                    row['error']='unknown'
                if row['status'] not in ('absent','deleted'):
                    fail('cleanup_incomplete')
                if not row.get('templateId') and value['templateId'] is None:
                    # An interrupted build without a returned ID is not proven
                    # absent merely because an alias GET currently returned 404.
                    fail('build_unreturned')
    except Exception as error:
        receipt['errors'].append(safe(error))
    receipt['status']='failed' if receipt['errors'] else 'complete'
    value['cleanup']=receipt;save(path,value)
    return receipt

def install_alarm(seconds):
    def timed_out(*_):
        raise Deadline('deadline')
    signal.signal(signal.SIGALRM,timed_out)
    signal.alarm(max(1,int(seconds)))

def one(source,key,ctx,kind,path,work_end):
    install_alarm(work_end-time.time())
    value=new_ledger(ctx,kind);save(path,value)
    def build_log(entry):
        # SDK 2.62.0 emits this closed message before upload/build trigger.
        # Preserve only opaque IDs so interrupted builds remain reclaimable.
        message=getattr(entry,'message',None)
        match=re.fullmatch(r'Template created with ID: ([A-Za-z0-9_-]{1,128}), Build ID: ([A-Za-z0-9_-]{1,128})',message) if isinstance(message,str) else None
        if match:
            template_id,build_id=match.groups()
            if (not opaque(template_id) or not opaque(build_id)
                or value['templateId'] not in (None,template_id) or value['buildId'] not in (None,build_id)):
                fail('template_identity_invalid')
            value['templateId']=template_id;value['buildId']=build_id;save(path,value)
    try:
        from e2b import Template,Sandbox
        try:
            request('GET','/templates/aliases/'+value['name'],key)
        except HTTPError as error:
            if error.code!=404:
                raise
        else:
            fail('template_identity_invalid')
        with tempfile.TemporaryDirectory() as temp:
            Path(temp,'observe.py').write_text(GUEST_PROGRAM)
            Path(temp,'official-files.py').write_bytes(workload_source(source).read_bytes())
            image=(Template(file_context_path=temp).from_template(kind).set_workdir('/')
                   .run_cmd('test ! -e /opt/mikka && test ! -L /opt/mikka && mkdir -m 0755 /opt/mikka',user='root')
                   .copy('observe.py','/opt/mikka/observe.py')
                   .copy('official-files.py','/opt/mikka/official-files.py')
                   .run_cmd(f'python3 -B /opt/mikka/observe.py {kind} before',user='root'))
            image=(image.run_cmd('python3 -B /opt/mikka/observe.py codex capture_workload',user='root')
                   .run_cmd('python3 -B /opt/mikka/observe.py codex after_capture',user='root')
                   .run_cmd('python3 -B /opt/mikka/observe.py codex strict_workload',user='root')
                   .run_cmd(f'python3 -B /opt/mikka/observe.py {kind} pre_finalization',user='root')
                   .set_user('root').set_start_cmd(f'python3 -B /opt/mikka/observe.py {kind} ready && exec sleep infinity',
                                                  'test -s /opt/mikka/ready.json'))
            value['buildStarted']=True;value['probe']={'status':'running','phase':'build'};save(path,value)
            built=Template.build(image,name=value['name'],cpu_count=2,memory_mb=4096,skip_cache=True,
                                 api_key=key,on_build_logs=build_log)
            if (not opaque(built.template_id) or not opaque(built.build_id)
                or value['templateId'] not in (None,built.template_id) or value['buildId'] not in (None,built.build_id)):
                fail('template_identity_invalid')
            value['templateId']=built.template_id;value['buildId']=built.build_id;save(path,value)
        if time.time()>=work_end:
            fail('deadline')
        alias=request('GET','/templates/aliases/'+value['name'],key)
        info=request('GET','/templates/'+value['templateId'],key)
        names=(info.get('names') or [])+(info.get('aliases') or [])
        if (alias.get('templateID')!=value['templateId'] or alias.get('public') is not False
            or info.get('templateID')!=value['templateId'] or info.get('public') is not False
            or info.get('isDefault') is True
            or not any(isinstance(n,str) and re.fullmatch(r'(?:[^/]+/)?'+re.escape(value['name']),n) for n in names)):
            fail('template_identity_invalid')
        value['createStarted']=True;value['probe']['phase']='fresh_create';save(path,value)
        instance=Sandbox.create(value['templateId'],api_key=key,timeout=120,
                                metadata={**ctx,'kind':kind},request_timeout=20)
        if not opaque(instance.sandbox_id):
            fail('sandbox_identity_invalid')
        value['sandboxId']=instance.sandbox_id;save(path,value)
        assert_owned(Sandbox.get_info(instance.sandbox_id,api_key=key,request_timeout=10),value,ctx)
        for phase in ('before','after_capture','pre_finalization','ready'):
            raw=instance.files.read('/opt/mikka/'+phase+'.json',user='root',request_timeout=10)
            value['observations'][phase]=observation(raw,kind,phase);save(path,value)
        result=instance.commands.run(f'python3 -B /opt/mikka/observe.py {kind} fresh',user='root',timeout=45,request_timeout=50)
        if result.exit_code!=0:
            fail('command_failed')
        value['observations']['fresh']=observation(result.stdout,kind,'fresh')
        collect_workload(source,instance,path,value['observations'])
        baseline=cli_identity(value['observations']['before']['cli'])
        if any(cli_identity(row['cli'])!=baseline for row in value['observations'].values()):
            fail('cli_changed')
        value['probe']={'status':'observed','phase':'complete'}
    except BaseException as error:
        value['probe']={'status':'failed','error':safe(error)}
    finally:
        signal.alarm(0);save(path,value)
        # Each kind releases its own resources promptly; the parent and always
        # step recheck independently. No new observation during cleanup.
        install_alarm(120)
        try:
            cleanup_one(source,key,ctx,kind,path)
        except BaseException as error:
            value=json.loads(path.read_text())
            value['cleanup']={'status':'failed','errors':[safe(error)]};save(path,value)
        finally:
            signal.alarm(0)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=('verify','diagnose','cleanup'))
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    ctx=context(os.environ);end=window(os.environ,cleanup=args.mode=='cleanup')
    checkouts(args.source,Path(__file__).resolve().parents[2],ctx)
    workload_source(args.source)
    if args.mode=='verify':
        if end-time.time()<780:
            fail('deadline')
        print(json.dumps({'guard':'passed','source':SOURCE,'boundedSeconds':900}))
        return 0
    if importlib.metadata.version('e2b')!='2.62.0':
        fail('sdk_mismatch')
    key=os.environ.pop('E2B_API_KEY','')
    if not key:
        fail('key_missing')
    args.output.mkdir(parents=True,exist_ok=True)
    processes=[]
    failure=None
    try:
        if args.mode=='diagnose':
            work_end=min(time.time()+600,end-180)
            if work_end-time.time()<480:
                fail('deadline')
            for kind in ACTIVE_KINDS:
                path=args.output/(kind+'.json')
                if path.exists():
                    fail('already_started')
                save(path,new_ledger(ctx,kind))
                process=multiprocessing.get_context('fork').Process(target=one,args=(args.source,key,ctx,kind,path,work_end))
                process.start();processes.append(process)
            wait_end=min(work_end+120,end-60)
            for process in processes:
                process.join(max(0,wait_end-time.time()))
            if any(process.is_alive() or process.exitcode!=0 for process in processes):
                fail('deadline')
    except BaseException as error:
        failure=safe(error)
    finally:
        # Terminate clients before cleanup, preventing late create/observations.
        for process in processes:
            if process.is_alive():
                process.terminate();process.join(2)
                if process.is_alive():
                    process.kill();process.join(2)
        cleanup_end=time.time()+150 if args.mode=='cleanup' else min(time.time()+150,end)
        install_alarm(min(150,cleanup_end-time.time()))
        receipts={}
        for kind in ACTIVE_KINDS:
            try:
                if time.time()>=cleanup_end:
                    fail('deadline')
                receipts[kind]=cleanup_one(args.source,key,ctx,kind,args.output/(kind+'.json'))
            except Deadline as error:
                receipts[kind]={'status':'failed','errors':[safe(error)]}
                for pending in ACTIVE_KINDS:
                    if pending not in receipts:
                        receipts[pending]={'status':'not_attempted_deadline','errors':[safe(error)]}
                break
            except BaseException as error:
                receipts[kind]={'status':'failed','errors':[safe(error)]}
        signal.alarm(0)
        report={'version':1,'identity':ctx,'targetedOnly':True,'releaseAccepted':False,'policyChanged':False,
                'budget':{'privateTemplates':1,'freshInstances':1,'desktopNoopSeconds':0,'buildObservationSeconds':600,
                          'absoluteDeadline':os.environ['CONTROL_DEADLINE'],'overallSeconds':900,'cleanupOnlyMaxSeconds':150,
                          'afterObservationDeadlineCleanup':args.mode=='cleanup' and time.time()>=end},
                'failure':failure,'cleanup':receipts}
        save(args.output/'summary.json',report)
        print(json.dumps({'type':'issue1506_official_targeted_control','failure':failure,'cleanup':receipts},sort_keys=True),flush=True)
    complete=all(r['status']=='complete' for r in receipts.values())
    if args.mode=='diagnose':
        complete=complete and all(json.loads((args.output/(k+'.json')).read_text())['probe']['status']=='observed' for k in ACTIVE_KINDS)
    return 0 if complete and failure is None else 1


GUEST_PROGRAM='"""Targeted read-only metadata, never full conservation acceptance."""\nimport hashlib,json,os,re,shutil,signal,stat,subprocess,sys,time\nfrom pathlib import Path\n\nCERT_PATHS=(\'/etc/ssl/certs/1560546e.0\',\'/etc/ssl/certs/e2b-ca.pem\',\'/usr/local/share/ca-certificates/e2b-ca.crt\')\nCERT_TARGETS={CERT_PATHS[0]:\'e2b-ca.pem\',CERT_PATHS[1]:CERT_PATHS[2]}\n\ndef certificate_references(nodes):\n    rows={row[\'path\']:row for row in nodes}\n    if len(nodes)!=3 or set(rows)!=set(CERT_PATHS):\n        raise ValueError(\'certificate_nodes_invalid\')\n    for path,row in rows.items():\n        if row[\'status\']==\'present\':\n            if row[\'kind\']==\'link\':\n                if path not in CERT_TARGETS or row[\'target\']!=CERT_TARGETS[path]:\n                    raise ValueError(\'certificate_target_invalid\')\n            elif row[\'kind\']!=\'file\':\n                raise ValueError(\'certificate_type_invalid\')\n    references=[]\n    for origin in CERT_PATHS[:2]:\n        current=origin;chain=[]\n        for _ in range(3):\n            row=rows[current]\n            if row[\'status\']!=\'present\':\n                references.append({\'path\':origin,\'status\':\'unresolved\'})\n                break\n            chain.append(current)\n            if row[\'kind\']==\'file\':\n                references.append({\'path\':origin,\'status\':\'observed\',\'chain\':chain,\n                                   \'terminalPath\':current,\'terminalSha256\':row[\'sha256\']})\n                break\n            current=CERT_PATHS[1] if current==CERT_PATHS[0] else CERT_PATHS[2]\n        else:\n            raise ValueError(\'certificate_chain_invalid\')\n    return references\n\nPATHS = {\n    \'claude\': (\'/usr/local/share/e2b\', \'/usr/local/share/e2b/ssl-certs.tar\'),\n    \'desktop\': CERT_PATHS,\n    \'codex\': CERT_PATHS,\n}\nPHASES = (\'before\', \'after_capture\', \'pre_finalization\', \'ready\', \'fresh\')\nSERVICE_FIELDS = (\'ActiveState\',\'SubState\',\'MainPID\',\'ExecMainStartTimestamp\',\n                  \'ExecMainExitTimestamp\',\'InvocationID\',\'Result\')\nUNITS = (\'apt-daily.service\',\'apt-daily-upgrade.service\',\'apt-daily.timer\',\'apt-daily-upgrade.timer\')\n\ndef identity(s):\n    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_size,s.st_mtime_ns,s.st_ctime_ns)\n\ndef node(path):\n    # Same path/kind/mode/uid/gid/hash semantics as official-files.entry,\n    # plus O_NOFOLLOW and stable identity around each bounded file read.\n    value = {\'path\': str(path)}\n    try:\n        before = path.lstat()\n    except FileNotFoundError:\n        return {**value, \'status\':\'absent\'}\n    value.update(status=\'present\',mode=stat.S_IMODE(before.st_mode),uid=before.st_uid,gid=before.st_gid,\n                 device=before.st_dev,inode=before.st_ino,size=before.st_size,\n                 mtimeNs=before.st_mtime_ns,ctimeNs=before.st_ctime_ns)\n    if stat.S_ISLNK(before.st_mode):\n        target = os.readlink(path)\n        if len(target)>4096 or any(ord(c)<32 for c in target):\n            raise ValueError(\'link_metadata_invalid\')\n        value.update(kind=\'link\',target=target)\n    elif stat.S_ISDIR(before.st_mode):\n        value[\'kind\']=\'directory\'\n    elif stat.S_ISREG(before.st_mode):\n        value[\'kind\']=\'file\'\n        if before.st_size>536870912:\n            return {**value,\'status\':\'too_large\'}\n        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)\n        try:\n            opened=os.fstat(fd)\n            if not stat.S_ISREG(opened.st_mode) or identity(opened)!=identity(before):\n                return {**value,\'status\':\'changed_during_read\'}\n            digest=hashlib.sha256()\n            with os.fdopen(fd,\'rb\',closefd=False) as stream:\n                for block in iter(lambda:stream.read(1048576),b\'\'):\n                    digest.update(block)\n            if identity(os.fstat(fd))!=identity(before) or identity(path.lstat())!=identity(before):\n                return {**value,\'status\':\'changed_during_read\'}\n            value[\'sha256\']=digest.hexdigest()\n        finally:\n            os.close(fd)\n    else:\n        value.update(kind=\'special\',type=stat.S_IFMT(before.st_mode),rdev=before.st_rdev)\n    return value\n\ndef command(argv):\n    try:\n        result=subprocess.run(argv,capture_output=True,text=True,timeout=3,check=False,\n                              env={\'PATH\':\'/usr/sbin:/usr/bin:/sbin:/bin\',\'LC_ALL\':\'C\',\'TZ\':\'UTC\'})\n        if result.returncode or len(result.stdout)>8192:\n            return None\n        return result.stdout.strip()\n    except (OSError,subprocess.TimeoutExpired):\n        return None\n\ndef systemd():\n    rows={}\n    for unit in UNITS:\n        fields=SERVICE_FIELDS if unit.endswith(\'.service\') else (\'LastTriggerUSec\',)\n        raw=command([\'systemctl\',\'show\',unit,\'--no-pager\',*[f\'--property={f}\' for f in fields]])\n        values={}\n        if raw is not None:\n            for line in raw.splitlines():\n                key,sep,value=line.partition(\'=\')\n                if not sep or key not in fields or key in values:\n                    values={};break\n                if len(value)>128 or not re.fullmatch(r\'[A-Za-z0-9_ .:+/()-]*\',value):\n                    values={};break\n                if key==\'MainPID\' and not re.fullmatch(r\'[0-9]+\',value):\n                    values={};break\n                if key==\'InvocationID\' and value and not re.fullmatch(r\'[a-f0-9]{32}\',value):\n                    values={};break\n                values[key]=value\n        rows[unit]={\'status\':\'observed\',\'values\':values} if set(values)==set(fields) else {\'status\':\'unsupported\'}\n    return rows\n\ndef cli(name=\'claude\'):\n    search=[p for p in os.environ.get(\'PATH\',\'\').split(os.pathsep)\n            if p.startswith(\'/\') and not Path(p).is_relative_to(\'/opt/mikka\')]\n    search.append(\'/home/user/.local/bin\')\n    found=shutil.which(name,path=os.pathsep.join(search))\n    if not found:\n        return {\'status\':\'absent\'}\n    discovered=Path(found)\n    canonical=discovered.resolve(strict=True)\n    if canonical.is_relative_to(\'/opt/mikka\') or not canonical.is_absolute():\n        raise ValueError(\'cli_path_invalid\')\n    return {\'status\':\'observed\',\'discovered\':node(discovered),\'canonical\':node(canonical)}\n\ndef certificate_snapshot():\n    nodes=[node(Path(path)) for path in CERT_PATHS]\n    references=certificate_references(nodes)\n    for reference in references:\n        if reference[\'status\']==\'observed\' and str(Path(reference[\'path\']).resolve(strict=True))!=reference[\'terminalPath\']:\n            raise ValueError(\'certificate_resolution_changed\')\n    # Recheck the same three bounded paths after resolution; never hash an\n    # arbitrary link destination or print certificate contents.\n    if [node(Path(path)) for path in CERT_PATHS]!=nodes:\n        raise ValueError(\'certificate_snapshot_changed\')\n    return nodes,references\n\n\nWORKLOAD_FILES = (\n    \'/opt/mikka/official-files-before.json\',\n    \'/opt/mikka/original-cli.json\',\n    \'/opt/mikka/official-files-conservation.json\',\n)\nWORKLOAD_READER_SHA = \'6191212b14205c7cb8043efcfb85eaff05670f8cb65c4c801052cf9d3a28babe\'\nWORKLOAD_READER = \'/opt/mikka/official-files.py\'\nWORKLOAD_STAGE_SECONDS = 240\n\ndef workload_error(error):\n    names={\'TimeoutExpired\',\'FileNotFoundError\',\'PermissionError\',\'OSError\',\'ValueError\',\'JSONDecodeError\',\'RuntimeError\'}\n    return {\'type\':type(error).__name__ if type(error).__name__ in names else \'unknown\',\n            \'causeType\':type(error.__cause__).__name__ if error.__cause__ is not None and type(error.__cause__).__name__ in names else None}\n\ndef workload_argv(stage):\n    if stage==\'capture\':\n        return [\'python3\',WORKLOAD_READER,\'capture\',WORKLOAD_FILES[0],\'--kind\',\'codex\',\'--cli-manifest\',WORKLOAD_FILES[1]]\n    if stage==\'strict\':\n        return [\'python3\',WORKLOAD_READER,\'verify\',WORKLOAD_FILES[0],\'--receipt\',WORKLOAD_FILES[2]]\n    raise ValueError(\'workload_stage_invalid\')\n\ndef run_workload(stage):\n    argv=workload_argv(stage)\n    directory=Path(WORKLOAD_FILES[0]).parent\n    status_path=directory/(stage+\'-status.json\')\n    if status_path.exists() or status_path.is_symlink():\n        raise ValueError(\'workload_already_attempted\')\n    status={\'stage\':stage,\'status\':\'failed\',\'exitCode\':None,\'startedUtcNs\':time.time_ns(),\n            \'finishedUtcNs\':None,\'durationNs\':None,\'error\':None,\n            \'manifestBefore\':node(Path(WORKLOAD_FILES[0])),\'manifestAfter\':None}\n    began=time.monotonic_ns()\n    try:\n        if hashlib.sha256(Path(WORKLOAD_READER).read_bytes()).hexdigest()!=WORKLOAD_READER_SHA:\n            raise ValueError(\'workload_reader_changed\')\n        if stage==\'strict\':\n            capture=json.loads((directory/\'capture-status.json\').read_text())\n            if capture.get(\'status\')!=\'completed\' or capture.get(\'exitCode\')!=0:\n                status[\'status\']=\'skipped\'\n                status[\'error\']={\'type\':\'CaptureFailed\',\'causeType\':None}\n                return\n        # Original builder argv, once. Output remains private; only metadata is\n        # returned. A nonzero reader exit is recorded, never promoted to success.\n        with (directory/(stage+\'-stdout\')).open(\'xb\') as stdout, (directory/(stage+\'-stderr\')).open(\'xb\') as stderr:\n            completed=subprocess.run(argv,stdout=stdout,stderr=stderr,timeout=WORKLOAD_STAGE_SECONDS,check=False)\n        status[\'exitCode\']=completed.returncode\n        status[\'status\']=\'completed\' if completed.returncode==0 else \'failed\'\n        if completed.returncode:\n            status[\'error\']={\'type\':\'ReaderExit\',\'causeType\':None}\n    except Exception as error:\n        status[\'error\']=workload_error(error)\n    finally:\n        status[\'finishedUtcNs\']=time.time_ns()\n        status[\'durationNs\']=time.monotonic_ns()-began\n        status[\'manifestAfter\']=node(Path(WORKLOAD_FILES[0]))\n        status[\'stdout\']=node(directory/(stage+\'-stdout\'))\n        status[\'stderr\']=node(directory/(stage+\'-stderr\'))\n        with status_path.open(\'x\') as handle:\n            json.dump(status,handle,separators=(\',\',\':\'))\n\ndef workload_snapshot():\n    directory=Path(WORKLOAD_FILES[0]).parent\n    result={\'capture\':None,\'strict\':None,\'files\':[node(Path(path)) for path in WORKLOAD_FILES],\n            \'manifestTargets\':None,\'manifestError\':None}\n    for stage in (\'capture\',\'strict\'):\n        path=directory/(stage+\'-status.json\')\n        if path.exists():\n            result[stage]=json.loads(path.read_text())\n    if result[\'files\'][0][\'status\']==\'present\':\n        try:\n            if result[\'files\'][0][\'size\']>67108864:\n                raise ValueError(\'manifest_too_large\')\n            raw=Path(WORKLOAD_FILES[0]).read_bytes()\n            if len(raw)>67108864:\n                raise ValueError(\'manifest_too_large\')\n            manifest=json.loads(raw)\n            if manifest.get(\'version\')!=1 or manifest.get(\'roots\')!=[\'/\'] or not isinstance(manifest.get(\'entries\'),list):\n                raise ValueError(\'manifest_invalid\')\n            rows={row[\'path\']:row for row in manifest[\'entries\']}\n            if len(rows)!=len(manifest[\'entries\']):\n                raise ValueError(\'manifest_duplicate\')\n            result[\'manifestTargets\']=[{\'path\':path,\'entry\':rows.get(path)} for path in CERT_PATHS]\n            if node(Path(WORKLOAD_FILES[0]))!=result[\'files\'][0]:\n                raise ValueError(\'manifest_changed_during_read\')\n        except Exception as error:\n            result[\'manifestTargets\']=None\n            result[\'manifestError\']=workload_error(error)\n    return result\n\ndef observe(kind,phase):\n    boot=Path(\'/proc/sys/kernel/random/boot_id\').read_text().strip()\n    if not re.fullmatch(r\'[a-f0-9-]{36}\',boot):\n        raise ValueError(\'boot_identity_invalid\')\n    result={\'version\':1,\'kind\':kind,\'phase\':phase,\'utcNs\':time.time_ns(),\n            \'monotonicNs\':time.monotonic_ns(),\'bootId\':boot,\n            \'nodes\':[],\'cli\':None,\'apt\':None,\'certificates\':[]}\n    if kind==\'claude\':\n        result[\'nodes\']=[node(Path(p)) for p in PATHS[kind]]\n        result[\'cli\']=cli()\n    else:\n        result[\'nodes\'],result[\'certificates\']=certificate_snapshot()\n        result[\'cli\']={name:cli(name) for name in (\'claude\',\'codex\')}\n    result[\'workload\']=workload_snapshot() if kind==\'codex\' else None\n    return result\n\ndef main():\n    kind,phase=sys.argv[1:]\n    if kind==\'codex\' and phase in (\'capture_workload\',\'strict_workload\'):\n        run_workload(phase.removesuffix(\'_workload\'))\n        return\n    if kind not in PATHS or phase not in PHASES:\n        raise ValueError(\'observation_arguments_invalid\')\n    result=observe(kind,phase)\n    raw=json.dumps(result,separators=(\',\',\':\'))+\'\\n\'\n    if len(raw)>32768:\n        raise ValueError(\'observation_too_large\')\n    if phase==\'fresh\':\n        print(raw,end=\'\')\n    else:\n        path=Path(\'/opt/mikka\')/(phase+\'.json\')\n        with path.open(\'x\') as stream:\n            stream.write(raw)\n        path.chmod(0o444)\n\nif __name__==\'__main__\':\n    signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError()))\n    signal.alarm(250 if len(sys.argv)>2 and sys.argv[2] in (\'capture_workload\',\'strict_workload\') else 45)\n    try:\n        main()\n    except BaseException:\n        print(\'{"error":"targeted_observation_failed"}\',file=sys.stderr)\n        sys.exit(1)\n'

if __name__=='__main__':
    logging.basicConfig(level=logging.CRITICAL)
    signal.signal(signal.SIGTERM,lambda *_:fail('interrupted'))
    signal.signal(signal.SIGINT,lambda *_:fail('interrupted'))
    try:
        code=main()
    except BaseException as error:
        print(json.dumps({'type':'issue1506_official_targeted_control','error':safe(error)}),flush=True);code=1
    sys.exit(code)
