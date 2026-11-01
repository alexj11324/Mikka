import asyncio
import base64
import importlib.util
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from aiohttp.test_utils import TestClient, TestServer

spec = importlib.util.spec_from_file_location('relay', Path(__file__).with_name('local-api-relay.py'))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)
CONFIG = {'origin': 'https://relay.example', 'deviceToken': 'orv_' + 'a' * 43, 'controlToken': 'b' * 43, 'repoToken': 'r' * 43}
RUN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
MCP_TOKEN = 'mkw_' + 'c' * 43
RUN_SCOPE = {'issueId': 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'repository': 'mikka-e2e/core-loop', 'branch': 'mikka/cloud-1'}

class Relay(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = TestClient(TestServer(relay.create_app(CONFIG)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    def headers(self, control=False):
        return {'host': 'relay.example', 'authorization': 'Bearer ' + CONFIG['controlToken' if control else 'deviceToken']}

    def bearer(self, token):
        return {'host': 'relay.example', 'authorization': 'Bearer ' + token}

    async def bind_scope(self, scope=None):
        response = await self.client.post('/control/bind-mcp', headers=self.headers(True), json={'runId': RUN, 'token': MCP_TOKEN, **(scope if scope is not None else RUN_SCOPE)})
        self.assertEqual(response.status, 204)

    async def next_item(self):
        response = await asyncio.wait_for(self.client.get('/control/next', headers=self.headers(True)), 5)
        self.assertEqual(response.status, 200)
        return await response.json()

    async def answer(self, item, data=b'{}', status=200, headers=None):
        prefix = '/control/' + item['id']
        self.assertEqual((await self.client.post(prefix + '/start', headers=self.headers(True), json={'status': status, 'headers': headers or {'content-type': 'application/json'}})).status, 204)
        await self.client.post(prefix + '/chunk', headers=self.headers(True), data=data)
        await self.client.post(prefix + '/end', headers=self.headers(True))

    async def test_no_public_account_routes_or_foreign_host(self):
        for path in ('/mikka/api/auth/get-session', '/mikka/api/mcp', '/control/next'):
            response = await self.client.get(path, headers=self.headers())
            self.assertIn(response.status, (401, 404))
        response = await self.client.post('/mikka/v1/devices/register', headers={**self.headers(), 'host': 'foreign.example'})
        self.assertEqual(response.status, 401)

    async def test_scoped_stream_and_mcp_token_boundary(self):
        public = asyncio.create_task(self.client.post('/mikka/v1/devices/register', headers=self.headers(), data=b'fixture'))
        item = await (await self.client.get('/control/next', headers=self.headers(True))).json()
        self.assertEqual(item['path'], '/mikka/v1/devices/register')
        self.assertEqual(item['scope'], 'device')
        self.assertNotIn('authorization', item['headers'])
        prefix = '/control/' + item['id']
        self.assertEqual((await self.client.post(prefix + '/start', headers=self.headers(True), json={'status': 200, 'headers': {'content-type': 'application/json'}})).status, 204)
        await self.client.post(prefix + '/chunk', headers=self.headers(True), data=b'{"ok":true}')
        await self.client.post(prefix + '/end', headers=self.headers(True))
        response = await public
        self.assertEqual(await response.json(), {'ok': True})
        token, run = 'mkw_' + 'c' * 43, 'a' * 8 + '-aaaa-aaaa-aaaa-' + 'a' * 12
        self.assertEqual((await self.client.post('/control/bind-mcp', headers=self.headers(True), json={'runId': run, 'token': token})).status, 204)
        self.assertEqual((await self.client.post('/mikka/api/mcp', headers=self.headers(), data=b'{}')).status, 401)
        public = asyncio.create_task(self.client.post('/mikka/api/mcp', headers={'host': 'relay.example', 'authorization': 'Bearer ' + token}, data=b'{}'))
        item = await (await self.client.get('/control/next', headers=self.headers(True))).json()
        self.assertEqual((item['scope'], item['runId']), ('mcp', run))
        prefix = '/control/' + item['id']
        await self.client.post(prefix + '/start', headers=self.headers(True), json={'status': 200, 'headers': {'content-type': 'application/json'}})
        await self.client.post(prefix + '/chunk', headers=self.headers(True), data=b'{}')
        await self.client.post(prefix + '/end', headers=self.headers(True))
        self.assertEqual(await (await public).json(), {})
        self.assertEqual((await self.client.post('/control/bind-mcp', headers=self.headers(True), json={'runId': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'token': token})).status, 409)
        await self.client.delete('/control/bind-mcp', headers=self.headers(True))
        response = await self.client.post('/mikka/api/mcp', headers={'host': 'relay.example', 'authorization': 'Bearer ' + token}, data=b'{}')
        self.assertEqual(response.status, 401)

    async def test_fixture_git_capability_cannot_be_device_control_or_run_authority(self):
        path = relay.GIT_PREFIX + '/info/refs?service=git-upload-pack'
        for token in (CONFIG['deviceToken'], CONFIG['controlToken'], MCP_TOKEN):
            self.assertEqual((await self.client.get(path, headers=self.bearer(token))).status, 401)
        self.assertEqual((await self.client.get(path, headers=self.bearer('invalid-é'))).status, 401)
        for token, path in ((CONFIG['repoToken'], '/control/next'), (CONFIG['repoToken'], '/mikka/v1/devices/register'), (CONFIG['repoToken'], '/mikka/api/mcp')):
            self.assertEqual((await self.client.get(path, headers=self.bearer(token))).status, 401)
        for field in ('deviceToken', 'controlToken'):
            with self.assertRaises(ValueError):
                relay.create_app({**CONFIG, 'repoToken': CONFIG[field]})
        for token in (CONFIG['repoToken'], CONFIG['deviceToken'], CONFIG['controlToken']):
            response = await self.client.post('/control/bind-mcp', headers=self.headers(True), json={'runId': RUN, 'token': token})
            self.assertEqual(response.status, 400)

    async def test_only_exact_smart_http_fixture_paths_are_allowed(self):
        bad = ('/mikka/v1/git/other.git/info/refs?service=git-upload-pack',
               relay.GIT_PREFIX + '/HEAD', relay.GIT_PREFIX + '/config',
               relay.GIT_PREFIX + '/info/refs?service=git-upload-pack&other=1',
               relay.GIT_PREFIX + '/info/refs?service=git-upload-archive',
               relay.GIT_PREFIX + '/git-upload-pack?other=1',
               relay.GIT_PREFIX + '/%2e%2e/config')
        for path in bad:
            self.assertEqual((await self.client.get(path, headers=self.bearer(CONFIG['repoToken']))).status, 404)
        for path, method in ((relay.GIT_PREFIX + '/info/refs?service=git-receive-pack', 'GET'), (relay.GIT_PREFIX + '/git-receive-pack', 'POST')):
            response = await self.client.request(method, path, headers=self.bearer(CONFIG['repoToken']))
            self.assertEqual(response.status, 403)

    async def test_receive_pack_requires_live_fixture_run_scope(self):
        await self.bind_scope({**RUN_SCOPE, 'repository': 'foreign/repository'})
        path = relay.GIT_PREFIX + '/info/refs?service=git-receive-pack'
        self.assertEqual((await self.client.get(path, headers=self.bearer(CONFIG['repoToken']))).status, 403)
        await self.bind_scope()
        public = asyncio.create_task(self.client.get(path, headers=self.bearer(CONFIG['repoToken'])))
        item = await self.next_item()
        self.assertEqual((item['scope'], item['runId'], item['runScope']), ('git', RUN, RUN_SCOPE))
        self.assertNotIn('authorization', item['headers'])
        await self.answer(item, b'refused-by-local-fixture', status=403)
        self.assertEqual((await public).status, 403)
        await self.client.delete('/control/bind-mcp', headers=self.headers(True))
        self.assertEqual((await self.client.get(path, headers=self.bearer(CONFIG['repoToken']))).status, 403)

    async def test_github_token_accepts_no_caller_scope_or_exact_bound_scope(self):
        endpoint = '/mikka/api/runs/github-token'
        self.assertEqual((await self.client.post(endpoint, headers=self.bearer(MCP_TOKEN))).status, 401)
        await self.bind_scope()
        self.assertEqual((await self.client.post(endpoint, headers=self.headers())).status, 401)
        for body in (None, RUN_SCOPE):
            public = asyncio.create_task(self.client.post(endpoint, headers=self.bearer(MCP_TOKEN), **({'json': body} if body is not None else {})))
            item = await self.next_item()
            self.assertEqual((item['scope'], item['runId'], item['runScope']), ('mcp', RUN, RUN_SCOPE))
            await self.answer(item)
            self.assertEqual(await (await public).json(), {})
        for body in ({}, {**RUN_SCOPE, 'issueId': RUN}, {**RUN_SCOPE, 'repository': 'foreign/repo'}, {**RUN_SCOPE, 'branch': 'main'}, {**RUN_SCOPE, 'runId': RUN}):
            self.assertEqual((await self.client.post(endpoint, headers=self.bearer(MCP_TOKEN), json=body)).status, 403)
        self.assertEqual((await self.client.post(endpoint, headers=self.bearer(MCP_TOKEN), data=b'not-json')).status, 400)
        self.assertEqual((await self.client.post(endpoint + '?other=1', headers=self.bearer(MCP_TOKEN))).status, 401)

    async def test_expired_or_unbound_run_cannot_receive_github_credentials(self):
        await self.bind_scope()
        with patch.object(relay, 'time', SimpleNamespace(monotonic=lambda: float('inf'))):
            self.assertEqual((await self.client.post('/mikka/api/runs/github-token', headers=self.bearer(MCP_TOKEN))).status, 401)
        public = asyncio.create_task(self.client.post('/mikka/api/runs/github-token', headers=self.bearer(MCP_TOKEN)))
        item = await self.next_item()
        await self.client.delete('/control/bind-mcp', headers=self.headers(True))
        await self.client.post('/control/' + item['id'] + '/start', headers=self.headers(True), json={'status': 200, 'headers': {}})
        self.assertEqual((await public).status, 401)

    async def test_real_git_clone_through_control_queue_and_temporary_bare_repository(self):
        with tempfile.TemporaryDirectory(prefix='mikka-relay-git-') as directory:
            root = Path(directory)
            bare, work = root / 'core-loop.git', root / 'seed'
            def git(*args):
                return subprocess.run(['/usr/bin/git', *args], check=True, capture_output=True, text=True)
            git('init', '--bare', '--initial-branch=trunk', str(bare))
            git('init', '--initial-branch=trunk', str(work))
            (work / 'README.md').write_text('relay upload-pack fixture\n')
            git('-C', str(work), 'add', 'README.md')
            git('-C', str(work), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'fixture')
            git('-C', str(work), 'push', str(bare), 'HEAD:trunk')
            async def serve_git():
                for _ in range(2):
                    item = await self.next_item()
                    self.assertEqual(item['scope'], 'git')
                    self.assertIsNone(item['runScope'])
                    self.assertNotIn('authorization', item['headers'])
                    path, _, query = item['path'].partition('?')
                    env = {'PATH': '/usr/bin:/bin', 'HOME': str(root / 'empty-home'), 'GIT_CONFIG_NOSYSTEM': '1',
                           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_PROJECT_ROOT': str(root), 'GIT_HTTP_EXPORT_ALL': '1',
                           'REQUEST_METHOD': item['method'], 'PATH_INFO': path.removeprefix('/mikka/v1/git'),
                           'QUERY_STRING': query, 'CONTENT_TYPE': item['headers'].get('content-type', ''),
                           'CONTENT_LENGTH': str(len(base64.b64decode(item['body'])))}
                    process = await asyncio.create_subprocess_exec('/usr/bin/git', 'http-backend', env=env,
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    stdout, _ = await process.communicate(base64.b64decode(item['body']))
                    self.assertEqual(process.returncode, 0)
                    raw_headers, payload = stdout.split(b'\r\n\r\n', 1)
                    headers = dict(line.decode().split(': ', 1) for line in raw_headers.split(b'\r\n'))
                    await self.answer(item, payload, headers=headers)
            worker = asyncio.create_task(serve_git())
            clone = await asyncio.create_subprocess_exec('/usr/bin/git', '-c', 'protocol.version=0',
                '-c', 'http.proxy=', '-c', 'http.extraHeader=Host: relay.example',
                '-c', 'http.extraHeader=Authorization: Bearer ' + CONFIG['repoToken'],
                'clone', str(self.client.make_url(relay.GIT_PREFIX)), str(root / 'checkout'),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                _, stderr = await asyncio.wait_for(clone.communicate(), 15)
                await worker
                self.assertEqual(clone.returncode, 0, stderr.decode())
                self.assertEqual((root / 'checkout/README.md').read_text(), 'relay upload-pack fixture\n')
            finally:
                if clone.returncode is None:
                    clone.kill()
                    await clone.wait()
                if not worker.done():
                    worker.cancel()
                    await asyncio.gather(worker, return_exceptions=True)

if __name__ == '__main__':
    unittest.main()
