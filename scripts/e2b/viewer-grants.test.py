import base64
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import sys
import types
import unittest

try:
    import aiohttp  # noqa: F401
except ImportError:
    # Grant validation does not use the HTTP server; CI needs no aiohttp install.
    aiohttp = types.ModuleType('aiohttp')
    aiohttp.web = types.SimpleNamespace()
    aiohttp.WSMsgType = object()
    sys.modules['aiohttp'] = aiohttp

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

desktop = load('desktop_viewer', 'viewer-gateway.py')
subagent = load('subagent_viewer', 'subagent-viewer.py')
def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()

def token(payload, key):
    value = encode(json.dumps(payload, separators=(',', ':')).encode())
    return value + '.' + encode(hmac.new(key, value.encode(), hashlib.sha256).digest())

class ViewerGrantTest(unittest.TestCase):
    def test_policy_changes_permanently_revoke_old_grants(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'key').write_bytes(b'fixture-key')
            desktop.STATE = root; subagent.ROOT = root; subagent.STATE = root
            task = '153bd012-55b3-44c0-8ff3-f78528775392'
            state = {'botId':'bot','ownerId':'owner','display':1,'epoch':0,'policyVersion':0,
                     'computerAllowed':True,'controlledBy':None,'controlUntil':0}
            (root / '1.json').write_text(json.dumps(state))
            grant = {**state, 'userId':'owner','mode':'view','exp':int(time.time())+120}
            signed = token(grant, b'fixture-key')
            self.assertEqual(desktop.authorize(signed)['mode'], 'view')
            state.update(policyVersion=2, computerAllowed=True)
            (root / '1.json').write_text(json.dumps(state))
            with self.assertRaises(ValueError): desktop.authorize(signed)
            state.update(subagentId=task,workspaceId='workspace',stopRequested=False)
            (root / f'{task}.json').write_text(json.dumps(state))
            payload = {**state,'kind':'subagent','userId':'owner','mode':'view','exp':int(time.time())+120}
            signed = token(payload, b'fixture-key')
            self.assertEqual(subagent.authorize(signed, task)['mode'], 'view')
            state.update(policyVersion=4,computerAllowed=True)
            (root / f'{task}.json').write_text(json.dumps(state))
            with self.assertRaises(ValueError): subagent.authorize(signed, task)

if __name__ == '__main__':
    unittest.main()
