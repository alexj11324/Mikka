"""Offline fake transports only: this file never imports or calls the E2B SDK."""
import contextlib
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('probe', HERE / 'issue1512-e2b-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
ENV = {'GITHUB_REPOSITORY': 'alexj11324/Mikka', 'GITHUB_REF': 'refs/heads/ops/1512-git-transport',
       'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '123456', 'GITHUB_RUN_ATTEMPT': '2'}
PRIVATE = 'sk_fixture_private_value_must_not_leave_runner'


class TimeoutException(Exception):
    pass


class Fake:
    def __init__(self, case='success'):
        self.case, self.calls = case, []
        self.context = probe.identity(ENV)
        self.builder = SimpleNamespace(assert_new_template=self.absent, build=self.build,
                                       _request=self.info, cleanup_templates=self.clean_templates)
        self.cleaner = SimpleNamespace(cleanup_sandboxes=self.clean_sandboxes)
        self.sandbox = SimpleNamespace(sandbox_id='owned-sandbox',
                                      files=SimpleNamespace(write=self.write), commands=SimpleNamespace(run=self.command))

    def absent(self, name, api_key):
        self.calls.append(('absence', name))
        if self.case == 'already_exists':
            raise ValueError('template_name_already_exists')

    def build(self, name, **kwargs):
        self.calls.append(('build', name, kwargs))
        assert kwargs['ref'] == probe.SOURCE_SHA and kwargs['kind'] == 'desktop'
        assert kwargs['api_key'] == PRIVATE
        kwargs['on_build_logs'](PRIVATE)
        if self.case == 'build_failure':
            raise RuntimeError(PRIVATE)
        if self.case == 'collision':
            raise ValueError('template_name_already_exists')
        return probe.SOURCE_SHA, SimpleNamespace(template_id='owned-template', build_id='owned-build')

    def info(self, method, path, api_key):
        self.calls.append(('info', method, path))
        assert method == 'GET'
        return {'templateID': 'owned-template', 'names': [probe.candidate_name(self.context)],
                'public': self.case == 'public', 'isDefault': False}

    def create(self, template, **kwargs):
        self.calls.append(('create', template, kwargs))
        assert kwargs == {'api_key': PRIVATE, 'timeout': 60, 'metadata': self.context}
        if self.case == 'create_partial':
            raise TimeoutException(PRIVATE)
        return self.sandbox

    def write(self, path, data, **kwargs):
        self.calls.append(('write', path))
        assert path.startswith('/tmp/mikka-i1512-probe-')
        assert data == '// reviewed hook' and kwargs == {'user': 'user'}
        assert PRIVATE not in path + data

    def command(self, command, **kwargs):
        self.calls.append(('command', command, kwargs))
        assert set(kwargs) == {'user', 'timeout', 'on_stderr'}
        assert kwargs['timeout'] == 45 and kwargs['user'] == 'user'
        assert '--probe-models' in command and '--import /tmp/mikka-i1512-probe-' in command
        assert PRIVATE not in command and 'bootstrap.json' not in command
        callback = kwargs['on_stderr']
        callback(PRIVATE + '\n')
        callback(probe.PREFIX + json.dumps({'version': 1, 'phase': 'spawn', 'harness': 'codex', 'pid': 42, 'elapsedMs': 4}) + '\n')
        if self.case == 'timeout':
            raise TimeoutException(PRIVATE)
        reports = [{'harness': harness, 'installed': True, 'models': [PRIVATE]} for harness in sorted(probe.HARNESSES)]
        if self.case == 'missing_catalogue':
            reports.pop()
        return SimpleNamespace(exit_code=0, stdout=json.dumps(reports))

    def clean_sandboxes(self, contexts, api_key):
        self.calls.append(('clean_sandboxes', deepcopy(contexts)))
        assert contexts == [self.context] and api_key == PRIVATE
        if self.case == 'cleanup_failure':
            raise RuntimeError(PRIVATE)
        return [{'sandboxId': 'owned-sandbox', 'status': 'killed'}] if any(c[0] == 'create' for c in self.calls) else []

    def clean_templates(self, rows, api_key):
        self.calls.append(('clean_templates', deepcopy(rows)))
        assert rows[0]['name'] == probe.candidate_name(self.context) and rows[0]['kind'] == 'desktop'
        assert api_key == PRIVATE
        return [{**rows[0], 'templateId': 'owned-template', 'status': 'retained_public' if self.case == 'public' else 'deleted'}]


class Guards(unittest.TestCase):
    def run_case(self, case):
        fake = Fake(case)
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()) as captured:
            output = Path(folder) / 'receipt.json'
            ledger = probe.diagnose(fake.builder, fake.cleaner, fake.create, fake.context, PRIVATE, '// reviewed hook', output)
            self.assertEqual(json.loads(output.read_text()), ledger)
            self.assertNotIn(PRIVATE, output.read_text() + captured.getvalue())
        return fake, ledger

    def test_real_ops_and_source_identities_remain_distinct_and_exact(self):
        result = probe.identity(ENV)
        self.assertEqual(result['sourceCommit'], probe.SOURCE_SHA)
        self.assertEqual(result['opsCommit'], ENV['GITHUB_SHA'])
        self.assertEqual(result['ref'], ENV['GITHUB_REF'])
        self.assertEqual(result['repository'], ENV['GITHUB_REPOSITORY'])
        self.assertEqual(ENV['GITHUB_REF'], probe.BRANCH)
        for key, value in [('GITHUB_REF', 'refs/heads/main'), ('GITHUB_REPOSITORY', 'other/repo'),
                           ('GITHUB_SHA', PRIVATE), ('GITHUB_RUN_ID', '0'), ('GITHUB_RUN_ATTEMPT', '0')]:
            with self.assertRaises(probe.DiagnosticFailure):
                probe.identity({**ENV, key: value})

    def test_source_and_ops_checkout_guards_refuse_wrong_or_dirty_source(self):
        with patch.object(probe.subprocess, 'run', return_value=SimpleNamespace(stdout='b' * 40, returncode=0)):
            with self.assertRaisesRegex(probe.DiagnosticFailure, 'source_mismatch'):
                probe.verify_checkout(Path('.'), probe.SOURCE_SHA, 'source_mismatch')
            with self.assertRaisesRegex(probe.DiagnosticFailure, 'ops_checkout_mismatch'):
                probe.verify_checkout(Path('.'), ENV['GITHUB_SHA'], 'ops_checkout_mismatch')
        with patch.object(probe.subprocess, 'run', side_effect=[SimpleNamespace(stdout=probe.SOURCE_SHA, returncode=0), SimpleNamespace(returncode=1)]):
            with self.assertRaisesRegex(probe.DiagnosticFailure, 'source_dirty'):
                probe.verify_checkout(Path('.'), probe.SOURCE_SHA, 'source_mismatch')

    def test_success_is_only_a_catalogue_diagnostic_and_preserves_original_bounds(self):
        fake, ledger = self.run_case('success')
        self.assertEqual(ledger['probe']['status'], 'passed')
        self.assertEqual(ledger['probe']['catalogueCounts'], {'claude_code': 1, 'codex': 1})
        self.assertEqual(ledger['cleanup']['status'], 'complete')
        self.assertFalse(ledger['releaseAccepted'])
        self.assertEqual(sum(c[0] == 'build' for c in fake.calls), 1)
        self.assertEqual(sum(c[0] == 'create' for c in fake.calls), 1)
        self.assertEqual(sum(c[0] == 'command' for c in fake.calls), 1)
        self.assertEqual(ledger['budget']['internalProbeMilliseconds'], 20000)
        self.assertEqual(ledger['candidate']['templateId'], 'owned-template')
        self.assertEqual(ledger['sandboxes'][0]['sandboxId'], 'owned-sandbox')

    def test_timeout_preserves_closed_events_and_still_cleans_both_owned_resources(self):
        fake, ledger = self.run_case('timeout')
        self.assertEqual(ledger['probe']['status'], 'failed')
        self.assertEqual(ledger['probe']['error']['type'], 'TimeoutException')
        self.assertEqual(ledger['events'][0]['phase'], 'spawn')
        self.assertEqual(ledger['cleanup']['status'], 'complete')
        self.assertEqual([c[0] for c in fake.calls][-2:], ['clean_sandboxes', 'clean_templates'])

    def test_partial_build_and_partial_sandbox_creation_recover_by_owned_identity(self):
        for case in ['build_failure', 'create_partial']:
            fake, ledger = self.run_case(case)
            self.assertEqual(ledger['probe']['status'], 'failed')
            self.assertTrue(ledger['candidate']['absenceConfirmed'])
            self.assertEqual(ledger['cleanup']['status'], 'complete')
            self.assertIn(('clean_sandboxes', [fake.context]), fake.calls)
            self.assertEqual(ledger['candidate']['templateId'], 'owned-template')
            if case == 'create_partial':
                self.assertEqual(ledger['sandboxes'][0]['status'], 'recovered_by_metadata')

    def test_repeated_finalizer_keeps_the_first_cleanup_resource_evidence(self):
        fake, ledger = self.run_case('create_partial')
        fake.cleaner.cleanup_sandboxes = lambda *_: []
        fake.builder.cleanup_templates = lambda rows, _: [{**rows[0], 'status': 'absent'}]
        with tempfile.TemporaryDirectory() as directory:
            self.assertTrue(probe.cleanup_owned(fake.builder, fake.cleaner, fake.context, PRIVATE,
                                               ledger, Path(directory) / 'receipt.json'))
        self.assertEqual(ledger['sandboxes'][0]['sandboxId'], 'owned-sandbox')
        self.assertEqual(ledger['candidate']['templateId'], 'owned-template')
        self.assertEqual(len(ledger['cleanupHistory']), 2)
        self.assertEqual(ledger['cleanupHistory'][0]['sandboxes'][0]['status'], 'killed')
        self.assertTrue(ledger['cleanup']['metadataScanComplete'])

    def test_preexisting_name_and_prebuild_collision_never_grant_cleanup_ownership(self):
        for case in ['already_exists', 'collision']:
            fake, ledger = self.run_case(case)
            self.assertEqual(ledger['probe']['status'], 'failed')
            self.assertFalse(ledger['candidate']['absenceConfirmed'])
            self.assertFalse(any(c[0].startswith('clean_') for c in fake.calls))

    def test_public_candidate_is_refused_without_starting_a_probe(self):
        fake, ledger = self.run_case('public')
        self.assertEqual(ledger['probe']['error']['code'], 'candidate_not_private')
        self.assertEqual(ledger['cleanup']['status'], 'incomplete')
        self.assertFalse(any(c[0] == 'create' for c in fake.calls))

    def test_missing_catalogue_and_cleanup_failure_are_not_success(self):
        _, missing = self.run_case('missing_catalogue')
        self.assertEqual(missing['probe']['error']['code'], 'catalogue_missing')
        _, cleanup = self.run_case('cleanup_failure')
        self.assertEqual(cleanup['probe']['status'], 'passed')
        self.assertEqual(cleanup['cleanup']['status'], 'incomplete')

    def test_cleanup_rejects_changed_workflow_identity_candidate_and_injected_fields(self):
        fake = Fake()
        baseline = probe.new_ledger(fake.context)
        baseline['candidate']['absenceConfirmed'] = True
        mutations = [lambda row: row['identity'].update(opsCommit='b' * 40),
                     lambda row: row['identity'].update(sourceCommit='b' * 40),
                     lambda row: row['identity'].update(runId='999'),
                     lambda row: row['identity'].update(runAttempt='3'),
                     lambda row: row['candidate'].update(name='desktop'),
                     lambda row: row['candidate'].update(templateId=PRIVATE),
                     lambda row: row.update(secret=PRIVATE)]
        with tempfile.TemporaryDirectory() as directory:
            for mutate in mutations:
                ledger = deepcopy(baseline); mutate(ledger)
                with self.assertRaises(probe.DiagnosticFailure):
                    probe.cleanup_owned(fake.builder, fake.cleaner, fake.context, PRIVATE, ledger, Path(directory) / 'receipt.json')
        self.assertFalse(fake.calls)

    def test_collector_drops_private_unrecognized_and_oversized_content(self):
        ledger = probe.new_ledger(probe.identity(ENV))
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as captured:
            callback = probe.Collector(ledger, Path(directory) / 'receipt.json')
            for value in [{'version': 1, 'phase': 'entry', 'secret': PRIVATE},
                          {'version': 1, 'phase': PRIVATE}, {'version': 1, 'phase': ['entry']},
                          {'version': 1, 'phase': 'spawn', 'pid': PRIVATE},
                          {'version': 1, 'phase': 'spawn', 'catalogueSeen': PRIVATE},
                          {'version': 1, 'phase': 'parent_deadline_snapshot', 'resources': {PRIVATE: 1}}]:
                callback(probe.PREFIX + json.dumps(value) + '\n')
            callback(PRIVATE * 1000)
            callback(probe.PREFIX + json.dumps({'version': 1, 'phase': 'parent_exit', 'elapsedMs': 7, 'exitCode': 0, 'spawned': 2, 'catalogues': 2, 'exited': 2, 'closed': 2}) + '\n')
            self.assertEqual(len(ledger['events']), 1)
            self.assertNotIn(PRIVATE, captured.getvalue() + json.dumps(ledger))

    def test_workflow_is_branch_scoped_pinned_and_reads_only_the_existing_e2b_key(self):
        workflow = (HERE.parents[1] / '.github/workflows/issue1512-e2b-probe.yml').read_text()
        self.assertIn('branches: [ops/1512-git-transport]', workflow)
        self.assertIn("startsWith(github.event.head_commit.message, 'issue1512:probe')", workflow)
        self.assertIn('ref: ' + probe.SOURCE_SHA, workflow)
        self.assertIn('ref: ${{ github.sha }}', workflow)
        self.assertEqual(workflow.count('persist-credentials: false'), 2)
        self.assertEqual(re.findall(r'secret-name: (\S+)', workflow), ['E2B_API_KEY'])
        self.assertIn('identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', workflow)
        self.assertIn('secret-path: /vercel', workflow)
        self.assertIn('env-slug: prod', workflow)
        self.assertIn('id-token: write', workflow)
        for action in re.findall(r'uses: (\S+)', workflow):
            self.assertRegex(action, r'^[^@]+@[a-f0-9]{40}$')
        for forbidden in ['ACME_', 'SMOKE_', 'VERCEL_TOKEN', 'GITHUB_SHA:', 'GITHUB_REF:', 'contents: write', 'workflow_dispatch']:
            self.assertNotIn(forbidden, workflow)
        self.assertIn("if: always() && steps.key.outcome == 'success'", workflow)


if __name__ == '__main__':
    unittest.main()
