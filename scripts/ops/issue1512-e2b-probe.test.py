"""Offline fake transports only: this file never imports or calls the E2B SDK."""
import contextlib
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
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
RELEASE_COMMAND = ('export PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH; '
                   'python3 /opt/mikka/worker/scripts/e2b/official-files.py cli-verify '
                   '/opt/mikka/worker/.mikka-original-cli.json --kind {kind} && '
                   'exec /opt/mikka/runtime/node/bin/node /opt/mikka/worker/packages/daemon/dist/cloud/cloud-model-probe.js')
VERIFIED = {'kind': 'desktop', 'files': [
    {'harness': 'claude_code', 'bytes': 100, 'elapsedMs': 2, 'matched': True},
    {'harness': 'codex', 'bytes': 200, 'elapsedMs': 3, 'matched': True}], 'elapsedMs': 7}


class TimeoutException(Exception):
    pass


class Fake:
    def __init__(self, case='success'):
        self.case, self.calls, self.deleted = case, [], False
        self.context = probe.identity(ENV)
        self.built = case == 'already_exists'
        self.candidate = {'kind': 'desktop', 'name': probe.candidate_name(self.context),
                          'templateId': 'owned-template', 'buildId': 'owned-build'}
        self.builder = SimpleNamespace(_request=self.info, build=self.build, MODEL_PROBE_COMMAND=RELEASE_COMMAND)
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
        assert command.endswith('/opt/mikka/worker/packages/daemon/dist/cloud/cloud-model-probe.js')
        assert 'cloud-worker.js' not in command and '--probe-models' not in command
        assert '--import /tmp/mikka-i1512-probe-' in command
        assert re.sub(r' --import /tmp/mikka-i1512-probe-[0-9]+-[0-9]+\.mjs', '', command) == RELEASE_COMMAND.format(kind='desktop')
        assert PRIVATE not in command and 'bootstrap.json' not in command
        callback = kwargs['on_stderr']
        callback(PRIVATE + '\n')
        if self.case != 'missing_verification':
            callback(probe.VERIFICATION_PREFIX + json.dumps(VERIFIED) + '\n')
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

    def test_actual_release_integrity_and_catalogue_share_one_original_command_budget(self):
        fake, ledger = self.run_case('success')
        self.assertEqual(ledger['version'], 6)
        self.assertEqual(ledger['cliVerification'], VERIFIED)
        self.assertTrue(ledger['budget']['cliIntegrityWithinCommand'])
        commands = [call for call in fake.calls if call[0] == 'command']
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][2]['timeout'], 45)
        self.assertLess(commands[0][1].index(' cli-verify '), commands[0][1].index(' --import '))

    def test_missing_integrity_receipt_does_not_pass_despite_successful_catalogues(self):
        _, ledger = self.run_case('missing_verification')
        self.assertEqual(ledger['probe']['error']['code'], 'cli_verification_missing')
        self.assertEqual(ledger['cleanup']['status'], 'complete')

    def test_integrity_receipt_is_numeric_closed_and_unique(self):
        ledger = probe.new_ledger(probe.identity(ENV))
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as captured:
            collect = probe.Collector(ledger, Path(directory) / 'receipt.json')
            invalid = [dict(VERIFIED, path=PRIVATE), dict(VERIFIED, elapsedMs=True),
                       dict(VERIFIED, files=[VERIFIED['files'][0]] * 2),
                       dict(VERIFIED, files=[dict(VERIFIED['files'][0], matched=False), VERIFIED['files'][1]]),
                       dict(VERIFIED, files=[dict(VERIFIED['files'][0], bytes=PRIVATE), VERIFIED['files'][1]])]
            for value in [*invalid, VERIFIED, VERIFIED]:
                collect(probe.VERIFICATION_PREFIX + json.dumps(value) + '\n')
            self.assertEqual(ledger['cliVerification'], VERIFIED)
            self.assertEqual(ledger['ignoredDiagnosticLines'], len(invalid) + 1)
            self.assertNotIn(PRIVATE, json.dumps(ledger) + captured.getvalue())

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

    def test_resource_schema_accepts_only_closed_kernel_numbers_and_enums(self):
        row = {'version': 1, 'phase': 'process_snapshot', 'sample': 'after_5s', 'elapsedMs': 5000,
               'harness': 'codex', 'pid': 42, 'ppid': 7, 'depth': 0, 'startTicks': 100,
               'state': 'S', 'wait': 'epoll', 'utimeTicks': 15, 'stimeTicks': 2, 'readBytes': 4096}
        self.assertEqual(probe.closed_event(row), row)
        for change in [{'comm': PRIVATE}, {'cmdline': PRIVATE}, {'path': PRIVATE}, {'wait': PRIVATE},
                       {'state': PRIVATE}, {'sample': 'after_30s'}, {'depth': 2}, {'pid': 0},
                       {'utimeTicks': -1}, {'readBytes': 2**53}, {'rssPages': True}]:
            self.assertIsNone(probe.closed_event({**row, **change}))
        vm = {'version': 1, 'phase': 'vm_snapshot', 'sample': 'cli_deadline', 'elapsedMs': 20000,
              'trackedProcesses': 0, 'snapshotMs': 2, 'cpuPressureSomeUs': 1300, 'memAvailableKiB': 1024}
        self.assertEqual(probe.closed_event(vm), vm)
        self.assertIsNone(probe.closed_event({**vm, 'trackedProcesses': 13}))
        self.assertIsNone(probe.closed_event({**vm, 'pressure': PRIVATE}))

    def test_resource_collector_requires_owned_roots_and_only_one_descendant_level(self):
        ledger = probe.new_ledger(probe.identity(ENV))
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            collect = probe.Collector(ledger, Path(directory) / 'receipt.json')
            def send(row): collect(probe.PREFIX + json.dumps({'version': 1, 'elapsedMs': 1, **row}) + '\n')
            row = {'phase': 'process_snapshot', 'sample': 'after_5s', 'harness': 'codex', 'pid': 42,
                   'ppid': 7, 'depth': 0, 'state': 'R', 'wait': 'other', 'startTicks': 100}
            send(row)  # No preceding owned spawn.
            send({'phase': 'spawn', 'harness': 'codex', 'pid': 42})
            send(row)
            send({**row, 'pid': 43, 'ppid': 999, 'depth': 1})
            send({**row, 'pid': 43, 'ppid': 42, 'depth': 1})
            send({**row, 'pid': 44, 'ppid': 43, 'depth': 1})
            send({**row, 'pid': 45, 'ppid': 42, 'harness': 'claude_code', 'depth': 1})
            processes = [event for event in ledger['events'] if event['phase'] == 'process_snapshot']
            self.assertEqual([event['pid'] for event in processes], [42, 43])

    def test_resource_collector_caps_three_snapshots_and_twelve_processes_per_snapshot(self):
        ledger = probe.new_ledger(probe.identity(ENV))
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            collect = probe.Collector(ledger, Path(directory) / 'receipt.json')
            def send(row): collect(probe.PREFIX + json.dumps({'version': 1, 'elapsedMs': 1, **row}) + '\n')
            send({'phase': 'spawn', 'harness': 'codex', 'pid': 42})
            for sample in ['after_5s', 'after_15s', 'cli_deadline', 'after_30s']:
                for pid in range(100, 120):
                    row = {'phase': 'process_snapshot', 'sample': sample, 'harness': 'codex', 'pid': pid,
                           'ppid': 42, 'depth': 1, 'state': 'D', 'wait': 'io', 'startTicks': 100}
                    send(row); send(row)
                vm = {'phase': 'vm_snapshot', 'sample': sample, 'trackedProcesses': 12, 'snapshotMs': 2}
                send(vm); send(vm)
            self.assertEqual(sum(event['phase'] == 'process_snapshot' for event in ledger['events']), 36)
            self.assertEqual(sum(event['phase'] == 'vm_snapshot' for event in ledger['events']), 3)
            self.assertEqual(ledger['budget']['resourceSnapshots'], 3)
            self.assertEqual(ledger['budget']['maxSnapshotProcesses'], 12)

    def test_actual_observer_with_fake_kernel_files_drops_names_pid_reuse_and_foreign_descendants(self):
        hook = (HERE / 'issue1512-e2b-probe-hook.mjs').read_text()
        reader = hook[hook.index('function readKernel('):hook.index('// Pure observer boundary')]
        observer = hook[hook.index('function createResourceObserver('):hook.index('// End bounded kernel observer.')]
        program = r'''
import assert from 'node:assert/strict'
let closed = 0, size = 3
const openSync = () => 8, closeSync = () => closed++
const readSync = (_fd, buffer, offset, length) => { assert.equal(offset, 0); assert.equal(length, 8193); buffer.write('123'); return size }
assert.equal(readKernel('unused-fixture'), '123')
size = 8193; assert.equal(readKernel('unused-fixture'), undefined); assert.equal(closed, 2)
const files = new Map(), reads = [], events = []
function stat(pid, ppid, start = 100, state = 'R') {
  const fields = Array(50).fill('0'); fields[0] = state
  for (const [index, value] of [[1, ppid], [7, 17], [9, 1], [11, 31], [12, 13], [19, start], [21, 22]]) fields[index] = String(value)
  return `${pid} (private-comm ) must-not-escape) ${fields.join(' ')}`
}
for (const [pid, ppid] of [[11, 7], [12, 7], [21, 11], [22, 999], [29, 21]]) files.set(`/proc/${pid}/stat`, stat(pid, ppid))
files.set('/proc/11/task/11/children', '21 22 29')
files.set('/proc/21/io', 'read_bytes: 512\nwrite_bytes: 1024\n')
files.set('/proc/21/wchan', 'futex_wait_queue')
files.set('/proc/11/wchan', 'private-kernel-symbol')
files.set('/proc/stat', 'cpu 1 2 3 4 5 6 7 8 0 0\n')
for (const key of ['cpu', 'memory', 'io']) files.set(`/proc/pressure/${key}`, 'some avg10=0.00 avg60=0.00 avg300=0.00 total=45\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=19\n')
files.set('/proc/meminfo', 'MemAvailable: 1234 kB\n')
files.set('/sys/fs/cgroup/memory.current', '4096\n')
files.set('/sys/fs/cgroup/cpu.stat', 'usage_usec 42\nuser_usec 30\nsystem_usec 12\nnr_periods 5\nnr_throttled 2\nthrottled_usec 90\n')
const read = path => { reads.push(path); return files.get(path)?.replaceAll('\\n', '\n') }
const resource = createResourceObserver(read, row => events.push(row), 7)
resource.track(11, 'claude_code'); resource.track(12, 'codex'); resource.track(99, 'other')
resource.sample('after_5s'); resource.sample('after_5s')
assert.deepEqual(events.filter(row => row.phase === 'process_snapshot').map(row => row.pid), [11, 12, 21])
assert.equal(events[0].utimeTicks, 31); assert.equal(events[0].stimeTicks, 13)
assert.equal(events[0].minFaults, 17); assert.equal(events[0].majorFaults, 1); assert.equal(events[0].rssPages, 22)
assert.equal(events[0].wait, 'other'); assert.equal(events[2].wait, 'futex'); assert.equal(events[2].readBytes, 512)
assert.ok(!('readBytes' in events[1]))
const vm = events.find(row => row.phase === 'vm_snapshot')
assert.equal(vm.cpuIdleTicks, 4); assert.equal(vm.cpuPressureSomeUs, 45); assert.equal(vm.memoryPressureFullUs, 19)
assert.equal(vm.memAvailableKiB, 1234); assert.equal(vm.cgroupMemoryBytes, 4096); assert.equal(vm.cgroupThrottledUs, 90)
files.set('/proc/11/stat', stat(11, 7, 999))
const before = events.length, beforeReads = reads.length
resource.sample('after_15s')
assert.deepEqual(events.slice(before).filter(row => row.phase === 'process_snapshot').map(row => row.pid), [12])
assert.ok(!reads.slice(beforeReads).includes('/proc/11/io'))
resource.sample('cli_deadline'); resource.sample('cli_deadline'); resource.sample('after_30s')
assert.equal(events.filter(row => row.phase === 'vm_snapshot').length, 3)
assert.ok(!JSON.stringify(events).includes('private-'))
assert.ok(reads.every(path => /^\/proc\/(?:\d+\/(?:stat|io|wchan|task\/\d+\/children)|stat|meminfo|pressure\/(?:cpu|memory|io))$/.test(path) || /^\/sys\/fs\/cgroup\/(?:memory.current|cpu.stat)$/.test(path)))
assert.ok(!reads.includes('/proc/21/task/21/children'))
files.set('/proc/11/stat', stat(11, 7)); files.set('/proc/11/task/11/children', Array.from({ length: 20 }, (_, n) => n + 100).join(' '))
for (let pid = 100; pid < 120; pid++) files.set(`/proc/${pid}/stat`, stat(pid, 11))
const capped = [], cap = createResourceObserver(read, row => capped.push(row), 7)
cap.track(11, 'claude_code'); cap.track(12, 'codex'); cap.sample('after_5s')
assert.equal(capped.filter(row => row.phase === 'process_snapshot').length, 12)
assert.equal(capped.at(-1).trackedProcesses, 12)
const denied = createResourceObserver(() => { throw Error('denied') }, () => { throw Error('must not emit') }, 7)
assert.doesNotThrow(() => { denied.track(11, 'codex'); denied.sample('after_5s') })
console.log(JSON.stringify({ checks: 8, passed: true }))
'''
        node = shutil.which('node')
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([node, '--input-type=module'], input=reader + observer + program,
                                    capture_output=True, text=True, timeout=10,
                                    env={'PATH': '/usr/bin:/bin', 'HOME': directory, 'NODE_OPTIONS': ''})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {'checks': 8, 'passed': True})

    def test_collector_keeps_complete_coalesced_lines_and_bounds_only_the_unfinished_tail(self):
        ledger = probe.new_ledger(probe.identity(ENV))
        rows = [{'version': 1, 'phase': 'spawn', 'harness': 'codex', 'pid': 42}]
        for sample in ['after_5s', 'after_15s', 'cli_deadline']:
            for pid in range(100, 112):
                rows.append({'version': 1, 'phase': 'process_snapshot', 'sample': sample, 'elapsedMs': 20000,
                             'harness': 'codex', 'pid': pid, 'ppid': 42, 'depth': 1, 'state': 'D', 'wait': 'io',
                             **{key: 2**53 - 1 for key in ['startTicks', 'utimeTicks', 'stimeTicks', 'minFaults',
                                                         'majorFaults', 'rssPages', 'readBytes', 'writeBytes']}})
            rows.append({'version': 1, 'phase': 'vm_snapshot', 'sample': sample,
                         'elapsedMs': 20000, 'trackedProcesses': 12, 'snapshotMs': 1})
        lines = [probe.PREFIX + json.dumps(row) + '\n' for row in rows]
        self.assertTrue(all(len(line) <= 4096 for line in lines))
        chunk = ''.join(lines)
        self.assertGreater(len(chunk), 8192)
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            collect = probe.Collector(ledger, Path(directory) / 'receipt.json')
            collect(chunk + 'x' * 8193)
            self.assertEqual(ledger['events'], rows)
            self.assertEqual(ledger['ignoredDiagnosticLines'], 1)
            self.assertEqual(collect.buffer, '')

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
