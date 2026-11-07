"""Offline real-file and fake SDK/API guards. No E2B import or cloud request."""
from copy import deepcopy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('official_ca', HERE / 'issue1512-official-claude-ca.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
ENV = {'GITHUB_REPOSITORY': 'alexj11324/Mikka', 'GITHUB_REF': control.BRANCH,
       'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '123456', 'GITHUB_RUN_ATTEMPT': '1'}
PRIVATE = 'sk_fixture_private_content_never_export'
CA = {'path': control.CA_PATH, 'mode': 511, 'uid': 0, 'gid': 0, 'size': 1234,
      'sha256': 'b' * 64, 'identityStable': True}


class TimeoutException(Exception):
    pass


class Fake:
    def __init__(self, case='success'):
        self.case, self.calls, self.killed = case, [], False
        self.context = control.identity(ENV)
        self.sandbox_id, self.commands = 'owned-sandbox', self
        self.sdk = (self, SimpleNamespace, SimpleNamespace(RUNNING='running', PAUSED='paused'))

    def request(self, path, key):
        self.calls.append(('get', path))
        assert key == PRIVATE
        if path == '/templates/aliases/claude':
            return {'templateID': 'official-template', 'public': self.case != 'private_template'}
        if path == '/templates/official-template':
            observed = sum(call == ('get', path) for call in self.calls)
            return {'templateID': 'official-template', 'buildID': 'changed-build' if self.case == 'drift' and observed > 1 else 'official-build',
                    'public': True, 'isDefault': self.case != 'not_official', 'buildStatus': 'ready'}
        if path == '/sandboxes/owned-sandbox':
            if self.killed:
                raise HTTPError(path, 404, PRIVATE, {}, None)
            return {'sandboxID': self.sandbox_id, 'templateID': 'official-template',
                    'metadata': {**self.context, 'runId': 'foreign'} if self.case == 'foreign' else self.context,
                    'unexportedValue': PRIVATE}
        raise AssertionError('unexpected API path')

    def create(self, template, **kwargs):
        self.calls.append(('create', template, kwargs))
        assert template == 'official-template'
        assert kwargs == {'api_key': PRIVATE, 'timeout': 60, 'metadata': self.context, 'request_timeout': 25}
        if self.case in {'partial', 'foreign_partial', 'excess_partial'}:
            raise TimeoutException(PRIVATE)
        return self

    def run(self, command, **kwargs):
        self.calls.append(('command', command, kwargs))
        assert command == control.CA_COMMAND
        assert kwargs == {'user': 'user', 'timeout': 15, 'request_timeout': 20}
        assert PRIVATE not in command
        if self.case == 'timeout':
            raise TimeoutException(PRIVATE)
        if self.case == 'command_failure':
            return SimpleNamespace(exit_code=1, stdout=PRIVATE, stderr=PRIVATE)
        data = {**CA, 'contents': PRIVATE} if self.case == 'private_output' else CA
        return SimpleNamespace(exit_code=0, stdout=json.dumps(data), stderr=PRIVATE)

    def kill(self, sandbox_id, **kwargs):
        self.calls.append(('kill', sandbox_id))
        assert sandbox_id == self.sandbox_id
        assert kwargs == {'api_key': PRIVATE, 'request_timeout': 10}
        if self.case != 'not_killed': self.killed = True
        return True

    def list(self, **kwargs):
        self.calls.append(('list', kwargs['query'].metadata))
        assert kwargs['query'].metadata == self.context
        assert kwargs['query'].state == ['running', 'paused']
        assert kwargs['api_key'] == PRIVATE and kwargs['request_timeout'] == 10
        row = SimpleNamespace(sandbox_id=self.sandbox_id, template_id='official-template', metadata=self.context)
        if self.case == 'foreign_partial': row.metadata = {**self.context, 'runId': 'foreign'}
        class Page:
            has_next = True
            def next_items(page):
                page.has_next = False
                return [row, row] if self.case == 'excess_partial' else [row]
        return Page()


class ControlTests(unittest.TestCase):
    def run_case(self, case):
        fake = Fake(case)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            ledger = control.diagnose(fake.sdk, fake.request, fake.context, PRIVATE, output)
            self.assertEqual(json.loads(output.read_text()), ledger)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(PRIVATE, output.read_text())
        return fake, ledger

    def test_one_official_vm_one_read_command_and_actual_id_cleanup(self):
        fake, ledger = self.run_case('success')
        self.assertEqual(ledger['probe']['status'], 'passed')
        self.assertEqual(ledger['observation'], CA)
        self.assertEqual(ledger['comparisonToFailure'], {'matchesBeforeSha256': False, 'matchesAfterSha256': False,
                                                       'matchesBeforeMode': False, 'matchesAfterMode': True})
        self.assertEqual(ledger['officialBefore'], ledger['officialAfter'])
        self.assertEqual(ledger['officialBefore']['buildId'], 'official-build')
        self.assertEqual(ledger['identity']['sourceCommit'], control.SOURCE_SHA)
        self.assertEqual(ledger['budget'], {'sandboxes': 1, 'sandboxSeconds': 60, 'commands': 1, 'commandSeconds': 15, 'overallSeconds': 180})
        self.assertEqual(sum(call[0] == 'create' for call in fake.calls), 1)
        self.assertEqual(sum(call[0] == 'command' for call in fake.calls), 1)
        self.assertEqual(sum(call[0] == 'kill' for call in fake.calls), 1)
        self.assertEqual(fake.calls[-1], ('get', '/sandboxes/owned-sandbox'))
        self.assertEqual(ledger['cleanup']['sandboxes'], [{'sandboxId': 'owned-sandbox', 'killRequested': True, 'absenceConfirmedById': True}])
        self.assertTrue(ledger['diagnosticOnly'])
        self.assertFalse(ledger['releaseAccepted'])
        self.assertFalse(ledger['policyChanged'])
        self.assertFalse(ledger['sandboxBuildIdExposedByApi'])
        self.assertEqual(ledger['scope']['templateMutations'], 0)

    def test_unverified_official_identity_stops_before_allocating(self):
        for case in ['private_template', 'not_official']:
            with self.subTest(case=case):
                fake, ledger = self.run_case(case)
                self.assertEqual(ledger['probe']['error']['code'], 'official_template_unverified')
                self.assertFalse(any(call[0] in {'create', 'command', 'kill', 'list'} for call in fake.calls))

    def test_template_build_drift_retains_observation_but_is_not_a_control_pass(self):
        _, ledger = self.run_case('drift')
        self.assertEqual(ledger['probe']['error']['code'], 'template_identity_changed')
        self.assertEqual(ledger['observation'], CA)
        self.assertEqual(ledger['cleanup']['status'], 'complete')

    def test_commands_and_bad_guest_output_preserve_failure_and_cleanup(self):
        for case, code in [('timeout', 'operation_failed'), ('command_failure', 'command_failed'), ('private_output', 'ca_observation_invalid')]:
            with self.subTest(case=case):
                fake, ledger = self.run_case(case)
                self.assertEqual(ledger['probe']['error']['code'], code)
                self.assertIsNone(ledger['observation'])
                self.assertTrue(fake.killed)
                self.assertEqual(ledger['cleanup']['status'], 'complete')

    def test_partial_create_recovers_only_one_exact_metadata_bound_actual_id(self):
        fake, ledger = self.run_case('partial')
        self.assertEqual(ledger['probe']['status'], 'failed')
        self.assertEqual(ledger['sandboxId'], 'owned-sandbox')
        self.assertTrue(ledger['cleanup']['metadataRecoveryUsed'])
        self.assertTrue(fake.killed)
        self.assertFalse(any(call[0] == 'command' for call in fake.calls))
        for case in ['foreign_partial', 'excess_partial', 'foreign']:
            with self.subTest(case=case):
                fake, ledger = self.run_case(case)
                self.assertEqual(ledger['cleanup']['status'], 'failed')
                self.assertFalse(any(call[0] in {'kill', 'command'} for call in fake.calls))

    def test_kill_response_does_not_replace_actual_id_absence(self):
        _, ledger = self.run_case('not_killed')
        self.assertEqual(ledger['cleanup']['status'], 'failed')
        self.assertEqual(ledger['cleanup']['errors'][0]['code'], 'sandbox_still_exists')
        self.assertFalse(ledger['cleanup']['sandboxes'][0]['absenceConfirmedById'])

    def test_repeat_cleanup_keeps_first_kill_receipt_and_refuses_forged_ledger(self):
        fake, ledger = self.run_case('success')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            self.assertTrue(control.cleanup_owned(fake.sdk, fake.request, fake.context, PRIVATE, ledger, output))
            self.assertEqual(len(ledger['cleanupHistory']), 2)
            self.assertTrue(ledger['cleanupHistory'][0]['sandboxes'][0]['killRequested'])
            self.assertFalse(ledger['cleanupHistory'][1]['sandboxes'][0]['killRequested'])
            for change in [{'identity': {**fake.context, 'runId': 'other'}}, {'sandboxId': PRIVATE},
                           {'unexpected': PRIVATE}, {'scope': {'secret': PRIVATE}}]:
                bad = deepcopy(ledger); bad.update(change)
                before = len(fake.calls)
                with self.assertRaisesRegex(control.DiagnosticFailure, 'ledger_invalid'):
                    control.cleanup_owned(fake.sdk, fake.request, fake.context, PRIVATE, bad, output)
                self.assertEqual(len(fake.calls), before)

    def test_real_guest_program_reads_only_owned_fixture_bytes_without_exporting_them(self):
        namespace = {'__name__': 'fixture'}
        exec(compile(control.CA_PROGRAM, '<fixed CA observer>', 'exec'), namespace)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'public-ca'
            path.write_text(PRIVATE)
            path.chmod(0o777)
            namespace['CERTIFICATE_PATH'] = str(path)
            before = path.read_bytes(), path.stat()
            value = namespace['observe']()
            self.assertEqual(value['mode'], 511)
            self.assertEqual(value['size'], len(PRIVATE))
            self.assertEqual(value['sha256'], hashlib.sha256(PRIVATE.encode()).hexdigest())
            self.assertNotIn(PRIVATE, json.dumps(value))
            self.assertEqual(path.read_bytes(), before[0])
            self.assertEqual((path.stat().st_ino, path.stat().st_mtime_ns, path.stat().st_mode),
                             (before[1].st_ino, before[1].st_mtime_ns, before[1].st_mode))
            link = Path(directory) / 'link'
            link.symlink_to(path)
            namespace['CERTIFICATE_PATH'] = str(link)
            with self.assertRaises(OSError): namespace['observe']()
            namespace['CERTIFICATE_PATH'] = str(path)
            path.write_bytes(b'x' * 131073)
            with self.assertRaisesRegex(ValueError, 'ca_file_invalid'): namespace['observe']()

    def test_guest_observation_schema_is_closed_and_numeric(self):
        self.assertEqual(control.closed_observation(json.dumps(CA)), CA)
        for change in [{'contents': PRIVATE}, {'path': PRIVATE}, {'mode': True}, {'mode': 4096}, {'uid': -1},
                       {'gid': 2**32}, {'size': 0}, {'size': 131073}, {'identityStable': False}, {'sha256': PRIVATE}]:
            with self.subTest(change=change), self.assertRaises(control.DiagnosticFailure):
                control.closed_observation(json.dumps({**CA, **change}))

    def test_api_wrapper_is_get_only_and_never_accepts_secret_or_mutation_paths(self):
        for path in ['/templates', '/templates/owned/publish', '/sandboxes', '/sandboxes/../foreign', '/secrets/value']:
            with patch.object(control, 'urlopen') as opened, self.assertRaises(control.DiagnosticFailure):
                control.api_get(path, PRIVATE)
            opened.assert_not_called()
        response = io.BytesIO(b'{"templateID":"official-template"}')
        with patch.object(control, 'urlopen', return_value=response) as opened:
            value = control.api_get('/templates/aliases/claude', PRIVATE)
        request = opened.call_args.args[0]
        self.assertEqual(request.get_method(), 'GET')
        self.assertEqual(request.full_url, 'https://api.e2b.app/templates/aliases/claude')
        self.assertEqual(value, {'templateID': 'official-template'})

    def test_source_and_workflow_identity_guards_run_before_resources(self):
        for key, value in [('GITHUB_REF', 'refs/heads/main'), ('GITHUB_REPOSITORY', 'other/repo'),
                           ('GITHUB_SHA', PRIVATE), ('GITHUB_RUN_ID', '0')]:
            with self.assertRaises(control.DiagnosticFailure): control.identity({**ENV, key: value})
        with patch.object(control.subprocess, 'run', return_value=SimpleNamespace(stdout='b' * 40, returncode=0)):
            with self.assertRaisesRegex(control.DiagnosticFailure, 'source_mismatch'):
                control.verify_checkout(Path('.'), control.SOURCE_SHA, 'source_mismatch')
        self.assertNotIn(PRIVATE, json.dumps(control.safe_error(RuntimeError(PRIVATE))))

    def test_workflow_is_fixed_official_control_with_existing_key_and_three_minute_cap(self):
        workflow = (HERE.parents[1] / '.github/workflows/issue1512-official-claude-ca.yml').read_text()
        self.assertIn('timeout-minutes: 3', workflow)
        self.assertIn('ref: ' + control.SOURCE_SHA, workflow)
        self.assertIn('ref: ${{ github.sha }}', workflow)
        self.assertIn("startsWith(github.event.head_commit.message, 'issue1512:official-ca')", workflow)
        self.assertIn('branches: [ops/1512-git-transport]', workflow)
        self.assertEqual(re.findall(r'secret-name: (\S+)', workflow), ['E2B_API_KEY'])
        self.assertIn('identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', workflow)
        self.assertIn("if: always() && steps.key.outcome == 'success'", workflow)
        for action in re.findall(r'uses: (\S+)', workflow): self.assertRegex(action, r'^[^@]+@[a-f0-9]{40}$')
        for forbidden in ['SMOKE_', 'VERCEL_TOKEN', 'contents: write', 'workflow_dispatch', 'issue1512-e2b-probe.py']:
            self.assertNotIn(forbidden, workflow)
        for forbidden in ['/opt/mikka', 'curl ', 'pip ', 'npm ', 'claude ', 'codex ', 'bootstrap.json']:
            self.assertNotIn(forbidden, control.CA_COMMAND)


if __name__ == '__main__':
    unittest.main()
