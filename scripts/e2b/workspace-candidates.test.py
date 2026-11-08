"""Offline boundary tests. No E2B SDK, credentials, templates or VMs needed."""
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from copy import deepcopy
from http import HTTPStatus
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('candidates', Path(__file__).with_name('workspace-candidates.py'))
candidates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidates)
ENV = {'GITHUB_REPOSITORY': 'alexj11324/Mikka', 'GITHUB_SHA': 'b' * 40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2'}
SCOPE = {'sourceCommit': 'a' * 40, 'workerSha': 'c' * 40, 'workflowCommit': ENV['GITHUB_SHA'], 'runId': '123', 'runAttempt': '2'}
PRIVATE = 'synthetic-private-sdk-response-and-key'


class Fixture:
    def __init__(self, output):
        self.output = output
        self.templates, self.aliases, self.sandboxes = {}, {}, {}
        self.calls, self.builds, self.probes, self.created = [], [], [], []
        self.override, self.foreign = {}, []
        self.fail_build = self.collision = self.fail_create = False
        self.emit_creation = True
        self.returned_id = None
        self.status_calls, self.status_error = [], None
        self.status_override = {}
        self.delete_templates = self.delete_sandboxes = True
        self.sdk = (SimpleNamespace(create=self.create, list=self.list, kill=self.kill),
                    SimpleNamespace, SimpleNamespace(RUNNING='running', PAUSED='paused'))

    def request(self, method, path, _key):
        self.calls.append((method, path))
        if path.startswith('/templates/aliases/'):
            name = path.rsplit('/', 1)[1]
            template_id = self.aliases.get(name)
            if template_id:
                return {'templateID': template_id, 'public': self.templates[template_id].get('public')}
        elif path.startswith('/templates/'):
            template_id = path.rsplit('/', 1)[1]
            if method == 'DELETE' and template_id in self.templates:
                if self.delete_templates:
                    self.templates.pop(template_id)
                    self.aliases = {name: identity for name, identity in self.aliases.items() if identity != template_id}
                return None
            if template_id in self.templates:
                return deepcopy(self.templates[template_id])
        elif path.startswith('/sandboxes/'):
            sandbox_id = path.rsplit('/', 1)[1]
            if sandbox_id in self.sandboxes:
                return {**self.sandboxes[sandbox_id], 'envdAccessToken': PRIVATE}
        raise HTTPError('https://provider.invalid', 404, PRIVATE, {}, None)

    def build(self, name, source, **kwargs):
        journal = candidates.read_journal(self.output, SCOPE)
        kind = kwargs['kind']
        assert journal['templates'][kind]['creationStarted']
        assert (self.output / candidates.JOURNAL).stat().st_mode & 0o777 == 0o600
        assert os.environ['GITHUB_SHA'] == ENV['GITHUB_SHA'] != source
        assert kwargs['cpu_count'] == 2 and kwargs['memory_mb'] == 4096
        assert kwargs['api_key'] == PRIVATE
        self.builds.append(kind)
        if self.collision:
            raise ValueError('template_name_already_exists')
        template_id, build_id = 'private-' + kind, 'build-' + kind
        self.aliases[name] = template_id
        self.templates[template_id] = {'templateID': template_id, 'aliases': [name], 'public': False,
                                       'builds': [{'buildID': build_id, 'status': 'ready'}], **self.override}
        if self.emit_creation:
            kwargs['on_build_logs'](SimpleNamespace(level='info', message=f'Template created with ID: {template_id}, Build ID: {build_id}'))
            # This is the SDK callback before upload/trigger/wait, not its eventual
            # return. A failed build must leave both IDs in the durable journal.
            early = candidates.read_journal(self.output, SCOPE)['templates'][kind]
            assert early.get('templateId') == template_id and early.get('buildId') == build_id
        kwargs['on_build_logs'](SimpleNamespace(level='info', message='mikka-bootstrap-phase source 12'))
        if self.fail_build:
            print(PRIVATE)
            failure = RuntimeError(PRIVATE)
            failure.__cause__ = HTTPError('https://provider.invalid/' + PRIVATE, 503, PRIVATE, {'Authorization': PRIVATE}, None)
            raise failure
        return source, SimpleNamespace(template_id=self.returned_id or template_id, build_id=build_id)

    def create(self, template_id, **kwargs):
        assert kwargs['metadata'] == candidates.metadata_for(SCOPE)
        assert kwargs['timeout'] in (60, 600)
        assert not self.sandboxes, 'a new VM must wait for provider-confirmed previous cleanup'
        sandbox_id = 'owned-vm-' + str(len(self.created) + 1)
        self.created.append(sandbox_id)
        self.sandboxes[sandbox_id] = {'sandboxID': sandbox_id, 'templateID': template_id, 'metadata': kwargs['metadata']}
        if self.fail_create:
            raise TimeoutError(PRIVATE)
        return SimpleNamespace(sandbox_id=sandbox_id, kill=lambda: self.kill(sandbox_id))

    def kill(self, sandbox_id, **_kwargs):
        self.calls.append(('KILL', sandbox_id))
        if self.delete_sandboxes:
            self.sandboxes.pop(sandbox_id, None)

    def list(self, **kwargs):
        assert kwargs['query'].metadata == candidates.metadata_for(SCOPE)
        assert kwargs['query'].state == ['running', 'paused']
        self.calls.append(('LIST', 'exact-ops-metadata'))
        rows = [SimpleNamespace(sandbox_id=row['sandboxID'], template_id=row['templateID'], metadata=row['metadata'])
                for row in self.sandboxes.values()] + self.foreign
        class Pages:
            has_next = True

            def next_items(self):
                self.has_next = False
                return rows
        return Pages()

    def models(self, template_id, kind, api_key, source, worker, factory):
        assert (source, worker) == (SCOPE['sourceCommit'], SCOPE['workerSha'])
        sandbox = factory(template_id, api_key=api_key, timeout=60, metadata=candidates.builder.release_metadata())
        self.probes.append('models-' + kind)
        sandbox.kill()
        return {'validated': True, 'sourceCommit': source, 'workerSha': worker}

    def conservation(self, template_id, api_key, kind, factory):
        sandbox = factory(template_id, api_key=api_key, timeout=600, metadata=candidates.builder.release_metadata())
        self.probes.append('conservation-' + kind)
        sandbox.kill()
        return {'validated': True}

    def read_status(self, row, api_key):
        self.status_calls.append((row['templateId'], row['buildId']))
        assert api_key == PRIVATE and row['templateId'] in self.templates, 'lookup must precede exact cleanup'
        if self.status_error:
            raise self.status_error
        return SimpleNamespace(**{'template_id': row['templateId'], 'build_id': row['buildId'],
            'status': SimpleNamespace(value='error'), 'reason': None, **self.status_override})

    def patches(self):
        stack = ExitStack()
        stack.enter_context(patch.dict(os.environ, ENV))
        stack.enter_context(patch.object(candidates.builder, '_request', self.request))
        stack.enter_context(patch.object(candidates.builder, 'build', self.build))
        stack.enter_context(patch.object(candidates.builder, 'probe_models', self.models))
        stack.enter_context(patch.object(candidates.builder, 'probe_conservation', self.conservation))
        stack.enter_context(patch.object(candidates, 'read_build_status', self.read_status, create=True))
        stack.enter_context(patch.object(candidates.builder, 'publish', side_effect=AssertionError('must not publish')))
        return stack


class Candidates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = candidates.output_directory(Path(self.temp.name) / 'output')
        self.fixture = Fixture(self.output)
        self.enterContext(self.fixture.patches())

    def build(self):
        return candidates.build_candidates(SCOPE, self.output, PRIVATE, self.fixture.sdk)

    def cleanup(self):
        return candidates.cleanup(SCOPE, self.output, PRIVATE, self.fixture.sdk)

    def test_source_head_and_original_workflow_context_are_independent_required_identities(self):
        with patch.object(candidates.builder, 'commit', return_value=SCOPE['sourceCommit']), \
             patch.object(candidates.builder, 'worker_hash', return_value=SCOPE['workerSha']), \
             patch.object(candidates.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            self.assertEqual(candidates.identity(SCOPE['sourceCommit'], ENV), SCOPE)
            self.assertEqual(os.environ['GITHUB_SHA'], ENV['GITHUB_SHA'])
            for env in ({}, {**ENV, 'GITHUB_REPOSITORY': 'foreign/repo'}, {**ENV, 'GITHUB_RUN_ATTEMPT': '0'}):
                with self.assertRaises(candidates.CandidateError):
                    candidates.identity(SCOPE['sourceCommit'], env)
            with self.assertRaises(candidates.CandidateError):
                candidates.identity('HEAD', ENV)
            with patch.object(candidates.builder, 'commit', side_effect=[SCOPE['sourceCommit'], 'd' * 40]):
                with self.assertRaisesRegex(candidates.CandidateError, 'source_ref_not_checkout_head'):
                    candidates.identity(SCOPE['sourceCommit'], ENV)
            with patch.object(candidates.subprocess, 'run', return_value=SimpleNamespace(returncode=1)):
                with self.assertRaisesRegex(candidates.CandidateError, 'source_checkout_modified'):
                    candidates.identity(SCOPE['sourceCommit'], ENV)

    def test_two_private_candidates_reuse_probes_and_confirm_each_vm_gone_before_the_next(self):
        report = self.build()
        self.assertEqual(set(report), {'sourceCommit', 'workerSha', 'templates'})
        self.assertEqual(self.fixture.builds, ['claude', 'codex'])
        self.assertEqual(self.fixture.probes, ['models-claude', 'conservation-claude', 'models-codex', 'conservation-codex'])
        self.assertEqual(len(self.fixture.created), 4)
        self.assertFalse(self.fixture.sandboxes)
        for kind, row in report['templates'].items():
            self.assertEqual(row['name'], candidates.candidate_name(SCOPE, kind))
            self.assertTrue(row['privateVerified'])
            self.assertTrue(row['preinstalled'])
            self.assertEqual(row['baseTemplate'], kind)
        self.assertEqual(len(self.fixture.templates), 2, 'successful candidates remain private for acceptance')
        journal = candidates.read_journal(self.output, SCOPE)
        self.assertTrue(all(row['deletedConfirmed'] for row in journal['sandboxes']))
        self.assertFalse(any(method in ('PATCH', 'POST') for method, _ in self.fixture.calls))
        result, name = self.cleanup()
        self.assertTrue(result['confirmed'])
        self.assertEqual(name, 'cleanup.json')
        self.assertFalse(self.fixture.templates)
        self.assertTrue(all(row['status'] == 'deleted' for row in result['templates']))

    def test_preexisting_alias_is_never_journaled_built_or_deleted(self):
        name = candidates.candidate_name(SCOPE, 'claude')
        self.fixture.aliases[name] = 'foreign'
        self.fixture.templates['foreign'] = {'public': False}
        with self.assertRaises(candidates.CandidateError):
            self.build()
        self.assertFalse((self.output / candidates.JOURNAL).exists())
        self.assertFalse(self.fixture.builds)
        self.assertFalse(any(method == 'DELETE' for method, _ in self.fixture.calls))
        before = len(self.fixture.calls)
        self.assertTrue(self.cleanup()[0]['confirmed'])
        self.assertEqual(len(self.fixture.calls), before)

    def test_second_absence_check_collision_does_not_acquire_cleanup_ownership(self):
        self.fixture.collision = True
        with self.assertRaises(candidates.CandidateError):
            self.build()
        self.assertTrue(candidates.read_journal(self.output, SCOPE)['templates']['claude']['collision'])
        self.assertFalse(any(method == 'DELETE' for method, _ in self.fixture.calls))

    def test_partial_build_recovers_exact_alias_and_keeps_failure_and_cleanup_history(self):
        self.fixture.fail_build = True
        logs = io.StringIO()
        with redirect_stdout(logs), redirect_stderr(logs), self.assertRaises(candidates.CandidateError) as raised:
            self.build()
        self.assertIsInstance(raised.exception.__cause__, RuntimeError)
        self.assertIsInstance(raised.exception.__cause__.__cause__, HTTPError)
        failed = (self.output / 'build-report.json').read_bytes()
        self.assertEqual(json.loads(failed)['stage'], 'build_claude')
        self.assertEqual(json.loads(failed)['status'], 'failed')
        diagnostic = json.loads(failed)['diagnostic']
        self.assertEqual(diagnostic['exceptionChain'], [
            {'type': 'RuntimeError', 'code': 'operation_failed'},
            {'type': 'HTTPError', 'code': 'provider_http_error', 'httpStatus': 503},
        ])
        self.assertEqual(diagnostic['buildLogs']['claude']['events'], [
            {'phase': 'template_created'}, {'phase': 'bootstrap', 'detail': 'source', 'elapsedMs': 12},
        ])
        row = candidates.read_journal(self.output, SCOPE)['templates']['claude']
        self.assertEqual((row['templateId'], row['buildId']), ('private-claude', 'build-claude'))
        self.assertFalse((self.output / 'candidates.json').exists())
        self.assertFalse(self.fixture.templates)
        result, path = self.cleanup()
        self.assertTrue(result['confirmed'])
        self.assertEqual(path, 'cleanup-2.json')
        self.assertEqual((self.output / 'build-report.json').read_bytes(), failed)
        self.assertNotIn(PRIVATE, logs.getvalue() + ''.join(path.read_text() for path in self.output.iterdir()))

    def test_log_projection_keeps_only_fixed_host_phases_and_never_raw_sdk_data(self):
        journal = {'version': 1, 'identity': SCOPE, 'templates': {kind: {'kind': kind,
            'name': candidates.candidate_name(SCOPE, kind), 'creationStarted': kind == 'claude', 'collision': False}
            for kind in candidates.KINDS}, 'sandboxes': [], 'pendingSandbox': None}
        log = candidates.BuildDiagnostics(journal, self.output, 'claude')
        messages = [
            'mikka-bootstrap-phase validation 1',
            'mikka-bootstrap-phase ' + PRIVATE + ' 1',
            json.dumps({'ok': False, 'detail': 'tool'}),
            json.dumps({'ok': False, 'detail': {'credential': PRIVATE}}),
            json.dumps({'ok': False, 'detail': 'tool', 'credential': PRIVATE}),
            'RuntimeError: official_files_changed ' + json.dumps([{'path': '/' + PRIVATE}]),
            json.dumps({'entries': 9, 'sha256': 'a' * 64}),
            PRIVATE + ' https://private.invalid?token=' + PRIVATE,
            PRIVATE * candidates.MAX_LOG_MESSAGE,
        ]
        for message in messages:
            log(SimpleNamespace(level='error', message=message))
        self.assertEqual(log.value['events'], [
            {'phase': 'bootstrap', 'detail': 'validation', 'elapsedMs': 1},
            {'phase': 'ingress', 'detail': 'tool'},
            {'phase': 'host_failure', 'detail': 'official_files_changed'},
            {'phase': 'official_capture', 'entries': 9},
        ])
        self.assertEqual(log.value['oversizedEntries'], 1)
        self.assertNotIn(PRIVATE, json.dumps(log.value))
        for _ in range(candidates.MAX_LOG_EVENTS):
            log(SimpleNamespace(level='info', message='mikka-bootstrap-phase build 1'))
        self.assertEqual(len(log.value['events']), candidates.MAX_LOG_EVENTS)
        self.assertTrue(log.value['truncated'])

    def test_actual_guard_failure_receipt_survives_provider_envelope_without_private_fields(self):
        path = Path(__file__).resolve().parents[2] / 'packages/daemon/scripts/workspace-ingress.py'
        spec = importlib.util.spec_from_file_location('guard_diagnostic', path)
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        error = guard.IngressCommandError('ipv6', 'provider_rule', 'exit', 2,
                                         (PRIVATE + ' Warning: Extension multiport revision 1 not supported; operation not permitted').encode())
        receipt = guard.failure_receipt(error)
        expected = deepcopy(receipt['command'])
        receipt['command'].update(argv=[PRIVATE], stderr=PRIVATE, path=PRIVATE)
        receipt['command']['unsupportedExtensions'][0]['stderr'] = PRIVATE
        log = candidates.BuildDiagnostics({}, self.output, 'claude')
        log(SimpleNamespace(level='error', message='[start] [stderr]: ' + json.dumps(receipt)))
        self.assertEqual(log.value['events'], [{'phase': 'ingress', 'detail': 'command', 'command': expected}])
        self.assertTrue(expected['permissionDenied'])
        self.assertEqual((expected['extension'], expected['revision']), ('multiport', 1))
        self.assertNotIn(PRIVATE, json.dumps(log.value))
        for kind, code in (('timeout', None), ('output_limit', 0), ('execution', None)):
            receipt['command'].update(failureKind=kind, returnCode=code)
            log(SimpleNamespace(level='error', message='[ready] [stderr]: ' + json.dumps(receipt)))
            self.assertEqual(log.value['events'][-1]['command']['failureKind'], kind)
            self.assertEqual(log.value['events'][-1]['command']['returnCode'], code)
        self.assertNotIn(PRIVATE, json.dumps(log.value))

    def test_malformed_command_observations_cannot_be_reported_as_real_ingress_evidence(self):
        command = {'family': 'ipv4', 'operation': 'new_chain', 'failureKind': 'exit', 'returnCode': 1,
                   **dict.fromkeys(candidates.INGRESS_COMMAND_FLAGS, False)}
        log = candidates.BuildDiagnostics({}, self.output, 'claude')
        changes = [{'family': PRIVATE}, {'operation': PRIVATE}, {'failureKind': PRIVATE}, {'returnCode': PRIVATE},
                   {'returnCode': True}, {'returnCode': 256}, {'returnCode': -256}, {'permissionDenied': PRIVATE},
                   {'operation': {PRIVATE: PRIVATE}}]
        for change in changes:
            log(SimpleNamespace(level='error', message=json.dumps({'ok': False, 'detail': 'command',
                                                                   'command': {**command, **change}})))
            self.assertEqual(log.value['events'][-1], {'phase': 'ingress', 'detail': 'command'})
        for key in command:
            incomplete = {name: value for name, value in command.items() if name != key}
            self.assertIsNone(candidates.ingress_command(incomplete))
        legacy = candidates.ingress_command(command)
        self.assertEqual((legacy['extension'], legacy['revision']), ('unknown', None))
        self.assertEqual(legacy['unsupportedExtensions'], [])
        for extension, revision, expected in ((PRIVATE, 1, ('unknown', None)), ('owner', PRIVATE, ('owner', None)),
                                             ('owner', True, ('owner', None)), ('owner', 256, ('owner', None))):
            value = candidates.ingress_command({**command, 'extension': extension, 'revision': revision})
            self.assertEqual((value['extension'], value['revision']), expected)
            self.assertEqual(value['operation'], 'new_chain')
            self.assertNotIn(PRIVATE, json.dumps(value))
        warnings = [{'extension': 'owner', 'revision': 1, 'stderr': PRIVATE}, {'extension': 'multiport', 'revision': 1},
                    {'extension': 'owner', 'revision': 1}, {'extension': PRIVATE, 'revision': 1},
                    {'extension': 'mark', 'revision': PRIVATE}, {'extension': 'conntrack', 'revision': 256}]
        value = candidates.ingress_command({**command, 'unsupportedExtensions': warnings + [{'extension': 'tcp', 'revision': 0}] * 20})
        self.assertEqual(value['unsupportedExtensions'], [{'extension': 'conntrack', 'revision': None}, {'extension': 'mark', 'revision': None},
                                                        {'extension': 'multiport', 'revision': 1}, {'extension': 'owner', 'revision': 1}])
        self.assertNotIn(PRIVATE, json.dumps(value))
        before = len(log.value['events'])
        log(SimpleNamespace(level='error', message=json.dumps({'ok': True, 'detail': 'command', 'command': command})))
        self.assertEqual(len(log.value['events']), before, 'success output cannot manufacture a failed command')
        self.assertNotIn(PRIVATE, json.dumps(log.value))

    def test_exception_projection_is_bounded_and_preserves_numeric_causes_only(self):
        failure = type('BuildException', (Exception,), {})(PRIVATE)
        failure.__cause__ = HTTPError('https://provider.invalid/' + PRIVATE, HTTPStatus.TOO_MANY_REQUESTS, PRIVATE, {'X-API-Key': PRIVATE}, None)
        failure.exit_code = 137
        actual = candidates.exception_diagnostic(failure)
        self.assertEqual(actual, {'exceptionChain': [
            {'type': 'BuildException', 'code': 'template_build_failed', 'exitCode': 137},
            {'type': 'HTTPError', 'code': 'provider_http_error', 'httpStatus': 429},
        ], 'exceptionChainTruncated': False})
        unknown = type(PRIVATE, (Exception,), {})(PRIVATE)
        unknown.__cause__ = unknown
        self.assertEqual(candidates.exception_diagnostic(unknown), {
            'exceptionChain': [{'type': 'other', 'code': 'operation_failed'}], 'exceptionChainTruncated': True})
        self.assertEqual(candidates.error_code(candidates.CandidateError(PRIVATE)), 'operation_failed')
        self.assertEqual(candidates.error_code(candidates.CandidateError([PRIVATE])), 'operation_failed')
        for _ in range(9):
            following = RuntimeError(PRIVATE)
            following.__cause__ = failure
            failure = following
        bounded = candidates.exception_diagnostic(failure)
        self.assertEqual(len(bounded['exceptionChain']), 8)
        self.assertTrue(bounded['exceptionChainTruncated'])
        self.assertNotIn(PRIVATE, json.dumps([actual, bounded]))

    def test_creation_callback_cannot_replace_the_owned_build_with_another_identity(self):
        self.build()
        journal = candidates.read_journal(self.output, SCOPE)
        original = (self.output / candidates.JOURNAL).read_bytes()
        log = candidates.BuildDiagnostics(journal, self.output, 'claude')
        log(SimpleNamespace(level='info', message='Template created with ID: private-claude, Build ID: build-claude'))
        self.assertEqual((self.output / candidates.JOURNAL).read_bytes(), original)
        for message in ('Template created with ID: foreign, Build ID: build-claude',
                        'Template created with ID: private-claude, Build ID: foreign'):
            with self.assertRaisesRegex(candidates.CandidateError, 'candidate_identity_mismatch'):
                log(SimpleNamespace(level='info', message=message))
            self.assertEqual((self.output / candidates.JOURNAL).read_bytes(), original)

    def test_creation_event_must_be_exact_and_result_must_match_its_early_identity(self):
        for emitted, returned, code in ((False, None, 'candidate_build_identity_missing'),
                                        (True, 'foreign-result', 'candidate_identity_mismatch')):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temp:
                output = candidates.output_directory(Path(temp) / 'output')
                fixture = Fixture(output)
                fixture.emit_creation, fixture.returned_id = emitted, returned
                with fixture.patches(), self.assertRaises(candidates.CandidateError):
                    candidates.build_candidates(SCOPE, output, PRIVATE, fixture.sdk)
                self.assertEqual(json.loads((output / 'build-report.json').read_text())['code'], code)
                self.assertFalse(fixture.templates)
                self.assertFalse(fixture.created)
                self.assertFalse(any(path.endswith('/foreign-result') for _method, path in fixture.calls))
        journal = {'templates': {'claude': {}}}
        log = candidates.BuildDiagnostics(journal, self.output, 'claude')
        for message in ('Template created with ID: https://private.invalid, Build ID: build-claude',
                        'Template created with ID: ' + 'x' * 129 + ', Build ID: build-claude',
                        'prefix Template created with ID: private-claude, Build ID: build-claude',
                        'Template created with ID: private-claude, Build ID: build-claude\n' + PRIVATE):
            log(SimpleNamespace(level='info', message=message))
        log(SimpleNamespace(level='error', message='Template created with ID: private-claude, Build ID: build-claude'))
        self.assertEqual(journal['templates']['claude'], {})
        self.assertFalse(log.value['events'])

    def test_failed_build_reads_its_exact_status_once_before_cleanup_without_retaining_provider_text(self):
        self.fixture.fail_build = True
        self.fixture.status_override = {'reason': SimpleNamespace(step='9',
            message='Command ' + PRIVATE + ' failed: exit status 2',
            log_entries=[SimpleNamespace(level='error', message=json.dumps({'ok': False, 'detail': 'provider'})),
                         SimpleNamespace(level='error', message=PRIVATE)])}
        with self.assertRaises(candidates.CandidateError):
            self.build()
        report = json.loads((self.output / 'build-report.json').read_text())
        self.assertEqual(self.fixture.status_calls, [('private-claude', 'build-claude')])
        self.assertEqual(report['diagnostic']['statusLookup'], {'attempted': True, 'identityMatched': True,
            'status': 'error', 'step': {'phase': 'bootstrap', 'index': 9}, 'exitCode': 2,
            'exitCodeSource': 'provider_reason', 'reasonLogEntries': 2, 'reasonLogEntriesTruncated': False})
        self.assertIn({'phase': 'ingress', 'detail': 'provider'}, report['diagnostic']['buildLogs']['claude']['events'])
        self.assertNotIn(PRIVATE, ''.join(path.read_text() for path in self.output.iterdir()))
        self.assertFalse(self.fixture.templates)

    def test_status_read_error_or_foreign_response_never_replaces_build_failure_or_skips_cleanup(self):
        for status_error, override, code in ((HTTPError('https://provider.invalid/' + PRIVATE, 503, PRIVATE, {}, None), {}, 'provider_http_error'),
                                             (None, {'template_id': 'foreign'}, 'candidate_identity_mismatch')):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temp:
                output = candidates.output_directory(Path(temp) / 'output')
                fixture = Fixture(output)
                fixture.fail_build, fixture.status_error, fixture.status_override = True, status_error, override
                with fixture.patches(), self.assertRaises(candidates.CandidateError):
                    candidates.build_candidates(SCOPE, output, PRIVATE, fixture.sdk)
                report = json.loads((output / 'build-report.json').read_text())
                self.assertEqual(report['code'], 'operation_failed')
                self.assertEqual(report['diagnostic']['exceptionChain'][0]['type'], 'RuntimeError')
                self.assertEqual(report['diagnostic']['statusLookup']['failure']['exceptionChain'][0]['code'], code)
                self.assertEqual(len(fixture.status_calls), 1)
                self.assertFalse(fixture.templates)

    def test_public_status_read_has_one_fifteen_second_request_and_closed_step_exit_projection(self):
        row = {'templateId': 'owned-template', 'buildId': 'owned-build', 'name': 'owned-name'}
        calls = []
        response = SimpleNamespace()
        def get_status(build, **options):
            calls.append((vars(build), options))
            return response
        with patch.dict('sys.modules', {'e2b': SimpleNamespace(Template=SimpleNamespace(get_build_status=get_status)),
                                       'e2b.template.types': SimpleNamespace(BuildInfo=SimpleNamespace)}):
            # Bypass the fixture's read-status replacement to exercise the SDK adapter.
            actual_spec = importlib.util.spec_from_file_location('status_adapter', Path(__file__).with_name('workspace-candidates.py'))
            actual = importlib.util.module_from_spec(actual_spec)
            actual_spec.loader.exec_module(actual)
            self.assertIs(actual.read_build_status(row, PRIVATE), response)
        self.assertEqual(calls, [({'template_id': 'owned-template', 'build_id': 'owned-build',
                                  'name': 'owned-name', 'alias': 'owned-name'}, {'api_key': PRIVATE, 'request_timeout': 15})])
        self.assertEqual(candidates.source_step('base'), {'phase': 'base', 'index': None})
        self.assertEqual(candidates.source_step('finalize'), {'phase': 'finalize', 'index': None})
        self.assertEqual(candidates.source_step('9'), {'phase': 'bootstrap', 'index': 9})
        for value in ('0', '13', '09', '999', PRIVATE, None, {}):
            self.assertEqual(candidates.source_step(value), {'phase': 'unknown', 'index': None})
        self.assertEqual(candidates.reason_exit_code(PRIVATE + ': exit status 137'), 137)
        self.assertEqual(candidates.reason_exit_code('command exited with exit code: 2; details ' + PRIVATE), 2)
        for value in (PRIVATE, 'exit status 9999', 'exit status 2.5', 'exit status 2a', 'exit status 1 then exit code 2'):
            self.assertIsNone(candidates.reason_exit_code(value))

    def test_provider_wrapped_stdout_and_stderr_keep_only_host_diagnostics_not_creation_events(self):
        journal = {'templates': {'claude': {}}}
        log = candidates.BuildDiagnostics(journal, self.output, 'claude')
        for message in ('[builder 9/12] [stdout]: mikka-bootstrap-phase source 12',
                        '[start] [stderr]: {"ok":false,"detail":"provider"}',
                        '[ready] [stderr]: RuntimeError: official_files_changed ' + PRIVATE,
                        '[builder 0/12] [stdout]: mikka-bootstrap-phase source 1',
                        '[builder 13/12] [stdout]: mikka-bootstrap-phase source 1',
                        '[' + PRIVATE + '] [stdout]: mikka-bootstrap-phase source 1',
                        '[builder 9/12] [stdout]: Template created with ID: foreign, Build ID: foreign'):
            log(SimpleNamespace(level='info', message=message))
        self.assertEqual(log.value['events'], [
            {'phase': 'bootstrap', 'detail': 'source', 'elapsedMs': 12},
            {'phase': 'ingress', 'detail': 'provider'},
            {'phase': 'host_failure', 'detail': 'official_files_changed'},
        ])
        self.assertEqual(journal['templates']['claude'], {})
        self.assertNotIn(PRIVATE, json.dumps(log.value))

    def test_numeric_provider_steps_match_the_actual_recipe_with_one_based_instructions(self):
        # Provider factory.go passes i+1 for Config.Steps; utils.go serializes
        # that exact number. Exercise this checkout's real recipe constructor,
        # so an inserted/reordered instruction cannot silently shift labels.
        actual_spec = importlib.util.spec_from_file_location('actual_recipe', Path(__file__).with_name('build-template.py'))
        actual = importlib.util.module_from_spec(actual_spec)
        actual_spec.loader.exec_module(actual)
        steps = []
        class Recipe:
            def from_template(self, _): return self
            def set_workdir(self, value): steps.append(('workdir', value)); return self
            def run_cmd(self, value, **_): steps.append(('run', value)); return self
            def copy(self, _source, destination): steps.append(('copy_runtime', destination)); return self
            def set_user(self, user): steps.append(('worker_user', user)); return self
            def set_start_cmd(self, _start, _ready): return self
        class Template:
            def __new__(cls, **_): return Recipe()
            @staticmethod
            def build(_recipe, **_): return SimpleNamespace(template_id='fixture', build_id='fixture')
        def context(directory, _):
            (directory / 'source-sha').write_text('b' * 40)
            return 'a' * 40
        with patch.dict('sys.modules', {'e2b': SimpleNamespace(Template=Template)}), \
             patch.object(actual, 'source_context', side_effect=context), patch.object(actual, 'assert_new_template'):
            actual.build('private-fixture', api_key=PRIVATE, kind='claude')
        for index, (kind, command) in enumerate(steps, 1):
            if kind != 'run': phase = kind
            elif command == actual.NPM_RUNTIME_CHECK: phase = 'npm_runtime'
            elif 'official-files.py capture ' in command: phase = 'official_capture'
            elif command.startswith('bash /opt/mikka/instance-bootstrap.sh '): phase = 'bootstrap'
            elif 'official-files.py verify ' in command: phase = 'official_verify'
            elif command.startswith('test ! -e /opt/mikka '): phase = 'private_directory'
            else: self.fail('unclassified recipe instruction')
            self.assertEqual(candidates.source_step(str(index)), {'phase': phase, 'index': index})
        self.assertEqual(candidates.source_step('1')['phase'], 'workdir')
        self.assertEqual(candidates.source_step('9')['phase'], 'bootstrap')
        self.assertEqual(candidates.source_step('10')['phase'], 'npm_runtime')
        self.assertEqual(candidates.source_step(str(len(steps) + 1))['phase'], 'unknown')

    def test_private_and_exact_build_ready_are_observed_before_any_probe(self):
        for override in ({'public': True}, {'public': None}, {'isDefault': True},
                         {'templateID': 'foreign'}, {'aliases': ['foreign-name']},
                         {'builds': [{'buildID': 'different-build', 'status': 'ready'}]},
                         {'builds': [{'buildID': 'build-claude', 'status': 'building'}]},
                         {'builds': [], 'buildStatus': 'ready'}):
            with self.subTest(override=override), tempfile.TemporaryDirectory() as temp:
                output = candidates.output_directory(Path(temp) / 'output')
                fixture = Fixture(output)
                fixture.override = override
                with fixture.patches(), self.assertRaises(candidates.CandidateError):
                    candidates.build_candidates(SCOPE, output, PRIVATE, fixture.sdk)
                self.assertFalse(fixture.created)
                if override.get('public') is not False and 'public' in override:
                    self.assertFalse(any(method == 'DELETE' for method, _ in fixture.calls))

    def test_provider_ack_without_vm_absence_stays_red_and_prevents_next_probe(self):
        self.fixture.delete_sandboxes = False
        with self.assertRaises(candidates.CandidateError):
            self.build()
        self.assertEqual(self.fixture.builds, ['claude'])
        self.assertEqual(len(self.fixture.created), 1)
        result = json.loads((self.output / 'cleanup.json').read_text())
        self.assertFalse(result['confirmed'])
        self.assertEqual(result['sandboxes'][0]['code'], 'sandbox_deletion_unconfirmed')

    def test_create_timeout_recovers_owned_vm_via_original_ops_metadata_not_candidate_source(self):
        self.fixture.fail_create = True
        with self.assertRaises(candidates.CandidateError):
            self.build()
        self.assertFalse(self.fixture.sandboxes)
        result = json.loads((self.output / 'cleanup.json').read_text())
        self.assertTrue(result['confirmed'])
        self.assertEqual(result['sandboxes'][0]['status'], 'deleted')
        self.assertIsNone(candidates.read_journal(self.output, SCOPE)['pendingSandbox'])

    def test_unknown_create_outcome_is_not_proved_absent_by_an_empty_list(self):
        self.build()
        journal = candidates.read_journal(self.output, SCOPE)
        journal['pendingSandbox'] = {'kind': 'claude', 'templateId': journal['templates']['claude']['templateId']}
        candidates.write_private(self.output / candidates.JOURNAL, journal)
        result, _ = self.cleanup()
        self.assertFalse(result['confirmed'])
        self.assertIn({'stage': 'sandbox_create', 'code': 'sandbox_creation_unconfirmed'}, result['errors'])

    def test_foreign_metadata_or_template_cannot_be_killed_even_if_list_returns_it(self):
        self.build()
        self.fixture.foreign = [SimpleNamespace(sandbox_id='foreign-vm', template_id='private-claude',
            metadata={**candidates.metadata_for(SCOPE), 'sourceCommit': SCOPE['sourceCommit']}),
            SimpleNamespace(sandbox_id='foreign-template-vm', template_id='foreign', metadata=candidates.metadata_for(SCOPE))]
        result, _ = self.cleanup()
        self.assertFalse(result['confirmed'])
        self.assertNotIn(('KILL', 'foreign-vm'), self.fixture.calls)
        self.assertNotIn(('KILL', 'foreign-template-vm'), self.fixture.calls)

    def test_template_delete_ack_is_not_enough_without_an_actual_404(self):
        self.build()
        self.fixture.delete_templates = False
        result, _ = self.cleanup()
        self.assertFalse(result['confirmed'])
        self.assertTrue(all(row['status'] == 'failed' for row in result['templates']))
        first = (self.output / 'cleanup.json').read_bytes()
        self.fixture.delete_templates = True
        later, path = self.cleanup()
        self.assertTrue(later['confirmed'])
        self.assertEqual(path, 'cleanup-2.json')
        self.assertEqual((self.output / 'cleanup.json').read_bytes(), first)

    def test_known_sandbox_is_freshly_checked_even_when_not_returned_by_the_list(self):
        self.build()
        journal = candidates.read_journal(self.output, SCOPE)
        recorded = journal['sandboxes'][0]
        self.fixture.sandboxes[recorded['sandboxId']] = {'sandboxID': recorded['sandboxId'],
            'templateID': recorded['templateId'], 'metadata': {**candidates.metadata_for(SCOPE), 'runAttempt': '1'}}
        before = sum(method == 'KILL' for method, _ in self.fixture.calls)
        result, _ = self.cleanup()
        self.assertFalse(result['confirmed'])
        self.assertEqual(sum(method == 'KILL' for method, _ in self.fixture.calls), before)
        self.assertEqual(result['sandboxes'][0]['code'], 'sandbox_scope_mismatch')

    def test_a_recorded_attempt_cannot_be_built_again_or_read_through_a_symlink(self):
        self.build()
        before = len(self.fixture.calls)
        with self.assertRaisesRegex(candidates.CandidateError, 'candidate_attempt_already_recorded'):
            self.build()
        self.assertEqual(len(self.fixture.calls), before)
        path = self.output / candidates.JOURNAL
        saved = self.output / 'saved-journal.json'
        path.rename(saved)
        path.symlink_to(saved)
        with self.assertRaises(candidates.CandidateError):
            self.cleanup()
        self.assertEqual(len(self.fixture.calls), before)

    def test_cross_source_run_attempt_names_and_readable_journal_fail_before_cleanup_api(self):
        self.build()
        path = self.output / candidates.JOURNAL
        original = json.loads(path.read_text())
        for mutate in (lambda value: value['identity'].update(sourceCommit='e' * 40),
                       lambda value: value['identity'].update(workflowCommit='e' * 40),
                       lambda value: value['identity'].update(runAttempt='1'),
                       lambda value: value['templates']['claude'].update(name='claude')):
            value = deepcopy(original)
            mutate(value)
            candidates.write_private(path, value)
            before = len(self.fixture.calls)
            with self.assertRaises(candidates.CandidateError):
                self.cleanup()
            self.assertEqual(len(self.fixture.calls), before)
        candidates.write_private(path, original)
        path.chmod(0o644)
        with self.assertRaises(candidates.CandidateError):
            self.cleanup()


if __name__ == '__main__':
    unittest.main()
