"""Real TCP/HTTP/WebSocket acceptance; all identities and cookies are synthetic.

No browser, model, external service or production credential is used. Run with
python3 scripts/e2b/preview-gateway.test.py in an isolated Linux environment.
"""
import asyncio
from contextlib import asynccontextmanager
import errno
import http.server
import importlib.util
import json
import os
import socket
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

from aiohttp import ClientSession, DummyCookieJar, WSMsgType, web

spec = importlib.util.spec_from_file_location('preview_gateway', Path(__file__).with_name('preview-gateway.py'))
gateway_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway_module)


class PreviewAcceptance(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mikka-preview-acceptance-')
        self.root = Path(self.temporary.name)
        self.previous = os.getcwd()
        os.chdir(self.root)
        self.protected = []
        # This fixture proves proxy behavior over real TCP, not the host
        # kernel's firewall. The external E2B gate proves public-port denial.
        self.gateway = gateway_module.Gateway(self.root, user_id=os.getuid(), protect=lambda port: self.protected.append(port))
        await self.gateway.start()
        self.observed = []
        self.app = web.Application()

        async def resource(request):
            self.observed.append({'path': request.path_qs, 'host': request.host, 'origin': request.headers.get('Origin'),
                                  'cookie': request.headers.get('Cookie'), 'authorization': request.headers.get('Authorization'),
                                  'forwarded': request.headers.get('Forwarded'), 'body': (await request.read()).decode()})
            if request.path == '/redirect':
                return web.Response(status=302, headers={'Location': '/assets/app.js?ok=1'})
            if request.path == '/redirect-loopback':
                return web.Response(status=302, headers={'Location': f'http://localhost:{self.upstream_port}/nested'})
            if request.path == '/redirect-external':
                return web.Response(status=302, headers={'Location': 'https://example.invalid/stolen'})
            if request.path == '/cookies':
                response = web.Response(text='cookie set')
                response.set_cookie('app_session', 'synthetic-app-session', path='/')
                response.set_cookie('parent_attack', 'synthetic-parent-cookie', domain='example.test')
                response.set_cookie('__Host-mikka_preview', 'synthetic-replacement')
                return response
            if request.path == '/hmr':
                ws = web.WebSocketResponse(protocols=('vite-hmr',))
                await ws.prepare(request)
                async for message in ws:
                    if message.type == WSMsgType.TEXT:
                        await ws.send_str('hmr:' + message.data)
                return ws
            if request.path == '/assets/app.js':
                return web.Response(text='export const accepted = true', content_type='application/javascript')
            return web.Response(text='<script type="module" src="/assets/app.js"></script><a href="nested">relative</a>', content_type='text/html')

        self.app.router.add_route('*', '/{path:.*}', resource)
        self.upstream_runner = web.AppRunner(self.app)
        await self.upstream_runner.setup()
        self.upstream_site = web.TCPSite(self.upstream_runner, '127.0.0.1', 0)
        await self.upstream_site.start()
        self.upstream_port = self.upstream_site._server.sockets[0].getsockname()[1]
        self.binding = {'taskId': 'task-a', 'runId': 'run-a', 'ownerId': 'owner-a', 'workspaceId': 'workspace-a',
                        'deviceId': 'device-a', 'repoId': 'repo-a', 'sandboxId': 'sandbox-a', 'epoch': 1,
                        'worktreePath': str(self.root), 'expiresAt': time.time() + 120}
        self.origin = 'https://preview.example.test'
        self.client = ClientSession(cookie_jar=DummyCookieJar(), trust_env=False)
        self.cookie = None
        self.port = None
        self.lease_id = 'synthetic-lease-a'

    async def asyncTearDown(self):
        await self.gateway.close()
        await self.client.close()
        await self.upstream_runner.cleanup()
        os.chdir(self.previous)
        self.temporary.cleanup()

    @asynccontextmanager
    async def control_daemon(self):
        previous = self.gateway
        factory = gateway_module.Gateway
        gateway = factory(self.root, user_id=os.getuid(), protect=lambda _port: None)
        start_server = asyncio.start_unix_server
        writers = set()

        async def tracked_server(callback, **options):
            async def tracked(reader, writer):
                writers.add(writer)
                try:
                    await callback(reader, writer)
                finally:
                    writers.discard(writer)
            return await start_server(tracked, **options)

        # Inject only the owned fixture directory/uid; run the actual daemon,
        # Gateway and Unix transport, including its real active connections.
        with mock.patch.object(gateway_module, 'ROOT', self.root), \
                mock.patch.object(gateway_module, 'Gateway', lambda: gateway), \
                mock.patch.object(asyncio, 'start_unix_server', tracked_server):
            self.gateway = gateway
            serving = asyncio.create_task(gateway_module.serve())
            try:
                async with asyncio.timeout(2):
                    while not (self.root / 'control.sock').exists():
                        if serving.done():
                            await serving
                        await asyncio.sleep(.001)
                yield serving
            finally:
                # An intentionally broken shutdown can wait on its own writer;
                # close only this fixture's accepted connections during teardown.
                for writer in list(writers):
                    writer.close()
                await asyncio.gather(*(writer.wait_closed() for writer in list(writers)), return_exceptions=True)
                if not serving.done():
                    serving.cancel()
                # Each body awaits the daemon's outcome explicitly; fixture
                # cleanup must not replace its original assertion failure.
                await asyncio.gather(serving, return_exceptions=True)
                await gateway.close()
                self.gateway = previous

    async def unix_control(self, message):
        reader, writer = await asyncio.open_unix_connection(str(self.root / 'control.sock'))
        try:
            writer.write(json.dumps(message).encode() + b'\n')
            await writer.drain()
            return json.loads(await asyncio.wait_for(reader.readline(), timeout=1))
        finally:
            writer.close()
            await writer.wait_closed()

    async def prepare(self, binding=None):
        result = await self.gateway.control({'operation': 'prepare', 'binding': binding or self.binding, 'port': self.upstream_port})
        self.assertTrue(result['running'])
        self.port = result['gatewayPort']
        return result

    async def issue(self, binding=None):
        return await self.gateway.control({'operation': 'issue', 'binding': binding or self.binding,
                                          'gatewayPort': self.port, 'origin': self.origin, 'parentOrigin': 'https://mikka.example.test', 'leaseId': self.lease_id})

    def headers(self, **changes):
        return {'Host': 'preview.example.test', 'Cookie': self.cookie or '', **changes}

    def url(self, path='/'):
        return f'http://127.0.0.1:{self.port}' + path

    async def open(self):
        await self.prepare()
        ticket = (await self.issue())['ticket']
        async with self.client.get(self.url(gateway_module.ENTRY + '?ticket=' + ticket), headers=self.headers(**{
            'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe'}), allow_redirects=False) as reply:
            self.assertEqual(reply.status, 200)
            document = await reply.text()
            self.assertIn('history.replaceState(null,"","/");location.replace("/")', document)
            self.assertNotIn(ticket, document)
            self.assertNotIn('Location', reply.headers)
            self.assertIn("default-src 'none'", reply.headers['Content-Security-Policy'])
            cookies = reply.headers.getall('Set-Cookie')
            self.assertEqual(len(cookies), 1)
            self.assertTrue(all(flag in cookies[0] for flag in ('__Host-', 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/')))
            self.cookie = cookies[0].split(';')[0]
        return ticket

    async def test_http_assets_relative_redirects_and_cookie_isolation(self):
        ticket = await self.open()
        async with self.client.get(self.url(), headers=self.headers()) as reply:
            self.assertEqual(reply.status, 200)
            self.assertIn('/assets/app.js', await reply.text())
            self.assertEqual(reply.headers['Referrer-Policy'], 'no-referrer')
            self.assertNotIn(ticket, await reply.text())
        async with self.client.get(self.url('/assets/app.js?ok=1'), headers=self.headers(Authorization='Bearer synthetic-main-credential',
                                   Cookie=self.cookie + '; better-auth.session_token=synthetic-main-cookie; forged=synthetic-forged',
                                   Forwarded='host=attacker.invalid')) as reply:
            self.assertEqual(reply.status, 200)
            self.assertIn('application/javascript', reply.headers['Content-Type'])
        observed = self.observed[-1]
        self.assertEqual(observed['host'], f'localhost:{self.upstream_port}')
        self.assertEqual(observed['origin'], f'http://localhost:{self.upstream_port}')
        self.assertIsNone(observed['cookie'])
        self.assertIsNone(observed['authorization'])
        self.assertIsNone(observed['forwarded'])
        for source, location in (('/redirect', self.origin + '/assets/app.js?ok=1'), ('/redirect-loopback', self.origin + '/nested')):
            async with self.client.get(self.url(source), headers=self.headers(), allow_redirects=False) as reply:
                self.assertEqual(reply.status, 302)
                self.assertEqual(reply.headers['Location'], location)
        async with self.client.get(self.url('/redirect-external'), headers=self.headers(), allow_redirects=False) as reply:
            self.assertEqual(reply.status, 502)
            self.assertEqual((await reply.json())['code'], 'redirect_denied')
        async with self.client.get(self.url('/cookies'), headers=self.headers()) as reply:
            self.assertEqual(reply.status, 200)
            cookies = reply.headers.getall('Set-Cookie')
            self.assertEqual(len(cookies), 1)
            self.assertIn('app_session=', cookies[0])
            self.assertNotIn('Domain=', cookies[0])
            self.assertIn('Partitioned', cookies[0])
        async with self.client.get(self.url('/nested'), headers=self.headers()) as reply:
            self.assertEqual(reply.status, 200)
        self.assertEqual(self.observed[-1]['cookie'], 'app_session=synthetic-app-session')
        async with self.client.post(self.url('/submit'), headers=self.headers(Origin=self.origin), data='accepted-body') as reply:
            self.assertEqual(reply.status, 200)
        self.assertEqual(self.observed[-1]['body'], 'accepted-body')

    async def test_ticket_replay_host_origin_and_scope_denials(self):
        ticket = await self.open()
        async with self.client.get(self.url(gateway_module.ENTRY + '?ticket=' + ticket), headers=self.headers(), allow_redirects=False) as reply:
            self.assertEqual(reply.status, 401)
        for headers in (self.headers(Host='attacker.invalid'), self.headers(Cookie=''), self.headers(Origin='https://attacker.invalid'), self.headers(**{'Sec-Fetch-Site': 'cross-site'})):
            async with self.client.get(self.url(), headers=headers) as reply:
                self.assertIn(reply.status, (401, 403))
        async with self.client.post(self.url('/submit'), headers=self.headers(), data='denied') as reply:
            self.assertEqual(reply.status, 403)
        for key in ('runId', 'ownerId', 'workspaceId', 'deviceId', 'repoId', 'sandboxId', 'worktreePath'):
            other = {**self.binding, key: self.binding[key] + '-other'}
            with self.assertRaises(gateway_module.PreviewFailure) as error:
                await self.issue(other)
            self.assertEqual(error.exception.code, 'scope_changed')
        with self.assertRaises(gateway_module.PreviewFailure):
            await self.gateway.control({'operation': 'prepare', 'binding': self.binding, 'port': 49983})

    async def test_real_websocket_hmr_and_immediate_revocation(self):
        await self.open()
        ws = await self.client.ws_connect(self.url('/hmr'), headers=self.headers(Origin=self.origin), protocols=('vite-hmr',))
        self.assertEqual(ws.protocol, 'vite-hmr')
        await ws.send_str('module-changed')
        self.assertEqual((await ws.receive(timeout=2)).data, 'hmr:module-changed')
        started = time.monotonic()
        result = await self.gateway.control({'operation': 'revoke', 'runId': self.binding['runId']})
        self.assertTrue(result['revoked'])
        self.assertLess(time.monotonic() - started, 1)
        self.assertIn((await ws.receive(timeout=2)).type, (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING))
        await ws.close()
        with self.assertRaises(gateway_module.PreviewFailure) as error:
            await self.prepare()
        self.assertEqual(error.exception.code, 'authorization_revoked')

    async def test_revoked_gateway_rebind_after_real_http_close_and_websocket(self):
        await self.open()
        previous_port = self.port
        marker = b'mikka-replacement-after-revoke'

        class ReplacementHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', str(len(marker)))
                self.end_headers()
                self.wfile.write(marker)

            def log_message(self, _format, *_args):
                pass

        # SO_REUSEADDR must not permit a second listener while this origin lives.
        with self.assertRaises(OSError) as occupied:
            with http.server.ThreadingHTTPServer(('0.0.0.0', previous_port), ReplacementHandler):
                self.fail('a live gateway allowed a competing listener')
        self.assertEqual(occupied.exception.errno, errno.EADDRINUSE)

        # Read through server EOF before closing our side, so this real gateway
        # owns a TIME_WAIT connection rather than relying on timing or a mock.
        reader, writer = await asyncio.open_connection('127.0.0.1', previous_port)
        try:
            writer.write(('GET / HTTP/1.1\r\nHost: preview.example.test\r\nCookie: '
                          + self.cookie + '\r\nConnection: close\r\n\r\n').encode())
            await writer.drain()
            response = await asyncio.wait_for(reader.read(), timeout=2)
            self.assertTrue(response.startswith(b'HTTP/1.1 200 '))
        finally:
            writer.close()
            await writer.wait_closed()

        websocket = await self.client.ws_connect(self.url('/hmr'), headers=self.headers(Origin=self.origin))
        try:
            await websocket.send_str('replacement-check')
            self.assertEqual((await websocket.receive(timeout=2)).data, 'hmr:replacement-check')
            await self.gateway.control({'operation': 'revoke', 'runId': self.binding['runId'],
                                        'leaseIds': [self.lease_id]})
            self.assertIn((await websocket.receive(timeout=2)).type,
                          (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING))
        finally:
            await websocket.close()
        self.assertIsNone(self.gateway.port)
        self.assertIsNone(self.gateway.site)
        self.assertIn(self.lease_id, self.gateway.revoked_leases)
        self.assertIn(previous_port, json.loads((self.root / 'ports.json').read_text()))
        self.assertTrue(any(row.split()[1].endswith(f':{previous_port:04X}') and row.split()[3] == '06'
                            for row in Path('/proc/net/tcp').read_text().splitlines()[1:]),
                        'the exercised gateway must own a real TIME_WAIT connection')

        # This is the same ordinary HTTPServer binding used by the private
        # takeover probe. Its new socket must not inherit the root socket mark.
        with http.server.ThreadingHTTPServer(('0.0.0.0', previous_port), ReplacementHandler) as replacement:
            self.assertEqual(replacement.socket.getsockopt(socket.SOL_SOCKET, socket.SO_MARK), 0)
            self.assertEqual(replacement.socket.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT), 0)
            serving = threading.Thread(target=replacement.serve_forever, daemon=True)
            serving.start()
            try:
                async with self.client.get(self.url(), headers={'Connection': 'close'}) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(await response.read(), marker)
            finally:
                await asyncio.to_thread(replacement.shutdown)
                serving.join(timeout=2)
                self.assertFalse(serving.is_alive())

    async def test_shutdown_replies_after_revoking_lease_without_waiting_on_its_own_client(self):
        async with self.control_daemon() as serving:
            await self.open()
            websocket = await self.client.ws_connect(self.url('/hmr'), headers=self.headers(Origin=self.origin))
            try:
                await websocket.send_str('before-shutdown')
                self.assertEqual((await websocket.receive(timeout=2)).data, 'hmr:before-shutdown')
                reply = await self.unix_control({'operation': 'shutdown'})
                self.assertEqual(reply, {'stopped': True})
                self.assertIsNone(self.gateway.site)
                self.assertIsNone(self.gateway.binding)
                self.assertIsNone(self.gateway.port)
                self.assertFalse(self.gateway.sessions)
                self.assertFalse(self.gateway.tickets)
                self.assertFalse((self.root / 'control.sock').exists())
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as fresh:
                    with self.assertRaises(OSError) as refused:
                        fresh.connect(str(self.root / 'control.sock'))
                    self.assertIn(refused.exception.errno, (errno.ENOENT, errno.ECONNREFUSED))
                self.assertIn((await websocket.receive(timeout=2)).type,
                              (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING))
                await asyncio.wait_for(serving, timeout=2)
            finally:
                await websocket.close()

    async def test_shutdown_refuses_accepted_and_discovering_controls_before_they_can_reopen(self):
        async with self.control_daemon() as serving:
            await self.open()
            used_ports = set(self.gateway.used_ports)
            entered = asyncio.Event()
            release = threading.Event()
            loop = asyncio.get_running_loop()

            def delayed_protection(_port):
                loop.call_soon_threadsafe(entered.set)
                if not release.wait(timeout=5):
                    raise RuntimeError('Synthetic shutdown discovery was not released')

            self.gateway.protect = delayed_protection
            pending = asyncio.create_task(self.unix_control({'operation': 'prepare',
                'binding': {**self.binding, 'runId': 'run-after-shutdown', 'epoch': 2}, 'port': self.upstream_port}))
            reader, writer = await asyncio.open_unix_connection(str(self.root / 'control.sock'))
            try:
                await asyncio.wait_for(entered.wait(), timeout=2)
                self.assertEqual(await self.unix_control({'operation': 'shutdown'}), {'stopped': True})
                self.assertFalse(serving.done(), 'outer server still waits for its other accepted connections')
                self.assertIsNone(self.gateway.port)
                self.assertFalse(self.gateway.sessions)
                self.assertFalse(self.gateway.tickets)
                release.set()
                self.assertEqual(await pending, {'error': 'control_unavailable', 'status': 503})
                # This socket was accepted before shutdown but supplies its
                # ordinary command only after the stopped ACK was received.
                writer.write(json.dumps({'operation': 'version'}).encode() + b'\n')
                await writer.drain()
                self.assertEqual(json.loads(await asyncio.wait_for(reader.readline(), timeout=1)),
                                 {'error': 'control_unavailable', 'status': 503})
                self.assertIsNone(self.gateway.port)
                self.assertEqual(self.gateway.used_ports, used_ports)
                self.assertFalse((self.root / 'control.sock').exists())
            finally:
                release.set()
                if not pending.done():
                    pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                writer.close()
                await writer.wait_closed()
            await asyncio.wait_for(serving, timeout=2)

    async def test_slow_discovery_never_delays_revocation_or_reopens_a_stopped_run(self):
        await self.open()
        websocket = await self.client.ws_connect(self.url('/hmr'), headers=self.headers(Origin=self.origin))
        entered = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()

        def delayed_protection(_port):
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(timeout=5):
                raise RuntimeError('Synthetic discovery was not released')

        self.gateway.protect = delayed_protection
        preparing = asyncio.create_task(self.prepare())
        try:
            await asyncio.wait_for(entered.wait(), timeout=2)
            started = time.monotonic()
            await asyncio.wait_for(self.gateway.control({'operation': 'revoke', 'runId': self.binding['runId']}), timeout=1)
            self.assertLess(time.monotonic() - started, 1)
            self.assertIn((await websocket.receive(timeout=2)).type, (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED))
        finally:
            release.set()
            await websocket.close()
        with self.assertRaises(gateway_module.PreviewFailure) as error:
            await preparing
        self.assertEqual(error.exception.code, 'authorization_revoked')
        self.assertIsNone(self.gateway.port)

    async def test_stop_rebind_and_new_run_origin_do_not_reuse_capability(self):
        await self.open()
        previous_port = self.port
        previous_cookie = self.cookie
        await self.upstream_site.stop()
        # Binding a new socket at the same port must not inherit old authority.
        self.upstream_site = web.TCPSite(self.upstream_runner, '127.0.0.1', self.upstream_port)
        await self.upstream_site.start()
        async with self.client.get(self.url(), headers=self.headers()) as reply:
            self.assertEqual(reply.status, 409)
            self.assertEqual((await reply.json())['code'], 'server_stopped')
        next_binding = {**self.binding, 'runId': 'run-b', 'epoch': 2}
        await self.prepare(next_binding)
        self.assertNotEqual(self.port, previous_port)
        await self.issue(next_binding)
        async with self.client.get(self.url(), headers=self.headers(Cookie=previous_cookie)) as reply:
            self.assertEqual(reply.status, 401)
        self.assertIn(previous_port, json.loads((self.root / 'ports.json').read_text()))

    async def test_expiry_closes_idle_websocket_without_polling(self):
        self.binding['expiresAt'] = time.time() + 1
        await self.open()
        ws = await self.client.ws_connect(self.url('/hmr'), headers=self.headers(Origin=self.origin), protocols=('vite-hmr',))
        message = await ws.receive(timeout=2)
        self.assertIn(message.type, (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING))
        await ws.close()
        self.assertIsNone(self.gateway.site)

    async def test_port_and_worktree_discovery_and_limits(self):
        other_path = self.root / 'other-repository'
        other_path.mkdir()
        result = await self.gateway.control({'operation': 'prepare', 'binding': {**self.binding, 'worktreePath': str(other_path)}, 'port': self.upstream_port})
        self.assertFalse(result['running'])
        await self.open()
        session = next(iter(self.gateway.sessions.values()))
        session['bytes'] = gateway_module.MAX_SESSION_BYTES
        async with self.client.post(self.url('/submit'), headers=self.headers(Origin=self.origin), data='one-byte-over-budget') as reply:
            self.assertEqual(reply.status, 429)
            self.assertEqual((await reply.json())['code'], 'byte_limit')
        while len(self.gateway.sessions) + len(self.gateway.tickets) < gateway_module.MAX_SESSIONS:
            self.lease_id = 'synthetic-lease-' + str(len(self.gateway.tickets) + 1)
            await self.issue()
        self.lease_id = 'synthetic-lease-over-limit'
        with self.assertRaises(gateway_module.PreviewFailure) as error:
            await self.issue()
        self.assertEqual(error.exception.code, 'session_limit')

    async def test_reopening_same_lease_rotates_ticket_without_a_sliding_expiry(self):
        await self.open()
        expiry = self.gateway.binding['expiresAt']
        first = (await self.issue())['ticket']
        second = (await self.issue())['ticket']
        self.assertNotEqual(first, second)
        self.assertEqual(len(self.gateway.tickets), 1)
        async with self.client.get(self.url(gateway_module.ENTRY + '?ticket=' + first), headers=self.headers()) as reply:
            self.assertEqual(reply.status, 401)
        self.assertEqual(self.gateway.binding['expiresAt'], expiry)

    async def test_revoked_lease_cannot_issue_late_and_new_lease_gets_new_origin(self):
        await self.prepare()
        previous_port = self.port
        await self.gateway.control({'operation': 'revoke', 'runId': self.binding['runId'], 'leaseIds': [self.lease_id]})
        await self.prepare()
        self.assertEqual(self.port, previous_port, 'an unissued lease has no browser session to close')
        with self.assertRaises(gateway_module.PreviewFailure) as error:
            await self.issue()
        self.assertEqual(error.exception.code, 'authorization_revoked')
        self.lease_id = 'synthetic-lease-b'
        self.assertIn('ticket', await self.issue())

    async def test_terminal_lease_revocation_does_not_close_a_preview_lease(self):
        await self.open()
        previous_port = self.port
        await self.gateway.control({'operation': 'revoke', 'runId': self.binding['runId'], 'leaseIds': ['synthetic-terminal-lease']})
        self.assertEqual(self.gateway.port, previous_port)
        async with self.client.get(self.url(), headers=self.headers()) as reply:
            self.assertEqual(reply.status, 200)

    async def test_worktree_symlink_and_public_listener_are_not_authority(self):
        link = self.root / 'linked-worktree'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(gateway_module.PreviewFailure) as error:
            await self.gateway.control({'operation': 'prepare', 'binding': {**self.binding, 'worktreePath': str(link)}, 'port': self.upstream_port})
        self.assertEqual(error.exception.code, 'worktree_unavailable')
        public = web.TCPSite(self.upstream_runner, '0.0.0.0', 0)
        await public.start()
        try:
            port = public._server.sockets[0].getsockname()[1]
            result = await self.gateway.control({'operation': 'prepare', 'binding': self.binding, 'port': port})
            self.assertFalse(result['running'])
        finally:
            await public.stop()

    async def test_missing_kernel_protection_never_mints_a_preview_origin(self):
        def unavailable(_port):
            raise gateway_module.FirewallError('firewall_unsupported')
        self.gateway.protect = unavailable
        with self.assertRaises(gateway_module.PreviewFailure) as error:
            await self.prepare()
        self.assertEqual(error.exception.code, 'firewall_unsupported')
        self.assertEqual(error.exception.status, 404)
        self.assertIsNone(self.gateway.port)
        self.assertEqual(len(self.gateway.tickets), 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
