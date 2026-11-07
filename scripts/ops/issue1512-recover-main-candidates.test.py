"""Offline guards using the actual fixed builder; no SDK or network calls."""
import argparse
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('recovery', HERE / 'issue1512-recover-main-candidates.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
SOURCE = HERE.parents[2] / 'Mikka'
KEY = 'sk_fixture_do_not_export'
RUN = {'id': recovery.TARGET_RUN, 'repository': {'full_name': recovery.REPOSITORY},
       'path': '.github/workflows/e2b-official-runtime.yml', 'head_branch': 'main',
       'head_sha': recovery.TARGET_SHA, 'run_attempt': 1, 'event': 'push',
       'status': 'completed', 'conclusion': 'failure'}


class Fake:
    def __init__(self, change=None, active=False, stale_at_delete=False, truncated=False):
        self.change = change or {}
        self.active, self.stale_at_delete, self.truncated = active, stale_at_delete, truncated
        self.deleted, self.calls, self.run_reads = set(), [], 0
        self.sdk = (self, SimpleNamespace, SimpleNamespace(RUNNING='running', PAUSED='paused'))

    def github(self):
        self.run_reads += 1
        if self.stale_at_delete and self.run_reads > 1:
            return {**RUN, 'run_attempt': 2, 'status': 'in_progress', 'conclusion': None}
        return deepcopy(RUN)

    def list(self, **kwargs):
        self.calls.append(('LIST', 'exact_metadata'))
        assert kwargs['query'].metadata == recovery.TARGET_METADATA
        assert kwargs['query'].state == ['running', 'paused']
        assert kwargs['limit'] == 10 and kwargs['api_key'] == KEY and kwargs['request_timeout'] == 10
        owner = self
        class Page:
            has_next = True
            def next_items(self):
                self.has_next = owner.truncated
                return ([SimpleNamespace(sandbox_id='active-owned-sandbox',
                         template_id=recovery.TARGETS[0]['templateId'], state='running',
                         metadata={**recovery.TARGET_METADATA, 'kind': 'desktop'})] if owner.active else [])
        return Page()

    def request(self, method, path, key):
        assert key == KEY
        self.calls.append((method, path))
        for index, row in enumerate(recovery.TARGETS):
            if path == '/templates/' + row['templateId']:
                if row['templateId'] in self.deleted or (index == 0 and self.change.get('absent')):
                    raise HTTPError(path, 404, KEY, {}, None)
                if method == 'DELETE':
                    self.deleted.add(row['templateId'])
                    return None
                assert method == 'GET'
                info = {'templateID': row['templateId'], 'buildID': row['buildId'],
                        'buildStatus': 'ready', 'public': False, 'isDefault': False,
                        'names': ['own-team/' + row['name']], 'aliases': []}
                if index == 0:
                    info.update({key: value for key, value in self.change.items()
                                 if key not in ('aliasId', 'aliasMissing', 'absent')})
                return info
            if path == '/templates/aliases/' + row['name']:
                assert method == 'GET'
                if index == 0 and self.change.get('aliasMissing'):
                    raise HTTPError(path, 404, KEY, {}, None)
                return {'templateID': self.change.get('aliasId', row['templateId']) if index == 0 else row['templateId'],
                        'public': False}
        raise AssertionError('unexpected API path')


class RecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = recovery.load_builder(SOURCE)

    def execute(self, fake, github=None):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'receipt.json'
            ledger = recovery.recover(self.builder, github or fake.github, fake.request,
                                      fake.sdk, KEY, output, {'opsCommit': 'a' * 40})
            self.assertEqual(json.loads(output.read_text()), ledger)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(KEY, output.read_text())
            return ledger

    def test_exact_three_private_candidates_use_existing_builder_and_id_404(self):
        fake = Fake()
        ledger = self.execute(fake)
        self.assertEqual(ledger['status'], 'complete')
        self.assertEqual(fake.deleted, {row['templateId'] for row in recovery.TARGETS})
        self.assertEqual(fake.run_reads, 4)
        self.assertEqual(sum(method == 'LIST' for method, _ in fake.calls), 1)
        self.assertEqual([path for method, path in fake.calls if method == 'DELETE'],
                         ['/templates/' + row['templateId'] for row in recovery.TARGETS])
        for row in ledger['candidates']:
            self.assertEqual(row['status'], 'deleted')
            self.assertTrue(row['deleteRequested'])
            self.assertTrue(row['absenceConfirmedById'])
            self.assertEqual(row['absenceHttpStatus'], 404)

    def test_stale_running_successful_or_wrong_source_run_stops_before_inventory(self):
        for change in [{'run_attempt': 2}, {'status': 'in_progress'}, {'conclusion': 'success'},
                       {'head_sha': 'b' * 40}, {'head_branch': 'feature'},
                       {'path': '.github/workflows/other.yml'}, {'id': 12}, {'event': 'workflow_dispatch'}]:
            with self.subTest(change=change):
                fake = Fake()
                ledger = self.execute(fake, lambda: {**RUN, **change})
                self.assertEqual(ledger['status'], 'blocked')
                self.assertEqual(ledger['errors'], [{'code': 'target_run_changed'}])
                self.assertEqual(fake.calls, [])

    def test_target_rerun_at_delete_boundary_never_deletes(self):
        fake = Fake(stale_at_delete=True)
        ledger = self.execute(fake)
        self.assertEqual(ledger['status'], 'incomplete')
        self.assertFalse(fake.deleted)
        self.assertEqual(ledger['candidates'][0]['error']['code'], 'target_run_changed')
        self.assertEqual(ledger['candidates'][1]['status'], 'not_attempted')

    def test_public_default_changed_build_name_or_rebound_alias_is_retained(self):
        cases = [({'public': True}, 'template_public'), ({'isDefault': True}, 'template_default'),
                 ({'buildID': 'different-build'}, 'template_build_changed'),
                 ({'names': ['foreign-name']}, 'template_name_changed'),
                 ({'aliasId': 'foreign-template'}, 'alias_rebound'),
                 ({'aliasMissing': True}, 'alias_unavailable')]
        for change, code in cases:
            with self.subTest(change=change):
                fake = Fake(change)
                ledger = self.execute(fake)
                self.assertNotIn(recovery.TARGETS[0]['templateId'], fake.deleted)
                self.assertEqual(ledger['candidates'][0]['status'], 'retained')
                self.assertEqual(ledger['candidates'][0]['error']['code'], code)
                self.assertEqual(ledger['status'], 'incomplete')

    def test_already_absent_known_id_is_confirmed_without_delete(self):
        fake = Fake({'absent': True})
        ledger = self.execute(fake)
        self.assertEqual(ledger['status'], 'complete')
        self.assertEqual(ledger['candidates'][0]['status'], 'absent')
        self.assertFalse(ledger['candidates'][0]['deleteRequested'])
        self.assertTrue(ledger['candidates'][0]['absenceConfirmedById'])

    def test_active_or_truncated_inventory_is_reported_without_any_delete(self):
        for fake, code in [(Fake(active=True), 'inventory_nonempty'), (Fake(truncated=True), 'inventory_truncated')]:
            ledger = self.execute(fake)
            self.assertEqual(ledger['status'], 'blocked')
            self.assertEqual(ledger['errors'], [{'code': code}])
            self.assertEqual(fake.calls, [('LIST', 'exact_metadata')])

    def test_workflow_has_fixed_source_existing_identity_no_github_identity_overrides(self):
        workflow = (HERE.parents[1] / '.github/workflows/issue1512-recover-main-candidates.yml').read_text()
        self.assertIn('ref: ' + recovery.SOURCE, workflow)
        self.assertIn('ref: ${{ github.sha }}', workflow)
        self.assertIn('actions: read', workflow)
        self.assertIn('timeout-minutes: 3', workflow)
        self.assertIn('identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', workflow)
        self.assertIn('secret-name: E2B_API_KEY', workflow)
        self.assertIn("startsWith(github.event.head_commit.message, 'issue1512:recover-main-candidates')", workflow)
        for prohibited in ['GITHUB_SHA:', 'GITHUB_RUN_ID:', 'GITHUB_RUN_ATTEMPT:', 'contents: write', 'workflow_dispatch']:
            self.assertNotIn(prohibited, workflow)
        self.assertNotIn(KEY, json.dumps(recovery.safe_error(RuntimeError(KEY))))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--source', type=Path, default=SOURCE)
    args, remaining = parser.parse_known_args()
    SOURCE = args.source
    unittest.main(argv=[sys.argv[0], *remaining])
