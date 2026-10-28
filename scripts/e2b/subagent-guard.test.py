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


if __name__ == '__main__':
    unittest.main()
