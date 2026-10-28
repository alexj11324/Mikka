"""Exercise the exact gateway JavaScript against synthetic DOM fields."""
import ast
import json
import math
from pathlib import Path
import subprocess
import unittest
from urllib.parse import urlsplit


module = ast.parse(Path(__file__).with_name('subagent-gateway.py').read_text())
constants = {node.targets[0].id: ast.literal_eval(node.value)
             for node in module.body if isinstance(node, ast.Assign)
             and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
             and node.targets[0].id in ('SAFE_TO_RESUME', 'SENSITIVE_FIELD')}
safe_node = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'safe_resume_snapshot')
broker_node = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'broker_command_allowed')
origin_node = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'browser_origin')
policy_nodes = [node for node in module.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ('BROKER_METHODS', 'BROKER_STORAGE_FUNCTION', 'BROKER_OTP_SELECTOR', 'BROKER_FOCUS_SELECTORS', 'BROKER_FOCUS_EXPRESSIONS', 'BROKER_EVALUATIONS')]
namespace = {'json': json, 'math': math, 'urlsplit': urlsplit}
exec(compile(ast.Module(body=[*policy_nodes, safe_node, origin_node, broker_node], type_ignores=[]), str(__file__), 'exec'), namespace)
safe_resume_snapshot = namespace['safe_resume_snapshot']
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
    def test_actual_broker_client_commands_match_gateway_policy(self):
        result=subprocess.run(['node','--import','tsx',str(Path(__file__).with_name('broker-contract.test.mjs'))],check=True,capture_output=True,text=True)
        commands=json.loads(result.stdout);sessions=set();objects={}
        for command in commands:
            self.assertTrue(broker_command_allowed(command,'target',sessions,objects,'https://example.test'),command['method'])
            if command['method']=='Target.attachToTarget':sessions.add('bound')
            if command['method']=='Runtime.evaluate' and command['params']['expression']=='globalThis':objects['bound']='known'
            if command['method']=='Runtime.callFunctionOn':objects.pop('bound')
    def test_broker_commands_bind_target_session_and_methods(self):
        attach = {'id': 1, 'method': 'Target.attachToTarget', 'params': {'targetId': 'target', 'flatten': True}}
        self.assertTrue(broker_command_allowed(attach, 'target', set()))
        self.assertFalse(broker_command_allowed(attach, 'other-target', set()))
        self.assertFalse(broker_command_allowed({**attach, 'params': {}}, 'target', set()))
        evaluate = {'id': 2, 'method': 'Runtime.evaluate', 'params': {'expression': 'Object.entries(localStorage)', 'returnByValue': True}, 'sessionId': 'bound-session'}
        self.assertTrue(broker_command_allowed(evaluate, 'target', {'bound-session'}))
        self.assertFalse(broker_command_allowed(evaluate, 'target', {'other-session'}))
        self.assertFalse(broker_command_allowed({**evaluate, 'method': 'Target.createTarget'}, 'target', {'bound-session'}))
        self.assertFalse(broker_command_allowed({**evaluate, 'id': True}, 'target', {'bound-session'}))

    def test_broker_rejects_script_injection_and_extra_arguments(self):
        sessions={'bound'}; base={'id': 1, 'sessionId': 'bound'}
        def check(method, params, **kwargs):
            return broker_command_allowed({**base,'method':method,'params':params},'target',sessions,**kwargs)
        self.assertTrue(check('Runtime.evaluate', {'expression':'globalThis','returnByValue':False}))
        self.assertFalse(check('Runtime.evaluate', {'expression':'globalThis;fetch("https://evil.invalid")','returnByValue':False}))
        self.assertFalse(check('Runtime.evaluate', {'expression':'Object.entries(localStorage)','returnByValue':True,'awaitPromise':True}))
        self.assertFalse(check('Runtime.evaluate', {'expression':'Object.entries(localStorage);alert(1)','returnByValue':True}))
        self.assertFalse(check('Runtime.evaluate', {'expression':['Object.entries(localStorage)'],'returnByValue':True}))
        self.assertFalse(check('Runtime.compileScript', {'expression':'alert(1)'}))
        params={'objectId':'known','functionDeclaration':namespace['BROKER_STORAGE_FUNCTION'],'arguments':[{'value':[['key','value']]}],'returnByValue':True}
        self.assertTrue(check('Runtime.callFunctionOn', params, objects={'bound':'known'}))
        self.assertFalse(check('Runtime.callFunctionOn', {**params,'objectId':'other'}, objects={'bound':'known'}))
        self.assertFalse(check('Runtime.callFunctionOn', {**params,'functionDeclaration':'function(){return document.cookie}'}, objects={'bound':'known'}))
        self.assertFalse(check('Runtime.callFunctionOn', {**params,'arguments':[{'value':[['key','value']],'objectId':'injected'}]}, objects={'bound':'known'}))
        self.assertFalse(check('Runtime.callFunctionOn', {**params,'objectId':None}))
        self.assertTrue(check('Network.getCookies', {'urls':['https://example.test']}, origin='https://example.test'))
        self.assertFalse(check('Network.getCookies', {'urls':['https://other.test']}, origin='https://example.test'))
        cookie={'name':'session','value':'synthetic','domain':'.example.test','path':'/'}
        self.assertTrue(check('Network.setCookies', {'cookies':[cookie]}, origin='https://example.test'))
        self.assertFalse(check('Network.setCookies', {'cookies':[{**cookie,'domain':'other.test'}]}, origin='https://example.test'))
        self.assertFalse(check('Network.setCookies', {'cookies':[{**cookie,'extra':'injected'}]}, origin='https://example.test'))
        self.assertFalse(check('Network.setCookies', {'cookies':[{**cookie,'secure':'true'}]}, origin='https://example.test'))
        self.assertFalse(check('Network.setCookies', {'cookies':[{**cookie,'value':'synthetic\r\ninjected'}]}, origin='https://example.test'))
        self.assertFalse(check('Network.setCookies', {'cookies':[{**cookie,'expires':float('inf')}]}, origin='https://example.test'))
        self.assertTrue(check('Network.setCookies', {'cookies':[{**cookie,'partitionKey':{'topLevelSite':'https://example.test','hasCrossSiteAncestor':False}}]}, origin='https://example.test'))
        self.assertFalse(check('Network.setCookies', {'cookies':[{**cookie,'partitionKey':{'topLevelSite':'https://other.test'}}]}, origin='https://example.test'))
        self.assertFalse(check('Network.setCookies', {'cookies':[{**cookie,'partitionKey':{'topLevelSite':'https://example.test','extra':True}}]}, origin='https://example.test'))
        self.assertFalse(check('Input.insertText', {'text':'synthetic','extra':True}))
        self.assertIsNone(namespace['browser_origin']('http://outside.example/login'))
        self.assertEqual(namespace['browser_origin']('http://127.0.0.1:6083/login'),'http://127.0.0.1:6083')

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
                                 constants['SAFE_TO_RESUME']],
                                check=True, capture_output=True, text=True)
        cases = json.loads(result.stdout)
        for name, expected in [('empty', True), ('otp', False), ('cleared', True),
                               ('iframe', False), ('open-shadow', False), ('closed-shadow', False)]:
            with self.subTest(name=name):
                case = cases[name]
                self.assertEqual(safe_resume_snapshot(case['frames'], case['document'], case['evaluation']), expected)


if __name__ == '__main__':
    unittest.main()
