"""Closed native drain evidence parsing and actual Node24 filter semantics."""
import copy
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('drain_proof', Path(__file__).with_name('native-drain-proof-1782.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


def xml(names, failed=False):
    root = ET.Element('testsuites')
    for name in names:
        case = ET.SubElement(root, 'testcase', name=name, time='5.05', classname='test', file='/checkout/' + proof.CASES)
        if failed:
            case.set('failure', 'NATIVE_DAEMON_DRAIN_TIMEOUT')
            failure = ET.SubElement(case, 'failure', type='testCodeFailure', message='NATIVE_DAEMON_DRAIN_TIMEOUT')
            failure.text = 'cause: Error: NATIVE_DAEMON_DRAIN_TIMEOUT\n    at Timeout._onTimeout (file:///checkout/apps/desktop/test/native-cleanup.mjs:16:39)'
    counts = {'tests': len(names), 'suites': 0, 'pass': 0 if failed else len(names), 'fail': len(names) if failed else 0,
              'cancelled': 0, 'skipped': 0, 'todo': 0, 'duration_ms': 5050}
    for key, value in counts.items(): root.append(ET.Comment(f' {key} {value} '))
    return root


def validate(root, phase='red', names=None):
    return proof.validate_junit(ET.tostring(root), phase, names or [proof.TARGET])


class NativeDrainClassifier(unittest.TestCase):
    def test_only_exact_five_second_drain_timer_failure_is_red(self):
        original = xml([proof.TARGET], True)
        self.assertEqual(validate(original)['testsRun'], 1)
        for field, value in [('type', 'hookFailed'), ('message', 'EPERM'), ('message', 'NATIVE_DAEMON_EXIT_TIMEOUT')]:
            changed = copy.deepcopy(original); changed[0][0].set(field, value)
            with self.subTest(field=field, value=value), self.assertRaisesRegex(RuntimeError, 'wrong_red_failure'):
                validate(changed)
        changed = copy.deepcopy(original); changed[0].set('time', '4.89')
        with self.assertRaisesRegex(RuntimeError, 'response_window_not_exercised'): validate(changed)

    def test_observed_node24_anonymous_timer_frame_is_the_original_timer(self):
        # Actual Node24.22.2 junit from run42696425897: baseline8 passed and
        # this selected old-driver case took6.106796s at immutable line16:39.
        observed = xml([proof.TARGET], True)
        observed[0].set('time', '6.106796')
        observed[0][0].text = ('cause: Error: NATIVE_DAEMON_DRAIN_TIMEOUT\n'
            '    at Timeout.<anonymous> (file:///home/runner/work/Mikka/Mikka/apps/desktop/test/native-cleanup.mjs:16:39)\n'
            '    at listOnTimeout (node:internal/timers:685:17)')
        self.assertEqual(validate(observed)['failure'], 'NATIVE_DAEMON_DRAIN_TIMEOUT')

    def test_matching_text_from_setup_rpc_or_wrong_timer_is_rejected(self):
        for trace in ['cause: Error: NATIVE_DAEMON_DRAIN_TIMEOUT at setup',
                      'cause: Error: NATIVE_DAEMON_DRAIN_TIMEOUT\n at Timeout._onTimeout (other.mjs:1:2)',
                      'cause: Error: NATIVE_DAEMON_DRAIN_TIMEOUT\n at Timeout.<anonymous> (native-cleanup.mjs:17:39)',
                      'cause: ResponseError: NATIVE_DAEMON_DRAIN_TIMEOUT\n at Timeout._onTimeout (native-cleanup.mjs:1:2)']:
            changed = xml([proof.TARGET], True); changed[0][0].text = trace
            with self.subTest(trace=trace), self.assertRaisesRegex(RuntimeError, 'wrong_timeout_stage'): validate(changed)

    def test_extra_errors_skips_cancelled_todo_or_missing_case_cannot_pass(self):
        for key in ['cancelled', 'skipped', 'todo']:
            changed = xml([proof.TARGET], True)
            next(item for item in changed if item.tag is ET.Comment and item.text.strip().startswith(key + ' ')).text = f' {key} 1 '
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'junit_incomplete_or_skipped'): validate(changed)
        for names in [[], [proof.TARGET, 'environment failure'], ['unrelated target']]:
            with self.subTest(names=names), self.assertRaises(RuntimeError): validate(xml(names, True))

    def test_original_eight_and_candidate_twelve_require_every_exact_case(self):
        for phase, count in [('baseline_green', 8), ('green', 12)]:
            names = [f'case {i}' for i in range(count)]; original = xml(names)
            self.assertEqual(validate(original, phase, names)['passed'], count)
            for altered in [xml(names[:-1]), xml(names + ['extra']), xml(names, True)]:
                with self.subTest(phase=phase), self.assertRaises(RuntimeError): validate(altered, phase, names)

    def test_invalid_xml_entities_or_missing_summary_are_not_native_results(self):
        for raw in [b'', b'<testsuites/>', b'<!DOCTYPE testsuites><testsuites/>', b'<environment>EPERM</environment>']:
            with self.subTest(raw=raw), self.assertRaises((RuntimeError, ET.ParseError)):
                proof.validate_junit(raw, 'red', [proof.TARGET])

    def test_actual_node24_name_filter_counts_only_selected_case(self):
        version = subprocess.check_output(['node', '--version'], text=True)
        self.assertRegex(version, r'^v24\.')
        with tempfile.TemporaryDirectory(prefix='native-drain-classifier-') as directory:
            path = Path(directory) / 'filter.test.mjs'
            path.write_text("import {test} from 'node:test';\ntest('unselected',()=>{});\ntest('selected',()=>{throw new Error('fixed synthetic error')});\n")
            result = subprocess.run(['node', '--test', '--test-reporter=junit', '--test-name-pattern=^selected$', str(path)],
                                    capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            root = ET.fromstring(result.stdout)
            self.assertEqual([item.get('name') for item in root.findall('testcase')], ['selected'])
            self.assertIn(b'<!-- tests 1 -->', result.stdout)
            self.assertIn(b'<!-- fail 1 -->', result.stdout)
            self.assertIn(b'<!-- skipped 0 -->', result.stdout)
            self.assertIn(b'<!-- cancelled 0 -->', result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
