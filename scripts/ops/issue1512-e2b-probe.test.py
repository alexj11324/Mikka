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
from urllib.error import HTTPError
from urllib.parse import unquote

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
        self.case, self.calls, self.deleted = case, [], False
        self.context = probe.identity(ENV)
        self.built = case == 'already_exists'
        self.candidate = {'kind': 'desktop', 'name': probe.candidate_name(self.context),
                          'templateId': 'owned-template', 'buildId': 'owned-build'}
        self.builder = SimpleNamespace(_request=self.info, build=self.build)
        self.cleaner = SimpleNamespace(cleanup_sandboxes=self.clean_sandboxes)
        self.sandbox = SimpleNamespace(sandbox_id='owned-sandbox',
                                      files=SimpleNamespace(write=self.write), commands=SimpleNamespace(run=self.command))

    def build(self, name, **kwargs):
        self.calls.append(('build', name, kwargs))
        assert name == self.candidate['name']
        assert kwargs['ref'] == probe.SOURCE_SHA and kwargs['kind'] == 'desktop'
        assert kwargs['cpu_count'] == 2 and kwargs['memory_mb'] == 4096 and kwargs['api_key'] == PRIVATE
        kwargs['on_build_logs'](PRIVATE)
        if self.case == 'build_before_create':
            raise RuntimeError(PRIVATE)
        self.built = True
        if self.case == 'build_partial':
            raise RuntimeError(PRIVATE)
        return probe.SOURCE_SHA, SimpleNamespace(template_id=self.candidate['templateId'], build_id=self.candidate['buildId'])

    def info(self, method, path, api_key):
        self.calls.append(('info', method, path))
        assert api_key == PRIVATE
        candidate = self.candidate
        if method == 'DELETE':
            assert path == '/templates/' + candidate['templateId']
            if self.case != 'delete_not_applied':
                self.deleted = True
            return None
        assert method == 'GET'
        if path == '/templates/' + candidate['templateId']:
            if self.deleted or self.case == 'absent':
                raise HTTPError('fixture', 404, PRIVATE, {}, None)
            value = {'templateID': candidate['templateId'], 'buildID': candidate['buildId'],
                     'names': [candidate['name']], 'aliases': [], 'public': False, 'isDefault': False,
                     'buildCount': 1, 'builds': [{'buildID': candidate['buildId'], 'status': 'ready'}]}
            if self.case in {'qualified', 'qualified_fallback', 'qualified_alias_wrong', 'qualified_missing'}:
                value['names'] = ['fixture-project/' + candidate['name']]
            if self.case == 'qualified_ambiguous':
                value['names'] = ['first/' + candidate['name'], 'second/' + candidate['name']]
            if self.case == 'suffix_only':
                value['names'] = ['foreign-prefix-' + candidate['name']]
            if self.case == 'public':
                value['public'] = True
            if self.case == 'visibility_missing':
                value.pop('public')
            if self.case == 'default':
                value['isDefault'] = True
            if self.case == 'default_absent':
                value.pop('isDefault')
            if self.case == 'wrong_id':
                value['templateID'] = 'foreign-template'
            if self.case == 'wrong_build' or (self.case == 'changed_before_cleanup' and any(c[0] == 'create' for c in self.calls)):
                value['buildID'] = 'foreign-build'
            if self.case == 'extra_build':
                value['builds'].append({'buildID': 'foreign-build', 'status': 'ready'})
            if self.case == 'build_missing':
                value['builds'] = []
            if self.case == 'build_partial':
                value['builds'][0]['status'] = 'error'
                value.pop('buildID')
            return value
        if path.startswith('/templates/aliases/'):
            alias = unquote(path.removeprefix('/templates/aliases/'))
            assert alias in {candidate['name'], 'fixture-project/' + candidate['name']}
            if not self.built:
                raise HTTPError('fixture', 404, PRIVATE, {}, None)
            if (self.case in {'qualified_fallback', 'qualified_alias_wrong', 'qualified_missing'} and alias == candidate['name']) or self.case == 'alias_missing':
                raise HTTPError('fixture', 404, PRIVATE, {}, None)
            if self.case == 'qualified_missing':
                raise HTTPError('fixture', 404, PRIVATE, {}, None)
            return {'templateID': 'foreign-template' if self.case in {'alias_wrong', 'qualified_alias_wrong'} else candidate['templateId'],
                    'public': False}
        # Reproduce the real API: a name in the template-ID route is not an ID.
        raise HTTPError('fixture', 404, PRIVATE, {}, None)

    def create(self, template, **kwargs):
        self.calls.append(('create', template, kwargs))
        assert template == self.candidate['templateId']
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
        for phase in sorted(probe.MARKERS):
            callback(probe.PREFIX + json.dumps({'version': 1, 'phase': phase, 'elapsedMs': 4}) + '\n')
        callback(probe.PREFIX + json.dumps({'version': 1, 'phase': 'spawn', 'harness': 'codex', 'pid': 42, 'elapsedMs': 4}) + '\n')
        if self.case == 'missing_marker':
            callback(probe.PREFIX + json.dumps({'version': 1, 'phase': 'marker_unavailable', 'marker': 'hosted_probe_enter', 'elapsedMs': 4}) + '\n')
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

class Guards(unittest.TestCase):
    def run_case(self, case):
        fake = Fake(case)
        with tempfile.TemporaryDirectory() as folder, contextlib.redirect_stdout(io.StringIO()) as captured:
            output = Path(folder) / 'receipt.json'
            ledger = probe.diagnose(fake.builder, fake.cleaner, fake.create, fake.context, PRIVATE, '// reviewed hook', output)
            self.assertEqual(json.loads(output.read_text()), ledger)
            self.assertNotIn(PRIVATE, output.read_text() + captured.getvalue())
            self.assertNotIn('fixture-project', output.read_text() + captured.getvalue())
        return fake, ledger

    def test_real_ops_and_source_identities_remain_distinct_and_exact(self):
        result = probe.identity(ENV)
        self.assertEqual(result['sourceCommit'], probe.SOURCE_SHA)
        self.assertEqual(result['opsCommit'], ENV['GITHUB_SHA'])
        self.assertEqual(result['ref'], ENV['GITHUB_REF'])
        self.assertEqual(result['repository'], ENV['GITHUB_REPOSITORY'])
        self.assertEqual(ENV['GITHUB_REF'], probe.BRANCH)
        ledger = probe.new_ledger(result)
        self.assertEqual(ledger['candidateOrigin'], result)
        self.assertIsNot(ledger['candidateOrigin'], result)
        self.assertEqual(ledger['candidate']['name'], 'mikka-i1512-123456-2-desktop')
        self.assertNotIn('templateId', ledger['candidate'])
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
        self.assertEqual(ledger['budget']['candidates'], 1)
        self.assertEqual(ledger['budget']['cpuCount'], 2)
        self.assertEqual(ledger['budget']['memoryMiB'], 4096)
        self.assertEqual(sum(c[0] == 'build' for c in fake.calls), 1)
        self.assertEqual(sum(c[0] == 'create' for c in fake.calls), 1)
        self.assertEqual(sum(c[0] == 'command' for c in fake.calls), 1)
        self.assertEqual(ledger['budget']['internalProbeMilliseconds'], 20000)
        self.assertEqual({key: ledger['candidate'][key] for key in fake.candidate}, fake.candidate)
        self.assertEqual(ledger['sandboxes'][0]['sandboxId'], 'owned-sandbox')
        self.assertEqual(ledger['cleanup']['templates'][0]['templateId'], fake.candidate['templateId'])
        self.assertTrue(ledger['cleanup']['templates'][0]['absenceConfirmedById'])
        self.assertEqual(fake.calls[-1], ('info', 'GET', '/templates/' + fake.candidate['templateId']))
        self.assertTrue(fake.deleted)

    def test_timeout_preserves_closed_events_and_still_cleans_both_owned_resources(self):
        fake, ledger = self.run_case('timeout')
        self.assertEqual(ledger['probe']['status'], 'failed')
        self.assertEqual(ledger['probe']['error']['type'], 'TimeoutException')
        self.assertTrue(any(event['phase'] == 'spawn' for event in ledger['events']))
        self.assertEqual(ledger['cleanup']['status'], 'complete')
        self.assertIn(('clean_sandboxes', [fake.context]), fake.calls)
        self.assertTrue(fake.deleted)

    def test_partial_sandbox_creation_recovers_only_the_current_exact_workflow_identity(self):
        fake, ledger = self.run_case('create_partial')
        self.assertEqual(ledger['probe']['status'], 'failed')
        self.assertEqual(ledger['cleanup']['status'], 'complete')
        self.assertIn(('clean_sandboxes', [fake.context]), fake.calls)
        self.assertEqual(ledger['sandboxes'][0]['status'], 'recovered_by_metadata')

    def test_repeated_finalizer_keeps_the_first_cleanup_resource_evidence(self):
        fake, ledger = self.run_case('create_partial')
        fake.cleaner.cleanup_sandboxes = lambda *_: []
        with tempfile.TemporaryDirectory() as directory:
            self.assertTrue(probe.cleanup_owned(fake.builder, fake.cleaner, fake.context, PRIVATE,
                                               ledger, Path(directory) / 'receipt.json'))
        self.assertEqual(ledger['sandboxes'][0]['sandboxId'], 'owned-sandbox')
        self.assertEqual(ledger['candidate']['templateId'], fake.candidate['templateId'])
        self.assertEqual(len(ledger['cleanupHistory']), 2)
        self.assertEqual(ledger['cleanupHistory'][0]['sandboxes'][0]['status'], 'killed')
        self.assertTrue(ledger['cleanup']['metadataScanComplete'])
        self.assertEqual(ledger['cleanup']['templates'][0]['status'], 'absent')
        self.assertTrue(ledger['cleanup']['templates'][0]['absenceConfirmedById'])

    def test_public_default_and_unknown_visibility_refuse_probe_and_deletion(self):
        for case in ['public', 'default', 'visibility_missing']:
            fake, ledger = self.run_case(case)
            self.assertEqual(ledger['probe']['error']['code'], 'candidate_not_private')
            self.assertEqual(ledger['cleanup']['status'], 'incomplete')
            self.assertFalse(any(c[0] == 'create' or c[:2] == ('info', 'DELETE') for c in fake.calls))

    def test_exact_id_build_and_name_binding_are_required_before_any_probe_or_deletion(self):
        for case in ['wrong_id', 'wrong_build', 'extra_build', 'build_missing', 'suffix_only',
                     'alias_wrong', 'alias_missing', 'qualified_ambiguous', 'qualified_alias_wrong', 'qualified_missing']:
            with self.subTest(case=case):
                fake, ledger = self.run_case(case)
                self.assertEqual(ledger['probe']['status'], 'failed')
                self.assertEqual(ledger['cleanup']['status'], 'incomplete')
                self.assertFalse(any(c[0] == 'create' or c[:2] == ('info', 'DELETE') for c in fake.calls))

    def test_namespaced_name_is_verified_by_the_real_alias_response_without_logging_namespace(self):
        for case in ['qualified', 'qualified_fallback']:
            fake, ledger = self.run_case(case)
            self.assertEqual(ledger['probe']['status'], 'passed')
            check = ledger['candidateChecks'][0]
            self.assertEqual(check['exactNameCount'], 0)
            self.assertEqual(check['qualifiedNameCount'], 1)
            self.assertTrue(check['aliasAttempts'][-1]['templateIdMatches'])
            if case == 'qualified_fallback':
                self.assertEqual(check['aliasAttempts'][0]['httpStatus'], 404)
                self.assertEqual(check['aliasAttempts'][1]['form'], 'qualified')
                self.assertIn(('info', 'GET', '/templates/aliases/fixture-project%2F' + fake.candidate['name']), fake.calls)

    def test_optional_default_field_matches_the_official_schema(self):
        _, ledger = self.run_case('default_absent')
        self.assertEqual(ledger['probe']['status'], 'passed')
        self.assertEqual(ledger['candidateChecks'][0]['isDefault'], 'absent')

    def test_an_absent_returned_id_is_recorded_without_rebuilding_or_starting_a_vm(self):
        fake, ledger = self.run_case('absent')
        self.assertEqual(ledger['probe']['error']['code'], 'candidate_missing')
        self.assertEqual(ledger['cleanup']['status'], 'complete')
        self.assertTrue(ledger['cleanup']['templates'][0]['absenceConfirmedById'])
        self.assertFalse(any(c[0] == 'create' or c[:2] == ('info', 'DELETE') for c in fake.calls))
        self.assertEqual(sum(c[0] == 'build' for c in fake.calls), 1)

    def test_correct_alias_preflight_refuses_a_preexisting_name_without_building_or_cleanup(self):
        fake, ledger = self.run_case('already_exists')
        self.assertEqual(ledger['probe']['error']['code'], 'candidate_collision')
        self.assertEqual(fake.calls, [('info', 'GET', '/templates/aliases/' + fake.candidate['name'])])
        self.assertFalse(ledger['candidate']['absenceConfirmed'])

    def test_partial_build_recovers_its_id_and_failed_build_through_the_owned_alias(self):
        fake, ledger = self.run_case('build_partial')
        self.assertEqual(ledger['probe']['status'], 'failed')
        self.assertEqual(ledger['candidate']['templateId'], fake.candidate['templateId'])
        self.assertEqual(ledger['candidate']['buildId'], fake.candidate['buildId'])
        self.assertEqual(ledger['cleanup']['status'], 'complete')
        self.assertTrue(fake.deleted)
        self.assertFalse(any(c[0] == 'create' for c in fake.calls))

    def test_no_returned_id_and_no_resolvable_alias_never_claims_id_absence(self):
        fake, ledger = self.run_case('build_before_create')
        self.assertEqual(ledger['cleanup']['status'], 'incomplete')
        self.assertEqual(ledger['cleanup']['errors'][0]['code'], 'candidate_identity_unresolved')
        self.assertFalse(any(c[:2] == ('info', 'DELETE') for c in fake.calls))
        self.assertNotIn('absenceConfirmedById', ledger['cleanup']['templates'][0])

    def test_missing_source_markers_are_an_observer_failure_even_if_catalogues_return(self):
        _, ledger = self.run_case('missing_marker')
        self.assertEqual(ledger['probe']['error']['code'], 'boundary_observer_incomplete')
        self.assertEqual(ledger['cleanup']['status'], 'complete')

    def test_a_concurrent_build_change_prevents_deletion_and_is_not_a_cleanup_pass(self):
        fake, ledger = self.run_case('changed_before_cleanup')
        self.assertEqual(ledger['probe']['status'], 'passed')
        self.assertEqual(ledger['cleanup']['status'], 'incomplete')
        self.assertFalse(any(c[:2] == ('info', 'DELETE') for c in fake.calls))
        self.assertEqual(ledger['cleanup']['errors'][0]['code'], 'candidate_build_mismatch')

    def test_delete_success_alone_never_counts_as_absence(self):
        _, ledger = self.run_case('delete_not_applied')
        self.assertEqual(ledger['cleanup']['status'], 'incomplete')
        self.assertEqual(ledger['cleanup']['errors'][0]['code'], 'candidate_still_exists')

    def test_missing_catalogue_and_cleanup_failure_are_not_success(self):
        _, missing = self.run_case('missing_catalogue')
        self.assertEqual(missing['probe']['error']['code'], 'catalogue_missing')
        _, cleanup = self.run_case('cleanup_failure')
        self.assertEqual(cleanup['probe']['status'], 'passed')
        self.assertEqual(cleanup['cleanup']['status'], 'incomplete')

    def test_cleanup_rejects_changed_workflow_identity_candidate_and_injected_fields(self):
        fake = Fake()
        baseline = probe.new_ledger(fake.context)
        mutations = [lambda row: row['identity'].update(opsCommit='b' * 40),
                     lambda row: row['identity'].update(sourceCommit='b' * 40),
                     lambda row: row['identity'].update(runId='999'),
                     lambda row: row['identity'].update(runAttempt='3'),
                     lambda row: row['candidateOrigin'].update(runId='999'),
                     lambda row: row['candidateOrigin'].update(opsCommit='b' * 40),
                     lambda row: row['candidate'].update(name='desktop'),
                     lambda row: row['candidate'].update(buildId='foreign-build'),
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
        self.assertIn('probe.py diagnose', workflow)
        self.assertNotIn('probe.py probe-existing', workflow)


if __name__ == '__main__':
    unittest.main()
