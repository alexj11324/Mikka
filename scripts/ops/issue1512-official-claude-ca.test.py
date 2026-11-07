"""Offline real-file and fake SDK guards. No E2B import or cloud request."""
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

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


class NotFoundException(Exception):
    pass


class SandboxNotFoundException(NotFoundException):
    pass


class Fake:
    def __init__(self, case='success'):
        self.case, self.calls, self.killed = case, [], False
        self.context = control.identity(ENV)
        self.sandbox_id, self.commands = 'owned-sandbox', self
        self.sdk = (self, SandboxNotFoundException)

    def get_info(self, sandbox_id, **kwargs):
        self.calls.append(('get_info', sandbox_id))
        assert sandbox_id == self.sandbox_id
        assert kwargs == {'api_key': PRIVATE, 'request_timeout': 10}
        if self.case == 'generic_not_found':
            raise NotFoundException(PRIVATE)
        if self.case == 'info_timeout':
            raise TimeoutException(PRIVATE)
        if self.killed:
            raise SandboxNotFoundException(PRIVATE)
        template_id = 'returned-template'
        if self.case == 'template_drift' and sum(call[0] == 'get_info' for call in self.calls) > 1:
            template_id = 'different-template'
        if self.case == 'template_private':
            template_id = PRIVATE
        return SimpleNamespace(sandbox_id=self.sandbox_id, template_id=template_id,
            metadata={**self.context, 'runId': 'foreign'} if self.case == 'foreign' else self.context,
            unexported_value=PRIVATE)

    def create(self, template, **kwargs):
        self.calls.append(('create', template, kwargs))
        assert template == 'claude'
        assert kwargs == {'api_key': PRIVATE, 'timeout': 60, 'metadata': self.context, 'request_timeout': 25}
        if self.case == 'partial':
            raise TimeoutException(PRIVATE)
        if self.case == 'id_private':
            self.sandbox_id = PRIVATE
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

class ControlTests(unittest.TestCase):
    def run_case(self, case):
        fake = Fake(case)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            ledger = control.diagnose(fake.sdk, fake.context, PRIVATE, output)
            self.assertEqual(json.loads(output.read_text()), ledger)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(PRIVATE, output.read_text())
        return fake, ledger

    def test_one_slug_created_vm_one_read_command_and_actual_id_cleanup(self):
        fake, ledger = self.run_case('success')
        self.assertEqual(ledger['probe']['status'], 'passed')
        self.assertEqual(ledger['observation'], CA)
        self.assertEqual(ledger['comparisonToFailure'], {'matchesBeforeSha256': False, 'matchesAfterSha256': False,
                                                       'matchesBeforeMode': False, 'matchesAfterMode': True})
        self.assertEqual(ledger['template'], {'requestedAlias': 'claude', 'returnedTemplateId': 'returned-template',
            'identitySource': 'sandbox_get_info', 'provenance': 'unknown', 'buildId': None,
            'officialIdentityAttested': False, 'managementApiRead': False})
        self.assertEqual(ledger['identity']['sourceCommit'], control.SOURCE_SHA)
        self.assertEqual(ledger['budget'], {'sandboxes': 1, 'sandboxSeconds': 60, 'commands': 1, 'commandSeconds': 15, 'overallSeconds': 180})
        self.assertEqual(sum(call[0] == 'create' for call in fake.calls), 1)
        self.assertEqual(sum(call[0] == 'command' for call in fake.calls), 1)
        self.assertEqual(sum(call[0] == 'kill' for call in fake.calls), 1)
        self.assertEqual(fake.calls[-1], ('get_info', 'owned-sandbox'))
        self.assertEqual(ledger['cleanup']['sandboxes'], [{'sandboxId': 'owned-sandbox', 'killRequested': True,
            'absenceConfirmedById': True, 'absenceHttpStatus': 404}])
        self.assertTrue(ledger['diagnosticOnly'])
        self.assertFalse(ledger['releaseAccepted'])
        self.assertFalse(ledger['policyChanged'])
        self.assertTrue(ledger['cleanup']['returnedIdOnly'])
        self.assertEqual(ledger['scope']['templateMutations'], 0)

    def test_foreign_or_invalid_returned_identity_never_runs_command_or_kills(self):
        for case in ['foreign', 'template_private', 'id_private']:
            with self.subTest(case=case):
                fake, ledger = self.run_case(case)
                self.assertEqual(ledger['probe']['status'], 'failed')
                self.assertEqual(ledger['cleanup']['status'], 'failed')
                self.assertFalse(any(call[0] in {'command', 'kill', 'list'} for call in fake.calls))

    def test_returned_template_id_drift_preserves_observation_but_refuses_cleanup(self):
        fake, ledger = self.run_case('template_drift')
        self.assertEqual(ledger['cleanup']['errors'][0]['code'], 'sandbox_ownership_mismatch')
        self.assertEqual(ledger['observation'], CA)
        self.assertEqual(ledger['cleanup']['status'], 'failed')
        self.assertFalse(fake.killed)

    def test_commands_and_bad_guest_output_preserve_failure_and_cleanup(self):
        for case, code in [('timeout', 'operation_failed'), ('command_failure', 'command_failed'), ('private_output', 'ca_observation_invalid')]:
            with self.subTest(case=case):
                fake, ledger = self.run_case(case)
                self.assertEqual(ledger['probe']['error']['code'], code)
                self.assertIsNone(ledger['observation'])
                self.assertTrue(fake.killed)
                self.assertEqual(ledger['cleanup']['status'], 'complete')

    def test_partial_create_without_returned_id_does_not_list_or_delete_resources(self):
        fake, ledger = self.run_case('partial')
        self.assertEqual(ledger['probe']['status'], 'failed')
        self.assertIsNone(ledger['sandboxId'])
        self.assertTrue(ledger['cleanup']['returnedIdOnly'])
        self.assertEqual(ledger['cleanup']['status'], 'failed')
        self.assertEqual(ledger['cleanup']['errors'][0]['code'], 'sandbox_id_not_returned')
        self.assertEqual([call[0] for call in fake.calls], ['create'])

    def test_kill_response_does_not_replace_actual_id_absence(self):
        _, ledger = self.run_case('not_killed')
        self.assertEqual(ledger['cleanup']['status'], 'failed')
        self.assertEqual(ledger['cleanup']['errors'][0]['code'], 'sandbox_still_exists')
        self.assertFalse(ledger['cleanup']['sandboxes'][0]['absenceConfirmedById'])

    def test_only_the_sdk_get_info_sandbox_404_exception_confirms_absence(self):
        for case in ['generic_not_found', 'info_timeout']:
            with self.subTest(case=case):
                fake, ledger = self.run_case(case)
                self.assertEqual(ledger['cleanup']['status'], 'failed')
                self.assertFalse(ledger['cleanup']['sandboxes'][0]['absenceConfirmedById'])
                self.assertIsNone(ledger['cleanup']['sandboxes'][0]['absenceHttpStatus'])
                self.assertFalse(any(call[0] in {'command', 'kill'} for call in fake.calls))

    def test_repeat_cleanup_keeps_first_kill_receipt_and_refuses_forged_ledger(self):
        fake, ledger = self.run_case('success')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            self.assertTrue(control.cleanup_owned(fake.sdk, fake.context, PRIVATE, ledger, output))
            self.assertEqual(len(ledger['cleanupHistory']), 2)
            self.assertTrue(ledger['cleanupHistory'][0]['sandboxes'][0]['killRequested'])
            self.assertFalse(ledger['cleanupHistory'][1]['sandboxes'][0]['killRequested'])
            for change in [{'identity': {**fake.context, 'runId': 'other'}}, {'sandboxId': PRIVATE},
                           {'unexpected': PRIVATE}, {'scope': {'secret': PRIVATE}},
                           {'template': {**ledger['template'], 'provenance': 'official'}},
                           {'template': {**ledger['template'], 'buildId': 'unproven-build'}},
                           {'template': {**ledger['template'], 'managementApiRead': True}},
                           {'template': {**ledger['template'], 'returnedTemplateId': PRIVATE}}]:
                bad = deepcopy(ledger); bad.update(change)
                before = len(fake.calls)
                with self.assertRaisesRegex(control.DiagnosticFailure, 'ledger_invalid'):
                    control.cleanup_owned(fake.sdk, fake.context, PRIVATE, bad, output)
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

    def test_control_uses_only_normal_create_owned_info_command_and_kill_sdk_interfaces(self):
        fake, ledger = self.run_case('success')
        self.assertEqual([call[0] for call in fake.calls],
                         ['create', 'get_info', 'command', 'get_info', 'kill', 'get_info'])
        self.assertEqual(fake.calls[0][1], 'claude')
        self.assertEqual(ledger['template']['provenance'], 'unknown')
        self.assertIsNone(ledger['template']['buildId'])
        source = Path(control.__file__).read_text()
        for forbidden in ['/templates/', 'Sandbox.list(', 'urlopen', 'official_template(']:
            self.assertNotIn(forbidden, source)

    def test_source_and_workflow_identity_guards_run_before_resources(self):
        for key, value in [('GITHUB_REF', 'refs/heads/main'), ('GITHUB_REPOSITORY', 'other/repo'),
                           ('GITHUB_SHA', PRIVATE), ('GITHUB_RUN_ID', '0')]:
            with self.assertRaises(control.DiagnosticFailure): control.identity({**ENV, key: value})
        with patch.object(control.subprocess, 'run', return_value=SimpleNamespace(stdout='b' * 40, returncode=0)):
            with self.assertRaisesRegex(control.DiagnosticFailure, 'source_mismatch'):
                control.verify_checkout(Path('.'), control.SOURCE_SHA, 'source_mismatch')
        self.assertNotIn(PRIVATE, json.dumps(control.safe_error(RuntimeError(PRIVATE))))

    def test_workflow_is_fixed_slug_control_with_existing_key_and_three_minute_cap(self):
        workflow = (HERE.parents[1] / '.github/workflows/issue1512-official-claude-ca.yml').read_text()
        self.assertIn('timeout-minutes: 3', workflow)
        self.assertIn('without origin attestation', workflow)
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
