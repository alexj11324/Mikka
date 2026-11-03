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
        subprocess.run(['git','init','-q',str(self.repo)],check=True)
        subprocess.run(['git','-C',str(self.repo),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.repo),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
        self.source=subprocess.check_output(['git','-C',str(self.repo),'rev-parse','HEAD'],text=True).strip()
        self.destination=self.runtime/'releases'/self.source
        self.node=self.runtime/'runtime/node/bin';self.node.mkdir(parents=True)
        self.executable(self.node/'node','#!/bin/sh\nexit 0\n')
        self.executable(self.bin/'corepack','#!/bin/sh\ntest ! -e "$STAGE_FAIL_INSTALL"\n')
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
        self.script=self.root/'bootstrap.sh';self.script.write_text(original.replace('/opt/mikka',str(self.runtime)).replace(' = 0 ]]',' = '+str(os.getuid())+' ]]').replace(' = 0 &&',' = '+str(os.getuid())+' &&'))
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
