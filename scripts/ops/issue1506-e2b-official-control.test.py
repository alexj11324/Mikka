"""Offline tests only: no SDK import, credentials, API, or resources."""
import hashlib,importlib.util,json,os,tempfile,time,types,unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('control',HERE/'issue1506-e2b-official-control.py')
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
guest={'__name__':'targeted_guest'}
exec(compile(control.GUEST_PROGRAM,'targeted_guest','exec'),guest)
SOURCE=Path(os.environ.get('CONTROL_TEST_SOURCE','source')).resolve()
ENV={'GITHUB_REPOSITORY':control.REPOSITORY,'GITHUB_REF':control.BRANCH,'GITHUB_SHA':'a'*40,
     'GITHUB_RUN_ID':'123456','GITHUB_RUN_ATTEMPT':'1','CONTROL_GO':'true',
     'CONTROL_NOT_BEFORE':'2026-11-09T12:00:00Z','CONTROL_DEADLINE':'2026-11-09T12:15:00Z'}
CTX=control.context(ENV)

def observed(kind,phase):
    return {'version':1,'kind':kind,'phase':phase,'utcNs':1,'monotonicNs':1,'bootId':'0'*8+'-'+'1'*4+'-'+'2'*4+'-'+'3'*4+'-'+'4'*12,
            'nodes':[{'path':path,'status':'absent'} for path in guest['PATHS'][kind]],
            'cli':{'status':'absent'} if kind=='claude' else None,
            'apt':None if kind=='claude' else {'version':'2.4.5','units':{unit:{'status':'unsupported'} for unit in guest['UNITS']}}}

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

    def test_only_two_run_owned_aliases(self):
        self.assertEqual(control.name_for(CTX,'claude'),'mikka-1506-official-control-123456-1-claude')
        with self.assertRaises(control.Failure):
            control.name_for(CTX,'codex')

    def test_unknown_error_never_exposes_message(self):
        raw=control.safe(RuntimeError('secret https://signed.invalid/?token=x'))
        self.assertEqual(raw,{'type':'RuntimeError','code':'operation_failed'})
        self.assertNotIn('secret',json.dumps(raw))
        error=http_error('https://secret.invalid',403,'private',{},None)
        self.assertEqual(control.safe(error)['httpStatus'],403)
        self.assertNotIn('secret',json.dumps(control.safe(error)))

    def test_source_hash_is_actual_fixed_e78(self):
        self.assertEqual(hashlib.sha256((SOURCE/'scripts/e2b/build-template.py').read_bytes()).hexdigest(),control.BUILDER_SHA)

    def test_six_guard_dimensions_and_exact_three_path_overlay(self):
        def fake_git(directory,*args):
            if args==('rev-parse','HEAD'):
                return control.SOURCE if directory==SOURCE else CTX['opsCommit']
            if args==('rev-list','--parents','-n','1','HEAD'):
                return CTX['opsCommit']+' '+control.SOURCE
            return '\n'.join(control.PATHS)
        with patch.object(control,'git',side_effect=fake_git),patch.object(control.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)):
            control.checkouts(SOURCE,Path('ops'),CTX)
        def extra_path(directory,*args):
            return fake_git(directory,*args)+'\nnot-allowed.py' if args[:2]==('diff','--name-only') else fake_git(directory,*args)
        with patch.object(control,'git',side_effect=extra_path),patch.object(control.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)),self.assertRaises(control.Failure):
            control.checkouts(SOURCE,Path('ops'),CTX)

    def test_source_guard_does_not_accept_second_parent(self):
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
        row=observed('claude','before');row['secret']='forbidden'
        with self.assertRaises(control.Failure):
            control.observation(json.dumps(row),'claude','before')
        with self.assertRaises(control.Failure):
            control.observation(json.dumps(observed('claude','ready')),'claude','fresh')

    def test_foreign_or_modified_ledger_rejected(self):
        row=control.new_ledger(CTX,'claude')
        for changed in ({**row,'name':'claude'},{**row,'identity':{**CTX,'runId':'999'}},{**row,'templateId':'tmpl'}):
            with self.subTest(value=changed),self.assertRaises(control.Failure):
                control.validate_ledger(changed,CTX,'claude')

    def cleanup_fixture(self,row,request,sdk):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'claude.json';control.save(path,row)
            with patch.object(control,'request',side_effect=request):
                result=control.cleanup_one(SOURCE,'FAKE_API_KEY',CTX,'claude',path,sdk)
            return result

    def test_cleanup_recovers_exact_alias_then_deletes_exact_id(self):
        row=control.new_ledger(CTX,'claude');row['buildStarted']=True
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
        row=control.new_ledger(CTX,'claude');row['buildStarted']=True
        def absent(*_args,**_kwargs):raise http_error('',404,'',{},None)
        result=self.cleanup_fixture(row,absent,(object,Missing))
        self.assertEqual(result['status'],'failed')
        self.assertIn({'code':'build_unreturned','type':'Failure'},result['errors'])

    def test_public_or_foreign_template_is_not_deleted(self):
        for mutate in ({'public':True},{'templateID':'foreign'},{'names':['unrelated']}):
            row=control.new_ledger(CTX,'claude');row.update(buildStarted=True,templateId='owned-id')
            calls=[]
            def request(method,path,_key,body=None):
                calls.append((method,path))
                base={'templateID':'owned-id','public':False,'names':[row['name']]}
                return {**base,**mutate}
            result=self.cleanup_fixture(row,request,(object,Missing))
            self.assertEqual(result['status'],'failed')
            self.assertFalse(any(method=='DELETE' for method,_ in calls))

    def test_instance_failure_does_not_skip_template_cleanup(self):
        row=control.new_ledger(CTX,'claude')
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
        row=control.new_ledger(CTX,'claude')
        row.update(buildStarted=True,templateId='owned-id',createStarted=True,sandboxId='sandbox-id')
        killed=[]
        class SDK:
            @staticmethod
            def get_info(*_args,**_kwargs):
                return types.SimpleNamespace(sandbox_id='sandbox-id',template_id='foreign',metadata={**CTX,'kind':'claude'})
            @staticmethod
            def kill(*args,**_kwargs):killed.append(args)
        def absent(*_args,**_kwargs):raise http_error('',404,'',{},None)
        result=self.cleanup_fixture(row,absent,(SDK,Missing))
        self.assertEqual(result['status'],'failed');self.assertEqual(killed,[])

    def test_two_fixed_budget_paths_no_worker_or_model(self):
        self.assertEqual(control.KINDS,('claude','desktop'))
        self.assertNotIn('E2B_API_KEY',control.GUEST_PROGRAM)
        self.assertNotIn('apt-get',control.GUEST_PROGRAM)
        self.assertNotIn('subprocess.Popen',control.GUEST_PROGRAM)
        workflow=HERE.parents[1]/'.github/workflows/issue1506-e2b-official-control.yml'
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
            self.assertEqual(job_if,"github.ref == 'refs/heads/ops/issue1506-e2b-conservation-control' && github.run_attempt == 1")
            self.assertEqual(go,"'true'")
            for stamp in (start,end):
                self.assertRegex(stamp,r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
            bound={**ENV,'CONTROL_GO':'true','CONTROL_NOT_BEFORE':start,'CONTROL_DEADLINE':end}
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
                control.one(SOURCE,'FAKE_API_KEY',CTX,'claude',path,time.time()+60)
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
                 patch.object(control,'checkouts'),patch.object(control,'window',return_value=time.time()+1000), \
                 patch.object(control.importlib.metadata,'version',return_value='2.62.0'), \
                 patch.object(control,'install_alarm'),patch.object(control,'request',side_effect=alarm_request):
                self.assertEqual(control.main(),1)
        self.assertEqual(calls,[('GET','/templates/owned-claude')])

if __name__=='__main__':
    unittest.main()
