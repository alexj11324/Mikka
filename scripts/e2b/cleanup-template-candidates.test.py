import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).with_name('cleanup-template-candidates.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
ENV = {'GITHUB_REPOSITORY': 'alexj11324/Mikka', 'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2'}


class Cleanup(unittest.TestCase):
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
        candidate = {'kind': 'codex', 'name': 'mikka-fixture-codex', 'templateId': 'owned-id'}
        for mutation, expected in [({}, 'deleted'), ({'public': True}, 'retained_public'),
                                   ({'templateID': 'different-id'}, 'failed'), ({'aliases': ['previous']}, 'failed'),
                                   ({'public': None}, 'failed'), ({'isDefault': True}, 'failed')]:
            calls = []
            info = {'templateID': 'owned-id', 'aliases': [candidate['name']], 'public': False, **mutation}
            def request(method, path, api_key):
                calls.append((method, path))
                if method == 'DELETE': return None
                if len(calls) == 3: raise HTTPError(path, 404, 'gone', {}, None)
                return info
            result = cleanup.builder.cleanup_templates([candidate], 'fixture', request)
            self.assertEqual(result[0]['status'], expected)
            self.assertEqual(sum(method == 'DELETE' for method, _ in calls), int(expected == 'deleted'))
            if expected == 'deleted': self.assertEqual(calls[-1], ('GET', '/templates/owned-id'))

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
