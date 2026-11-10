"""Local-only filesystem/process regression for private runtime refresh."""
import contextlib, importlib.util, io, json, os, pathlib, socket, subprocess, tempfile, threading, unittest
spec=importlib.util.spec_from_file_location('refresh',pathlib.Path(__file__).with_name('refresh-cloud-worker.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class RefreshTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        m.RUNTIME=self.root/'opt';m.HOME=self.root/'home';m.ROOT_UID=os.getuid();m.USER_UID=os.getuid()
        self.old=m.RUNTIME/'releases'/('a'*40)/'source';(self.old/'packages/daemon').mkdir(parents=True)
        stage=self.root/'stage';stage.mkdir()
        for args in [['init','-q'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture']]:subprocess.run(['git','-C',str(stage),*args],check=True)
        self.source=subprocess.check_output(['git','-C',str(stage),'rev-parse','HEAD'],text=True).strip()
        self.new=m.RUNTIME/'releases'/self.source/'source';self.new.parent.mkdir();stage.rename(self.new);(self.new/'packages/daemon').mkdir(parents=True)
        (self.new.parent/'worker-ready.sha').write_text('c'*40);(self.new.parent/'worker-ready.sha').chmod(0o444)
        (m.RUNTIME/'worker').symlink_to(self.old);(m.RUNTIME/'worker-source-sha').write_text('b'*40);(m.RUNTIME/'worker-source-sha').chmod(0o444)
        data=m.HOME/'worker';data.mkdir(parents=True)
        (data/'device.json').write_text(json.dumps({'deviceId':'device','workspaceId':'workspace'}));(data/'runs.json').write_text('{"runs":{}}')
        self.sentinel=m.HOME/'native-session';self.sentinel.write_text('preserved')
        self.official=self.root/'official-cli';self.official.write_text('stock')
        self.args=('device','workspace','b'*40,self.source,'c'*40,'11111111-1111-4111-8111-111111111111');self.processes=[]
    def tearDown(self):
        for p in self.processes:
            if p.poll() is None:p.terminate()
            p.wait()
        self.temp.cleanup()
    def process(self,target):
        p=subprocess.Popen(['python3','-c','import time;time.sleep(60)','cloud-worker'],cwd=target/'packages/daemon');self.processes.append(p)
        (m.HOME/'worker/daemon.pid').write_text(str(p.pid));threading.Thread(target=p.wait,daemon=True).start();return p
    def call(self,mode):
        out=io.StringIO()
        with contextlib.redirect_stdout(out):m.switch(mode,*self.args)
        return json.loads(out.getvalue())
    def initialize(self):
        script=pathlib.Path(__file__).with_name('official-e2b-instance-bootstrap.sh').read_text()
        start="python3 - <<'MIKKA_INITIAL_WORKER_JOURNAL'\n"
        self.assertIn(start,script,'fresh official install must durably initialize its journal before the first claim')
        source=script.split(start,1)[1].split('\nMIKKA_INITIAL_WORKER_JOURNAL',1)[0]
        source=source.replace("home=pathlib.Path('/home/user/.mikka')",'home=pathlib.Path('+repr(str(m.HOME))+')').replace("account=pwd.getpwnam('user')",'account=type("FixtureAccount",(),{"pw_uid":'+str(os.getuid())+',"pw_gid":'+str(os.getgid())+'})()')
        return subprocess.run(['python3','-c',source],capture_output=True,text=True)
    def test_fresh_install_creates_private_journal_before_a_refused_first_claim(self):
        data=m.HOME/'worker';(data/'device.json').unlink();(data/'runs.json').unlink();data.rmdir()
        result=self.initialize();self.assertEqual(result.returncode,0,result.stderr)
        journal=data/'runs.json'
        self.assertEqual(json.loads(journal.read_text()),{'version':1,'runs':{}})
        self.assertEqual(journal.stat().st_mode & 0o777,0o600);self.assertEqual(journal.stat().st_uid,os.getuid())
        self.assertEqual(data.stat().st_mode & 0o777,0o700)
        # Registration happens later; a rejected claim never reaches put().
        (data/'device.json').write_text(json.dumps({'deviceId':'device','workspaceId':'workspace'}))
        old=self.process(self.old)
        self.assertEqual(self.call('switch')['status'],'switched');self.assertIsNotNone(old.poll())
        self.assertEqual(self.call('rollback')['status'],'restored_not_ready')
        self.assertEqual(json.loads(journal.read_text()),{'version':1,'runs':{}})
    def test_initial_journal_never_replaces_existing_identity_history_or_symlinks(self):
        data=m.HOME/'worker';journal=data/'runs.json'
        for content in ['PRIVATE-NATIVE-HISTORY',json.dumps({'version':1,'runs':{'old':{'state':'succeeded'}}})]:
            journal.write_text(content);result=self.initialize()
            self.assertEqual(result.returncode,1);self.assertEqual(result.stderr.strip(),'runtime_initial_journal_refused')
            self.assertEqual(journal.read_text(),content);self.assertTrue((data/'device.json').is_file())
        journal.unlink();journal.symlink_to(self.root/'absent')
        result=self.initialize();self.assertEqual(result.returncode,1);self.assertTrue(journal.is_symlink())
        journal.unlink();(data/'device.json').unlink();data.rmdir();data.symlink_to(self.root/'absent-worker')
        result=self.initialize();self.assertEqual(result.returncode,1);self.assertTrue(data.is_symlink());self.assertFalse((self.root/'absent-worker').exists())
    def cli(self,mode):
        # Run the real entry point against this disposable installation only.
        source=pathlib.Path(__file__).with_name('refresh-cloud-worker.py').read_text()
        source=source.replace("RUNTIME=pathlib.Path('/opt/mikka')",'RUNTIME=pathlib.Path('+repr(str(m.RUNTIME))+')').replace("HOME=pathlib.Path('/home/user/.mikka')",'HOME=pathlib.Path('+repr(str(m.HOME))+')')
        source=source.replace('ROOT_UID=0','ROOT_UID='+str(os.getuid())).replace('USER_UID=None','USER_UID='+str(os.getuid())).replace('if os.geteuid()!=0:','if os.geteuid()!=ROOT_UID:')
        runner=self.root/'refresh-cli.py';runner.write_text(source)
        return subprocess.run(['python3',str(runner),mode,*self.args],capture_output=True,text=True)
    def test_missing_journal_is_classified_and_never_assumed_idle_for_switch_or_rollback(self):
        old=self.process(self.old);(m.HOME/'worker/runs.json').unlink()
        for mode in ['switch','rollback']:
            with self.subTest(mode=mode):
                result=self.cli(mode)
                self.assertEqual(result.returncode,1)
                self.assertEqual(result.stdout,'')
                self.assertEqual(json.loads(result.stderr),{'protocol':'mikka-runtime-refresh-refusal/v1','action':mode,'phase':'journal_before_stop','code':'runtime_journal_missing'})
                self.assertIsNone(old.poll());self.assertEqual((m.RUNTIME/'worker').resolve(),self.old)
                self.assertEqual((m.RUNTIME/'worker-source-sha').read_text(),'b'*40)
                self.assertFalse((m.RUNTIME/'runtime-refresh'/self.args[-1]).exists())
                self.assertFalse((m.HOME/'worker/runs.json').exists())
                self.assertEqual(self.sentinel.read_text(),'preserved')
    def test_corrupt_or_nonregular_journal_has_closed_diagnostics_and_is_never_replaced(self):
        old=self.process(self.old);journal=m.HOME/'worker/runs.json'
        secret='PRIVATE-NATIVE-CREDENTIAL'
        for content in [secret,json.dumps({'runs':[]}),json.dumps({'runs':{'run':{'private':secret}}})]:
            journal.write_text(content);result=self.cli('switch')
            self.assertEqual(result.returncode,1)
            self.assertEqual(json.loads(result.stderr)['code'],'runtime_journal_invalid')
            self.assertNotIn(secret,result.stderr);self.assertNotIn(str(self.root),result.stderr)
            self.assertEqual(journal.read_text(),content);self.assertIsNone(old.poll())
        journal.unlink();journal.symlink_to(self.root/'absent')
        result=self.cli('switch');self.assertEqual(result.returncode,1)
        self.assertEqual(json.loads(result.stderr)['code'],'runtime_journal_untrusted')
        self.assertTrue(journal.is_symlink());self.assertIsNone(old.poll())
    def test_busy_and_foreign_identity_cli_refusals_preserve_old_worker(self):
        old=self.process(self.old);journal=m.HOME/'worker/runs.json'
        journal.write_text('{"runs":{"run":{"state":"running"}}}')
        self.assertEqual(json.loads(self.cli('switch').stderr)['code'],'runtime_native_busy')
        journal.write_text('{"runs":{}}');(m.HOME/'worker/device.json').write_text('{}')
        self.assertEqual(json.loads(self.cli('switch').stderr)['code'],'runtime_identity_mismatch')
        self.assertIsNone(old.poll());self.assertEqual((m.RUNTIME/'worker').resolve(),self.old)
    def test_switch_verifies_new_process_and_rollback_preserves_user_and_official_files(self):
        old=self.process(self.old);self.assertEqual(self.call('switch')['status'],'switched');self.assertIsNotNone(old.poll())
        self.assertEqual((m.RUNTIME/'worker').resolve(),self.new)
        with self.assertRaisesRegex(RuntimeError,'running_process'):self.call('verify')
        self.process(self.new);self.assertEqual(self.call('verify')['status'],'verified_process')
        self.assertEqual(self.call('rollback')['status'],'restored_not_ready');self.assertEqual((m.RUNTIME/'worker').resolve(),self.old)
        self.assertEqual(self.sentinel.read_text(),'preserved');self.assertEqual(self.official.read_text(),'stock')
    def test_missing_pid_with_live_rpc_cannot_switch(self):
        sock=socket.socket(socket.AF_UNIX);sock.bind(str(m.HOME/'worker/daemon.sock'));sock.listen()
        try:
            with self.assertRaisesRegex(RuntimeError,'pid_unavailable'):self.call('switch')
            self.assertEqual((m.RUNTIME/'worker').resolve(),self.old)
        finally:sock.close()
    def test_active_native_and_foreign_identity_refuse_before_stop(self):
        p=self.process(self.old)
        (m.HOME/'worker/runs.json').write_text('{"runs":{"run":{"state":"running"}}}')
        with self.assertRaisesRegex(RuntimeError,'native_busy'):self.call('switch')
        (m.HOME/'worker/runs.json').write_text('{"runs":{}}');(m.HOME/'worker/device.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError,'identity_mismatch'):self.call('switch')
        self.assertIsNone(p.poll())
    def test_partial_switch_failure_can_restore_but_never_claim_ready(self):
        original=m.atomically_write
        def fail_marker(path,text):
            if path.name=='worker-source-sha':raise OSError('fixture failure')
            original(path,text)
        m.atomically_write=fail_marker
        try:
            with self.assertRaises(OSError):self.call('switch')
        finally:m.atomically_write=original
        self.assertEqual(self.call('rollback')['status'],'restored_not_ready');self.assertEqual((m.RUNTIME/'worker').resolve(),self.old)


class StageTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.runtime=self.root/'runtime'
        self.bin=self.root/'bin';self.bin.mkdir();self.repo=self.root/'repository';self.repo.mkdir()
        (self.repo/'scripts/e2b').mkdir(parents=True);(self.repo/'scripts/e2b/build-template.py').write_text("print('c'*40)\n")
        # Stage the real protection and lock projection helpers. The fixture
        # still substitutes network/package/build work, but must satisfy the
        # same CLI inventory and fresh importer-link contract as production.
        scripts=pathlib.Path(__file__).parent
        official=scripts.parents[2]/'scripts/e2b/official-files.py'
        (self.repo/'scripts/e2b/official-files.py').write_text(official.read_text().replace('/opt/mikka',str(self.runtime)))
        for name in ['config','protocol','daemon']:
            package=self.repo/'packages'/name;package.mkdir(parents=True)
            (package/'package.json').write_text(json.dumps({'name':'@mikka/'+name,'version':'0.0.0','private':True}))
        (self.repo/'packages/daemon/scripts').mkdir()
        (self.repo/'packages/daemon/scripts/prepare-worker-install.py').write_bytes((scripts/'prepare-worker-install.py').read_bytes())
        (self.repo/'package.json').write_text('{"private":true,"packageManager":"pnpm@10.34.3"}')
        (self.repo/'pnpm-workspace.yaml').write_text('packages:\n  - packages/*\n')
        (self.repo/'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n  packages/config: {}\n  packages/protocol: {}\n  packages/daemon: {}\n")
        for name in ['claude','codex']:
            self.executable(self.bin/name,'#!/bin/sh\nprintf "official-fixture\\n"\n')
        subprocess.run(['git','init','-q',str(self.repo)],check=True)
        subprocess.run(['git','-C',str(self.repo),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.repo),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
        self.source=subprocess.check_output(['git','-C',str(self.repo),'rev-parse','HEAD'],text=True).strip()
        self.destination=self.runtime/'releases'/self.source
        self.node=self.runtime/'runtime/node/bin';self.node.mkdir(parents=True)
        self.executable(self.node/'node','#!/bin/sh\nif test "$1" = --input-type=module; then printf "{}\\n"; fi\nexit 0\n')
        self.executable(self.bin/'corepack','#!/bin/sh\nset -e\ntest ! -e "$STAGE_FAIL_INSTALL"\nfor package in config protocol daemon; do mkdir -p "packages/$package/node_modules"; done\n')
        self.executable(self.bin/'git',"""#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
if 'fetch' in args:
 if os.path.exists(os.environ['STAGE_FAIL_FETCH']):sys.exit(7)
 args[args.index('origin')]=os.environ['STAGE_FIXTURE_REPO']
os.execv('/usr/bin/git',['git',*args])
""")
        self.executable(self.bin/'stat',"""#!/bin/sh
if test "$1" = -c && test "$2" = %u; then
 if test -e "$STAGE_FOREIGN_OWNER" && test "$3" = "$STAGE_FOREIGN_PATH"; then echo 999999; else id -u; fi
else exec /usr/bin/stat "$@"; fi
""")
        (self.runtime/'worker-source-sha').write_text('b'*40);(self.runtime/'worker').symlink_to(self.root/'original-source')
        original=pathlib.Path(__file__).with_name('official-e2b-instance-bootstrap.sh').read_text()
        # Render fixed private root into a disposable local directory; commands
        # only fetch a local fixture and simulate package/build outcomes.
        self.script=self.root/'bootstrap.sh';self.script.write_text(original.replace('/opt/mikka',str(self.runtime)).replace('/home/user/.mikka',str(self.root/'home')).replace(' = 0 ]]',' = '+str(os.getuid())+' ]]').replace(' = 0 &&',' = '+str(os.getuid())+' &&'))
        self.env={**os.environ,'PATH':str(self.bin)+':'+os.environ['PATH'],'STAGE_FIXTURE_REPO':str(self.repo),'STAGE_FAIL_FETCH':str(self.root/'fail-fetch'),'STAGE_FAIL_INSTALL':str(self.root/'fail-install'),'STAGE_FOREIGN_OWNER':str(self.root/'foreign-owner'),'STAGE_FOREIGN_PATH':str(self.destination/'worker-ready.sha')}
    def executable(self,path,text):path.write_text(text);path.chmod(0o755)
    def tearDown(self):self.temp.cleanup()
    def run_stage(self,sha='c'*40):
        return subprocess.run(['bash','-c','umask 077; exec bash "$@"','stage-test',str(self.script),self.source,sha,'codex','stage','b'*40],env=self.env,capture_output=True,text=True)
    def test_fetch_or_install_failure_can_retry_same_version_and_reuse_ready_release(self):
        for failure in ['STAGE_FAIL_FETCH','STAGE_FAIL_INSTALL']:
            with self.subTest(failure=failure):
                flag=pathlib.Path(self.env[failure]);flag.touch()
                result=self.run_stage();self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertFalse(self.destination.exists());flag.unlink()
        self.assertEqual(len(list((self.runtime/'releases').glob('.stage-*'))),2)
        result=self.run_stage();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.destination.stat().st_mode & 0o777,0o755)
        self.assertEqual((self.destination/'source').stat().st_mode & 0o777,0o755)
        self.assertEqual((self.destination/'worker-ready.sha').read_text().strip(),'c'*40)
        manifest=json.loads((self.destination/'source/.mikka-original-cli.json').read_text())
        self.assertEqual(manifest['original']['codex']['path'],str(self.bin/'codex'))
        self.assertEqual(manifest['original']['claude_code']['path'],str(self.bin/'claude'))
        self.assertEqual(manifest['added'],{})
        for name in ['config','protocol','daemon']:
            modules=self.destination/'source/packages'/name/'node_modules'
            self.assertTrue(modules.is_symlink())
            self.assertEqual(modules.resolve(strict=True),self.destination/'worker-install/packages'/name/'node_modules')
        self.assertEqual((self.runtime/'worker-source-sha').read_text(),'b'*40)
        self.assertEqual((self.runtime/'worker').readlink(),self.root/'original-source')
        pathlib.Path(self.env['STAGE_FAIL_FETCH']).touch();pathlib.Path(self.env['STAGE_FAIL_INSTALL']).touch()
        result=self.run_stage();self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('mikka-official-instance-staged '+self.source,result.stdout)
    def test_wrong_digest_and_foreign_owner_never_publish_or_reuse(self):
        self.assertNotEqual(self.run_stage('d'*40).returncode,0);self.assertFalse(self.destination.exists())
        self.assertEqual(self.run_stage().returncode,0)
        self.assertNotEqual(self.run_stage('d'*40).returncode,0)
        pathlib.Path(self.env['STAGE_FOREIGN_OWNER']).touch();self.assertNotEqual(self.run_stage().returncode,0)
    def test_reuse_checks_actual_source(self):
        self.assertEqual(self.run_stage().returncode,0)
        subprocess.run(['git','-C',str(self.destination/'source'),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','wrong-source'],check=True)
        self.assertNotEqual(self.run_stage().returncode,0)
if __name__=='__main__':unittest.main()
