"""Real local WebSocket transport; authentication and captured frames are fixtures."""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from aiohttp import ClientWSTimeout, WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer


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
