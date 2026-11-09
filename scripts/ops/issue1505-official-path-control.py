"""Bounded official-only targeted control for issue 1505. Not a release gate."""
import argparse,hashlib,importlib.metadata,importlib.util,json,logging,multiprocessing,os,re,signal,subprocess,sys,tempfile,time,urllib.request
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError

SOURCE='5ba1f9e2359ce714d83cd16fc040f2567c40a6d0'
CARRIER_PARENT='e93477fe401c70dca532784e71b76d56877b6899'
GO='root-reviewed-1505-official-path-control-20261109-v1'
REPOSITORY='alexj11324/Mikka'
BRANCH='refs/heads/ops/1505-smoke-github-readonly-20261109'
APPLICATION='mikka-1505-official-path-control'
KINDS=('desktop','codex')
ACTIVE_KINDS=('desktop','codex')
PATHS=('.github/workflows/issue1505-official-path-control.yml',
       'scripts/ops/issue1505-official-path-control.py','scripts/ops/issue1505-official-path-control.test.py')
BUILDER_SHA='0adb53fbdd6cbcd61f1d1804aee3e2df1538997c0724556062f2741c5ac1cdb1'
ERROR_CODES={'identity_invalid','source_mismatch','ops_mismatch','source_dirty','overlay_invalid',
             'unbound','deadline','key_missing','sdk_mismatch','ledger_invalid','already_started',
             'template_identity_invalid','sandbox_identity_invalid','sandbox_unreturned','build_unreturned',
             'command_failed','observation_invalid','cleanup_incomplete','interrupted','operation_failed'}
ERROR_TYPES={'Failure','Deadline','HTTPError','TimeoutError','TimeoutException','CommandExitException',
             'SandboxNotFoundException','NotFoundException','AuthenticationException','BuildException',
             'OSError','ValueError','RuntimeError','ConnectError','ReadTimeout','ConnectTimeout'}

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
    if env.get('CONTROL_GO')!=GO:
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
    if git(ops,'rev-list','--parents','-n','1','HEAD').split()!=[ctx['opsCommit'],SOURCE,CARRIER_PARENT]:
        fail('overlay_invalid')
    if set(git(ops,'diff','--name-only',SOURCE,'HEAD','--').splitlines())!=set(PATHS):
        fail('overlay_invalid')
    # The second parent preserves only closed carrier ancestry. The tree adds
    # these three regular files to SOURCE and cannot restore any old C9 entry.
    changes=git(ops,'diff','--raw','--no-abbrev',SOURCE,'HEAD','--').splitlines()
    added=[]
    for change in changes:
        metadata,separator,path=change.partition('\t')
        fields=metadata.split()
        if (not separator or len(fields)!=5 or fields[:3]!=[':000000','100644','0'*40]
            or not re.fullmatch(r'[a-f0-9]{40}',fields[3]) or fields[4]!='A'):
            fail('overlay_invalid')
        added.append(path)
    if len(added)!=len(PATHS) or set(added)!=set(PATHS):
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
    return f"mikka-1505-official-path-control-{ctx['runId']}-{ctx['runAttempt']}-{kind}"

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

OBSERVED_PATHS={'desktop':('/var/lib/apt/extended_states','/var/backups/apt.extended_states.0'),
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
            image=(Template(file_context_path=temp).from_template(kind).set_workdir('/')
                   .run_cmd('test ! -e /opt/mikka && test ! -L /opt/mikka && mkdir -m 0755 /opt/mikka',user='root')
                   .copy('observe.py','/opt/mikka/observe.py')
                   .run_cmd(f'python3 -B /opt/mikka/observe.py {kind} before',user='root'))
            image=(image.run_cmd(f'python3 -B /opt/mikka/observe.py {kind} pre_finalization',user='root')
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
        for phase in ('before','pre_finalization','ready'):
            raw=instance.files.read('/opt/mikka/'+phase+'.json',user='root',request_timeout=10)
            value['observations'][phase]=observation(raw,kind,phase);save(path,value)
        result=instance.commands.run(f'python3 -B /opt/mikka/observe.py {kind} fresh',user='root',timeout=45,request_timeout=50)
        if result.exit_code!=0:
            fail('command_failed')
        value['observations']['fresh']=observation(result.stdout,kind,'fresh')
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
                'budget':{'privateTemplates':2,'freshInstances':2,'desktopNoopSeconds':0,'modelCalls':0,'workerInstallCommands':0,'buildObservationSeconds':600,
                          'absoluteDeadline':os.environ['CONTROL_DEADLINE'],'overallSeconds':900,'cleanupOnlyMaxSeconds':150,
                          'afterObservationDeadlineCleanup':args.mode=='cleanup' and time.time()>=end},
                'failure':failure,'cleanup':receipts}
        save(args.output/'summary.json',report)
        print(json.dumps({'type':'issue1505_official_path_control','failure':failure,'cleanup':receipts},sort_keys=True),flush=True)
    complete=all(r['status']=='complete' for r in receipts.values())
    if args.mode=='diagnose':
        complete=complete and all(json.loads((args.output/(k+'.json')).read_text())['probe']['status']=='observed' for k in ACTIVE_KINDS)
    return 0 if complete and failure is None else 1


GUEST_PROGRAM=r'''"""Only fixed Desktop APT metadata and the Codex public root CA node."""
import hashlib,json,os,re,signal,stat,subprocess,sys,time
from pathlib import Path
PATHS={'desktop':('/var/lib/apt/extended_states','/var/backups/apt.extended_states.0'),
       'codex':('/usr/local/share/ca-certificates/e2b-ca.crt',)}
PHASES=('before','pre_finalization','ready','fresh')
SERVICE_FIELDS=('ActiveState','SubState','MainPID','ExecMainStartTimestamp',
                'ExecMainExitTimestamp','InvocationID','Result')
UNITS=('apt-daily.service','apt-daily-upgrade.service','apt-daily.timer','apt-daily-upgrade.timer')

def identity(s):
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def node(path):
    # Same path/kind/mode/uid/gid/hash semantics as official-files.entry,
    # plus O_NOFOLLOW and stable identity around each bounded file read.
    value = {'path': str(path)}
    try:
        before = path.lstat()
    except FileNotFoundError:
        return {**value, 'status':'absent'}
    value.update(status='present',mode=stat.S_IMODE(before.st_mode),uid=before.st_uid,gid=before.st_gid,
                 device=before.st_dev,inode=before.st_ino,size=before.st_size,
                 mtimeNs=before.st_mtime_ns,ctimeNs=before.st_ctime_ns)
    if stat.S_ISLNK(before.st_mode):
        target = os.readlink(path)
        if len(target)>4096 or any(ord(c)<32 for c in target):
            raise ValueError('link_metadata_invalid')
        value.update(kind='link',target=target)
    elif stat.S_ISDIR(before.st_mode):
        value['kind']='directory'
    elif stat.S_ISREG(before.st_mode):
        value['kind']='file'
        if before.st_size>536870912:
            return {**value,'status':'too_large'}
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            opened=os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or identity(opened)!=identity(before):
                return {**value,'status':'changed_during_read'}
            digest=hashlib.sha256()
            with os.fdopen(fd,'rb',closefd=False) as stream:
                for block in iter(lambda:stream.read(1048576),b''):
                    digest.update(block)
            if identity(os.fstat(fd))!=identity(before) or identity(path.lstat())!=identity(before):
                return {**value,'status':'changed_during_read'}
            value['sha256']=digest.hexdigest()
        finally:
            os.close(fd)
    else:
        value.update(kind='special',type=stat.S_IFMT(before.st_mode),rdev=before.st_rdev)
    return value

def command(argv):
    try:
        result=subprocess.run(argv,capture_output=True,text=True,timeout=3,check=False,
                              env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','TZ':'UTC'})
        if result.returncode or len(result.stdout)>8192:
            return None
        return result.stdout.strip()
    except (OSError,subprocess.TimeoutExpired):
        return None

def systemd():
    rows={}
    for unit in UNITS:
        fields=SERVICE_FIELDS if unit.endswith('.service') else ('LastTriggerUSec',)
        raw=command(['systemctl','show',unit,'--no-pager',*[f'--property={f}' for f in fields]])
        values={}
        if raw is not None:
            for line in raw.splitlines():
                key,sep,value=line.partition('=')
                if not sep or key not in fields or key in values:
                    values={};break
                if len(value)>128 or not re.fullmatch(r'[A-Za-z0-9_ .:+/()-]*',value):
                    values={};break
                if key=='MainPID' and not re.fullmatch(r'[0-9]+',value):
                    values={};break
                if key=='InvocationID' and value and not re.fullmatch(r'[a-f0-9]{32}',value):
                    values={};break
                values[key]=value
        rows[unit]={'status':'observed','values':values} if set(values)==set(fields) else {'status':'unsupported'}
    return rows

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

def main():
    kind,phase=sys.argv[1:]
    if kind not in PATHS or phase not in PHASES:
        raise ValueError('observation_arguments_invalid')
    result=observe(kind,phase)
    raw=json.dumps(result,separators=(',',':'))+'\n'
    if len(raw)>32768:
        raise ValueError('observation_too_large')
    if phase=='fresh':
        print(raw,end='')
    else:
        path=Path('/opt/mikka')/(phase+'.json')
        with path.open('x') as stream:
            stream.write(raw)
        path.chmod(0o444)

if __name__=='__main__':
    signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(45)
    try:
        main()
    except BaseException:
        print('{"error":"targeted_observation_failed"}',file=sys.stderr)
        sys.exit(1)
'''

if __name__=='__main__':
    logging.basicConfig(level=logging.CRITICAL)
    signal.signal(signal.SIGTERM,lambda *_:fail('interrupted'))
    signal.signal(signal.SIGINT,lambda *_:fail('interrupted'))
    try:
        code=main()
    except BaseException as error:
        print(json.dumps({'type':'issue1505_official_path_control','error':safe(error)}),flush=True);code=1
    sys.exit(code)
