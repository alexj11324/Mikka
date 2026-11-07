import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).with_name('cleanup-template-candidates.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
ENV = {'GITHUB_REPOSITORY': 'alexj11324/Mikka', 'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2'}
CANDIDATE = {'kind': 'codex', 'name': 'mikka-fixture-codex', 'templateId': 'owned-id'}


class TemplateAPI:
    """The alias and ID endpoints have distinct response contracts."""
    def __init__(self, info=None, alias=None, *, id_absent=False, alias_absent=False, delete_effective=True):
        self.info = {'templateID': 'owned-id', 'aliases': [CANDIDATE['name']], 'public': False, **(info or {})}
        self.alias = {'templateID': 'owned-id', 'public': False, **(alias or {})}
        self.id_absent = id_absent
        self.alias_absent = alias_absent
        self.delete_effective = delete_effective
        self.calls = []

    def __call__(self, method, path, api_key):
        self.calls.append((method, path))
        if method == 'GET' and path == '/templates/aliases/' + CANDIDATE['name']:
            if not self.alias_absent:
                return self.alias
        elif method == 'GET' and path == '/templates/owned-id':
            if not self.id_absent:
                return self.info
        elif method == 'DELETE' and path == '/templates/owned-id':
            self.id_absent = self.delete_effective
            return None
        elif method != 'GET':
            raise AssertionError('unexpected_template_mutation')
        raise HTTPError(path, 404, 'private-response-contents', {}, None)


def receipt(attempt='2'):
    return {'version': 1, 'sourceCommit': ENV['GITHUB_SHA'], 'runId': ENV['GITHUB_RUN_ID'], 'runAttempt': attempt,
            'templates': {kind: {'baseTemplate': kind, 'name': f'mikka-aaaaaaaaaaaa-123-{attempt}-{kind}',
                                 'templateId': f'owned-{kind}'} for kind in cleanup.builder.KINDS}}


class Cleanup(unittest.TestCase):
    def test_short_identity_schema_size_source_run_and_producer_attempt_are_checked(self):
        raw = json.dumps(receipt()).encode()
        self.assertLess(len(raw), cleanup.IDENTITY_MAX_BYTES)
        self.assertEqual(cleanup.identity_receipt(raw, ENV), receipt())
        for mutate in [lambda value: value.update(sourceCommit='b' * 40), lambda value: value.update(runId='456'),
                       lambda value: value.update(runAttempt='3'), lambda value: value.update(runAttempt='0'),
                       lambda value: value.update(version=True), lambda value: value.update(extra='private-marker'),
                       lambda value: value['templates']['codex'].update(name='codex'),
                       lambda value: value['templates']['codex'].update(extra='private-marker'),
                       lambda value: value['templates']['codex'].update(templateId='owned-claude')]:
            value = receipt()
            mutate(value)
            with self.assertRaisesRegex(ValueError, 'cleanup_identity_receipt_invalid'):
                cleanup.identity_receipt(json.dumps(value).encode(), ENV)
        with self.assertRaisesRegex(ValueError, 'cleanup_identity_too_large'):
            cleanup.identity_receipt(b' ' * (cleanup.IDENTITY_MAX_BYTES + 1), ENV)

    def test_old_producer_identities_clean_both_exact_attempts_without_reusing_their_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'identities.json'
            path.write_text(json.dumps(receipt('1')))
            metadata, candidates, errors = cleanup.cleanup_plan(ENV, identity_path=path, identities_required=True)
        self.assertEqual(errors, [])
        self.assertEqual([row['runAttempt'] for row in metadata], ['1', '2'])
        self.assertEqual(len(candidates), 6)
        self.assertEqual({row['templateId'] for row in candidates if 'templateId' in row},
                         {'owned-claude', 'owned-codex', 'owned-desktop'})
        self.assertEqual({row['name'] for row in candidates},
                         {f'mikka-aaaaaaaaaaaa-123-{attempt}-{kind}' for attempt in ('1', '2') for kind in cleanup.builder.KINDS})

    def test_missing_optional_identity_uses_only_this_attempt_but_missing_required_identity_stays_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'missing.json'
            _, candidates, errors = cleanup.cleanup_plan(ENV, identity_path=path)
            self.assertEqual(errors, [])
            self.assertTrue(all('templateId' not in row for row in candidates))
            _, required, errors = cleanup.cleanup_plan(ENV, identity_path=path, identities_required=True)
        self.assertEqual(candidates, required)
        self.assertEqual(errors, [{'phase': 'candidate_identity', 'error': 'ValueError'}])

    def test_corrupt_identity_or_large_report_still_closes_our_scope_and_emits_a_failed_receipt(self):
        for option, contents in [('--identities-file', '{"private-marker-invalid-json'),
                                 ('--report', '{"private-marker-invalid-json'),
                                 ('--identities-file', json.dumps({**receipt(), 'sourceCommit': 'b' * 40}))]:
            with tempfile.TemporaryDirectory() as directory:
                path, output = Path(directory) / 'input.json', Path(directory) / 'cleanup.json'
                path.write_text(contents)
                calls = []
                def close_images(candidates, api_key):
                    calls.extend(candidates)
                    return [{**row, 'status': 'absent'} for row in candidates]
                with patch.dict(cleanup.os.environ, {**ENV, 'E2B_API_KEY': 'fixture'}, clear=True), \
                        patch('sys.argv', ['cleanup-template-candidates.py', option, str(path), '--output', str(output)]), \
                        patch.object(cleanup, 'cleanup_sandboxes', return_value=[]), \
                        patch.object(cleanup.builder, 'cleanup_templates', side_effect=close_images), \
                        patch('sys.stdout', new_callable=io.StringIO) as stdout:
                    with self.assertRaisesRegex(RuntimeError, 'release_cleanup_incomplete'):
                        cleanup.main()
                result = json.loads(output.read_text())
                self.assertEqual(len(calls), 3)
                self.assertTrue(all(row['name'].startswith('mikka-aaaaaaaaaaaa-123-2-') and 'templateId' not in row for row in calls))
                self.assertEqual(result['errors'][0]['phase'], 'candidate_identity')
                self.assertNotIn('private-marker', output.read_text() + stdout.getvalue())

    def test_context_is_exact_to_the_workflow_and_can_recover_a_prior_attempt_report(self):
        report = {'sourceCommit': ENV['GITHUB_SHA'], 'templates': {'codex': {
            'baseTemplate': 'codex', 'name': 'mikka-aaaaaaaaaaaa-123-1-codex', 'templateId': 'owned-id'}}}
        metadata, candidates = cleanup.identities(ENV, report)
        self.assertEqual([row['runAttempt'] for row in metadata], ['1', '2'])
        self.assertEqual(next(row for row in candidates if row['kind'] == 'codex')['templateId'], 'owned-id')
        for name in ['mikka-aaaaaaaaaaaa-456-1-codex', 'mikka-aaaaaaaaaaaa-123-3-codex', 'codex']:
            report['templates']['codex']['name'] = name
            with self.assertRaisesRegex(ValueError, 'cleanup_candidate_identity_mismatch'):
                cleanup.identities(ENV, report)
        with self.assertRaisesRegex(ValueError, 'cleanup_workflow_identity_required'):
            cleanup.identities({})

    def test_only_the_exact_private_name_and_id_are_deleted_and_absence_is_verified(self):
        for mutation, expected in [({}, 'deleted'), ({'public': True}, 'retained_public'),
                                   ({'templateID': 'different-id'}, 'failed'), ({'aliases': ['previous']}, 'failed'),
                                   ({'public': None}, 'failed'), ({'isDefault': True}, 'failed')]:
            with self.subTest(mutation=mutation):
                api = TemplateAPI(info=mutation)
                result = cleanup.builder.cleanup_templates([CANDIDATE], 'fixture', api)
                self.assertEqual(result[0]['status'], expected)
                self.assertEqual(sum(method == 'DELETE' for method, _ in api.calls), int(expected == 'deleted'))
                if expected == 'deleted':
                    self.assertEqual(api.calls, [('GET', '/templates/owned-id'),
                                                ('GET', '/templates/aliases/' + CANDIDATE['name']),
                                                ('DELETE', '/templates/owned-id'), ('GET', '/templates/owned-id')])

    def test_existing_id_with_rebound_or_untrusted_alias_is_not_reported_absent(self):
        for options in ({'alias': {'templateID': 'different-id'}},
                        {'alias': {'templateID': '../foreign'}}, {'alias': {'public': None}}):
            with self.subTest(options=options):
                api = TemplateAPI(**options)
                result = cleanup.builder.cleanup_templates([CANDIDATE], 'fixture', api)
                self.assertEqual(result[0]['status'], 'failed')
                self.assertEqual(api.calls[0], ('GET', '/templates/owned-id'))
                self.assertFalse(any(method == 'DELETE' for method, _ in api.calls))
                self.assertNotIn('private-response-contents', str(result))

    def test_known_id_absence_is_verified_by_id_without_following_a_rebound_alias(self):
        api = TemplateAPI(id_absent=True, alias={'templateID': 'different-id'})
        result = cleanup.builder.cleanup_templates([CANDIDATE], 'fixture', api)
        self.assertEqual(result, [{**CANDIDATE, 'status': 'absent'}])
        self.assertEqual(api.calls, [('GET', '/templates/owned-id')])

    def test_partial_creation_is_recovered_through_the_exact_alias_then_id(self):
        candidate = {key: value for key, value in CANDIDATE.items() if key != 'templateId'}
        api = TemplateAPI()
        result = cleanup.builder.cleanup_templates([candidate], 'fixture', api)
        self.assertEqual(result, [{**CANDIDATE, 'status': 'deleted'}])
        self.assertEqual(api.calls, [('GET', '/templates/aliases/' + CANDIDATE['name']),
                                    ('GET', '/templates/owned-id'), ('DELETE', '/templates/owned-id'),
                                    ('GET', '/templates/owned-id')])
        missing = TemplateAPI(alias_absent=True)
        self.assertEqual(cleanup.builder.cleanup_templates([candidate], 'fixture', missing),
                         [{**candidate, 'status': 'absent'}])
        self.assertEqual(missing.calls, [('GET', '/templates/aliases/' + CANDIDATE['name'])])

    def test_namespaced_name_requires_the_same_exact_alias_binding(self):
        info = {'aliases': [], 'names': ['owned-team/' + CANDIDATE['name']]}
        api = TemplateAPI(info=info)
        self.assertEqual(cleanup.builder.cleanup_templates([CANDIDATE], 'fixture', api)[0]['status'], 'deleted')
        rebound = TemplateAPI(info=info, alias={'templateID': 'different-id'})
        self.assertEqual(cleanup.builder.cleanup_templates([CANDIDATE], 'fixture', rebound)[0]['status'], 'failed')
        self.assertFalse(any(method == 'DELETE' for method, _ in rebound.calls))
        missing = TemplateAPI(info=info, alias_absent=True)
        self.assertEqual(cleanup.builder.cleanup_templates([CANDIDATE], 'fixture', missing)[0]['status'], 'failed')
        self.assertFalse(any(method == 'DELETE' for method, _ in missing.calls))

    def test_public_alias_and_unconfirmed_deletion_are_never_reported_deleted(self):
        public = TemplateAPI(alias={'public': True})
        self.assertEqual(cleanup.builder.cleanup_templates([CANDIDATE], 'fixture', public)[0]['status'], 'retained_public')
        self.assertFalse(any(method == 'DELETE' for method, _ in public.calls))
        still_exists = TemplateAPI(delete_effective=False)
        result = cleanup.builder.cleanup_templates([CANDIDATE], 'fixture', still_exists)
        self.assertEqual(result[0]['status'], 'failed')
        self.assertEqual(result[0]['error'], 'RuntimeError')
        self.assertEqual(still_exists.calls[-1], ('GET', '/templates/owned-id'))

    def test_invalid_expected_id_does_not_fall_back_to_name_only_recovery(self):
        for template_id in ('../foreign', '', None):
            with self.subTest(template_id=template_id):
                api = TemplateAPI()
                result = cleanup.builder.cleanup_templates([{**CANDIDATE, 'templateId': template_id}], 'fixture', api)
                self.assertEqual(result[0]['status'], 'failed')
                self.assertEqual(api.calls, [])

    def test_name_only_cleanup_resolves_the_alias_before_reading_and_deleting_the_id(self):
        candidate = {'kind': 'desktop', 'name': 'mikka-own-desktop'}
        calls = []
        def request(method, path, _):
            calls.append((method, path))
            if method == 'DELETE': return None
            if path == '/templates/aliases/mikka-own-desktop': return {'templateID': 'owned-id', 'public': False}
            if path == '/templates/owned-id' and len(calls) == 2:
                return {'templateID': 'owned-id', 'names': [candidate['name']], 'public': False}
            raise HTTPError(path, 404, 'gone', {}, None)
        result = cleanup.builder.cleanup_templates([candidate], 'fixture', request)
        self.assertEqual(result, [{**candidate, 'templateId': 'owned-id', 'status': 'deleted'}])
        self.assertEqual(calls, [('GET', '/templates/aliases/mikka-own-desktop'), ('GET', '/templates/owned-id'),
                                 ('DELETE', '/templates/owned-id'), ('GET', '/templates/owned-id')])

    def test_missing_alias_does_not_hide_a_recorded_template_id(self):
        candidate = {'kind': 'claude', 'name': 'mikka-own-claude', 'templateId': 'owned-id'}
        calls = []
        def request(method, path, _):
            calls.append((method, path))
            if method == 'DELETE': return None
            if path == '/templates/owned-id' and not any(call[0] == 'DELETE' for call in calls):
                return {'templateID': 'owned-id', 'names': [candidate['name']], 'public': False}
            raise HTTPError(path, 404, 'gone', {}, None)
        result = cleanup.builder.cleanup_templates([candidate], 'fixture', request)
        self.assertEqual(result[0]['status'], 'deleted')
        self.assertIn(('DELETE', '/templates/owned-id'), calls)

    def test_alias_repointing_cannot_delete_a_different_image(self):
        candidate = {'kind': 'codex', 'name': 'mikka-own-codex', 'templateId': 'recorded-id'}
        calls = []
        def request(method, path, _):
            calls.append((method, path))
            return {'templateID': 'foreign-id', 'public': False}
        result = cleanup.builder.cleanup_templates([candidate], 'fixture', request)
        self.assertEqual(result[0]['status'], 'failed')
        self.assertEqual(calls, [('GET', '/templates/recorded-id'), ('GET', '/templates/aliases/mikka-own-codex')])

    def test_cleanup_refuses_a_mismatched_list_result_and_continues_after_a_kill_error(self):
        metadata, _ = cleanup.identities(ENV)
        deleted = []
        class Sandbox:
            rows = [SimpleNamespace(sandbox_id='one', metadata=metadata[0]), SimpleNamespace(sandbox_id='two', metadata=metadata[0])]
            @classmethod
            def list(cls, **kwargs):
                self.assertEqual(kwargs['query'].metadata, metadata[0])
                class Pages:
                    has_next = True
                    def next_items(self): self.has_next = False; return cls.rows
                return Pages()
            @staticmethod
            def kill(sandbox_id, **kwargs):
                deleted.append(sandbox_id)
                if sandbox_id == 'one': raise RuntimeError('private-response-contents')
        sdk = (Sandbox, SimpleNamespace, SimpleNamespace(RUNNING='running', PAUSED='paused'))
        result = cleanup.cleanup_sandboxes(metadata, 'fixture', sdk)
        self.assertEqual([row['status'] for row in result], ['failed', 'killed'])
        self.assertNotIn('private-response-contents', str(result))
        self.assertEqual(deleted, ['one', 'two'])
        Sandbox.rows = [SimpleNamespace(sandbox_id='foreign', metadata={**metadata[0], 'sourceCommit': 'b' * 40})]
        with self.assertRaisesRegex(ValueError, 'cleanup_sandbox_identity_mismatch'):
            cleanup.cleanup_sandboxes(metadata, 'fixture', sdk)
        self.assertNotIn('foreign', deleted)


if __name__ == '__main__':
    unittest.main()
