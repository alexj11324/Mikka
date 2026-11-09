"""Publish step of build-template.py, against a fake E2B API (no network, no SDK)."""
import importlib.util
import io
import copy
from contextlib import redirect_stderr
import hashlib
import json
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('build_template', Path(__file__).with_name('build-template.py'))
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)

def mcp_timing(run_id, harness):
    return {'version': 1, 'source': 'mikka_mcp_physical_fetch', 'scope': 'observed_mikka_mcp_children',
            'generationCoverage': 'unverified', 'allFirstPartyHttpComplete': False, 'remoteMcpServerCount': 0, 'childPathAuditVersion': 1,
            'runIdHash': hashlib.sha256(run_id.encode()).hexdigest()[:16], 'harness': harness, 'startedAt': 1010, 'endedAt': 1900,
            'expectedChildren': 1, 'observedChildren': 1, 'closedChildren': 0, 'observedComplete': True, 'childLifecycleComplete': False,
            'rejectedEvents': 0, 'truncated': False,
            'children': [{'child': 1, 'startedAt': 1020, 'closedAt': None, 'lastSequence': 3, 'sent': 1, 'completed': 1, 'lost': 0}],
            'requests': [{'child': 1, 'sequence': 1, 'operation': 'decision_catalogue', 'startedAt': 1040,
                          'endedAt': 1050, 'durationMs': 10, 'status': 200, 'outcome': 'ok'}]}

def bootstrap_acceptance(run_id, harness):
    base = {'version': 1, 'runIdHash': hashlib.sha256(run_id.encode()).hexdigest()[:16],
            'harness': harness, 'outcome': 'ok', 'truncated': False}
    source = 'bootstrap_codex_initialize' if harness == 'codex' else 'bootstrap_claude_start'
    prepared = {**base, 'startedAt': 1000, 'endedAt': 1500, 'ms': 500, 'source': source,
                'phases': [{'name': 'daemon.adapter.cli_init.prewarm', 'startMs': 0, 'endMs': 300, 'ms': 300, 'outcome': 'ok'},
                           {'name': 'daemon.adapter.cli_init', 'startMs': 490, 'endMs': 500, 'ms': 10, 'outcome': 'ok'}]}
    if harness == 'claude_code':
        prepared.update(claimAuthentication='oauth_environment', observedAuthSource='oauth_environment')
    return {'version': 1, 'runIdHash': base['runIdHash'], 'harness': harness, 'source': source,
            'bootstrapSha256': '1' * 64, 'hintSha256': '2' * 64, 'preparationTiming': prepared,
            'startupTiming': {**base, 'startedAt': 1200, 'endedAt': 1600, 'ms': 400, 'phases': []}}


class FakeResponse(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *_): return False

def fake(template):
    calls = []
    def opener(request, timeout):
        calls.append((request.get_method(), request.full_url, request.get_header('X-api-key'), request.data))
        return FakeResponse(b'' if request.get_method() == 'PATCH' else json.dumps(template).encode())
    return opener, calls

def model_receipt(kind='desktop'):
    original = {'claude_code': None, 'codex': None}
    if kind != 'desktop':
        harness = 'claude_code' if kind == 'claude' else 'codex'
        original[harness] = {'path': '/usr/local/bin/' + kind, 'sha256': 'a' * 64}
    added = {harness: {'path': '/opt/mikka/harness/' + harness, 'sha256': 'b' * 64}
             for harness, binary in original.items() if binary is None}
    manifest = {'version': 1, 'kind': kind, 'original': original, 'added': added}
    binaries = {harness: (original[harness] or added[harness])['path'] for harness in original}
    return {'version': 1, 'sourceCommit': 'c' * 40, 'workerSha': 'd' * 40, 'manifest': manifest, 'binaries': binaries,
            'reports': [{'harness': harness, 'installed': True, 'version': None, 'models': ['fixture-' + harness],
                         'modelSlots': [{'slot': 'fixture-' + harness, 'model': 'fixture-' + harness, 'name': 'Fixture'}],
                         'defaultModelSlot': 'fixture-' + harness} for harness in original]}


class ModelSandbox:
    def __init__(self, receipt):
        self.receipt = receipt
        self.manifest = copy.deepcopy(receipt['manifest'])
        self.worker_sha, self.source_commit = receipt['workerSha'], receipt['sourceCommit']
        self.commands = self.files = self
        self.calls = []
        self.exit_code = 0
        self.read_error = None
    def run(self, command, **options):
        self.calls.append(('run', command, options))
        return SimpleNamespace(exit_code=self.exit_code, stdout='/opt/mikka/releases/' + self.source_commit + '/source\n')
    def read(self, path, **options):
        self.calls.append(('read', path, options))
        if path.endswith('worker-source-sha'): return self.worker_sha + '\n'
        if path.endswith('.mikka-original-cli.json'): return json.dumps(self.manifest)
        if self.read_error: raise self.read_error
        assert path == '/home/user/.mikka/preloaded-models.json'
        return json.dumps(self.receipt)
    def kill(self): self.calls.append(('kill',))

class Publish(unittest.TestCase):
    def test_conservation_failure_logs_safe_metadata_before_kill_and_keeps_the_original_exception(self):
        digest = {'entries': 5, 'sha256': 'f' * 64}
        final = {'kind': 'codex', 'policySha256': bt.official_files_guard().finalization_policy('codex')[1],
                 'before': digest, 'after': digest, 'originalBefore': digest, 'originalAfter': digest, 'providerChanges': []}
        change = {'path': '/usr/local/bin/codex', 'kind': 'file',
                  'before': {'sha256': 'a' * 64, 'mode': 0o755}, 'after': {'sha256': 'b' * 64, 'mode': 0o644}}
        secret = 'DO-NOT-LOG-CREDENTIAL-OR-PROVIDER-TEXT'
        failure = RuntimeError(secret)
        failure.__cause__ = ValueError(secret)
        failure.exit_code = 1
        failure.stdout = secret
        failure.stderr = secret + '\nRuntimeError: official_files_changed ' + json.dumps([change]) + '\n' + secret
        output, killed = io.StringIO(), []
        class Probe:
            def __init__(self): self.files = self.commands = self
            def read(self, path, **_):
                return json.dumps(final if path.endswith('ready.json') else {'before': digest, 'after': digest})
            def run(self, *_args, **_options): raise failure
            def kill(self): killed.append(output.getvalue())
        with redirect_stderr(output), self.assertRaises(RuntimeError) as raised:
            bt.probe_conservation('candidate', secret, 'codex', lambda *_, **__: Probe())
        self.assertIs(raised.exception, failure)
        self.assertIs(raised.exception.__cause__, failure.__cause__)
        self.assertEqual(len(killed), 1)
        self.assertIn('mikka-conservation-failed ', killed[0])
        row = json.loads(next(line.removeprefix('mikka-conservation-failed ') for line in output.getvalue().splitlines()
                              if line.startswith('mikka-conservation-failed ')))
        self.assertEqual(row, {'kind': 'codex', 'stage': 'fresh_scan', 'code': 'official_files_changed',
                               'exitCode': 1, 'changes': [change]})
        self.assertNotIn(secret, output.getvalue())

    def test_conservation_diagnostics_accept_only_closed_bounded_metadata(self):
        secret = 'DO-NOT-LOG-SECRET'
        error = RuntimeError(secret)
        error.exit_code, error.stdout = 137, secret
        error.stderr = 'arbitrary stderr ' + secret
        self.assertEqual(bt.conservation_diagnostic(error, 'desktop', 'fresh_scan'),
                         {'kind': 'desktop', 'stage': 'fresh_scan', 'code': 'conservation_failed', 'exitCode': 137})
        error.stderr = 'RuntimeError: official_files_removed ' + json.dumps({'path': '/usr/local/bin/claude'})
        self.assertEqual(bt.conservation_diagnostic(error, 'claude', 'fresh_scan')['missing'], {'path': '/usr/local/bin/claude'})
        row = {'path': '/usr/local/bin/claude', 'kind': 'file', 'before': {'sha256': 'a' * 64}, 'after': {'sha256': 'b' * 64}}
        invalid = [
            {'path': '/usr/local/bin/claude', 'token': secret},
            [dict(row, token=secret)],
            [{**row, 'before': {'token': secret}, 'after': {'token': secret}}],
            [{**row, 'after': {'sha256': secret}}],
            [{**row, 'resolvedSha256': None}],
            [{**row, 'kind': secret}],
            [{**row, 'path': '/' + 'x' * 2048}],
            [row] * (bt.CONSERVATION_DIAGNOSTIC_MAX_CHANGES + 1),
        ]
        for value in invalid:
            code = 'official_files_removed' if isinstance(value, dict) else 'official_files_changed'
            error.stderr = 'RuntimeError: ' + code + ' ' + json.dumps(value)
            with self.subTest(value_type=type(value).__name__):
                actual = bt.conservation_diagnostic(error, 'desktop', 'fresh_scan')
                self.assertEqual(actual['code'], 'conservation_metadata_invalid')
                self.assertNotIn('changes', actual)
                self.assertNotIn('missing', actual)
                self.assertNotIn(secret, json.dumps(actual))
        error.stderr = secret + 'x' * bt.CONSERVATION_DIAGNOSTIC_MAX_BYTES
        actual = bt.conservation_diagnostic(error, 'desktop', 'fresh_scan')
        self.assertEqual(actual['code'], 'conservation_diagnostic_too_large')
        self.assertNotIn(secret, json.dumps(actual))

    def test_conservation_receipt_validation_failures_keep_the_stage_and_cleanup(self):
        killed = []
        class Probe:
            def __init__(self): self.files = self.commands = self
            def read(self, *_args, **_options): return '{}'
            def run(self, *_args, **_options): raise AssertionError('invalid build proof must stop before scanning')
            def kill(self): killed.append(True)
        output = io.StringIO()
        with redirect_stderr(output), self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
            bt.probe_conservation('candidate', 'fixture-key', 'desktop', lambda *_, **__: Probe())
        row = json.loads(next(line.removeprefix('mikka-conservation-failed ') for line in output.getvalue().splitlines()
                              if line.startswith('mikka-conservation-failed ')))
        self.assertEqual(row, {'kind': 'desktop', 'stage': 'preload_validation', 'code': 'official_conservation_invalid'})
        self.assertEqual(killed, [True])

    def test_conservation_reads_build_receipts_and_rechecks_a_fresh_disposable_image(self):
        calls = []
        digest = {'entries': 5, 'sha256': 'f' * 64}
        final = {'kind': 'codex', 'policySha256': bt.official_files_guard().finalization_policy('codex')[1],
                 'before': digest, 'after': digest, 'originalBefore': digest, 'originalAfter': digest, 'providerChanges': []}
        class Probe:
            def __init__(self): self.files = self.commands = self
            def read(self, path, **options):
                calls.append(('read', path))
                return json.dumps(final if path.endswith(('ready.json', 'fresh-conservation.json')) else {'before': digest, 'after': digest})
            def run(self, command, **options):
                calls.append(('run', command))
                return SimpleNamespace(exit_code=0, stdout=json.dumps(final))
            def kill(self): calls.append(('kill',))
        result = bt.probe_conservation('candidate', 'fixture-key', 'codex', lambda *_, **__: Probe())
        self.assertEqual(result['preloadFinalization'], final)
        self.assertEqual(result['finalization'], final)
        self.assertEqual([call[0] for call in calls], ['read', 'read', 'run', 'read', 'kill'])
        self.assertIn('verify /opt/mikka/official-files-before.json --e2b-finalization codex', calls[2][1])

    def test_build_name_must_be_absent_and_never_an_official_alias(self):
        def existing_alias(method, path, api_key):
            if path == '/templates/aliases/mikka-old-claude':
                return {'templateID': 'previous-version', 'public': False}
            raise HTTPError(path, 404, 'Not found', {}, None)
        with patch.object(bt, '_request', side_effect=existing_alias) as request:
            with self.assertRaisesRegex(ValueError, 'template_name_already_exists'):
                bt.assert_new_template('mikka-old-claude', 'fixture-key')
            request.assert_called_once_with('GET', '/templates/aliases/mikka-old-claude', 'fixture-key')
        for name in ('claude', 'codex', 'desktop', '../other'):
            with patch.object(bt, '_request') as request:
                with self.assertRaisesRegex(ValueError, 'template_name_invalid'):
                    bt.assert_new_template(name, 'fixture-key')
                request.assert_not_called()
        with patch.object(bt, '_request', side_effect=HTTPError('https://api.e2b.app/templates/aliases/new', 404, 'Not found', {}, None)) as request:
            bt.assert_new_template('mikka-new-claude', 'fixture-key')
            request.assert_called_once_with('GET', '/templates/aliases/mikka-new-claude', 'fixture-key')
        with patch.object(bt, '_request', side_effect=HTTPError('https://api.e2b.app/templates/new', 503, 'Unavailable', {}, None)):
            with self.assertRaises(HTTPError):
                bt.assert_new_template('mikka-new-claude', 'fixture-key')

    def test_reads_the_completed_anonymous_probe_without_starting_another_node_or_cli(self):
        for kind in bt.KINDS:
            receipt = model_receipt(kind)
            sandbox = ModelSandbox(receipt)
            result = bt.probe_models('tpl1', kind, 'fixture-key', receipt['sourceCommit'], receipt['workerSha'], lambda *_, **__: sandbox)
            expected = receipt['reports'] if kind == 'desktop' else [row for row in receipt['reports'] if row['harness'] == ('claude_code' if kind == 'claude' else 'codex')]
            self.assertEqual(result, expected)
            self.assertEqual([call[0] for call in sandbox.calls], ['run', 'read', 'read', 'read', 'kill'])
            command = sandbox.calls[0][1]
            self.assertIn(bt.ANONYMOUS_WORKER_READY, command)
            self.assertIn('test ! -w /home/user/.mikka/preloaded-models.json', command)
            self.assertIn('test ! -e /home/user/.mikka/worker/device.json', command)
            self.assertNotIn('--probe-models', command)
            self.assertNotIn('node ', command)

    def test_model_receipt_rejects_wrong_release_or_selection_and_incomplete_catalogues(self):
        original = model_receipt('claude')
        changes = [
            lambda row: row.update(version=2),
            lambda row: row.update(version=True),
            lambda row: row.update(sourceCommit='e' * 40),
            lambda row: row.update(workerSha='e' * 40),
            lambda row: row.update(credential='must-not-be-accepted'),
            lambda row: row['manifest'].update(kind='desktop'),
            lambda row: row['manifest']['original']['claude_code'].update(sha256='f' * 64),
            lambda row: row['binaries'].update(claude_code='/opt/mikka/private-claude'),
            lambda row: row['binaries'].pop('codex'),
            lambda row: row['reports'].pop(),
            lambda row: row['reports'][1].update(harness='claude_code'),
            lambda row: row['reports'][0].update(installed=False),
            lambda row: row['reports'][0].update(models=[]),
            lambda row: row['reports'][0].update(modelSlots=[]),
            lambda row: row['reports'][0]['modelSlots'][0].update(slot='not-reported'),
            lambda row: row['reports'][0].update(defaultModelSlot='not-reported'),
            lambda row: row['reports'][0].update(credential='must-not-be-accepted'),
        ]
        for change in changes:
            invalid = copy.deepcopy(original)
            change(invalid)
            sandbox = ModelSandbox(original)
            sandbox.receipt = invalid
            with self.subTest(change=change), self.assertRaises((RuntimeError, ValueError)):
                bt.probe_models('tpl1', 'claude', 'fixture-key', original['sourceCommit'], original['workerSha'], lambda *_, **__: sandbox)
            self.assertEqual(sandbox.calls[-1], ('kill',))

    def test_fresh_worker_and_manifest_cannot_self_attest_a_different_build(self):
        receipt = model_receipt()
        for field in ('source_commit', 'worker_sha'):
            sandbox = ModelSandbox(receipt)
            setattr(sandbox, field, 'e' * 40)
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'model_receipt_worker_'):
                bt.probe_models('tpl1', 'desktop', 'fixture-key', receipt['sourceCommit'], receipt['workerSha'], lambda *_, **__: sandbox)
            self.assertEqual(sandbox.calls[-1], ('kill',))
        sandbox = ModelSandbox(receipt)
        sandbox.receipt = copy.deepcopy(receipt)
        sandbox.receipt['workerSha'] = sandbox.worker_sha = 'e' * 40
        with self.assertRaisesRegex(RuntimeError, 'model_receipt_worker_mismatch'):
            bt.probe_models('tpl1', 'desktop', 'fixture-key', receipt['sourceCommit'], receipt['workerSha'], lambda *_, **__: sandbox)
        # A matching receipt cannot replace the manifest's official CLI with a
        # private binary, even when both files agree with one another.
        receipt = model_receipt('claude')
        receipt['manifest']['added']['claude_code'] = {'path': '/opt/mikka/private-claude', 'sha256': 'b' * 64}
        sandbox = ModelSandbox(receipt)
        with self.assertRaisesRegex(ValueError, 'official_cli_manifest_invalid'):
            bt.probe_models('tpl1', 'claude', 'fixture-key', receipt['sourceCommit'], receipt['workerSha'], lambda *_, **__: sandbox)
        self.assertEqual(sandbox.calls[-1], ('kill',))

    def test_missing_or_unready_receipt_fails_without_a_cold_probe_fallback_and_still_cleans_up(self):
        receipt = model_receipt()
        for failure in (FileNotFoundError(), PermissionError(), 'not-ready'):
            sandbox = ModelSandbox(receipt)
            if failure == 'not-ready': sandbox.exit_code = 1
            else: sandbox.read_error = failure
            with self.subTest(failure=failure), self.assertRaises((OSError, RuntimeError)):
                bt.probe_models('tpl1', 'desktop', 'fixture-key', receipt['sourceCommit'], receipt['workerSha'], lambda *_, **__: sandbox)
            self.assertEqual(sandbox.calls[-1], ('kill',))
            self.assertEqual(sum(call[0] == 'run' for call in sandbox.calls), 1)

    def test_model_probe_timeout_records_only_safe_counts_and_preserves_the_failure(self):
        class TimeoutException(Exception): pass
        for stage in ('ready_check', 'receipt_read'):
            with self.subTest(stage=stage):
                failure = TimeoutException('private transport detail')
                cause = OSError('private connection detail')
                receipt = model_receipt('codex')
                class Probe(ModelSandbox):
                    def run(self, command, **options):
                        result = super().run(command, **options)
                        if stage == 'ready_check': raise failure from cause
                        return result
                    def read(self, path, **options):
                        if path.endswith('preloaded-models.json'):
                            self.calls.append(('read', path, options))
                            raise failure from cause
                        return super().read(path, **options)
                sandbox = Probe(receipt)
                def factory(*args, **options):
                    sandbox.calls.append(('create', args, options))
                    return sandbox
                log = io.StringIO()
                with patch.object(bt.time, 'monotonic', side_effect=[100, 145.25]), patch.object(bt.sys, 'stderr', log):
                    with self.assertRaises(TimeoutException) as raised:
                        bt.probe_models('private-template', 'codex', 'private-key', receipt['sourceCommit'], receipt['workerSha'], factory)
                self.assertIs(raised.exception, failure)
                self.assertIs(raised.exception.__cause__, cause)
                expected_calls = ['create', 'run', 'kill'] if stage == 'ready_check' else ['create', 'run', 'read', 'read', 'read', 'kill']
                self.assertEqual([call[0] for call in sandbox.calls], expected_calls)
                self.assertEqual(sandbox.calls[0][2]['timeout'], 60)
                self.assertEqual(sandbox.calls[1][2]['timeout'], 45)
                self.assertNotIn('--probe-models', sandbox.calls[1][1])
                self.assertNotIn('request_timeout', sandbox.calls[1][2])
                self.assertTrue(all(call[2]['request_timeout'] == 30 for call in sandbox.calls if call[0] == 'read'))
                self.assertEqual(json.loads(log.getvalue()), {
                    'event': 'mikka_model_probe_failed', 'kind': 'codex', 'stage': stage, 'error': 'timeout',
                    'bytes': {'workerIdentity': None if stage == 'ready_check' else len(receipt['workerSha'] + '\n'),
                              'manifest': None if stage == 'ready_check' else len(json.dumps(receipt['manifest']).encode('utf-8')),
                              'receipt': None},
                    'elapsedMs': 45250, 'receiptJsonReceived': False,
                })
                self.assertNotIn('private', log.getvalue())

    def test_model_probe_receipt_errors_record_only_the_completed_reads(self):
        receipt = model_receipt('claude')
        invalid = {**receipt, 'credential': 'private-凭证'}
        cases = [
            (None, RuntimeError('private read error'), 'receipt_read', 'read_failed', False),
            ('{"private-凭证":', None, 'receipt_parse', 'invalid_json', False),
            (json.dumps(invalid, ensure_ascii=False), None, 'receipt_validate', 'identity_invalid', True),
            (json.dumps(receipt), RuntimeError('private validation error'), 'receipt_validate', 'unexpected', True),
        ]
        for raw, failure, stage, category, parsed in cases:
            with self.subTest(stage=stage, category=category):
                class Probe(ModelSandbox):
                    def read(self, path, **options):
                        if path.endswith('preloaded-models.json'):
                            self.calls.append(('read', path, options))
                            if raw is None: raise failure
                            return raw
                        return super().read(path, **options)
                sandbox = Probe(receipt)
                log = io.StringIO()
                validator = bt.validate_model_receipt
                with patch.object(bt.time, 'monotonic', side_effect=[10, 11]), patch.object(bt.sys, 'stderr', log), \
                        patch.object(bt, 'validate_model_receipt', side_effect=failure if category == 'unexpected' else validator):
                    with self.assertRaises((RuntimeError, json.JSONDecodeError)) as raised:
                        bt.probe_models('private-template', 'claude', 'private-key', receipt['sourceCommit'], receipt['workerSha'], lambda *_, **__: sandbox)
                if failure is not None: self.assertIs(raised.exception, failure)
                self.assertEqual([call[0] for call in sandbox.calls], ['run', 'read', 'read', 'read', 'kill'])
                self.assertEqual(json.loads(log.getvalue()), {
                    'event': 'mikka_model_probe_failed', 'kind': 'claude', 'stage': stage, 'error': category,
                    'bytes': {'workerIdentity': len(receipt['workerSha'] + '\n'),
                              'manifest': len(json.dumps(receipt['manifest']).encode('utf-8')),
                              'receipt': None if raw is None else len(raw.encode('utf-8'))},
                    'elapsedMs': 1000, 'receiptJsonReceived': parsed,
                })
                self.assertNotIn('private', log.getvalue())
                self.assertNotIn('凭证', log.getvalue())

    def test_model_probe_cleanup_and_logging_failures_do_not_mask_the_original_error(self):
        for log_fails in (False, True):
            with self.subTest(log_fails=log_fails):
                failure = TimeoutError('private receipt read failure')
                cause = OSError('private transport cause')
                receipt = model_receipt('codex')
                class Probe(ModelSandbox):
                    def read(self, path, **options):
                        if path.endswith('preloaded-models.json'):
                            self.calls.append(('read', path, options))
                            raise failure from cause
                        return super().read(path, **options)
                    def kill(self):
                        self.calls.append(('kill',))
                        raise RuntimeError('private cleanup failure')
                class Log(io.StringIO):
                    def write(self, message):
                        if log_fails:
                            raise OSError('private logging failure')
                        return super().write(message)
                log = Log()
                sandbox = Probe(receipt)
                with patch.object(bt.sys, 'stderr', log):
                    with self.assertRaises(TimeoutError) as raised:
                        bt.probe_models('private-template', 'codex', 'private-key', receipt['sourceCommit'], receipt['workerSha'], lambda *_, **__: sandbox)
                self.assertIs(raised.exception, failure)
                self.assertIs(raised.exception.__cause__, cause)
                self.assertEqual([call[0] for call in sandbox.calls], ['run', 'read', 'read', 'read', 'kill'])
                self.assertEqual(failure.__notes__, (['model_probe_diagnostic_failed'] if log_fails else []) + ['model_probe_cleanup_failed'])
                self.assertNotIn('private', log.getvalue())

    def test_model_probe_success_still_fails_if_its_sandbox_cannot_be_cleaned_up(self):
        failure = RuntimeError('private cleanup failure')
        receipt = model_receipt('codex')
        class Probe(ModelSandbox):
            def kill(self): raise failure
        log = io.StringIO()
        with patch.object(bt.sys, 'stderr', log):
            with self.assertRaises(RuntimeError) as raised:
                bt.probe_models('private-template', 'codex', 'private-key', receipt['sourceCommit'], receipt['workerSha'], lambda *_, **__: Probe(receipt))
        self.assertIs(raised.exception, failure)
        self.assertEqual(log.getvalue(), '')

    def test_standalone_instance_probe_does_not_start_cli_after_verification_failure(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            fixture_path = Path(__file__).with_name('official-files.test.py')
            fixture_spec = importlib.util.spec_from_file_location('cli_verification_fixture', fixture_path)
            fixture = importlib.util.module_from_spec(fixture_spec)
            fixture_spec.loader.exec_module(fixture)
            private, manifest, _, added = fixture.CliVerification().inventory(directory)
            manifest_bytes, original_byte = manifest.read_bytes(), added.read_bytes()[:1]
            guard, probe, started = directory / 'guard.py', directory / 'probe.sh', directory / 'probe-started'
            # Exercise the real CLI and hashing. Only root metadata is modelled
            # so the same filesystem/command test works on unprivileged CI.
            guard.write_text(f'''import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('cli_verification_fixture', {str(fixture_path)!r})
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
fixture.files.PRIVATE = Path({str(private)!r})
with fixture.root_file_metadata():
    fixture.files.main()
''')
            probe.write_text(f'#!/bin/sh\nprintf started > {shlex.quote(str(started))}\nprintf "[]\\n"\n')
            command = bt.MODEL_PROBE_COMMAND.format(kind='desktop').replace(
                'python3 /opt/mikka/worker/scripts/e2b/official-files.py', f'{shlex.quote(sys.executable)} {shlex.quote(str(guard))}').replace(
                '/opt/mikka/worker/.mikka-original-cli.json', shlex.quote(str(manifest))).replace(
                '/opt/mikka/runtime/node/bin/node', f'sh {shlex.quote(str(probe))}')
            with added.open('r+b') as handle: handle.write(b'!')
            result = subprocess.run(['bash', '-c', command], capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('runtime_cli_changed', result.stderr)
            self.assertFalse(started.exists())
            self.assertEqual(manifest.read_bytes(), manifest_bytes)
            with added.open('r+b') as handle: handle.write(original_byte)
            result = subprocess.run(['bash', '-c', command], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0)
            self.assertTrue(started.exists())
            self.assertEqual(json.loads(result.stdout), [])
            receipt = json.loads(result.stderr.removeprefix('mikka-cli-verification '))
            self.assertTrue(all(row['matched'] is True for row in receipt['files']))

    def test_failed_or_timed_out_receipt_ready_check_still_kills_its_sandbox(self):
        for failure in (False, True):
            calls = []
            class Probe:
                def __init__(self): self.commands = self
                def run(self, command, **options):
                    calls.append((command, options))
                    if failure: raise TimeoutError('fixture command deadline')
                    return SimpleNamespace(exit_code=1, stdout='')
                def kill(self): calls.append('killed')
            receipt = model_receipt()
            with patch.object(bt.sys, 'stderr', io.StringIO()), self.assertRaises(TimeoutError if failure else RuntimeError):
                bt.probe_models('tpl1', 'desktop', 'fixture-key', receipt['sourceCommit'], receipt['workerSha'], lambda *_, **__: Probe())
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][1], {'user': 'user', 'timeout': 45})
            self.assertNotIn('node ', calls[0][0])
            self.assertNotIn('cli-verify', calls[0][0])
            self.assertEqual(calls[-1], 'killed')

    def test_official_instance_validation_uses_the_same_standalone_probe(self):
        module_spec = importlib.util.spec_from_file_location('validate_official', Path(__file__).with_name('validate-official-instances.py'))
        validator = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(validator)
        calls, killed = [], []
        class Probe:
            def __init__(self, kind):
                self.kind, self.sandbox_id, self.commands = kind, 'fixture-instance', self
            def run(self, command, **options):
                calls.append((command, options))
                harnesses = ['claude_code', 'codex'] if self.kind == 'desktop' else ['claude_code' if self.kind == 'claude' else 'codex']
                data = [{'harness': harness, 'installed': True, 'models': ['fixture-model']} for harness in harnesses]
                return SimpleNamespace(exit_code=0, stdout=json.dumps(data if 'cloud-model-probe.js' in command else {'entries': 1, 'sha256': 'f' * 64}))
            def kill(self): killed.append(self.kind)
        sdk = SimpleNamespace(Sandbox=SimpleNamespace(create=lambda kind, **_: Probe(kind)))
        with patch.dict('sys.modules', {'e2b': sdk}), patch.dict(validator.os.environ, {'E2B_API_KEY': 'fixture-key'}), \
                patch.object(validator.digest, 'commit', return_value='a' * 40), \
                patch.object(validator.digest, 'worker_hash', return_value='b' * 40), \
                patch.object(validator.subprocess, 'check_output', return_value='# fixture bootstrap'):
            validator.validate()
        probes = [(command, options) for command, options in calls if 'cloud-model-probe.js' in command]
        self.assertEqual(len(probes), 3)
        for kind, (command, options) in zip(['desktop', 'claude', 'codex'], probes):
            self.assertEqual(command, bt.MODEL_PROBE_COMMAND.format(kind=kind))
            self.assertNotIn('cloud-worker.js', command)
            self.assertEqual(options, {'user': 'user', 'timeout': 100})
        self.assertEqual(killed, ['desktop', 'claude', 'codex'])

    def test_capability_manifest_matches_template_kinds_and_task_environment(self):
        manifest = json.loads((bt.ROOT / 'scripts/e2b/template-capabilities.json').read_text())
        self.assertEqual(set(manifest), set(bt.KINDS))
        self.assertEqual(manifest, {'desktop': ['claude_code', 'codex'], 'claude': ['claude_code'], 'codex': ['codex']})
        runtime = (bt.ROOT / 'lib/secrets/e2b-runtime.ts').read_text()
        for harness, variable in [('claude_code', 'E2B_CLAUDE_TEMPLATE'), ('codex', 'E2B_CODEX_TEMPLATE')]:
            self.assertIn(harness, runtime)
            self.assertIn(variable, runtime)

    def fake_build(self, kind):
        called = {'commands': [], 'copies': [], 'users': []}
        class Recipe:
            def from_template(self, name):
                called['base_template'] = name
                return self
            def copy(self, source, destination):
                called['copies'].append((source, destination))
                return self
            def set_workdir(self, _): return self
            def run_cmd(self, command, user=None, **__):
                called['commands'].append(command)
                called['users'].append((command, user))
                return self
            def set_user(self, _): return self
            def set_start_cmd(self, start, ready):
                self.start, self.ready = start, ready
                return self
        def build_recipe(recipe, **options):
            called.update(options)
            called['start'], called['ready'] = recipe.start, recipe.ready
            return SimpleNamespace(template_id='tpl1', build_id='b1')
        def context(directory, _):
            (directory / 'source-sha').write_text('b' * 40)
            return 'a' * 40
        class Template:
            def __new__(cls, **_): return Recipe()
            build = staticmethod(build_recipe)
        with patch.dict('sys.modules', {'e2b': SimpleNamespace(Template=Template)}), patch.object(bt, 'source_context', side_effect=context), patch.object(bt, 'assert_new_template'):
            sha, result = bt.build(f'mikka-test-{kind}', api_key='fixture-key', kind=kind)
        self.assertEqual(sha, 'a' * 40)
        self.assertEqual(result.template_id, 'tpl1')
        return called

    def test_build_is_additive_and_original_file_gate_surrounds_installation(self):
        for kind in bt.KINDS:
            called = self.fake_build(kind)
            self.assertEqual(called['base_template'], kind)
            self.assertEqual(called['name'], f'mikka-test-{kind}')
            self.assertTrue(all(destination.startswith('/opt/mikka/') for _, destination in called['copies']))
            commands = called['commands']
            capture = next(i for i, command in enumerate(commands) if 'official-files.py capture' in command)
            install = next(i for i, command in enumerate(commands) if 'bash /opt/mikka/instance-bootstrap.sh' in command)
            verify = next(i for i, command in enumerate(commands) if 'official-files.py verify' in command)
            self.assertLess(capture, install)
            self.assertLess(install, verify)
            self.assertLess(commands.index(bt.NPM_RUNTIME_CHECK), verify)
            self.assertNotIn('--e2b-finalization', commands[verify])
            self.assertIn(f'--e2b-finalization {kind}', called['ready'])
            self.assertIn(' '.join(['a' * 40, 'b' * 40, kind]), commands[install])
            self.assertFalse(any('apt-get' in command or 'ln -sf' in command or 'systemctl' in command for command in commands))
            self.assertEqual(called['start'], 'bash /opt/mikka/start-prebuilt.sh')
            self.assertIn('kill -0 "$mikka_preloaded_pid"', called['ready'])
            self.assertIn("grep -Fxq -- '--wait-bootstrap'", called['ready'])
            self.assertIn('test ! -e /home/user/.mikka/bootstrap.json', called['ready'])
            self.assertIn('test ! -e /home/user/.mikka/worker/device.json', called['ready'])
            if kind == 'desktop': self.assertIn('test ! -e /run/mikka-viewer/key', called['ready'])
            self.assertIn((bt.NPM_RUNTIME_CHECK, 'user'), called['users'])

    def test_template_start_preloads_only_anonymous_private_runtime(self):
        text = (bt.ROOT / 'scripts/e2b/start-prebuilt.sh').read_text()
        self.assertIn('--wait-bootstrap', text)
        self.assertNotIn('env -i', text)
        self.assertIn('/opt/mikka/runtime/node/bin/node', text)
        self.assertNotIn('rm ', text)
        self.assertNotIn('sleep ', text)
        self.assertNotIn('systemctl', text)

    def test_release_gate_rejects_missing_stale_and_non_subscription_receipts(self):
        proof = {'entries': 4, 'sha256': 'f' * 64}
        def conservation(kind):
            return {'before': proof.copy(), 'after': proof.copy(), 'finalization': {
                'kind': kind, 'policySha256': bt.official_files_guard().finalization_policy(kind)[1],
                'before': proof.copy(), 'after': proof.copy(), 'originalBefore': proof.copy(),
                'originalAfter': proof.copy(), 'providerChanges': []}}
        report = {'sourceCommit': 'a' * 40, 'workerSha': 'b' * 40, 'templates': {
            kind: {'templateId': 'tpl-' + kind, 'buildId': 'build-' + kind, 'baseTemplate': kind, 'preinstalled': True,
                   'conservation': conservation(kind)} for kind in bt.KINDS}}
        with self.assertRaisesRegex(ValueError, 'release_subscription_acceptance_missing'):
            bt.verify_release_evidence(report)
        report['subscriptionAcceptance'] = {
            kind: {'status': 'passed', 'templateId': 'tpl-' + kind, 'sourceCommit': report['sourceCommit'],
                   'workerSha': report['workerSha'], 'harness': harness, 'model': model, 'credentialRoute': 'subscription',
                   'officialBinarySha256': 'e' * 64, 'officialCliVersion': 'fixture-version',
                   'bootstrapAcceptance': bootstrap_acceptance('run-' + kind, harness),
                   'agentAcceptance': {'runIdHash': hashlib.sha256(('run-' + kind).encode()).hexdigest()[:16], 'harness': harness,
                                       'kind': 'claude_user_ack' if harness == 'claude_code' else 'codex_turn_start_ack', 'at': 1100, 'ms': 100},
                   'runtimeAuthorization': {'source': 'http_server_link', 'scope': 'daemon_http_server_link_and_task_fetch',
                                            'complete': True, 'truncated': False, 'extraRemoteCalls': 0,
                                            'hostAuthorizationComplete': True, 'allFirstPartyHttpComplete': False,
                                            'basis': 'host_authorization_census_and_closed_mcp_business_paths',
                                            'mcpHttpTiming': mcp_timing('run-' + kind, harness), 'observedProviderEvents': 1,
                                            'officialDelivery': 'best_effort_not_a_complete_call_count'},
                   'replyVerifiedAfterTool': True, 'toolEvidence': {'toolCallHash': 'd' * 16, 'outcome': 'ok'},
                   'replyVerified': True, 'runId': 'run-' + kind, 'deviceId': 'device-' + kind}
            for kind, harness, model in [('claude', 'claude_code', 'claude-haiku-5-5'), ('codex', 'codex', 'gpt-6-luna')]}
        self.assertIs(bt.verify_release_evidence(report), report)
        for field, value in [('bootstrapAcceptance', None), ('bootstrapAcceptance', bootstrap_acceptance('foreign', 'codex')), ('templateId', 'old-template'), ('sourceCommit', 'c' * 40), ('credentialRoute', 'api_key'), ('replyVerified', False), ('model', 'other'),
                             ('replyVerifiedAfterTool', None), ('replyVerifiedAfterTool', False), ('toolEvidence', None),
                             ('toolEvidence', {'toolCallHash': 'd' * 16, 'outcome': 'error'}),
                             ('toolEvidence', {'toolCallHash': 'raw-id', 'outcome': 'ok'}),
                             ('toolEvidence', {'toolCallHash': 'd' * 16, 'outcome': 'ok', 'providerText': 'must-not-pass'})]:
            invalid = json.loads(json.dumps(report))
            invalid['subscriptionAcceptance']['codex'][field] = value
            with self.assertRaisesRegex(ValueError, 'release_subscription_acceptance_missing codex'):
                bt.verify_release_evidence(invalid)
        invalid = json.loads(json.dumps(report))
        invalid['templates']['desktop']['conservation']['after']['sha256'] = 'e' * 64
        with self.assertRaisesRegex(ValueError, 'release_conservation_invalid desktop'):
            bt.verify_release_evidence(invalid)

    def test_publication_keeps_child_lifecycle_unknown_and_refuses_missing_or_overstated_observations(self):
        valid = mcp_timing('run-codex', 'codex')
        check = lambda value: bt.observed_mcp_business_evidence(value, valid['runIdHash'], 'codex')
        self.assertTrue(check(valid), 'a missing child close is retained; it is not an extra auth request')
        for field, changed in [('runIdHash', 'f' * 16), ('harness', 'claude_code'), ('generationCoverage', 'complete'),
                               ('allFirstPartyHttpComplete', True), ('remoteMcpServerCount', 1), ('remoteMcpServerCount', False),
                               ('childPathAuditVersion', 2), ('childLifecycleComplete', True), ('truncated', True),
                               ('rejectedEvents', 1), ('requests', []), ('observedChildren', 0)]:
            value = copy.deepcopy(valid)
            value[field] = changed
            self.assertFalse(check(value), field)
        self.assertFalse(check(None))
        for mutate in [lambda value: value.pop('remoteMcpServerCount'),
                       lambda value: value['children'][0].pop('closedAt'),
                       lambda value: value['children'][0].update(lastSequence=4),
                       lambda value: value['requests'][0].update(operation='permission_check'),
                       lambda value: value['requests'][0].update(sequence=2),
                       lambda value: value['requests'][0].update(status=503),
                       lambda value: value['requests'][0].update(status=None),
                       lambda value: value['requests'][0].pop('status'),
                       lambda value: value['requests'].append(copy.deepcopy(value['requests'][0]))]:
            value = copy.deepcopy(valid)
            mutate(value)
            self.assertFalse(check(value))
        pending = copy.deepcopy(valid)
        pending['observedComplete'] = False
        pending['children'][0].update(sent=2, lastSequence=4)
        pending['requests'].append({'child': 1, 'sequence': 2, 'operation': 'decision_record', 'startedAt': 1800,
                                    'endedAt': None, 'durationMs': None, 'status': None, 'outcome': 'pending'})
        self.assertTrue(check(pending), 'known pending business work cannot become a permission-only count')

    def test_publication_requires_observed_matching_claim_catalogue_for_zero_startup_http(self):
        value = mcp_timing('run-codex', 'codex')
        value.update(version=3, childPathAuditVersion=2, expectedCatalogueSha256='b' * 64, requests=[])
        value['children'][0].update(sent=0, completed=0, lastSequence=2,
                                   catalogue={'source': 'claim', 'sha256': 'b' * 64, 'readyAt': 1040})
        check = lambda row: bt.observed_mcp_business_evidence(row, value['runIdHash'], 'codex')
        self.assertTrue(check(value))
        for mutate in [lambda row: row.pop('expectedCatalogueSha256'),
                       lambda row: row.update(expectedCatalogueSha256=None),
                       lambda row: row.update(childPathAuditVersion=1),
                       lambda row: row['children'][0].pop('catalogue'),
                       lambda row: row['children'][0]['catalogue'].update(sha256='c' * 64),
                       lambda row: row['children'][0]['catalogue'].update(text='PRIVATE'),
                       lambda row: row['children'][0]['catalogue'].update(readyAt=1000),
                       lambda row: row['children'][0].update(catalogue=None, lastSequence=1)]:
            invalid = copy.deepcopy(value); mutate(invalid)
            self.assertFalse(check(invalid))
        conflict = copy.deepcopy(value)
        request = mcp_timing('run-codex', 'codex')['requests'][0]
        conflict['requests'] = [{**request, 'body': None}]
        conflict['children'][0].update(sent=1, completed=1, lastSequence=4)
        self.assertFalse(check(conflict))

    def test_publication_accepts_body_terminal_evidence_without_reinterpreting_legacy_headers(self):
        legacy = mcp_timing('run-codex', 'codex')
        check = lambda value: bt.observed_mcp_business_evidence(value, legacy['runIdHash'], 'codex')
        self.assertTrue(check(legacy))
        value = copy.deepcopy(legacy)
        value['version'] = 2
        request = value['requests'][0]
        request['body'] = {'endedAt': request['endedAt'] + 100, 'durationMs': request['durationMs'] + 100, 'outcome': 'read'}
        value['children'][0]['lastSequence'] += 1
        self.assertTrue(check(value))
        for mutate in [lambda row: row['requests'][0].pop('body'),
                       lambda row: row['requests'][0]['body'].update(outcome=['read']),
                       lambda row: row['requests'][0]['body'].update(endedAt=request['endedAt'] - 1),
                       lambda row: row['requests'][0]['body'].update(durationMs=request['durationMs'] - 1),
                       lambda row: row['requests'][0]['body'].update(durationMs=True),
                       lambda row: row['requests'][0]['body'].update(content='PRIVATE_BODY'),
                       lambda row: row['children'][0].update(lastSequence=3)]:
            invalid = copy.deepcopy(value)
            mutate(invalid)
            self.assertFalse(check(invalid))
        value['requests'][0]['body'] = None
        value['children'][0]['lastSequence'] -= 1
        self.assertTrue(check(value), 'no body observation remains unknown, not a second send or a zero duration')

    def test_patches_public_and_verifies_ready(self):
        opener, calls = fake({'public': True, 'buildStatus': 'ready', 'builds': [{'buildID': 'b1', 'status': 'ready'}]})
        self.assertEqual(bt.publish('tpl1', 'b1', 'k', opener), {'public': True, 'buildStatus': 'ready'})
        self.assertEqual(calls[0], ('PATCH', 'https://api.e2b.app/templates/tpl1', 'k', b'{"public": true}'))
        self.assertEqual(calls[1][:2], ('GET', 'https://api.e2b.app/templates/tpl1'))

    def test_refuses_private_template(self):
        opener, _ = fake({'public': False, 'buildStatus': 'ready', 'builds': [{'buildID': 'b1', 'status': 'ready'}]})
        with self.assertRaisesRegex(RuntimeError, 'not public'):
            bt.publish('tpl1', 'b1', 'k', opener)

    def test_refuses_build_that_is_not_ready(self):
        opener, _ = fake({'public': True, 'buildStatus': 'ready', 'builds': [{'buildID': 'b1', 'status': 'error'}]})
        with self.assertRaisesRegex(RuntimeError, 'not ready'):
            bt.publish('tpl1', 'b1', 'k', opener)

    def test_refuses_odd_template_id(self):
        with self.assertRaises(ValueError):
            bt.publish('../x', 'b1', 'k', fake({})[0])

    def test_recipe_comes_from_immutable_commit_not_the_worktree(self):
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as context:
            root = Path(repo)
            git = lambda *args: subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', *args], cwd=root, check=True, capture_output=True)
            git('init', '-q')
            paths = [*(f'scripts/e2b/{name}' for name in bt.BOOTSTRAP_FILES), bt.INSTANCE_BOOTSTRAP]
            for path in paths:
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('committed recipe')
            git('add', '.'); git('commit', '-qm', 'immutable recipe')
            for path in paths: (root / path).write_text('uncommitted replacement')
            with patch.object(bt, 'ROOT', root):
                sha = bt.source_context(Path(context), 'HEAD')
                self.assertEqual(Path(context, 'source-sha').read_text(), bt.worker_hash(sha) + '\n')
                for name in (*bt.BOOTSTRAP_FILES, 'instance-bootstrap.sh'):
                    self.assertEqual(Path(context, name).read_text(), 'committed recipe')
            self.assertEqual({file.name for file in Path(context).iterdir()}, {*bt.BOOTSTRAP_FILES, 'instance-bootstrap.sh', 'source-sha'})

class WorkerHash(unittest.TestCase):
    def test_capture_tool_pins_and_installer_change_the_canonical_worker_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            git = lambda *args: subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', *args], cwd=temp, check=True, capture_output=True)
            root = Path(temp)
            helper = root / 'packages/daemon/src/agents/capture-video.mjs'
            installer = root / 'packages/daemon/scripts/install-capture-tools.mjs'
            helper.parent.mkdir(parents=True); installer.parent.mkdir(parents=True)
            helper.write_text('const binarySha256 = "first"')
            installer.write_text('verify compressed and binary hashes')
            git('init', '-q'); git('add', '.'); git('commit', '-qm', 'pinned tools')
            with patch.object(bt, 'ROOT', root):
                original = bt.worker_hash('HEAD')
                helper.write_text('const binarySha256 = "second"'); git('commit', '-qam', 'updated pin')
                changed_pin = bt.worker_hash('HEAD')
                self.assertNotEqual(original, changed_pin)
                installer.write_text('changed installer'); git('commit', '-qam', 'updated installer')
                self.assertNotEqual(changed_pin, bt.worker_hash('HEAD'))

    def test_changes_only_with_what_the_template_packages(self):
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as temp:
            git = lambda *args: subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', *args], cwd=temp, check=True, capture_output=True)
            write = lambda path, text: (Path(temp, path).parent.mkdir(parents=True, exist_ok=True), Path(temp, path).write_text(text))
            git('init', '-q')
            for path in ('package.json', 'packages/daemon/a.ts', 'scripts/e2b/official-files.py', 'scripts/e2b/build-template.py', 'app/page.tsx'):
                write(path, 'one')
            git('add', '-A'); git('commit', '-qm', 'one')
            root, bt.ROOT = bt.ROOT, Path(temp)
            try:
                first = bt.worker_hash('HEAD')
                self.assertRegex(first, r'^[0-9a-f]{40}$')
                write('app/page.tsx', 'two'); git('commit', '-qam', 'app only')
                self.assertEqual(bt.worker_hash('HEAD'), first)
                write('packages/daemon/a.ts', 'two'); git('commit', '-qam', 'daemon')
                second = bt.worker_hash('HEAD')
                self.assertNotEqual(second, first)
                write('scripts/e2b/official-files.py', 'two'); git('commit', '-qam', 'recipe')
                recipe = bt.worker_hash('HEAD')
                self.assertNotEqual(recipe, second)
                write('scripts/e2b/viewer-gateway.py', 'guard'); git('add', '.'); git('commit', '-qm', 'viewer guard')
                self.assertNotEqual(bt.worker_hash('HEAD'), recipe)
                viewer = bt.worker_hash('HEAD')
                write('scripts/e2b/acceptance-bootstrap.mts', 'candidate helper'); git('add', '.'); git('commit', '-qm', 'candidate helper')
                helper = bt.worker_hash('HEAD')
                self.assertNotEqual(helper, viewer)
                write('scripts/e2b/acceptance-bootstrap.mts', 'changed candidate helper'); git('commit', '-qam', 'candidate helper change')
                self.assertNotEqual(bt.worker_hash('HEAD'), helper)
            finally:
                bt.ROOT = root

    def test_script_and_unrelated_lock_entries_do_not_change_the_hash(self):
        import subprocess, tempfile
        with tempfile.TemporaryDirectory() as temp:
            git = lambda *args: subprocess.run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', *args], cwd=temp, check=True, capture_output=True)
            write = lambda path, text: (Path(temp, path).parent.mkdir(parents=True, exist_ok=True), Path(temp, path).write_text(text))
            git('init', '-q')
            write('package.json', '{"packageManager":"pnpm@10.34.3","scripts":{"test":"one"},"dependencies":{"next":"1.0.0"}}')
            write('packages/daemon/package.json', '{"name":"@mikka/daemon","dependencies":{"zod":"1.0.0"}}')
            write('pnpm-lock.yaml', '''lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      next:
        specifier: 1.0.0
        version: 1.0.0

  packages/daemon:
    dependencies:
      zod:
        specifier: 1.0.0
        version: 1.0.0

packages:

  next@1.0.0:
    resolution: {integrity: web}

  zod@1.0.0:
    resolution: {integrity: daemon}

snapshots:

  next@1.0.0: {}

  zod@1.0.0: {}
''')
            write('packages/daemon/a.ts', 'one')
            git('add', '-A'); git('commit', '-qm', 'base')
            root, bt.ROOT = bt.ROOT, Path(temp)
            try:
                first = bt.worker_hash('HEAD')
                write('package.json', '{"packageManager":"pnpm@10.34.3","scripts":{"test":"two"},"dependencies":{"next":"1.0.0"}}')
                git('commit', '-qam', 'script only')
                self.assertEqual(bt.worker_hash('HEAD'), first)
                write('pnpm-lock.yaml', Path(temp, 'pnpm-lock.yaml').read_text().replace('integrity: web', 'integrity: web2'))
                git('commit', '-qam', 'web package only')
                self.assertEqual(bt.worker_hash('HEAD'), first, 'a web-only lockfile entry stays out of the worker hash')
                text = Path(temp, 'pnpm-lock.yaml').read_text().replace('integrity: daemon', 'integrity: daemon2')
                write('pnpm-lock.yaml', text)
                git('commit', '-qam', 'daemon package')
                self.assertNotEqual(bt.worker_hash('HEAD'), first)
            finally:
                bt.ROOT = root

    def test_real_lockfile_projects(self):
        digest = bt.worker_hash('HEAD')
        self.assertRegex(digest, r'^[0-9a-f]{40}$')

class WorkerImports(unittest.TestCase):
    def test_packaged_code_only_imports_what_the_template_ships(self):
        # The template holds WORKER_PATHS only: a relative import that leaves them works in the
        # repository and fails in the cloud worker (ERR_MODULE_NOT_FOUND), so no worker starts.
        import os, re
        spec = re.compile(r"""(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)['"](\.{1,2}/[^'"]+)['"]""", re.M)
        roots = [bt.ROOT / path for path in bt.WORKER_PATHS if (bt.ROOT / path).is_dir()]
        shipped = [os.path.realpath(bt.ROOT / path) for path in bt.WORKER_PATHS]
        escapes = []
        for root in roots:
            for directory, dirs, files in os.walk(root):
                dirs[:] = [d for d in dirs if d not in ('node_modules', 'dist', 'test', '__tests__')]
                for name in files:
                    if not re.search(r'\.(ts|tsx|mts|cts|js|mjs|cjs)$', name) or re.search(r'\.(test|spec)\.|\.node\.ts$', name):
                        continue
                    source = Path(directory, name)
                    for target in spec.findall(source.read_text(errors='ignore')):
                        resolved = os.path.realpath(os.path.join(directory, target))
                        if not any(resolved == top or resolved.startswith(top + os.sep) for top in shipped):
                            escapes.append(f'{source.relative_to(bt.ROOT)} -> {target}')
        self.assertEqual(escapes, [])

if __name__ == '__main__':
    unittest.main()
