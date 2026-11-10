"""Both viewer transport regression suites against the exact merged handler.

The sockets are real; only pre-established authority and browser frames are fixtures.
"""
import ast
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, ClientTimeout, ClientWSTimeout, WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer


SOURCE = Path(__file__).with_name('subagent-gateway.py')
MODULE = ast.parse(SOURCE.read_text())
VIEWER = next(node for node in MODULE.body
              if isinstance(node, ast.AsyncFunctionDef) and node.name == 'viewer')


class ViewerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.browser = SimpleNamespace(guard=None, frame='fixture-frame',
                                       viewer=set(), stopped=False)
        self.finished = asyncio.Event()
        self.sockets = []
        self.expired = False
        self.grant = {'subagentId': 'owned-fixture'}

        def authorize(_request, role):
            self.assertEqual(role, 'view')
            return 'synthetic-view-capability', self.grant

        def token(raw, role):
            self.assertEqual(raw, 'synthetic-view-capability')
            self.assertEqual(role, 'view')
            if self.expired:
                raise ValueError('expired')
            return self.grant

        namespace = {'asyncio': asyncio, 'web': web, 'WSMsgType': WSMsgType,
                     'authorize': authorize, 'token': token,
                     'browser': lambda grant: self.browser}
        exec(compile(ast.Module(body=[VIEWER], type_ignores=[]), str(SOURCE), 'exec'), namespace)

        async def handler(request):
            try:
                return await namespace['viewer'](request)
            finally:
                self.finished.set()

        application = web.Application()
        application.router.add_get('/viewer', handler)
        self.runner = web.AppRunner(application, shutdown_timeout=1)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await site.start()
        self.origin = f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
        self.client = ClientSession(timeout=ClientTimeout(total=3))

    async def asyncTearDown(self):
        self.browser.stopped = True
        for socket in self.sockets:
            if not socket.closed:
                await asyncio.wait_for(socket.close(), 1)
        await self.client.close()
        await self.runner.cleanup()

    async def connect(self, **options):
        socket = await self.client.ws_connect(self.origin + '/viewer',
                                             timeout=ClientWSTimeout(ws_close=0.5), **options)
        self.sockets.append(socket)
        return socket

    async def assert_removed(self):
        await asyncio.wait_for(self.finished.wait(), 1)
        self.assertEqual(len(self.browser.viewer), 0)

    async def test_client_close_is_acknowledged_and_unregisters_the_live_viewer(self):
        socket = await self.connect()
        frame = await socket.receive_json(timeout=1)
        self.assertEqual(frame, {'type': 'frame', 'data': 'fixture-frame'})
        self.assertEqual(len(self.browser.viewer), 1)
        await asyncio.wait_for(socket.close(code=1000), 1)
        self.assertEqual(socket.close_code, 1000, 'the peer must acknowledge CLOSE, not time out as 1006')
        await self.assert_removed()

    async def test_guarded_viewer_consumes_ping_and_close_without_forwarding_inputs(self):
        self.browser.guard = 'credentials'
        socket = await self.connect(autoping=False)
        await socket.send_json({'id': 1, 'method': 'Runtime.evaluate',
                                'params': {'expression': 'synthetic-input'}})
        await socket.send_bytes(b'synthetic-input')
        await socket.ping(b'close-proof')
        message = await socket.receive(timeout=1)
        self.assertEqual(message.type, WSMsgType.PONG)
        self.assertEqual(message.data, b'close-proof')
        # The fixture has no CDP methods. Input cannot cause a browser action or
        # a frame while guarded; receive only services WebSocket control frames.
        self.assertIsNone(getattr(self.browser, 'rpc', None))
        await asyncio.wait_for(socket.close(code=1000), 1)
        self.assertEqual(socket.close_code, 1000)
        await self.assert_removed()

    async def test_server_guard_close_still_completes_with_a_receiver_waiting(self):
        self.browser.guard = 'credentials'
        socket = await self.connect()
        server_socket = next(iter(self.browser.viewer))
        closing = asyncio.create_task(server_socket.close(code=1000))
        message = await socket.receive(timeout=1)
        self.assertEqual(message.type, WSMsgType.CLOSE)
        await asyncio.wait_for(closing, 1)
        self.assertEqual(socket.close_code, 1000)
        await self.assert_removed()

    async def test_expiry_closes_a_silent_guarded_viewer_and_its_receiver(self):
        self.browser.guard = 'credentials'
        socket = await self.connect()
        self.expired = True
        message = await socket.receive(timeout=1)
        self.assertEqual(message.type, WSMsgType.CLOSE)
        self.assertEqual(socket.close_code, 1000)
        await self.assert_removed()


class Viewers(set):
    def __init__(self):
        super().__init__()
        self.drained = asyncio.Event()

    def discard(self, value):
        super().discard(value)
        if not self:
            self.drained.set()


class ViewerTransportTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        path = Path(__file__).with_name('subagent-gateway.py')
        spec = importlib.util.spec_from_file_location('viewer_gateway_test', path)
        self.gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.gateway)
        self.browser = SimpleNamespace(viewer=Viewers(), stopped=False, guard=False,
                                       frame='synthetic-captured-frame')
        self.patches = [
            patch.object(self.gateway, 'authorize', lambda request, purpose: ('synthetic-capability', {})),
            patch.object(self.gateway, 'browser', lambda grant: self.browser),
            patch.object(self.gateway, 'token', lambda raw, purpose: None),
        ]
        for item in self.patches:
            item.start()
        app = web.Application()
        app.router.add_get('/viewer', self.gateway.viewer)
        self.client = TestClient(TestServer(app, shutdown_timeout=.1))
        await self.client.start_server()

    async def asyncTearDown(self):
        self.browser.stopped = True
        await asyncio.wait_for(self.client.close(), 2)
        for item in reversed(self.patches):
            item.stop()

    async def assert_normal_close(self, websocket):
        await asyncio.wait_for(websocket.close(), 1)
        self.assertEqual(websocket.close_code, 1000, 'server must acknowledge the client CLOSE frame')
        await asyncio.wait_for(self.browser.viewer.drained.wait(), 1)
        self.assertFalse(self.browser.viewer)

    async def test_client_close_while_frames_are_available(self):
        websocket = await self.client.ws_connect('/viewer', timeout=ClientWSTimeout(ws_close=.5))
        self.assertEqual((await websocket.receive_json())['type'], 'frame')
        await self.assert_normal_close(websocket)

    async def test_client_close_when_guard_suppresses_all_frames(self):
        self.browser.guard = True
        websocket = await self.client.ws_connect('/viewer', timeout=ClientWSTimeout(ws_close=.5))
        await self.assert_normal_close(websocket)

    async def test_viewer_input_is_ignored_and_never_reaches_browser_control(self):
        async def forbidden_control(*args, **kwargs):
            self.fail('read-only viewer input reached browser control')
        self.browser.rpc = forbidden_control
        websocket = await self.client.ws_connect('/viewer', timeout=ClientWSTimeout(ws_close=.5))
        await websocket.send_json({'method': 'Input.insertText', 'params': {'text': 'synthetic-input'}})
        await websocket.send_bytes(b'synthetic-input')
        message = await websocket.receive()
        self.assertEqual(message.type, WSMsgType.TEXT)
        self.assertEqual(message.json(), {'type': 'frame', 'data': self.browser.frame})
        await self.assert_normal_close(websocket)


if __name__ == '__main__':
    unittest.main()
