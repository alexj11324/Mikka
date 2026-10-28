"""Exercise the exact gateway JavaScript against synthetic DOM fields."""
import ast
import json
from pathlib import Path
import subprocess
import unittest


module = ast.parse(Path(__file__).with_name('subagent-gateway.py').read_text())
constants = {node.targets[0].id: ast.literal_eval(node.value)
             for node in module.body if isinstance(node, ast.Assign)
             and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
             and node.targets[0].id in ('SAFE_TO_RESUME', 'SENSITIVE_FIELD')}
safe_node = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'safe_resume_snapshot')
inspect_node = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'inspect_mutation_expression')
broker_node = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'broker_command_allowed')
methods_node = next(node for node in module.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'BROKER_METHODS')
namespace = {'json': json}
exec(compile(ast.Module(body=[methods_node, safe_node, inspect_node, broker_node], type_ignores=[]), str(__file__), 'exec'), namespace)
safe_resume_snapshot = namespace['safe_resume_snapshot']
inspect_mutation_expression = namespace['inspect_mutation_expression']
broker_command_allowed = namespace['broker_command_allowed']


def evaluate(expression, fields):
    script = """
const fields = JSON.parse(process.argv[1]).map(field => ({
  tagName: 'INPUT', type: 'text', value: '', name: '', id: '', autocomplete: '',
  getAttribute(name) { return this[name] || null }, ...field
}));
const document = { querySelectorAll: () => fields };
const e = fields[0];
process.stdout.write(JSON.stringify(eval(process.argv[2])));
"""
    result = subprocess.run(['node', '-e', script, json.dumps(fields), expression],
                            check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


class GuardTest(unittest.TestCase):
    def test_broker_commands_bind_target_session_and_methods(self):
        attach = {'id': 1, 'method': 'Target.attachToTarget', 'params': {'targetId': 'target', 'flatten': True}}
        self.assertTrue(broker_command_allowed(attach, 'target', set()))
        self.assertFalse(broker_command_allowed(attach, 'other-target', set()))
        self.assertFalse(broker_command_allowed({**attach, 'params': {}}, 'target', set()))
        evaluate = {'id': 2, 'method': 'Runtime.evaluate', 'params': {}, 'sessionId': 'bound-session'}
        self.assertTrue(broker_command_allowed(evaluate, 'target', {'bound-session'}))
        self.assertFalse(broker_command_allowed(evaluate, 'target', {'other-session'}))
        self.assertFalse(broker_command_allowed({**evaluate, 'method': 'Target.createTarget'}, 'target', {'bound-session'}))
        self.assertFalse(broker_command_allowed({**evaluate, 'id': True}, 'target', {'bound-session'}))

    def test_uninspectable_or_nested_documents_fail_closed(self):
        frames = {'frameTree': {'frame': {'id': 'main'}}}
        document = {'root': {'nodeName': '#document', 'children': []}}
        success = {'result': {'value': True}}
        self.assertTrue(safe_resume_snapshot(frames, document, success))
        self.assertFalse(safe_resume_snapshot({}, document, success))
        self.assertFalse(safe_resume_snapshot({'frameTree': {}}, document, success))
        self.assertFalse(safe_resume_snapshot(frames, {}, success))
        self.assertFalse(safe_resume_snapshot(frames, document, {'exceptionDetails': {}, 'result': {'value': True}}))
        self.assertFalse(safe_resume_snapshot({'frameTree': {'childFrames': [{}]}}, document, success))
        self.assertFalse(safe_resume_snapshot(frames, {'root': {'nodeName': 'IFRAME'}}, success))
        self.assertFalse(safe_resume_snapshot(frames, {'root': {'shadowRoots': [{'shadowRootType': 'closed'}]}}, success))

    def test_nonempty_otp_without_autocomplete_blocks_resume_until_cleared(self):
        otp = {'name': 'otp', 'value': '123456'}
        self.assertFalse(evaluate(constants['SAFE_TO_RESUME'], [otp]))
        self.assertTrue(evaluate(constants['SENSITIVE_FIELD'], [otp]))
        self.assertTrue(evaluate(constants['SAFE_TO_RESUME'], [{**otp, 'value': ''}]))

    def test_password_and_unlabelled_text_block_hidden_token_does_not(self):
        for field in ({'type': 'password', 'value': 'synthetic'},
                      {'name': 'unlabelled', 'value': 'synthetic'},
                      {'tagName': 'TEXTAREA', 'value': 'synthetic'}):
            with self.subTest(field=field):
                self.assertFalse(evaluate(constants['SAFE_TO_RESUME'], [field]))
        self.assertTrue(evaluate(constants['SAFE_TO_RESUME'], [{'type': 'hidden', 'value': 'csrf'}]))

    def test_common_code_labels_are_blocked_for_model_typing(self):
        for field in ({'autocomplete': 'one-time-code'}, {'id': 'verification_code'},
                      {'placeholder': 'Security code'}, {'name': 'authentication-code'}):
            with self.subTest(field=field):
                self.assertTrue(evaluate(constants['SENSITIVE_FIELD'], [field]))
        self.assertFalse(evaluate(constants['SENSITIVE_FIELD'], [{'name': 'search'}]))

    def test_isolated_chromium_iframe_and_open_closed_shadow(self):
        result = subprocess.run(['node', str(Path(__file__).with_name('subagent-guard-browser.test.mjs')),
                                 constants['SAFE_TO_RESUME'],
                                 inspect_mutation_expression({'action': 'click', 'selector': '#continue'}),
                                 inspect_mutation_expression({'action': 'click', 'selector': '#delete'})],
                                check=True, capture_output=True, text=True)
        cases = json.loads(result.stdout)
        for name, expected in [('empty', True), ('otp', False), ('cleared', True),
                               ('iframe', False), ('open-shadow', False), ('closed-shadow', False)]:
            with self.subTest(name=name):
                case = cases[name]
                self.assertEqual(safe_resume_snapshot(case['frames'], case['document'], case['evaluation']), expected)
        self.assertTrue(cases['deleteHint'])
        self.assertFalse(cases['ambiguousHint'])
        self.assertTrue(cases['syntheticHandlerRan'], 'metadata cannot predict arbitrary page callbacks')


if __name__ == '__main__':
    unittest.main()
