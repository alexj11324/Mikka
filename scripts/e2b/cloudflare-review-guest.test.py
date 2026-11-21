"""Credential-free qualification in a fresh private Cloudflare VM network namespace."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from uuid import uuid4

from aiohttp import ClientSession, DummyCookieJar, WSMsgType

GATEWAY_DIR = Path(__file__).resolve().parent
ROOT = GATEWAY_DIR.parents[1]
GUARD = Path('/opt/mikka/runtime/ingress-v1/guard.py')
PREVIEW = GATEWAY_DIR / 'preview-gateway.py'
PRIVATE_HEADERS = {'Host': 'preview.example.test'}
DEV_SERVER = '''
import asyncio
from aiohttp import web
async def http(_):
    return web.Response(text='task-preview-ok')
async def hmr(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    async for message in ws:
        await ws.send_str('hmr:' + message.data)
    return ws
async def main():
    app = web.Application()
    app.router.add_get('/', http)
    app.router.add_get('/hmr', hmr)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    print(runner.addresses[0][1], flush=True)
    await asyncio.Event().wait()
asyncio.run(main())
'''


def run(*args):
    return subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=30, check=True)


class CloudflareGuest(unittest.IsolatedAsyncioTestCase):
    async def test_existing_review_contract_on_private_guest(self):
        self.assertEqual(os.geteuid(), 0)
        for family in ('-4', '-6'):
            self.assertEqual(run('ip', family, 'route', 'show', 'default').stdout, b'')
        # Refuse an existing installed guard or review session. This test owns
        # the disposable VM and its fresh network namespace through teardown.
        self.assertFalse(GUARD.exists())
        self.assertFalse(Path('/run/mikka-preview').exists())
        GUARD.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'packages/daemon/scripts/workspace-ingress.py', GUARD)
        proof = json.loads(run(sys.executable, GUARD, 'prepare-cloudflare').stdout)
        self.assertEqual(proof['providerPorts'], [])
        self.assertEqual(proof['provider'], 'cloudflare')
        self.assertEqual(proof['rulesVerified'], {'ipv4': True, 'ipv6': True})
        self.assertEqual(proof, json.loads(run(sys.executable, GUARD, 'verify').stdout))
        run(sys.executable, ROOT / 'packages/daemon/scripts/workspace-control-install.py', '--cloudflare-task')
        lock = Path('/run/mikka-review-control/machine.lock').stat()
        self.assertEqual((lock.st_uid, lock.st_gid), (0, 1000))
        ready = json.loads(run(sys.executable, PREVIEW, 'ensure', '--cloudflare-task').stdout)
        self.assertEqual(ready['provider'], 'cloudflare')

        def control(message):
            path = Path('/run/mikka-preview') / ('acceptance-' + str(uuid4()) + '.json')
            with path.open('x') as data:
                os.chmod(path, 0o600)
                json.dump(message, data)
            return json.loads(run(sys.executable, PREVIEW, 'control', path).stdout)

        self.addCleanup(control, {'operation': 'shutdown'})
        with tempfile.TemporaryDirectory() as checkout:
            os.chown(checkout, 1000, 1000)
            dev = await asyncio.create_subprocess_exec('setpriv', '--reuid=1000', '--regid=1000', '--clear-groups',
                '--no-new-privs', sys.executable, '-c', DEV_SERVER, cwd=checkout, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'HOME': '/home/node'})
            try:
                dev_port = int(await asyncio.wait_for(dev.stdout.readline(), 10))
                binding = {key: str(uuid4()) for key in ('taskId', 'runId', 'ownerId', 'workspaceId', 'deviceId', 'repoId', 'sandboxId')}
                binding.update(epoch=1, worktreePath=checkout, expiresAt=time.time() + 120)
                opened = control({'operation': 'prepare', 'binding': binding, 'port': dev_port})
                self.assertTrue(opened.get('running'), opened.get('error') or opened.get('code'))
                port = opened['gatewayPort']
                lease = str(uuid4())
                issued = control({'operation': 'issue', 'binding': binding, 'gatewayPort': port, 'leaseId': lease,
                                  'origin': 'https://preview.example.test', 'parentOrigin': 'https://application.example.test'})
                base = 'http://127.0.0.1:' + str(port)
                async with ClientSession(cookie_jar=DummyCookieJar(), trust_env=False) as client:
                    async with client.get(base, headers=PRIVATE_HEADERS) as reply:
                        self.assertEqual(reply.status, 401)
                    headers = {**PRIVATE_HEADERS, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe'}
                    async with client.get(base + '/__mikka/preview/open', params={'ticket': issued['ticket']}, headers=headers) as reply:
                        self.assertEqual(reply.status, 200)
                        cookie = reply.headers['Set-Cookie'].split(';', 1)[0]
                    headers = {**PRIVATE_HEADERS, 'Cookie': cookie, 'Origin': 'https://preview.example.test'}
                    async with client.get(base, headers=headers) as reply:
                        self.assertEqual(await reply.text(), 'task-preview-ok')
                    async with client.ws_connect(base + '/hmr', headers=headers) as websocket:
                        await websocket.send_str('change')
                        self.assertEqual((await websocket.receive(timeout=3)).data, 'hmr:change')
                        stopped = await asyncio.to_thread(control, {'operation': 'revoke', 'runId': binding['runId'], 'leaseIds': [lease]})
                        self.assertIs(stopped.get('revoked'), True)
                        self.assertIn((await websocket.receive(timeout=3)).type, (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING))
            finally:
                if dev.returncode is None:
                    dev.terminate()
                await asyncio.wait_for(dev.wait(), 5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
