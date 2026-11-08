"""Offline policy/state checks; never changes the host's netfilter rules.

The separate fixed-source E2B acceptance proves real kernel/provider behavior.
"""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ingress', Path(__file__).with_name('workspace-ingress.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class Netfilter:
    def __init__(self):
        self.rules = {family: {'OUTPUT': []} for family in ('iptables', 'ip6tables')}
        self.calls = []
        self.fail = None
        self.fail_exact = None

    def run(self, args, **options):
        self.calls.append(args)
        family, tail = args[0], args[1:]
        if tail == ['--version']:
            return SimpleNamespace(returncode=0, stdout=b'iptables v1.8.9 (nf_tables)', stderr=b'')
        assert tail[:2] == ['--wait', '5']
        action, chain, *rule = tail[2:]
        table = self.rules[family]
        status, output = 0, b''
        if self.fail == (family, action) or self.fail_exact == tuple(args):
            status = 1
        elif action == '--new-chain':
            if chain in table:
                status = 1
            else:
                table[chain] = []
        elif action == '--append':
            table[chain].append(rule)
        elif action == '--insert':
            table[chain].insert(int(rule[0]) - 1, rule[1:])
        elif action == '--check':
            status = 0 if rule in table.get(chain, []) else 1
        elif action == '--list-rules':
            output = '\n'.join(shlex.join(['-A', chain, *row]) for row in table.get(chain, [])).encode()
        else:
            raise AssertionError(action)
        return SimpleNamespace(returncode=status, stdout=output, stderr=b'')


class IngressPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.geteuid() != 0:
            raise RuntimeError('Ingress root-owned state tests require root; do not silently skip this gate')

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='mikka-ingress-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.filter = Netfilter()
        for name, value in (('ROOT', self.root / 'state'), ('RECEIPT', self.root / 'state/receipt.json'),
                            ('MACHINE_FILES', (self.root / 'bootstrap.json', self.root / 'device.json', self.root / 'preloaded.pid'))):
            installed = patch.object(guard, name, value)
            installed.start()
            self.addCleanup(installed.stop)
        for installed in (patch.object(guard.subprocess, 'run', side_effect=self.filter.run),
                          patch.object(guard.shutil, 'which', side_effect=lambda name, **_kw: name),
                          patch.object(guard, 'provider_ports', return_value=[49983])):
            installed.start()
            self.addCleanup(installed.stop)

    def test_fresh_policy_is_global_dual_stack_and_preserves_only_observed_root_provider(self):
        proof = guard.prepare()
        self.assertTrue(proof['preparedBeforeWorker'])
        self.assertEqual(proof['rulesVerified'], {'ipv4': True, 'ipv6': True})
        self.assertEqual(proof['providerPorts'], [49983])
        for table in self.filter.rules.values():
            self.assertEqual(table['OUTPUT'], [['!', '-o', 'lo', '-p', 'tcp', '-j', guard.CHAIN]])
            provider, reply = table[guard.CHAIN]
            self.assertIn('--uid-owner', provider)
            self.assertEqual(provider[provider.index('--uid-owner') + 1], '0')
            self.assertEqual(provider[provider.index('--sports') + 1], '49983')
            self.assertNotIn('50005', provider)
            self.assertNotIn('--sports', reply, 'the rule must precede arbitrary future dev listeners')
            self.assertIn('REPLY', reply)
            self.assertIn(str(guard.SOCKET_MARK), reply)
            self.assertIn('REJECT', reply)
            self.assertNotIn('INPUT', table)

    def test_repeated_prepare_only_verifies_original_receipt_and_never_repairs_rules(self):
        proof = guard.prepare()
        original = guard.RECEIPT.read_bytes()
        (self.root / 'bootstrap.json').write_text('{}')
        self.filter.calls.clear()
        self.assertEqual(guard.prepare(), proof)
        self.assertEqual(guard.RECEIPT.read_bytes(), original)
        self.assertTrue(all(args[1:] == ['--version'] or args[3] in ('--check', '--list-rules') for args in self.filter.calls))
        self.filter.rules['ip6tables'][guard.CHAIN].pop()
        with self.assertRaises(guard.IngressError):
            guard.prepare()
        self.assertEqual(guard.RECEIPT.read_bytes(), original)
        self.assertEqual(len(self.filter.rules['ip6tables'][guard.CHAIN]), 1)

    def test_late_install_or_partial_family_failure_never_creates_a_receipt(self):
        (self.root / 'preloaded.pid').write_text('123')
        with self.assertRaisesRegex(guard.IngressError, 'late_install'):
            guard.prepare()
        self.assertFalse(self.filter.calls)
        (self.root / 'preloaded.pid').unlink()
        self.filter.fail = ('ip6tables', '--append')
        with self.assertRaises(guard.IngressError):
            guard.prepare()
        self.assertFalse(guard.RECEIPT.exists())
        self.filter.fail = None
        with self.assertRaises(guard.IngressError):
            guard.prepare()
        self.assertFalse(guard.RECEIPT.exists(), 'a later request cannot adopt a partially installed chain')

    def test_each_family_and_policy_operation_reports_the_actual_failing_call(self):
        provider, reply, jump = guard.policy([49983])
        operations = {
            'new_chain': ['--new-chain', guard.CHAIN],
            'provider_rule': ['--append', guard.CHAIN, *provider],
            'reply_rule': ['--append', guard.CHAIN, *reply],
            'output_jump': ['--insert', 'OUTPUT', '1', *jump],
            'check_output': ['--check', 'OUTPUT', *jump],
            'check_provider': ['--check', guard.CHAIN, *provider],
            'check_reply': ['--check', guard.CHAIN, *reply],
            'list_output': ['--list-rules', 'OUTPUT'],
            'list_chain': ['--list-rules', guard.CHAIN],
        }
        for family, program in (('ipv4', 'iptables'), ('ipv6', 'ip6tables')):
            for operation, arguments in operations.items():
                with self.subTest(family=family, operation=operation):
                    self.filter.rules = {name: {'OUTPUT': []} for name in ('iptables', 'ip6tables')}
                    self.filter.fail_exact = tuple([program, '--wait', '5', *arguments])
                    directory = self.root / (family + '-' + operation)
                    with patch.object(guard, 'ROOT', directory), patch.object(guard, 'RECEIPT', directory / 'receipt.json'):
                        with self.assertRaises(guard.IngressCommandError) as failed:
                            guard.prepare()
                        receipt = guard.failure_receipt(failed.exception)
                        self.assertEqual(receipt['detail'], 'command')
                        self.assertEqual({key: receipt['command'][key] for key in ('family', 'operation', 'failureKind', 'returnCode')},
                                         {'family': family, 'operation': operation, 'failureKind': 'exit', 'returnCode': 1})
                        self.assertFalse(guard.RECEIPT.exists(), 'failure must not grant a readiness receipt')

    def test_rule_precedence_and_added_broad_allow_fail_verification(self):
        guard.prepare()
        self.filter.rules['iptables']['OUTPUT'].insert(0, ['-j', 'ACCEPT'])
        with self.assertRaisesRegex(guard.IngressError, 'rule_order'):
            guard.verify()
        self.filter.rules['iptables']['OUTPUT'].pop(0)
        self.filter.rules['ip6tables'][guard.CHAIN].insert(1, ['-j', 'ACCEPT'])
        with self.assertRaisesRegex(guard.IngressError, 'rule_order'):
            guard.verify()

    def test_receipt_is_root_private_same_source_and_same_boot(self):
        guard.prepare()
        original = guard.RECEIPT.read_bytes()
        for update in ({'bootId': 'a' * 36}, {'sourceSha256': 'b' * 64}, {'preparedBeforeWorker': False},
                       {'installedTicks': guard.ticks() + 100000}, {'extra': True}):
            guard.RECEIPT.write_text(json.dumps(json.loads(original) | update))
            with self.assertRaisesRegex(guard.IngressError, 'receipt'):
                guard.verify()
        guard.RECEIPT.write_bytes(original)
        guard.RECEIPT.chmod(0o644)
        with self.assertRaisesRegex(guard.IngressError, 'receipt'):
            guard.verify()
        guard.RECEIPT.chmod(0o600)
        guard.RECEIPT.rename(guard.ROOT / 'real.json')
        guard.RECEIPT.symlink_to(guard.ROOT / 'real.json')
        with self.assertRaises(OSError):
            guard.verify()

    def test_unknown_backend_fails_before_changing_rules(self):
        with patch.object(guard.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'iptables v1.8.9 (legacy)')):
            with self.assertRaisesRegex(guard.IngressError, 'backend'):
                guard.prepare()
        self.assertFalse(guard.RECEIPT.exists())
        self.assertFalse(self.filter.calls)


class CommandDiagnostics(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='mikka-command-diagnostic-')
        self.addCleanup(temporary.cleanup)
        self.program = Path(temporary.name) / 'fixture'
        self.private = 'synthetic-private-command-value'
        self.program.write_text(f'''#!{sys.executable}
import sys,time
mode=sys.argv[-1]
private={self.private!r}
if mode=='success':
    sys.stdout.write('safe-result')
elif mode=='failure':
    sys.stdout.write(private)
    sys.stderr.write(private+' Warning: Extension owner revision 1 not supported, missing kernel module? could not load match; operation not supported; permission denied; invalid argument')
    sys.exit(23)
elif mode=='oversized':
    sys.stderr.write(private*3000)
elif mode=='timeout':
    sys.stderr.write(private+' operation not permitted'); sys.stderr.flush(); time.sleep(30)
''')
        self.program.chmod(0o700)

    def test_real_child_failure_emits_only_closed_fields_and_six_independent_flags(self):
        with self.assertRaises(guard.IngressCommandError) as failed:
            guard.execute(str(self.program), ['failure'], family='ipv6', operation='provider_rule')
        value = guard.failure_receipt(failed.exception)
        command = value['command']
        self.assertEqual({key: command[key] for key in ('family', 'operation', 'failureKind', 'returnCode')},
                         {'family': 'ipv6', 'operation': 'provider_rule', 'failureKind': 'exit', 'returnCode': 23})
        flags = {'unsupportedRevision', 'missingKernelModule', 'missingExtension',
                 'operationNotSupported', 'permissionDenied', 'invalidArgument'}
        self.assertEqual(set(command), flags | {'family', 'operation', 'failureKind', 'returnCode', 'extension', 'revision', 'unsupportedExtensions'})
        self.assertEqual((command['extension'], command['revision']), ('owner', 1))
        self.assertEqual(command['unsupportedExtensions'], [{'extension': 'owner', 'revision': 1}])
        self.assertTrue(all(command[key] is True for key in flags))
        self.assertNotIn(self.private, json.dumps(value))
        self.assertNotIn(str(self.program), json.dumps(value))
        success = guard.execute(str(self.program), ['success'], family='ipv4', operation='list_output')
        self.assertEqual((success.returncode, success.stdout), (0, b'safe-result'))

    def test_real_oversized_timeout_and_execution_errors_remain_closed_and_fail(self):
        with self.assertRaises(guard.IngressCommandError) as failed:
            guard.execute(str(self.program), ['oversized'], family='ipv4', operation='list_chain')
        oversized = guard.failure_receipt(failed.exception)
        self.assertEqual((oversized['command']['failureKind'], oversized['command']['returnCode']), ('output_limit', 0))
        run = subprocess.run
        with patch.object(guard.subprocess, 'run', side_effect=lambda *args, **kwargs: run(*args, **{**kwargs, 'timeout': 0.05})):
            with self.assertRaises(guard.IngressCommandError) as failed:
                guard.execute(str(self.program), ['timeout'], family='ipv4', operation='new_chain')
        timed_out = guard.failure_receipt(failed.exception)
        self.assertIsInstance(failed.exception.__cause__, subprocess.TimeoutExpired)
        self.assertEqual((timed_out['command']['failureKind'], timed_out['command']['returnCode']), ('timeout', None))
        with self.assertRaises(guard.IngressCommandError) as failed:
            guard.execute(str(self.program.parent / self.private), [], family='ipv6', operation='new_chain')
        unavailable = guard.failure_receipt(failed.exception)
        self.assertIsInstance(failed.exception.__cause__, FileNotFoundError)
        self.assertEqual((unavailable['command']['failureKind'], unavailable['command']['returnCode']), ('execution', None))
        for value in (oversized, timed_out, unavailable):
            self.assertEqual(value['detail'], 'command')
            self.assertNotIn(self.private, json.dumps(value))
            self.assertNotIn(str(self.program.parent), json.dumps(value))

    def test_invalid_context_and_unbounded_returncodes_cannot_escape_the_closed_schema(self):
        for family, operation, kind in ((self.private, 'new_chain', 'exit'), ('ipv4', self.private, 'exit'),
                                        ('ipv4', 'new_chain', self.private)):
            with self.assertRaises(guard.IngressError) as failed:
                guard.IngressCommandError(family, operation, kind)
            self.assertEqual(guard.failure_receipt(failed.exception), {'ok': False, 'detail': 'runtime'})
        for code in (self.private, True, 256, -256):
            failure = guard.IngressCommandError('ipv4', 'new_chain', 'exit', code)
            self.assertIsNone(guard.failure_receipt(failure)['command']['returnCode'])
        for extension in ('owner', 'multiport', 'conntrack', 'mark', 'tcp'):
            stderr = f'Warning: Extension {extension} revision 255 not supported, missing kernel module?'.encode()
            value = guard.IngressCommandError('ipv4', 'provider_rule', 'exit', 4, stderr).diagnostic
            self.assertEqual((value['extension'], value['revision']), (extension, 255))
            self.assertEqual(value['unsupportedExtensions'], [{'extension': extension, 'revision': 255}])
        for warning, extension, revision in (
                (f'Extension {self.private} revision 1 not supported', 'unknown', None),
                ('Extension owner revision 256 not supported', 'owner', None),
                ('Extension owner revision -1 not supported', 'unknown', None),
                ('Extension owner revision 1 not supported; Extension owner revision 2 not supported', 'owner', None),
                ('Extension owner revision 1 not supported; Extension mark revision 1 not supported', 'unknown', None),
                ('Extension owner revision 0 not supported; Extension owner revision 0 not supported', 'owner', 0)):
            value = guard.IngressCommandError('ipv4', 'provider_rule', 'exit', 4, warning.encode()).diagnostic
            self.assertEqual((value['extension'], value['revision']), (extension, revision))
            self.assertNotIn(self.private, json.dumps(value))
        warnings = '; '.join(f'Warning: Extension owner revision {value} not supported' for value in range(8))
        warnings += '; Warning: Extension multiport revision 1 not supported; Warning: Extension owner revision 0 not supported'
        value = guard.IngressCommandError('ipv4', 'provider_rule', 'exit', 4, warnings.encode()).diagnostic
        self.assertEqual(value['unsupportedExtensions'], [{'extension': 'multiport', 'revision': 1}]
                         + [{'extension': 'owner', 'revision': revision} for revision in range(5)])


class ProviderAndWorkerProof(unittest.TestCase):
    def test_failed_cli_preserves_closed_stdout_protocol_and_builder_stderr(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('workspace-ingress.py')), 'invalid'],
                                capture_output=True, text=True, timeout=5, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {'ok': False, 'detail': 'operation'})
        self.assertEqual(result.stderr, result.stdout)
        for failure in (OSError('/private/fixture secret'), guard.IngressError('/private/fixture secret')):
            self.assertEqual(guard.failure_detail(failure), 'runtime')
        self.assertEqual(guard.failure_detail(guard.IngressError('rule_order')), 'rule_order')

    def test_final_start_recreates_actual_control_files_before_worker_after_run_was_reset(self):
        repo = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory(prefix='mikka-start-order-') as temporary:
            root = Path(temporary)
            runtime = root / 'opt'
            control = root / 'run/control'
            order = root / 'order'
            (runtime / 'runtime/ingress-v1').mkdir(parents=True)
            (runtime / 'runtime/node/bin').mkdir(parents=True)
            installer = runtime / 'worker/packages/daemon/scripts/workspace-control-install.py'
            installer.parent.mkdir(parents=True)
            control.parent.mkdir(parents=True)
            # Only the OS account and fixture paths change. Execute the real
            # install() implementation so chmod/ownership/marker errors cannot
            # be hidden by a fake successful installer process.
            installer.write_text(Path(__file__).with_name('workspace-control-install.py').read_text()
                .replace("Path('/run/mikka-review-control')", 'Path(' + repr(str(control)) + ')')
                .replace("pwd.getpwnam('user')", 'pwd.getpwuid(os.getuid())'))
            (runtime / 'runtime/ingress-v1/guard.py').write_text(
                'import pathlib,sys\nassert sys.argv[1:] == ["prepare"]\n'
                + 'assert not pathlib.Path(' + repr(str(control)) + ').exists()\n'
                + 'pathlib.Path(' + repr(str(order)) + ').write_text("guard\\n")\n')
            node = runtime / 'runtime/node/bin/node'
            node.write_text('#!' + sys.executable + '\nimport pathlib,stat,sys\n'
                + 'order=pathlib.Path(' + repr(str(order)) + ')\n'
                + 'root=pathlib.Path(' + repr(str(control)) + ')\n'
                + 'assert order.read_text()=="guard\\n"\n'
                + 'assert sys.argv[-1]=="--wait-bootstrap"\n'
                + 'assert (root/"version").read_text()=="1\\n"\n'
                + 'assert stat.S_IMODE(root.stat().st_mode)==0o710\n'
                + 'assert all((root/n).stat().st_uid==0 for n in ("version","machine.json","machine.lock"))\n'
                + 'assert all(stat.S_IMODE((root/n).stat().st_mode)==0o660 for n in ("machine.json","machine.lock"))\n'
                + 'order.write_text(order.read_text()+"control-before-worker\\n")\n')
            node.chmod(0o700)
            startup = (repo / 'scripts/e2b/start-prebuilt.sh').read_text()
            startup = startup.replace('/opt/mikka', str(runtime)).replace('/home/user/.mikka', str(root / 'home/.mikka'))
            startup = startup.replace('/run/mikka-viewer', str(root / 'run/viewer')).replace('exec runuser -u user -- env', 'exec env')
            start = root / 'start.sh'
            start.write_text(startup)
            result = subprocess.run(['bash', str(start)], capture_output=True, text=True, timeout=10, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(order.read_text(), 'guard\ncontrol-before-worker\n')

    def test_absent_optional_port_is_not_exempt_and_a_task_uid_cannot_claim_provider(self):
        def table(ports):
            return 'header\n' + '\n'.join(f'0: 00000000:{port:04X} 00000000:0000 0A 0 0 0 {uid} 0 1' for port, uid in ports)
        for ports, expected in [([(49983, 0)], [49983]), ([(49983, 0), (50005, 0)], [49983, 50005])]:
            with patch.object(Path, 'read_text', return_value=table(ports)):
                self.assertEqual(guard.provider_ports(), expected)
        for ports in ([], [(49983, 1000)], [(49983, 0), (50005, 1000)]):
            with patch.object(Path, 'read_text', return_value=table(ports)):
                with self.assertRaisesRegex(guard.IngressError, 'provider'):
                    guard.provider_ports()

    def test_readiness_proves_real_worker_process_started_after_guard(self):
        before = guard.ticks()
        # Some development executors place a child in a PID namespace while
        # mounting the parent's procfs. Ask its own procfs for the visible PID;
        # this still checks the actual process, not a fabricated stat record.
        child = subprocess.Popen([sys.executable, '-c', 'import os,time; print(os.readlink("/proc/self"),flush=True); time.sleep(30)',
                                  guard.WORKER, '--wait-bootstrap'],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            pid = int(child.stdout.readline(32))
            with patch.object(guard.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())):
                with patch.object(guard, 'verify', return_value={'installedTicks': before}):
                    self.assertTrue(guard.ready(pid)['workerStartedAfterGuard'])
                with patch.object(guard, 'verify', return_value={'installedTicks': guard.ticks() + 100000}):
                    with self.assertRaisesRegex(guard.IngressError, 'worker_order'):
                        guard.ready(pid)
        finally:
            child.terminate()
            child.wait(timeout=5)
            child.stdout.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
