"""Actual Next and Vite HTML/assets/HMR through the preview data plane.

API/CLI acceptance only; no browser. Dependencies come from pnpm's frozen
workspace install. Kernel ingress isolation is separately proved on E2B by
preview-network-acceptance.mjs, not by this synthetic local proxy fixture.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import tempfile
import time
import unittest

from aiohttp import ClientSession, DummyCookieJar, ClientTimeout, WSMsgType

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('preview-gateway.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FrameworkAcceptance(unittest.IsolatedAsyncioTestCase):
    async def check_framework(self, framework):
        with tempfile.TemporaryDirectory(prefix=f'mikka-preview-{framework}-') as temporary:
            root = Path(temporary)
            (root / 'node_modules').symlink_to(REPO / 'node_modules', target_is_directory=True)
            (root / 'package.json').write_text(json.dumps({'name': 'mikka-preview-fixture', 'private': True}))
            (root / 'authority').mkdir(mode=0o700)
            with socket.socket() as reserving:
                reserving.bind(('127.0.0.1', 0))
                port = reserving.getsockname()[1]
            node = shutil.which('node')
            if framework == 'next':
                (root / 'app').mkdir()
                (root / 'app/layout.jsx').write_text('export default function Layout({children}){return <html><body>{children}</body></html>}')
                changed = root / 'app/page.jsx'
                changed.write_text('export default function Page(){return <main>mikka-preview-next-v1</main>}')
                command = [node, str(REPO / 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', str(port)]
            else:
                binaries = sorted((REPO / 'node_modules/.pnpm').glob('vite@*/node_modules/vite/bin/vite.js'))
                if not binaries:
                    self.fail('The frozen Vite dependency is required')
                (root / 'index.html').write_text('<main>mikka-preview-vite-v1</main><script type="module" src="/main.js"></script>')
                changed = root / 'main.js'
                changed.write_text('export const version = 1; if (import.meta.hot) import.meta.hot.accept();')
                command = [node, str(binaries[0]), '--host', '127.0.0.1', '--port', str(port), '--strictPort']
            process = await asyncio.create_subprocess_exec(*command, cwd=root, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True,
                env={'PATH': os.environ['PATH'], 'HOME': temporary, 'NEXT_TELEMETRY_DISABLED': '1', 'NO_COLOR': '1'})
            gateway = module.Gateway(root / 'authority', user_id=os.getuid(), protect=lambda _port: None)
            await gateway.start()
            drain = None
            try:
                async def ready():
                    count = 0
                    while line := await process.stdout.readline():
                        count += len(line)
                        if count > 100_000:
                            self.fail('Framework startup output exceeded its bound')
                        if (framework == 'next' and b'Ready in' in line) or (framework == 'vite' and b'Local:' in line):
                            return
                    self.fail('Framework exited before its ready receipt')
                await asyncio.wait_for(ready(), timeout=60)
                async def discard_output():
                    while await process.stdout.read(4096):
                        pass
                drain = asyncio.create_task(discard_output())
                scope = {key: 'fixture-' + key for key in ('taskId', 'runId', 'ownerId', 'workspaceId', 'deviceId', 'repoId', 'sandboxId')}
                scope.update(epoch=1, worktreePath=str(root), expiresAt=time.time() + 90)
                prepared = await gateway.control({'operation': 'prepare', 'binding': scope, 'port': port})
                self.assertTrue(prepared['running'])
                origin = 'https://preview.example.test'
                entry = await gateway.control({'operation': 'issue', 'binding': scope, 'gatewayPort': prepared['gatewayPort'],
                    'origin': origin, 'parentOrigin': 'https://mikka.example.test', 'leaseId': 'fixture-lease'})
                base = 'http://127.0.0.1:' + str(prepared['gatewayPort'])
                async with ClientSession(cookie_jar=DummyCookieJar(), trust_env=False, timeout=ClientTimeout(total=40)) as client:
                    async with client.get(base + module.ENTRY + '?ticket=' + entry['ticket'], headers={'Host': 'preview.example.test'}) as reply:
                        self.assertEqual(reply.status, 200)
                        cookie = reply.headers['Set-Cookie'].split(';')[0]
                    headers = {'Host': 'preview.example.test', 'Cookie': cookie, 'Origin': origin, 'Sec-Fetch-Site': 'same-origin'}
                    async with client.get(base + '/', headers=headers) as reply:
                        self.assertEqual(reply.status, 200)
                        html = await reply.text()
                        self.assertIn(f'mikka-preview-{framework}-v1', html)
                    if framework == 'next':
                        assets = re.findall(r'<script[^>]+src="([^"]+)"', html)
                        self.assertTrue(assets)
                        async with client.get(base + assets[0].replace('&amp;', '&'), headers=headers) as reply:
                            self.assertEqual(reply.status, 200)
                            self.assertGreater(len(await reply.read()), 100)
                        document_id = re.search(r'self\.__next_r="([^"]+)"', html)
                        self.assertIsNotNone(document_id)
                        ws_path = '/_next/hmr?id=' + document_id.group(1)
                        protocols = ()
                    else:
                        async with client.get(base + '/@vite/client', headers=headers) as reply:
                            self.assertEqual(reply.status, 200)
                            script = await reply.text()
                        token = re.search(r'const wsToken = [\'"]([^\'"]+)[\'"]', script)
                        self.assertIsNotNone(token)
                        async with client.get(base + '/main.js', headers=headers) as reply:
                            self.assertEqual(reply.status, 200)
                            self.assertIn('import.meta.hot', await reply.text())
                        ws_path = '/?token=' + token.group(1)
                        protocols = ('vite-hmr',)
                    async with client.ws_connect(base + ws_path, headers=headers, protocols=protocols) as websocket:
                        first = await websocket.receive(timeout=10)
                        self.assertEqual(first.type, WSMsgType.TEXT)
                        if framework == 'next':
                            await websocket.send_json({'event': 'ping', 'page': '/'})
                        changed.write_text(changed.read_text().replace('v1', 'v2').replace('version = 1', 'version = 2'))
                        async def updated():
                            for _ in range(20):
                                message = await websocket.receive(timeout=20)
                                if framework == 'next' and message.type == WSMsgType.BINARY:
                                    # Next forwards React debug chunks on the
                                    # same socket before its JSON HMR receipt.
                                    self.assertGreater(len(message.data), 0)
                                    continue
                                self.assertEqual(message.type, WSMsgType.TEXT)
                                data = json.loads(message.data)
                                if data.get('type') in ('built', 'serverComponentChanges', 'update', 'full-reload'):
                                    return
                            self.fail('No framework HMR update receipt')
                        await asyncio.wait_for(updated(), timeout=25)
                        async with client.get(base + ('/' if framework == 'next' else '/main.js'), headers=headers) as reply:
                            self.assertEqual(reply.status, 200)
                            self.assertIn('mikka-preview-next-v2' if framework == 'next' else 'version = 2', await reply.text())
                        started = time.monotonic()
                        await gateway.control({'operation': 'revoke', 'runId': scope['runId'], 'leaseIds': ['fixture-lease']})
                        self.assertLess(time.monotonic() - started, 1)
                        while True:
                            closed = await websocket.receive(timeout=2)
                            if closed.type != WSMsgType.TEXT:
                                self.assertIn(closed.type, (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED))
                                break
            finally:
                await gateway.close()
                if process.returncode is None:
                    os.killpg(process.pid, signal.SIGTERM)
                await asyncio.wait_for(process.wait(), timeout=10)
                if drain:
                    drain.cancel()
                    await asyncio.gather(drain, return_exceptions=True)

    async def test_next_html_assets_and_hot_reload(self):
        await self.check_framework('next')

    async def test_vite_html_assets_and_hot_reload(self):
        await self.check_framework('vite')


if __name__ == '__main__':
    unittest.main(verbosity=2)
