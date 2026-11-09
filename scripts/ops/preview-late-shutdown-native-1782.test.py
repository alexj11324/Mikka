"""Offline checks of the exact late-shutdown native proof, without sockets."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('late_native_proof', Path(__file__).with_name('preview-late-shutdown-native-1782.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


def actual_red():
    # Exercise unittest's real AssertionError serialization and traceback. This
    # is only a classifier fixture; it does not claim a Unix listener was run.
    with tempfile.TemporaryDirectory(prefix='late-classifier-') as directory:
        path = Path(directory) / 'preview-gateway.test.py'
        path.write_text('class PreviewAcceptance(unittest.TestCase):\n'
                        '    def ' + proof.TARGET + '(self):\n'
                        '        socket_path = missing\n'
                        '        ' + proof.FAIL_ASSERTION + '\n')
        namespace = {'__name__': 'preview_late_shutdown_cases', 'unittest': unittest,
                     'missing': Path(directory) / 'absent-control.sock'}
        exec(compile(path.read_bytes(), str(path), 'exec'), namespace)
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(namespace['PreviewAcceptance'])
        result = unittest.TextTestRunner(stream=io.StringIO(), resultclass=proof.EvidenceResult).run(suite)
        return proof.result_evidence(result, 'red')


def green(phase, count):
    names = ['test_' + str(index) for index in range(count)]
    return {'phase': phase, 'testsRun': count,
            'successes': ['preview_late_shutdown_cases.PreviewAcceptance.' + name for name in names],
            'errors': [], 'failures': [], 'skipped': 0, 'expectedFailures': 0, 'unexpectedSuccesses': 0}, names


class LateNativeProof(unittest.TestCase):
    def test_real_unittest_assertion_and_its_exact_source_frame_are_accepted(self):
        result = actual_red()
        self.assertEqual(result['testsRun'], 1)
        self.assertEqual(result['failures'][0]['type'], 'builtins.AssertionError')
        self.assertIs(result['failures'][0]['messageMatched'], True)
        proof.validate_phase(result, 'red', [])

    def test_environment_timeout_wrong_assertion_or_other_test_is_never_red(self):
        original = actual_red()
        for key, value in [('type', 'builtins.TimeoutError'), ('type', 'builtins.PermissionError'),
                           ('type', 'builtins.FileNotFoundError'), ('type', 'subprocess.TimeoutExpired'),
                           ('messageMatched', False), ('messageMatched', 1), ('test', 'different_test')]:
            changed = copy.deepcopy(original)
            changed['failures'][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaisesRegex(RuntimeError, 'wrong_red_failure'):
                proof.validate_phase(changed, 'red', [])
        changed = copy.deepcopy(original)
        changed['errors'] = changed['failures']; changed['failures'] = []
        with self.assertRaisesRegex(RuntimeError, 'expected_unlink_failure_missing'):
            proof.validate_phase(changed, 'red', [])

    def test_matching_message_outside_the_socket_survival_assertion_is_refused(self):
        for frame in [{'file': 'other.py', 'function': proof.TARGET, 'replacementSocketSurvivalAssertion': True},
                      {'file': 'preview-gateway.test.py', 'function': 'asyncSetUp', 'replacementSocketSurvivalAssertion': True},
                      {'file': 'preview-gateway.test.py', 'function': proof.TARGET, 'replacementSocketSurvivalAssertion': False},
                      {'file': 'preview-gateway.test.py', 'function': proof.TARGET, 'replacementSocketSurvivalAssertion': 1}]:
            changed = actual_red(); changed['failures'][0]['frames'] = [frame]
            with self.subTest(frame=frame), self.assertRaisesRegex(RuntimeError, 'wrong_assertion_stage'):
                proof.validate_phase(changed, 'red', [])

    def test_extra_failures_skips_or_incomplete_results_cannot_be_expected_red(self):
        original = actual_red()
        for key, value in [('testsRun', 0), ('testsRun', 2), ('testsRun', True), ('skipped', 1),
                           ('skipped', False), ('expectedFailures', 1), ('unexpectedSuccesses', 1),
                           ('failures', []), ('failures', original['failures'] * 2),
                           ('successes', ['another_test']), ('errors', [{'type': 'builtins.OSError'}])]:
            changed = copy.deepcopy(original); changed[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                proof.validate_phase(changed, 'red', [])
        with self.assertRaises(RuntimeError):
            proof.validate_phase(original, 'unknown', [])

    def test_both_original_fifteen_and_candidate_sixteen_exact_sets_are_required(self):
        for phase, count in [('baseline_green', 15), ('green', 16)]:
            original, names = green(phase, count)
            proof.validate_phase(original, phase, names)
            for key, value in [('testsRun', count - 1), ('skipped', 1),
                               ('errors', actual_red()['failures']), ('failures', actual_red()['failures']),
                               ('successes', original['successes'][:-1]),
                               ('successes', [original['successes'][0]] * count)]:
                changed = copy.deepcopy(original); changed[key] = value
                with self.subTest(phase=phase, key=key), self.assertRaises(RuntimeError):
                    proof.validate_phase(changed, phase, names)

    def test_all_original_fifteen_test_bodies_are_preserved(self):
        prefix = 'class PreviewAcceptance:\n'
        original = prefix + ''.join('    async def test_' + str(index) + '(self):\n        self.assertEqual(1, 1)\n'
                                    for index in range(15))
        candidate = original + '    async def ' + proof.TARGET + '(self):\n        self.assertTrue(True)\n'
        old, new = proof.test_preservation(original, candidate)
        self.assertEqual((len(old), len(new)), (15, 16))
        with self.assertRaisesRegex(RuntimeError, 'original_case_changed'):
            proof.test_preservation(original, candidate.replace('self.assertEqual(1, 1)', 'self.assertEqual(1, 0)', 1))
        for changed in [original, candidate + '    async def test_extra(self):\n        pass\n']:
            with self.assertRaisesRegex(RuntimeError, 'fixture_cases_changed'):
                proof.test_preservation(original, changed)

    def test_real_parent_and_exact_seven_path_delta_are_required_before_fixture_reads(self):
        with tempfile.TemporaryDirectory(prefix='late-source-classifier-') as directory:
            repo = Path(directory); event = repo / 'event.json'; head = 'a' * 40
            env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': 'alexj11324/Mikka',
                   'GITHUB_ACTOR': 'alexj11324', 'GITHUB_TRIGGERING_ACTOR': 'alexj11324',
                   'GITHUB_EVENT_NAME': 'push', 'GITHUB_RUN_ATTEMPT': '1',
                   'GITHUB_REF': 'refs/heads/' + proof.gateway.BRANCH, 'GITHUB_JOB': 'native_late_shutdown',
                   'GITHUB_WORKFLOW_REF': 'alexj11324/Mikka/' + proof.gateway.WORKFLOW + '@refs/heads/' + proof.gateway.BRANCH,
                   'GITHUB_SHA': head, 'GITHUB_EVENT_PATH': str(event)}
            event.write_text(json.dumps({'after': head, 'ref': env['GITHUB_REF'], 'forced': False, 'deleted': False,
                                         'repository': {'id': 1427517699, 'owner': {'id': 183887963}}}))
            cases = [(['b' * 40], proof.PATCH_PATHS, 'source_parent_changed'),
                     ([proof.SOURCE_PARENT, 'b' * 40], proof.PATCH_PATHS, 'source_parent_changed'),
                     ([proof.SOURCE_PARENT], proof.PATCH_PATHS - {proof.HELPER_TEST}, 'source_scope_changed'),
                     ([proof.SOURCE_PARENT], proof.PATCH_PATHS | {proof.FIXTURE_DIRECTORY + 'extra.py'}, 'source_scope_changed')]
            for parents, appended, code in cases:
                def git(args, **_kwargs):
                    command = args[3:]
                    if command == ['rev-parse', 'HEAD']: return (head + '\n').encode()
                    if command == ['status', '--porcelain', '--untracked-files=all']: return b''
                    if command == ['show', '-s', '--format=%P', head]: return (' '.join(parents) + '\n').encode()
                    if command == ['rev-parse', proof.SOURCE_PARENT + '^{tree}']: return (proof.SOURCE_PARENT_TREE + '\n').encode()
                    if command == ['merge-base', '--is-ancestor', proof.gateway.BASE, head]: return b''
                    if command == ['diff', '--name-only', proof.gateway.BASE, head]: return ('\n'.join(sorted(proof.gateway.ALLOWED)) + '\n').encode()
                    if command == ['diff', '--name-only', proof.SOURCE_PARENT, head]: return ('\n'.join(sorted(appended)) + '\n').encode()
                    self.fail('Unexpected read after invalid source: ' + repr(command))
                with self.subTest(code=code, appended=sorted(appended)), patch.object(proof.subprocess, 'check_output', side_effect=git), \
                        self.assertRaisesRegex(RuntimeError, code):
                    proof.source(repo, env)


if __name__ == '__main__':
    unittest.main(verbosity=2)
