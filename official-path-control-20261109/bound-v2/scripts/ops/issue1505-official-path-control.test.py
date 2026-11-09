"""Offline tests only: no SDK import, credentials, API, or resources."""
import ast,copy,hashlib,importlib.util,json,os,tempfile,time,types,unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('control',HERE/'issue1505-official-path-control.py')
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
guest={'__name__':'targeted_guest'}
exec(compile(control.GUEST_PROGRAM,'targeted_guest','exec'),guest)
SOURCE=Path(os.environ.get('CONTROL_TEST_SOURCE','source')).resolve()
ENV={'GITHUB_REPOSITORY':control.REPOSITORY,'GITHUB_REF':control.BRANCH,'GITHUB_SHA':'a'*40,
     'GITHUB_RUN_ID':'123456','GITHUB_RUN_ATTEMPT':'1','CONTROL_GO':control.GO,
     'CONTROL_NOT_BEFORE':'2026-11-09T12:00:00Z','CONTROL_DEADLINE':'2026-11-09T12:15:00Z'}
CTX=control.context(ENV)

def observed(kind,phase):
    return {'version':1,'kind':kind,'phase':phase,'utcNs':1,'monotonicNs':1,
            'bootId':'00000000-1111-2222-3333-444444444444',
            'nodes':[{'path':path,'status':'absent'} for path in guest['PATHS'][kind]],
            'apt':{'units':{unit:{'status':'unsupported'} for unit in guest['UNITS']}} if kind=='desktop' else None}

def http_error(*args,**kwargs):
    error=HTTPError(*args,**kwargs)
    error.close()
    return error

class Missing(Exception):
    pass

class Tests(unittest.TestCase):
    def test_disabled_or_unbound_refuses(self):
        for env in ({**ENV,'CONTROL_GO':'false'},{**ENV,'CONTROL_DEADLINE':'UNBOUND'}):
            with self.subTest(env=env['CONTROL_GO']),self.assertRaises(control.Failure):
                control.window(env,1794225601)

    def test_single_absolute_window(self):
        start=1794225600
        self.assertEqual(control.window(ENV,start+10),start+900)
        for now in (start-1,start+900):
            with self.subTest(now=now),self.assertRaises(control.Failure):
                control.window(ENV,now)
        with self.assertRaises(control.Failure):
            control.window({**ENV,'CONTROL_DEADLINE':'2026-11-09T12:16:00Z'},start+10)


        with patch.object(control.signal,'signal') as register,patch.object(control.signal,'alarm'):
            control.install_alarm(1)
        handler=register.call_args.args[1]
        try:
            handler()
        except BaseException as error:
            # Existing cleanup catches Exception; deadlines must escape it.
            self.assertNotIsInstance(error,Exception)
            self.assertEqual(control.safe(error)['code'],'deadline')
        else:
            self.fail('alarm must interrupt cleanup')

    def test_exact_own_identity(self):
        self.assertEqual(control.context(ENV),CTX)
        for field,value in [('GITHUB_REF','refs/heads/ops/1512-git-transport'),('GITHUB_REPOSITORY','other/repo'),('GITHUB_SHA','main'),('GITHUB_RUN_ID','../123')]:
            with self.subTest(field=field),self.assertRaises(control.Failure):
                control.context({**ENV,field:value})

    def test_only_known_run_owned_aliases(self):
        self.assertEqual(control.name_for(CTX,'codex'),'mikka-1505-official-path-control-123456-1-codex')
        with self.assertRaises(control.Failure):
            control.name_for(CTX,'ubuntu')

    def test_unknown_error_never_exposes_message(self):
        raw=control.safe(RuntimeError('secret https://signed.invalid/?token=x'))
        self.assertEqual(raw,{'type':'RuntimeError','code':'operation_failed'})
        self.assertNotIn('secret',json.dumps(raw))
        error=http_error('https://secret.invalid',403,'private',{},None)
        self.assertEqual(control.safe(error)['httpStatus'],403)
        self.assertNotIn('secret',json.dumps(control.safe(error)))

    def test_source_hash_is_actual_fixed_5ba(self):
        self.assertEqual(hashlib.sha256((SOURCE/'scripts/e2b/build-template.py').read_bytes()).hexdigest(),control.BUILDER_SHA)

    def test_six_guard_dimensions_and_exact_three_path_overlay(self):
        def fake_git(directory,*args):
            if args==('rev-parse','HEAD'):
                return control.SOURCE if directory==SOURCE else CTX['opsCommit']
            if args==('rev-list','--parents','-n','1','HEAD'):
                return CTX['opsCommit']+' '+control.SOURCE+' '+control.CARRIER_PARENT
            if args[:2]==('diff','--raw'):
                return '\n'.join(':000000 100644 '+'0'*40+' '+'c'*40+' A\t'+path for path in control.PATHS)
            return '\n'.join(control.PATHS)
        with patch.object(control,'git',side_effect=fake_git),patch.object(control.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)):
            control.checkouts(SOURCE,Path('ops'),CTX)
        def extra_path(directory,*args):
            return fake_git(directory,*args)+'\nnot-allowed.py' if args[:2]==('diff','--name-only') else fake_git(directory,*args)
        with patch.object(control,'git',side_effect=extra_path),patch.object(control.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)),self.assertRaises(control.Failure):
            control.checkouts(SOURCE,Path('ops'),CTX)

    def test_source_guard_rejects_unapproved_second_parent(self):
        def fake_git(directory,*args):
            if args==('rev-parse','HEAD'):
                return control.SOURCE if directory==SOURCE else CTX['opsCommit']
            return CTX['opsCommit']+' '+control.SOURCE+' '+'b'*40
        with patch.object(control,'git',side_effect=fake_git),patch.object(control.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)),self.assertRaises(control.Failure):
            control.checkouts(SOURCE,Path('ops'),CTX)

    def test_missing_directory_and_real_file_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);path=root/'file';path.write_bytes(b'fixture')
            self.assertEqual(guest['node'](root/'missing'),{'path':str(root/'missing'),'status':'absent'})
            self.assertEqual(guest['node'](root)['kind'],'directory')
            row=guest['node'](path)
            self.assertEqual(row['sha256'],hashlib.sha256(b'fixture').hexdigest())
            self.assertEqual(row['inode'],path.stat().st_ino)
            self.assertEqual(row['ctimeNs'],path.stat().st_ctime_ns)

    def test_symlink_is_recorded_without_hashing_target(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'link';path.symlink_to('/no/such/target')
            row=guest['node'](path)
            self.assertEqual(row['kind'],'link')
            self.assertEqual(row['target'],'/no/such/target')
            self.assertNotIn('sha256',row)

    def test_unsupported_systemd_is_explicit(self):
        with patch.dict(guest,{'command':lambda _args:None}):
            self.assertEqual(guest['systemd'](),{unit:{'status':'unsupported'} for unit in guest['UNITS']})

    def test_unknown_systemd_fields_or_secret_text_rejected(self):
        with patch.dict(guest,{'command':lambda _args:'Secret=credential'}):
            self.assertTrue(all(row=={'status':'unsupported'} for row in guest['systemd']().values()))

    def test_fixed_closed_observations(self):
        for kind in control.KINDS:
            for phase in guest['PHASES']:
                row=observed(kind,phase)
                self.assertEqual(control.observation(json.dumps(row),kind,phase),row)
        row=observed('desktop','before');row['nodes'][0]['path']='/etc/shadow'
        with self.assertRaises(control.Failure):
            control.observation(json.dumps(row),'desktop','before')

    def test_extra_payload_or_phase_rejected(self):
        row=observed('codex','before');row['secret']='forbidden'
        with self.assertRaises(control.Failure):
            control.observation(json.dumps(row),'codex','before')
        with self.assertRaises(control.Failure):
            control.observation(json.dumps(observed('codex','ready')),'codex','fresh')

    def test_foreign_or_modified_ledger_rejected(self):
        row=control.new_ledger(CTX,'codex')
        for changed in ({**row,'name':'codex'},{**row,'identity':{**CTX,'runId':'999'}},{**row,'templateId':'tmpl'}):
            with self.subTest(value=changed),self.assertRaises(control.Failure):
                control.validate_ledger(changed,CTX,'codex')

    def cleanup_fixture(self,row,request,sdk):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'claude.json';control.save(path,row)
            with patch.object(control,'request',side_effect=request):
                result=control.cleanup_one(SOURCE,'FAKE_API_KEY',CTX,'codex',path,sdk)
            return result

    def test_cleanup_recovers_exact_alias_then_deletes_exact_id(self):
        row=control.new_ledger(CTX,'codex');row['buildStarted']=True
        calls=[];deleted=False
        def request(method,path,_key,body=None):
            nonlocal deleted
            calls.append((method,path))
            if path.endswith('/aliases/'+row['name']):
                return {'templateID':'owned-id','public':False}
            if method=='DELETE':
                self.assertEqual(path,'/templates/owned-id');deleted=True;return None
            if deleted:raise http_error('',404,'',{},None)
            return {'templateID':'owned-id','public':False,'isDefault':False,'names':[row['name']]}
        result=self.cleanup_fixture(row,request,(object,Missing))
        self.assertEqual(result['status'],'complete')
        self.assertIn(('GET','/templates/aliases/'+row['name']),calls)
        self.assertNotIn(('GET','/templates/'+row['name']),calls)
        self.assertEqual([x for x in calls if x[0]=='DELETE'],[('DELETE','/templates/owned-id')])

    def test_unknown_build_id_alias_absent_is_unresolved(self):
        row=control.new_ledger(CTX,'codex');row['buildStarted']=True
        def absent(*_args,**_kwargs):raise http_error('',404,'',{},None)
        result=self.cleanup_fixture(row,absent,(object,Missing))
        self.assertEqual(result['status'],'failed')
        self.assertIn({'code':'build_unreturned','type':'Failure'},result['errors'])

    def test_public_or_foreign_template_is_not_deleted(self):
        for mutate in ({'public':True},{'templateID':'foreign'},{'names':['unrelated']}):
            row=control.new_ledger(CTX,'codex');row.update(buildStarted=True,templateId='owned-id')
            calls=[]
            def request(method,path,_key,body=None):
                calls.append((method,path))
                base={'templateID':'owned-id','public':False,'names':[row['name']]}
                return {**base,**mutate}
            result=self.cleanup_fixture(row,request,(object,Missing))
            self.assertEqual(result['status'],'failed')
            self.assertFalse(any(method=='DELETE' for method,_ in calls))

    def test_instance_failure_does_not_skip_template_cleanup(self):
        row=control.new_ledger(CTX,'codex')
        row.update(buildStarted=True,templateId='owned-id',createStarted=True,sandboxId='sandbox-id')
        class SDK:
            @staticmethod
            def get_info(*_args,**_kwargs):raise RuntimeError('secret')
        calls=[]
        def absent(method,path,*_args,**_kwargs):
            calls.append((method,path));raise http_error('',404,'',{},None)
        result=self.cleanup_fixture(row,absent,(SDK,Missing))
        self.assertEqual(result['status'],'failed')
        self.assertIn(('GET','/templates/owned-id'),calls)
        self.assertEqual(result['templates'][0]['status'],'absent')
        self.assertNotIn('secret',json.dumps(result))

    def test_foreign_sandbox_is_not_killed(self):
        row=control.new_ledger(CTX,'codex')
        row.update(buildStarted=True,templateId='owned-id',createStarted=True,sandboxId='sandbox-id')
        killed=[]
        class SDK:
            @staticmethod
            def get_info(*_args,**_kwargs):
                return types.SimpleNamespace(sandbox_id='sandbox-id',template_id='foreign',metadata={**CTX,'kind':'codex'})
            @staticmethod
            def kill(*args,**_kwargs):killed.append(args)
        def absent(*_args,**_kwargs):raise http_error('',404,'',{},None)
        result=self.cleanup_fixture(row,absent,(SDK,Missing))
        self.assertEqual(result['status'],'failed');self.assertEqual(killed,[])

    def test_two_fixed_budget_paths_no_worker_or_model(self):
        self.assertEqual(control.KINDS,('desktop','codex'))
        self.assertNotIn('E2B_API_KEY',control.GUEST_PROGRAM)
        self.assertNotIn('apt-get',control.GUEST_PROGRAM)
        self.assertNotIn('subprocess.Popen',control.GUEST_PROGRAM)
        workflow=HERE.parents[1]/'.github/workflows/issue1505-official-path-control.yml'
        if not workflow.exists():
            workflow=workflow.with_name(workflow.name+'.in')
        source=workflow.read_text()
        def field(prefix):
            values=[line[len(prefix):] for line in source.splitlines() if line.startswith(prefix)]
            self.assertEqual(len(values),1)
            return values[0]
        job_if=field('    if: ')
        go=field('      CONTROL_GO: ')
        start=field('      CONTROL_NOT_BEFORE: ')
        end=field('      CONTROL_DEADLINE: ')
        if job_if=='false':
            self.assertEqual((go,start,end),("'false'",'UNBOUND','UNBOUND'))
        else:
            self.assertEqual(job_if,"github.repository == 'alexj11324/Mikka' && github.ref == 'refs/heads/ops/1505-smoke-github-readonly-20261109' && github.run_attempt == 1")
            self.assertEqual(go,repr(control.GO))
            for stamp in (start,end):
                self.assertRegex(stamp,r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
            bound={**ENV,'CONTROL_GO':control.GO,'CONTROL_NOT_BEFORE':start,'CONTROL_DEADLINE':end}
            began=control.datetime.strptime(start,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=__import__('datetime').timezone.utc).timestamp()
            self.assertGreater(control.window(bound,now=began),began)
        self.assertIn("if: always() && steps.key.outcome == 'success'",source)
        self.assertIn('secret-name: E2B_API_KEY',source)
        self.assertNotIn('pnpm',source)
        self.assertNotIn('postgres',source)


    def test_interrupted_build_keeps_early_exact_ids_for_cleanup(self):
        class Image:
            def __init__(self,**_kwargs):pass
            def __getattr__(self,_name):return lambda *_args,**_kwargs:self
            @staticmethod
            def build(_image,**kwargs):
                kwargs['on_build_logs'](types.SimpleNamespace(message='Template created with ID: owned-id, Build ID: build-id'))
                raise TimeoutError('untrusted remote payload')
        class SDK:
            @staticmethod
            def create(*_args,**_kwargs):raise AssertionError('must not create after build interruption')
        module=types.SimpleNamespace(Template=Image,Sandbox=SDK)
        def absent(*_args,**_kwargs):raise http_error('',404,'',{},None)
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'claude.json'
            with patch.dict('sys.modules',{'e2b':module,'e2b.exceptions':types.SimpleNamespace(SandboxNotFoundException=Missing)}),patch.object(control,'request',side_effect=absent):
                control.one(SOURCE,'FAKE_API_KEY',CTX,'codex',path,time.time()+60)
            result=json.loads(path.read_text())
        self.assertEqual(result['templateId'],'owned-id')
        self.assertEqual(result['buildId'],'build-id')
        self.assertIsNone(result['sandboxId'])
        self.assertEqual(result['cleanup']['status'],'complete')
        self.assertEqual(result['cleanup']['templates'][0]['templateId'],'owned-id')
        self.assertEqual(result['probe']['status'],'failed')
        self.assertNotIn('untrusted remote payload',json.dumps(result))


    def test_cleanup_after_observation_deadline_still_validates_binding(self):
        self.assertEqual(control.window(ENV,1794225600+1000,cleanup=True),1794225600+900)
        for changed in ({**ENV,'CONTROL_GO':'false'},{**ENV,'CONTROL_DEADLINE':'UNBOUND'},
                        {**ENV,'CONTROL_DEADLINE':'2026-11-09T12:16:00Z'}):
            with self.subTest(changed=changed),self.assertRaises(control.Failure):
                control.window(changed,1794225600+1000,cleanup=True)

    def test_attempt_two_cannot_create_another_two_resources(self):
        with self.assertRaises(control.Failure):
            control.context({**ENV,'GITHUB_RUN_ATTEMPT':'2'})


    def test_alarm_escapes_real_cleanup_and_stops_next_kind(self):
        with patch.object(control.signal,'signal') as register,patch.object(control.signal,'alarm'):
            control.install_alarm(1)
        handler=register.call_args.args[1]
        calls=[]
        def alarm_request(method,path,*_args,**_kwargs):
            calls.append((method,path))
            handler()
        with tempfile.TemporaryDirectory() as temp:
            output=Path(temp)
            for kind in control.KINDS:
                ledger=control.new_ledger(CTX,kind)
                ledger.update(buildStarted=True,templateId='owned-'+kind)
                control.save(output/(kind+'.json'),ledger)
            module=types.SimpleNamespace(Sandbox=object)
            argv=['control','cleanup','--source',str(SOURCE),'--output',str(output)]
            with patch.dict(os.environ,{**ENV,'E2B_API_KEY':'FAKE_API_KEY'}),patch('sys.argv',argv), \
                 patch.dict('sys.modules',{'e2b':module,'e2b.exceptions':types.SimpleNamespace(SandboxNotFoundException=Missing)}), \
                 patch.object(control,'checkouts'),patch.object(control,'ACTIVE_KINDS',control.KINDS),patch.object(control,'window',return_value=time.time()+1000), \
                 patch.object(control.importlib.metadata,'version',return_value='2.62.0'), \
                 patch.object(control,'install_alarm'),patch.object(control,'request',side_effect=alarm_request):
                self.assertEqual(control.main(),1)
        self.assertEqual(calls,[('GET','/templates/owned-desktop')])


    def test_entry_orchestrates_only_desktop_and_codex(self):
        self.assertEqual(control.ACTIVE_KINDS,('desktop','codex'))
        spawned=[];cleaned=[]
        class Process:
            exitcode=0
            def __init__(self,*,target,args):
                self.args=args
                self.target=target
                spawned.append((target,args[3]))
            def start(self):
                source,key,ctx,kind,path,end=self.args
                row=control.new_ledger(ctx,kind)
                row['probe']={'status':'observed','phase':'complete'}
                control.save(path,row)
            def join(self,_timeout=None):pass
            def is_alive(self):return False
        def cleanup(_source,_key,_ctx,kind,_path):
            cleaned.append(kind)
            return {'status':'complete'}
        with tempfile.TemporaryDirectory() as temp:
            output=Path(temp)
            argv=['control','diagnose','--source',str(SOURCE),'--output',str(output)]
            with patch.dict(os.environ,{**ENV,'E2B_API_KEY':'FAKE_API_KEY'}),patch('sys.argv',argv), \
                 patch.object(control,'checkouts'),patch.object(control,'window',return_value=time.time()+900), \
                 patch.object(control.importlib.metadata,'version',return_value='2.62.0'), \
                 patch.object(control.multiprocessing,'get_context',return_value=types.SimpleNamespace(Process=Process)), \
                 patch.object(control,'install_alarm'),patch.object(control,'cleanup_one',side_effect=cleanup):
                self.assertEqual(control.main(),0)
            report=json.loads((output/'summary.json').read_text())
        self.assertEqual(spawned,[(control.one,'desktop'),(control.one,'codex')])
        self.assertEqual(cleaned,['desktop','codex'])
        self.assertEqual(report['budget']['privateTemplates'],2)
        self.assertEqual(report['budget']['freshInstances'],2)
        self.assertEqual(report['budget']['desktopNoopSeconds'],0)







class PathScopeTests(unittest.TestCase):
    def test_exact_ordered_parents_accept_only_source_then_closed_carrier(self):
        def fake_git(parents):
            def read(directory,*args):
                if args==('rev-parse','HEAD'):
                    return control.SOURCE if directory==SOURCE else CTX['opsCommit']
                if args==('rev-list','--parents','-n','1','HEAD'):
                    return ' '.join([CTX['opsCommit'],*parents])
                if args[:2]==('diff','--raw'):
                    return '\n'.join(':000000 100644 '+'0'*40+' '+'c'*40+' A\t'+path for path in control.PATHS)
                return '\n'.join(control.PATHS)
            return read
        expected=[control.SOURCE,control.CARRIER_PARENT]
        with patch.object(control,'git',side_effect=fake_git(expected)),patch.object(control.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)):
            control.checkouts(SOURCE,Path('ops'),CTX)
        invalid=[expected[::-1],[control.SOURCE,'b'*40],['b'*40,control.CARRIER_PARENT],
                 [control.SOURCE],[*expected,'b'*40]]
        for parents in invalid:
            with self.subTest(parents=parents),patch.object(control,'git',side_effect=fake_git(parents)), \
                 patch.object(control.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)),self.assertRaises(control.Failure):
                control.checkouts(SOURCE,Path('ops'),CTX)

    def test_overlay_adds_only_three_regular_files_without_old_carrier_tree(self):
        correct=[':000000 100644 '+'0'*40+' '+'c'*40+' A\t'+path for path in control.PATHS]
        invalid=[correct[1:],correct+[correct[0]],
                 [correct[0].replace('100644','120000'),*correct[1:]],
                 [correct[0].replace('100644','100755'),*correct[1:]],
                 [correct[0].replace(':000000',':100644').replace(' A\t',' M\t'),*correct[1:]],
                 correct+[':000000 100644 '+'0'*40+' '+'d'*40+' A\t.github/workflows/issue1505-smoke-github-readonly.yml']]
        for changes in invalid:
            def fake_git(directory,*args):
                if args==('rev-parse','HEAD'):
                    return control.SOURCE if directory==SOURCE else CTX['opsCommit']
                if args==('rev-list','--parents','-n','1','HEAD'):
                    return ' '.join([CTX['opsCommit'],control.SOURCE,control.CARRIER_PARENT])
                return '\n'.join(changes if args[:2]==('diff','--raw') else control.PATHS)
            with self.subTest(changes=changes),patch.object(control,'git',side_effect=fake_git), \
                 patch.object(control.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)),self.assertRaises(control.Failure):
                control.checkouts(SOURCE,Path('ops'),CTX)

    def test_only_this_control_go_is_accepted(self):
        self.assertEqual(control.window(ENV,1794225601),1794226500)
        for old in ('true','root-reviewed-1505-github-handoff-v3','root-reviewed-1505-github-r7-20261109-v1'):
            with self.subTest(go=old),self.assertRaises(control.Failure):
                control.window({**ENV,'CONTROL_GO':old},1794225601)

    def test_codex_actual_public_file_projection_keeps_only_requested_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'public-ca.crt';path.write_bytes(b'public certificate fixture')
            path.chmod(0o644);before=guest['codex_root'](path)
            path.chmod(0o777);after=guest['codex_root'](path)
        self.assertEqual(set(before),{'path','status','kind','mode','uid','gid','sha256'})
        self.assertEqual((before['mode'],after['mode']),(420,511))
        self.assertEqual(before['sha256'],hashlib.sha256(b'public certificate fixture').hexdigest())
        self.assertEqual(before['sha256'],after['sha256'])
        for actual in (before,after):
            fixture={**actual,'path':control.OBSERVED_PATHS['codex'][0]}
            value=observed('codex','fresh');value['nodes']=[fixture]
            self.assertEqual(control.observation(json.dumps(value),'codex','fresh'),value)

    def test_codex_absent_or_unstable_is_explicit_without_a_digest(self):
        root=control.OBSERVED_PATHS['codex'][0]
        for row in ({'path':root,'status':'absent'},
                    {'path':root,'status':'changed_during_read','kind':'file','mode':420,'uid':0,'gid':0},
                    {'path':root,'status':'too_large','kind':'file','mode':420,'uid':0,'gid':0}):
            value=observed('codex','before');value['nodes']=[row]
            self.assertEqual(control.observation(json.dumps(value),'codex','before'),value)
            self.assertNotIn('sha256',row)

    def test_closed_kind_path_and_schema_reject_other_targets_and_cli_payload(self):
        for kind in control.KINDS:
            changes=[lambda x:x.update(cli={}),lambda x:x.update(certificates=[]),
                     lambda x:x['nodes'][0].update(path='/etc/shadow'),
                     lambda x:x['nodes'].append(copy.deepcopy(x['nodes'][0])),
                     lambda x:x.update(version=True)]
            for change in changes:
                value=observed(kind,'fresh');change(value)
                with self.subTest(kind=kind,change=change),self.assertRaises(control.Failure):
                    control.observation(json.dumps(value),kind,'fresh')
        for kind in ('claude','ubuntu'):
            with self.subTest(kind=kind),self.assertRaises(control.Failure):
                control.observation(json.dumps(observed('codex','before')),kind,'before')
        value=observed('codex','before');value['apt']={'units':{}}
        with self.assertRaises(control.Failure):control.observation(json.dumps(value),'codex','before')

    def test_desktop_real_backup_file_and_absence_preserve_closed_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'backup';path.write_bytes(b'Package: public-fixture\nAuto-Installed: 1\n')
            before=guest['node'](path);path.unlink();after=guest['node'](path)
        target=control.OBSERVED_PATHS['desktop'][1]
        self.assertEqual(before['kind'],'file');self.assertEqual(after['status'],'absent')
        for sample in (before,after):
            value=observed('desktop','fresh');value['nodes'][1]={**sample,'path':target}
            self.assertEqual(control.observation(json.dumps(value),'desktop','fresh'),value)

    def test_systemd_exact_four_units_and_closed_properties_only(self):
        calls=[]
        def command(argv):
            calls.append(argv)
            fields=guest['SERVICE_FIELDS'] if argv[2].endswith('.service') else ('LastTriggerUSec',)
            values={'ActiveState':'inactive','SubState':'dead','MainPID':'0',
                    'ExecMainStartTimestamp':'','ExecMainExitTimestamp':'','InvocationID':'','Result':'success','LastTriggerUSec':''}
            return '\n'.join(key+'='+values[key] for key in fields)
        with patch.dict(guest,{'command':command}):units=guest['systemd']()
        self.assertEqual(len(calls),4)
        self.assertEqual([argv[2] for argv in calls],list(guest['UNITS']))
        for argv in calls:
            fields=guest['SERVICE_FIELDS'] if argv[2].endswith('.service') else ('LastTriggerUSec',)
            self.assertEqual(argv,['systemctl','show',argv[2],'--no-pager',*[f'--property={field}' for field in fields]])
        value=observed('desktop','fresh');value['apt']={'units':units}
        self.assertEqual(control.observation(json.dumps(value),'desktop','fresh'),value)
        for field,bad in [('MainPID','not-a-pid'),('InvocationID','not-an-id'),('Result','private\ntext')]:
            malformed=copy.deepcopy(value);malformed['apt']['units']['apt-daily.service']['values'][field]=bad
            with self.subTest(field=field),self.assertRaises(control.Failure):
                control.observation(json.dumps(malformed),'desktop','fresh')

    def test_guest_observes_only_fixed_paths_without_cli_or_apt_commands(self):
        calls=[]
        class FixedPath:
            def __init__(self,value):self.value=str(value)
            def __str__(self):return self.value
            def read_text(self):
                self.asserted=self.value
                if self.value!='/proc/sys/kernel/random/boot_id':raise AssertionError('unexpected read')
                return '00000000-1111-2222-3333-444444444444'
        def node(path):
            calls.append(str(path));return {'path':str(path),'status':'absent'}
        units={unit:{'status':'unsupported'} for unit in guest['UNITS']}
        with patch.dict(guest,{'Path':FixedPath,'node':node,'systemd':lambda:units}):
            for kind in control.KINDS:
                for phase in guest['PHASES']:
                    calls.clear();value=guest['observe'](kind,phase)
                    self.assertEqual(calls,list(control.OBSERVED_PATHS[kind]))
                    self.assertEqual(control.observation(json.dumps(value),kind,phase),value)
        parsed=ast.parse(control.GUEST_PROGRAM)
        functions={node.name for node in parsed.body if isinstance(node,ast.FunctionDef)}
        self.assertNotIn('cli',functions);self.assertNotIn('certificate_snapshot',functions)
        for forbidden in ('apt-get','dpkg-query','time.sleep','os.walk','flock','systemctl stop','systemctl disable','E2B_API_KEY','os.environ','shutil'):
            self.assertNotIn(forbidden,control.GUEST_PROGRAM)

    def test_one_uses_only_observer_commands_and_one_fresh_instance_per_kind(self):
        for kind in control.KINDS:
            with self.subTest(kind=kind):
                steps=[];state={'built':False,'killed':False,'deleted':False,'creates':0}
                class Image:
                    def __init__(self,**_kwargs):pass
                    def __getattr__(self,name):
                        def record(*args,**kwargs):steps.append((name,args,kwargs));return self
                        return record
                    @staticmethod
                    def build(_image,**kwargs):
                        state['built']=True
                        self.assertEqual((kwargs['cpu_count'],kwargs['memory_mb'],kwargs['skip_cache']),(2,4096,True))
                        kwargs['on_build_logs'](types.SimpleNamespace(message='Template created with ID: owned-id, Build ID: build-id'))
                        return types.SimpleNamespace(template_id='owned-id',build_id='build-id')
                class SDK:
                    @staticmethod
                    def create(template_id,**kwargs):
                        state['creates']+=1;self.assertEqual(template_id,'owned-id');self.assertEqual(kwargs['timeout'],120)
                        self.assertEqual(kwargs['metadata'],{**CTX,'kind':kind})
                        files=types.SimpleNamespace(read=lambda name,**_k:json.dumps(observed(kind,Path(name).stem)))
                        def run(command,**_kwargs):
                            steps.append(('fresh_command',(command,),_kwargs))
                            return types.SimpleNamespace(exit_code=0,stdout=json.dumps(observed(kind,'fresh')))
                        return types.SimpleNamespace(sandbox_id='sandbox-id',files=files,commands=types.SimpleNamespace(run=run))
                    @staticmethod
                    def get_info(*_args,**_kwargs):
                        if state['killed']:raise Missing()
                        return types.SimpleNamespace(sandbox_id='sandbox-id',template_id='owned-id',metadata={**CTX,'kind':kind})
                    @staticmethod
                    def kill(sandbox_id,**_kwargs):self.assertEqual(sandbox_id,'sandbox-id');state['killed']=True
                def request(method,path,_key,body=None):
                    if not state['built'] or state['deleted']:raise http_error('',404,'',{},None)
                    if method=='DELETE':state['deleted']=True;return None
                    return {'templateID':'owned-id','public':False,'isDefault':False,'names':[control.name_for(CTX,kind)]}
                with tempfile.TemporaryDirectory() as temp:
                    path=Path(temp)/(kind+'.json')
                    with patch.dict('sys.modules',{'e2b':types.SimpleNamespace(Template=Image,Sandbox=SDK),
                                    'e2b.exceptions':types.SimpleNamespace(SandboxNotFoundException=Missing)}), \
                         patch.object(control,'request',side_effect=request),patch.object(control,'install_alarm'):
                        control.one(SOURCE,'FAKE_API_KEY',CTX,kind,path,time.time()+60)
                    value=json.loads(path.read_text())
                self.assertEqual(value['probe'],{'status':'observed','phase':'complete'})
                self.assertEqual(value['cleanup']['status'],'complete')
                self.assertEqual(set(value['observations']),set(guest['PHASES']))
                self.assertEqual(state['creates'],1);self.assertTrue(state['killed']);self.assertTrue(state['deleted'])
                self.assertEqual([args for name,args,_ in steps if name=='from_template'],[(kind,)])
                commands=[args[0] for name,args,_ in steps if name=='run_cmd']
                self.assertEqual(commands,['test ! -e /opt/mikka && test ! -L /opt/mikka && mkdir -m 0755 /opt/mikka',
                    f'python3 -B /opt/mikka/observe.py {kind} before',f'python3 -B /opt/mikka/observe.py {kind} pre_finalization'])
                self.assertEqual([args[0] for name,args,_ in steps if name=='fresh_command'],[f'python3 -B /opt/mikka/observe.py {kind} fresh'])
                self.assertEqual([args[0] for name,args,_ in steps if name=='set_start_cmd'],[f'python3 -B /opt/mikka/observe.py {kind} ready && exec sleep infinity'])


if __name__=='__main__':
    unittest.main()
