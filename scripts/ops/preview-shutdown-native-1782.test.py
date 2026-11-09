"""Offline proof-classifier tests. No sockets or production credentials."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('native_proof', Path(__file__).with_name('preview-shutdown-native-1782.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


def result(phase):
    return {'phase': phase, 'testsRun': 1, 'successes': [], 'errors': [], 'failures': [],
            'skipped': 0, 'expectedFailures': 0, 'unexpectedSuccesses': 0}


def red():
    value = result('red')
    value['errors'] = [{'test': 'preview_shutdown_cases.PreviewAcceptance.' + proof.SELF_WAIT,
        'type': 'builtins.TimeoutError', 'frames': [
            {'file': 'preview-gateway.test.py', 'function': proof.SELF_WAIT, 'line': 1},
            {'file': 'preview-gateway.test.py', 'function': 'unix_control', 'line': 2, 'awaitingControlReadline': True}]}]
    return value


class NativeProof(unittest.TestCase):
    def test_only_exact_target_timeout_is_expected_red(self):
        proof.validate_phase(red(), 'red', [])
        for code in ['builtins.PermissionError', 'builtins.ImportError', 'builtins.AssertionError', 'subprocess.TimeoutExpired']:
            invalid = red(); invalid['errors'][0]['type'] = code
            with self.subTest(code=code), self.assertRaisesRegex(RuntimeError, 'wrong_red_failure'):
                proof.validate_phase(invalid, 'red', [])

    def test_setup_or_websocket_timeout_is_not_self_wait_proof(self):
        for frames in [[{'file': 'preview-gateway.test.py', 'function': 'asyncSetUp'}],
                       [{'file': 'preview-gateway.test.py', 'function': proof.SELF_WAIT}],
                       [{'file': 'other.py', 'function': proof.SELF_WAIT}, {'file': 'other.py', 'function': 'unix_control'}]]:
            invalid = red(); invalid['errors'][0]['frames'] = frames
            with self.subTest(frames=frames), self.assertRaisesRegex(RuntimeError, 'wrong_timeout_stage'):
                proof.validate_phase(invalid, 'red', [])
        invalid = red(); invalid['errors'][0]['frames'][1]['awaitingControlReadline'] = False
        with self.assertRaisesRegex(RuntimeError, 'wrong_timeout_stage'):
            proof.validate_phase(invalid, 'red', [])

    def test_environment_or_teardown_additional_error_cannot_be_accepted(self):
        invalid = red(); invalid['errors'].append(copy.deepcopy(invalid['errors'][0]))
        with self.assertRaisesRegex(RuntimeError, 'expected_timeout_missing'):
            proof.validate_phase(invalid, 'red', [])
        invalid = red(); invalid['errors'][0]['test'] = 'other_test'
        with self.assertRaisesRegex(RuntimeError, 'wrong_red_failure'):
            proof.validate_phase(invalid, 'red', [])

    def test_missing_failure_skip_or_expected_failure_is_never_red(self):
        for field, value in [('errors', []), ('testsRun', 0), ('testsRun', 2), ('skipped', 1),
                             ('expectedFailures', 1), ('unexpectedSuccesses', 1), ('failures', ['assertion'])]:
            invalid = red(); invalid[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                proof.validate_phase(invalid, 'red', [])

    def test_baseline_thirteen_and_full_fifteen_successes_are_both_required(self):
        for phase, count in [('baseline_green', 13), ('green', 15)]:
            names = ['test_' + str(index) for index in range(count)]
            value = result(phase); value['testsRun'] = count
            value['successes'] = ['preview_shutdown_cases.PreviewAcceptance.' + name for name in names]
            proof.validate_phase(value, phase, names)
            for field, changed in [('testsRun', count - 1), ('skipped', 1), ('errors', [red()['errors'][0]]),
                                   ('successes', value['successes'][:-1]), ('successes', [value['successes'][0]] * count)]:
                invalid = copy.deepcopy(value); invalid[field] = changed
                with self.subTest(phase=phase, field=field), self.assertRaises(RuntimeError):
                    proof.validate_phase(invalid, phase, names)

    def test_source_preservation_rejects_removed_or_changed_original_test(self):
        prefix = 'class PreviewAcceptance:\n'
        methods = ''.join('    async def test_' + str(index) + '(self):\n        self.assertEqual(1, 1)\n' for index in range(13))
        added = ''.join('    async def ' + name + '(self):\n        self.assertEqual(2, 2)\n' for name in [proof.SELF_WAIT, proof.RACE])
        names = proof.test_preservation(prefix + methods, prefix + methods + added)
        self.assertEqual(len(names), 15)
        with self.assertRaisesRegex(RuntimeError, 'original_case_changed'):
            proof.test_preservation(prefix + methods, (prefix + methods + added).replace('self.assertEqual(1, 1)', 'self.assertEqual(1, 0)', 1))
        with self.assertRaisesRegex(RuntimeError, 'fixture_cases_changed'):
            proof.test_preservation(prefix + methods, prefix + methods)


if __name__ == '__main__':
    unittest.main(verbosity=2)
