"""Offline control regressions. No SDK, credentials, external API or allocation."""
import ast,copy,hashlib,importlib.util,inspect,json,os,re,tempfile,time,types,unittest
from datetime import datetime,timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('control',HERE/'issue1782-official-claude-control.py')
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
guest={'__name__':'offline_targeted_guest'}
exec(compile(control.GUEST_PROGRAM,'offline_targeted_guest','exec'),guest)
SOURCE=Path(os.environ.get('CONTROL_TEST_SOURCE','source')).resolve()
ENV={'GITHUB_ACTIONS':'true','GITHUB_EVENT_NAME':'push','GITHUB_REPOSITORY':control.REPOSITORY,
     'GITHUB_REPOSITORY_ID':'1427517699','GITHUB_REPOSITORY_OWNER_ID':'183887963',
     'GITHUB_REF':control.BRANCH,'GITHUB_SHA':'a'*40,'GITHUB_WORKFLOW_SHA':'a'*40,
     'GITHUB_WORKFLOW_REF':control.REPOSITORY+'/'+control.WORKFLOW+'@'+control.BRANCH,
     'GITHUB_ACTOR':'alexj11324','GITHUB_ACTOR_ID':'183887963','GITHUB_TRIGGERING_ACTOR':'alexj11324',
     'GITHUB_JOB':'official_claude_control','GITHUB_RUN_ID':'123456','GITHUB_RUN_ATTEMPT':'1',
     'CONTROL_GO':'true','CONTROL_NOT_BEFORE':'2026-11-09T12:00:00Z','CONTROL_DEADLINE':'2026-11-09T12:15:00Z'}
CTX=control.context(ENV)

def http_error(*args,**kwargs):
    error=HTTPError(*args,**kwargs);error.close();return error

class Missing(Exception):
    pass

def observed(phase='before',links=False):
    # Independent fixture reproduces the actual Claude file→link shape. This
    # known failure digest is test data, never a prefilled measured result.
    original='4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1'
    nodes=[{'path':path,'status':'present','kind':'file','mode':0o777,'uid':0,'gid':0,
            'device':1,'inode':index+1,'size':1234,'mtimeNs':10,'ctimeNs':11,
            'sha256':original if index<2 else 'b'*64} for index,path in enumerate(control.CERT_PATHS)]
    if links:
        for index,target in enumerate(('e2b-ca.pem','/usr/local/share/ca-certificates/e2b-ca.crt')):
            nodes[index].pop('sha256');nodes[index].update(kind='link',target=target,size=len(target))
        references=[{'path':control.CERT_PATHS[0],'status':'observed','chain':list(control.CERT_PATHS),
                     'terminalPath':control.CERT_PATHS[2],'terminalSha256':'b'*64},
                    {'path':control.CERT_PATHS[1],'status':'observed','chain':list(control.CERT_PATHS[1:]),
                     'terminalPath':control.CERT_PATHS[2],'terminalSha256':'b'*64}]
    else:
        references=[{'path':path,'status':'observed','chain':[path],'terminalPath':path,'terminalSha256':original}
                    for path in control.CERT_PATHS[:2]]
    return {'version':1,'kind':'claude','phase':phase,'utcNs':100,'monotonicNs':50,
            'bootId':'00000000-1111-2222-3333-444444444444','nodes':nodes,'certificates':references}

class Tests(unittest.TestCase):
    def test_unbound_paths_refuse_before_checkout_or_sdk(self):
        with patch.object(control,'git') as git,patch.object(control,'OPS_CHANGED_PATHS',None):
            with self.assertRaisesRegex(control.Failure,'unbound'):
                control.checkouts(SOURCE,Path('ops'),CTX)
            git.assert_not_called()

    def test_disabled_window_refuses_before_reading_a_key(self):
        class NoKey(dict):
            def pop(self,*_args):raise AssertionError('must not read a credential')
        env=NoKey({**ENV,'CONTROL_GO':'false'})
        with patch.object(control.os,'environ',env),patch('sys.argv',['control','verify','--source',str(SOURCE),'--output','unused']), \
             patch.object(control.importlib.metadata,'version') as version:
            with self.assertRaisesRegex(control.Failure,'unbound'):control.main()
            version.assert_not_called()

    def test_exact_owned_push_job_actor_and_attempt(self):
        self.assertEqual(control.context(ENV),CTX)
        for field,value in [('GITHUB_ACTIONS','false'),('GITHUB_EVENT_NAME','workflow_dispatch'),
                            ('GITHUB_REPOSITORY','other/repo'),('GITHUB_REPOSITORY_ID','1'),
                            ('GITHUB_REPOSITORY_OWNER_ID','1'),('GITHUB_REF','refs/heads/main'),
                            ('GITHUB_SHA','main'),('GITHUB_WORKFLOW_SHA','b'*40),('GITHUB_WORKFLOW_REF','other'),
                            ('GITHUB_ACTOR','other'),('GITHUB_ACTOR_ID','1'),('GITHUB_TRIGGERING_ACTOR','other'),
                            ('GITHUB_JOB','private_candidates'),('GITHUB_RUN_ID','../1'),('GITHUB_RUN_ATTEMPT','2')]:
            with self.subTest(field=field),self.assertRaises(control.Failure):control.context({**ENV,field:value})

    def test_one_absolute_window_and_cleanup_grace(self):
        start=1794225600
        self.assertEqual(control.window(ENV,start),start+900)
        self.assertEqual(control.window(ENV,start+1000,cleanup=True),start+900)
        for changed,now in [({},start-1),({},start+900),({'CONTROL_GO':'false'},start+1),
                            ({'CONTROL_NOT_BEFORE':'UNBOUND'},start+1),({'CONTROL_DEADLINE':'UNBOUND'},start+1),
                            ({'CONTROL_DEADLINE':'2026-11-09T12:16:00Z'},start+1)]:
            with self.subTest(changed=changed,now=now),self.assertRaises(control.Failure):control.window({**ENV,**changed},now)

    def test_cleanup_builder_hash_matches_exact_product_source(self):
        self.assertEqual(hashlib.sha256((SOURCE/'scripts/e2b/build-template.py').read_bytes()).hexdigest(),control.BUILDER_SHA)

    def test_exact_source_tree_single_ops_parent_and_final_append_paths(self):
        paths=control.CONTROL_PATHS+('scripts/ops/workspace-private-acceptance.mjs',)
        def answer(directory,*args):
            if args==('rev-parse','HEAD'):return control.SOURCE if directory==SOURCE else CTX['opsCommit']
            if args==('rev-parse','HEAD^{tree}'):return control.SOURCE_TREE
            if args[0]=='status':return ''
            if args[0]=='rev-list':return CTX['opsCommit']+' '+control.OPS_PARENT
            if args[:2]==('diff','--name-only'):return '\n'.join(paths)
            self.fail('unexpected git operation')
        with patch.object(control,'OPS_CHANGED_PATHS',paths),patch.object(control,'git',side_effect=answer):
            control.checkouts(SOURCE,Path('ops'),CTX)
        cases=[('source_sha',lambda directory,args,value:'b'*40 if directory==SOURCE and args==('rev-parse','HEAD') else value),
               ('source_tree',lambda _directory,args,value:'b'*40 if args==('rev-parse','HEAD^{tree}') else value),
               ('ops_sha',lambda directory,args,value:'b'*40 if directory!=SOURCE and args==('rev-parse','HEAD') else value),
               ('untracked',lambda _directory,args,value:'?? unknown.py' if args[0]=='status' else value),
               ('parent',lambda _directory,args,value:CTX['opsCommit']+' '+'b'*40 if args[0]=='rev-list' else value),
               ('second_parent',lambda _directory,args,value:value+' '+'b'*40 if args[0]=='rev-list' else value),
               ('extra_path',lambda _directory,args,value:value+'\nother-owner.py' if args[0]=='diff' else value),
               ('missing_path',lambda _directory,args,value:'\n'.join(paths[:-1]) if args[0]=='diff' else value)]
        for label,mutate in cases:
            with self.subTest(label=label),patch.object(control,'OPS_CHANGED_PATHS',paths), \
                 patch.object(control,'git',side_effect=lambda directory,*args:mutate(directory,args,answer(directory,*args))), \
                 self.assertRaises(control.Failure):control.checkouts(SOURCE,Path('ops'),CTX)

    def test_unreviewed_or_ambiguous_append_sets_fail_closed(self):
        for paths in (None,(),list(control.CONTROL_PATHS),control.CONTROL_PATHS*2,control.CONTROL_PATHS[:-1],
                      control.CONTROL_PATHS+('/etc/shadow',),control.CONTROL_PATHS+('../other',)):
            with self.subTest(paths=paths),patch.object(control,'OPS_CHANGED_PATHS',paths),patch.object(control,'git') as git, \
                 self.assertRaises(control.Failure):
                control.checkouts(SOURCE,Path('ops'),CTX)
            git.assert_not_called()

    def test_real_public_fixture_digest_and_inode_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'ca.crt';path.write_bytes(b'public certificate fixture')
            row=guest['node'](path)
            self.assertEqual(row['sha256'],hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(row['inode'],path.stat().st_ino)
            self.assertEqual(row['size'],path.stat().st_size)
            self.assertNotIn('content',row)

    def test_link_is_lstat_only_and_never_hashes_its_arbitrary_target(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'link';path.symlink_to('/unrelated/private/file')
            with patch.object(guest['os'],'open') as opened:
                row=guest['node'](path)
            opened.assert_not_called();self.assertEqual(row['kind'],'link');self.assertNotIn('sha256',row)

    def test_large_or_changed_file_never_emits_a_trusted_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'large';path.write_bytes(b'x'*(1048576+1))
            self.assertEqual(guest['node'](path)['status'],'too_large')
            path.write_bytes(b'public fixture');original=os.fstat;count=0
            def changed(fd):
                nonlocal count
                count+=1;value=original(fd)
                if count==1:return value
                return types.SimpleNamespace(**{key:getattr(value,key)+(1 if key=='st_mtime_ns' else 0)
                    for key in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_size','st_mtime_ns','st_ctime_ns')})
            with patch.object(guest['os'],'fstat',side_effect=changed):row=guest['node'](path)
            self.assertEqual(row['status'],'changed_during_read');self.assertNotIn('sha256',row)

    def test_three_fixed_paths_four_phases_and_actual_file_to_link_chain(self):
        for phase in ('before','pre_finalization','ready','fresh'):
            row=observed(phase,phase=='fresh')
            self.assertEqual(control.observation(json.dumps(row),'claude',phase),row)
            self.assertEqual(guest['certificate_references'](row['nodes']),row['certificates'])
        self.assertEqual(control.KINDS,('claude',));self.assertEqual(control.ACTIVE_KINDS,('claude',))
        self.assertEqual(len(control.CERT_PATHS),3)

    def test_projection_rejects_unknown_paths_raw_content_and_wrong_chain(self):
        changes=[lambda x:x.update(secret='forbidden'),lambda x:x.update(kind='desktop'),
                 lambda x:x.update(phase='unknown'),lambda x:x.update(version=True),
                 lambda x:x['nodes'][0].update(path='/etc/shadow'),lambda x:x['nodes'][0].update(mode=True),
                 lambda x:x['nodes'][0].update(content='raw certificate bytes'),
                 lambda x:x['nodes'][0].update(target='/unrelated/private/file'),
                 lambda x:x['nodes'][0].update(sha256='private'),
                 lambda x:x['certificates'][0].update(terminalPath='/unrelated/private/file'),
                 lambda x:x['certificates'][0].update(terminalSha256='c'*64),
                 lambda x:x['certificates'][0].update(chain=list(control.CERT_PATHS)[::-1])]
        for mutate in changes:
            row=observed('fresh',True);mutate(row)
            with self.subTest(row=row),self.assertRaises(control.Failure):control.observation(json.dumps(row),'claude','fresh')

    def test_incomplete_or_duplicate_certificate_nodes_do_not_count_as_observed(self):
        for mutate in [lambda x:x['nodes'].pop(),lambda x:x['nodes'].append(x['nodes'][0]),
                       lambda x:x['nodes'].__setitem__(0,{'path':control.CERT_PATHS[0],'status':'absent'}),
                       lambda x:x['nodes'][0].update(status='changed_during_read')]:
            row=observed();mutate(row)
            with self.subTest(row=row),self.assertRaises(control.Failure):control.observation(json.dumps(row),'claude','before')

    def test_reference_resolves_only_the_recorded_three_node_chain(self):
        fixture=observed('fresh',True);rows={row['path']:row for row in fixture['nodes']};calls=[]
        class FixedPath:
            def __init__(self,value):self.value=str(value)
            def __str__(self):return self.value
            def resolve(self,strict):
                self.asserted=strict
                return FixedPath(control.CERT_PATHS[2])
        def node(path):calls.append(str(path));return copy.deepcopy(rows[str(path)])
        with patch.dict(guest,{'Path':FixedPath,'node':node}):
            nodes,references=guest['certificate_snapshot']()
        self.assertEqual(nodes,fixture['nodes']);self.assertEqual(references,fixture['certificates'])
        self.assertEqual(calls,list(control.CERT_PATHS)*2)

    def test_resolution_or_snapshot_race_is_rejected(self):
        fixture=observed('fresh',True);rows={row['path']:row for row in fixture['nodes']}
        class WrongPath:
            def __init__(self,value):self.value=str(value)
            def __str__(self):return self.value
            def resolve(self,strict):return WrongPath('/unrelated/private/file')
        with patch.dict(guest,{'Path':WrongPath,'node':lambda path:copy.deepcopy(rows[str(path)])}),self.assertRaises(ValueError):
            guest['certificate_snapshot']()
        class RightPath(WrongPath):
            def resolve(self,strict):return RightPath(control.CERT_PATHS[2])
        count=0
        def changed(path):
            nonlocal count
            count+=1;row=copy.deepcopy(rows[str(path)])
            if count>3:row['inode']+=100
            return row
        with patch.dict(guest,{'Path':RightPath,'node':changed}),self.assertRaises(ValueError):guest['certificate_snapshot']()

    def test_safe_errors_never_copy_provider_text_or_urls(self):
        value=control.safe(RuntimeError('private https://signed.invalid/?token=secret'))
        self.assertEqual(value,{'code':'operation_failed','type':'RuntimeError'})
        self.assertNotIn('secret',json.dumps(value))

    def cleanup_fixture(self,row,request,sdk):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'claude.json';control.save(path,row)
            with patch.object(control,'request',side_effect=request):return control.cleanup_one(SOURCE,'FAKE_API_KEY',CTX,'claude',path,sdk)

    def test_lost_create_identity_cannot_claim_absence(self):
        row=control.new_ledger(CTX,'claude');row.update(buildStarted=True,templateId='owned-id',createStarted=True)
        result=self.cleanup_fixture(row,lambda *_a,**_k:(_ for _ in ()).throw(http_error('',404,'',{},None)),(object,Missing))
        self.assertEqual(result['status'],'failed')
        self.assertIn({'code':'sandbox_unreturned','type':'Failure'},result['errors'])

    def test_only_one_official_template_and_fresh_instance_no_product_install(self):
        steps=[];state={'built':False,'killed':False,'deleted':False,'creates':0}
        class Image:
            def __init__(self,**_kwargs):pass
            def __getattr__(self,name):
                def record(*args,**kwargs):steps.append((name,args,kwargs));return self
                return record
            @staticmethod
            def build(_image,**kwargs):
                state['built']=True
                kwargs['on_build_logs'](types.SimpleNamespace(message='untrusted private SDK text'))
                kwargs['on_build_logs'](types.SimpleNamespace(message='Template created with ID: owned-id, Build ID: build-id'))
                self.assertEqual(kwargs['cpu_count'],2);self.assertEqual(kwargs['memory_mb'],4096)
                self.assertTrue(kwargs['skip_cache'])
                return types.SimpleNamespace(template_id='owned-id',build_id='build-id')
        class SDK:
            @staticmethod
            def create(template_id,**kwargs):
                state['creates']+=1;self.assertEqual(template_id,'owned-id');self.assertEqual(kwargs['timeout'],120)
                self.assertEqual(kwargs['metadata'],{**CTX,'kind':'claude'})
                files=types.SimpleNamespace(read=lambda name,**_k:json.dumps(observed(Path(name).stem)))
                commands=types.SimpleNamespace(run=lambda *_a,**_k:types.SimpleNamespace(exit_code=0,stdout=json.dumps(observed('fresh',True))))
                return types.SimpleNamespace(sandbox_id='sandbox-id',files=files,commands=commands)
            @staticmethod
            def get_info(*_a,**_k):
                if state['killed']:raise Missing()
                return types.SimpleNamespace(sandbox_id='sandbox-id',template_id='owned-id',metadata={**CTX,'kind':'claude'})
            @staticmethod
            def kill(sandbox_id,**_k):self.assertEqual(sandbox_id,'sandbox-id');state['killed']=True
        def request(method,path,_key,body=None):
            if not state['built'] or state['deleted']:raise http_error('',404,'',{},None)
            if method=='DELETE':state['deleted']=True;return None
            return {'templateID':'owned-id','public':False,'isDefault':False,'names':[control.name_for(CTX,'claude')]}
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'claude.json'
            with patch.dict('sys.modules',{'e2b':types.SimpleNamespace(Template=Image,Sandbox=SDK),
                            'e2b.exceptions':types.SimpleNamespace(SandboxNotFoundException=Missing)}), \
                 patch.object(control,'request',side_effect=request):
                control.one(SOURCE,'FAKE_API_KEY',CTX,'claude',path,time.time()+60)
            value=json.loads(path.read_text())
        self.assertEqual(value['probe']['status'],'observed');self.assertEqual(value['cleanup']['status'],'complete')
        self.assertEqual(set(value['observations']),{'before','pre_finalization','ready','fresh'})
        self.assertEqual(state['creates'],1);self.assertTrue(state['killed']);self.assertTrue(state['deleted'])
        self.assertEqual([args for name,args,_kwargs in steps if name=='from_template'],[('claude',)])
        commands=[args[0] for name,args,_kwargs in steps if name=='run_cmd']
        self.assertEqual(commands,['test ! -e /opt/mikka && test ! -L /opt/mikka && mkdir -m 0755 /opt/mikka',
            'python3 -B /opt/mikka/observe.py claude before','python3 -B /opt/mikka/observe.py claude pre_finalization'])
        self.assertNotIn('untrusted private',json.dumps(value))

    def test_guest_contains_no_private_paths_credentials_installers_or_cli_execution(self):
        parsed=ast.parse(control.GUEST_PROGRAM)
        imports={node.names[0].name for node in parsed.body if isinstance(node,ast.Import)}
        self.assertNotIn('subprocess',imports);self.assertNotIn('urllib.request',imports)
        for text in ('E2B_API_KEY','os.environ','apt-get','pnpm','node_modules','/etc/shadow','/root/.','/home/'):
            self.assertNotIn(text,control.GUEST_PROGRAM)

    def assert_workflow_activation(self,workflow):
        guard="github.repository == 'alexj11324/Mikka' && github.actor == 'alexj11324' && github.ref == 'refs/heads/ops/self-hosted-vault-closeout-20261108' && github.run_attempt == 1"
        expressions=re.findall(r'^    if: (.+)$',workflow,re.M)
        self.assertEqual(len(expressions),1)
        self.assertIn(expressions[0],('false && '+guard,guard,'true && '+guard))
        trigger=re.findall(r'^on:\n(.*?)^permissions:\n',workflow,re.M|re.S)
        expected='  push:\n    branches: [ops/self-hosted-vault-closeout-20261108]\n    paths:\n'+''.join('      - '+path+'\n' for path in control.CONTROL_PATHS)
        self.assertEqual(trigger,[expected])
        self.assertEqual(re.findall(r'^          ref: (.+)$',workflow,re.M),[control.SOURCE,'${{ github.sha }}'])
        rows=re.findall(r'^      (CONTROL_GO|CONTROL_NOT_BEFORE|CONTROL_DEADLINE): (.+)$',workflow,re.M)
        self.assertEqual(len(rows),3);self.assertEqual(len(dict(rows)),3)
        values={name:value[1:-1] if len(value)>=2 and value[0] in "'\"" and value[-1]==value[0] else value for name,value in rows}
        if expressions[0].startswith('false && '):
            self.assertEqual(values,{'CONTROL_GO':'false','CONTROL_NOT_BEFORE':'UNBOUND','CONTROL_DEADLINE':'UNBOUND'})
        else:
            self.assertEqual(values['CONTROL_GO'],'true')
            self.assertIsInstance(control.OPS_CHANGED_PATHS,tuple)
            self.assertTrue(set(control.CONTROL_PATHS)<=set(control.OPS_CHANGED_PATHS))
            start=datetime.strptime(values['CONTROL_NOT_BEFORE'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp()
            # Exercise the actual time guard with the fixed interval, without
            # pretending an offline fixture is today's runnable authorization.
            end=control.window(values,now=start)
            self.assertGreater(end,start);self.assertLessEqual(end-start,900)
            with self.assertRaises(control.Failure):control.window(values,now=start-1)
            with self.assertRaises(control.Failure):control.window(values,now=end)

    def test_workflow_same_owned_subject_and_bounded_activation_with_cleanup(self):
        path=HERE.parents[1]/'.github/workflows/issue1782-official-claude-control.yml';workflow=path.read_text()
        self.assert_workflow_activation(workflow)
        self.assertIn('fetch-depth: 2',workflow)
        self.assertEqual(workflow.count('secret-name:'),1);self.assertIn('secret-name: E2B_API_KEY',workflow)
        self.assertIn('if: always() && steps.key.outcome',workflow)
        self.assertNotIn('actions: write',workflow);self.assertNotIn('SMOKE_OWNER',workflow)
        self.assertNotIn('MIKKA_DATABASE_URL',workflow);self.assertNotIn('pnpm',workflow)
        self.assertNotIn('workspace-private-acceptance.mjs',workflow)

    def test_activation_accepts_disabled_or_explicit_bounded_real_configuration(self):
        workflow=(HERE.parents[1]/'.github/workflows/issue1782-official-claude-control.yml').read_text()
        # Normalize only the activation fields so this regression itself works
        # in both the disabled review draft and the later activated append.
        disabled=re.sub(r'^    if: (?:false && |true && )?', '    if: false && ',workflow,flags=re.M)
        for field,value in (('CONTROL_GO',"'false'"),('CONTROL_NOT_BEFORE','UNBOUND'),('CONTROL_DEADLINE','UNBOUND')):
            disabled=re.sub(r'^      '+field+r': .+$','      '+field+': '+value,disabled,flags=re.M)
        self.assert_workflow_activation(disabled)
        active=disabled.replace('if: false &&','if: true &&').replace("CONTROL_GO: 'false'","CONTROL_GO: 'true'").replace('CONTROL_NOT_BEFORE: UNBOUND','CONTROL_NOT_BEFORE: 2026-11-09T12:00:00Z').replace('CONTROL_DEADLINE: UNBOUND','CONTROL_DEADLINE: 2026-11-09T12:15:00Z')
        with patch.object(control,'OPS_CHANGED_PATHS',control.CONTROL_PATHS):
            self.assert_workflow_activation(active)
            self.assert_workflow_activation(active.replace('if: true && ','if: '))
            mutations=[active.replace("github.actor == 'alexj11324' && ",''),
                       active.replace('github.run_attempt == 1','github.run_attempt >= 1'),
                       active.replace('refs/heads/ops/self-hosted-vault-closeout-20261108','refs/heads/main'),
                       active.replace('      - scripts/ops/issue1782-official-claude-control.py','      - scripts/ops/**'),
                       active.replace('permissions:\n','  workflow_dispatch:\npermissions:\n',1),
                       active.replace('          ref: '+control.SOURCE,'          ref: main'),
                       active.replace('2026-11-09T12:15:00Z','2026-11-09T12:15:01Z'),
                       active.replace('2026-11-09T12:15:00Z','2026-11-09T12:00:00Z'),
                       active.replace('2026-11-09T12:15:00Z','UNBOUND'),
                       active.replace("CONTROL_GO: 'true'","CONTROL_GO: 'false'"),
                       active.replace('if: true &&','if: false &&')]
            for changed in mutations:
                with self.subTest(changed=changed),self.assertRaises((AssertionError,control.Failure,ValueError)):
                    self.assert_workflow_activation(changed)
        with patch.object(control,'OPS_CHANGED_PATHS',None),self.assertRaises(AssertionError):
            self.assert_workflow_activation(active)


    def test_only_known_run_owned_aliases(self):
        self.assertEqual(control.name_for(CTX,'claude'),'mikka-1782-official-claude-control-123456-1-claude')
        with self.assertRaises(control.Failure):
            control.name_for(CTX,'ubuntu')

    def test_foreign_or_modified_ledger_rejected(self):
        row=control.new_ledger(CTX,'claude')
        for changed in ({**row,'name':'claude'},{**row,'identity':{**CTX,'runId':'999'}},{**row,'templateId':'tmpl'}):
            with self.subTest(value=changed),self.assertRaises(control.Failure):
                control.validate_ledger(changed,CTX,'claude')

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

    def test_alarm_escapes_real_cleanup_without_false_absence(self):
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
        self.assertEqual(calls,[('GET','/templates/owned-claude')])

    def test_entry_orchestrates_one_claude_and_one_cleanup_budget(self):
        self.assertEqual(control.ACTIVE_KINDS,('claude',))
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
        self.assertEqual(spawned,[(control.one,'claude')])
        self.assertEqual(cleaned,['claude'])
        self.assertEqual(report['budget']['privateTemplates'],1)
        self.assertEqual(report['budget']['freshInstances'],1)
        self.assertEqual(report['budget']['workerInstallCommands'],0)
        self.assertEqual(report['budget']['modelCalls'],0)
        self.assertIs(report['targetedOnly'],True)
        self.assertIs(report['releaseAccepted'],False)
        self.assertIs(report['policyChanged'],False)

if __name__=='__main__':
    unittest.main(verbosity=2)
