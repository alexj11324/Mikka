"""Disposable E2B-to-loopback API relay for isolated acceptance, never production.

The private JSON configuration is consumed once. Device, run, fixed fixture Git
and control capabilities are separate. Account pages remain inaccessible; the
only non-v1 routes are the bound run's MCP and GitHub-token endpoints.
"""
import asyncio
import base64
import hmac
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit
from uuid import uuid4
from aiohttp import web

SAFE_HEADERS = {'accept', 'content-type', 'user-agent', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'git-protocol'}
HOP_HEADERS = {'connection', 'transfer-encoding', 'content-length', 'content-encoding', 'keep-alive', 'set-cookie', 'host'}
GIT_PREFIX = '/mikka/v1/git/core-loop.git'
FIXTURE_REPOSITORY = 'mikka-e2e/core-loop'
SCOPE_FIELDS = ('issueId', 'repository', 'branch')
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

def git_service(path, method):
    for service in ('git-upload-pack', 'git-receive-pack'):
        if (method == 'GET' and path == f'{GIT_PREFIX}/info/refs?service={service}'
            or method == 'POST' and path == f'{GIT_PREFIX}/{service}'):
            return service
    return None

def allowed_path(value):
    if not isinstance(value, str) or len(value) > 8192 or '\\' in value:
        return False
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.fragment or not parsed.path.startswith('/mikka/v1/'):
        return False
    decoded = unquote(unquote(parsed.path))
    return decoded == parsed.path and '//' not in decoded and all(part not in ('.', '..') for part in decoded.split('/'))

def create_app(config):
    origin = urlsplit(config['origin'])
    if origin.scheme != 'https' or not origin.netloc or origin.path or origin.query or origin.fragment:
        raise ValueError('Invalid relay origin')
    if not re.fullmatch(r'orv_[A-Za-z0-9_-]{43}', config['deviceToken']) or len(config['controlToken']) < 43:
        raise ValueError('Invalid relay credentials')
    if config['deviceToken'] == config['controlToken']:
        raise ValueError('Separate relay credentials required')
    repo_token = config.get('repoToken')
    if repo_token is not None and (not isinstance(repo_token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', repo_token)
                                   or repo_token in (config['deviceToken'], config['controlToken'])):
        raise ValueError('Separate fixture repository credential required')
    queued, pending, mcp = asyncio.Queue(maxsize=64), {}, {}
    device_bound = not config.get('bindDeviceOnce', False)
    app = web.Application(client_max_size=8 * 1024 * 1024)

    def require(request, token):
        if request.headers.get('host') != origin.netloc or not hmac.compare_digest(request.headers.get('authorization', '').encode(), ('Bearer ' + token).encode()):
            raise web.HTTPUnauthorized()

    async def proxy(request):
        is_mcp = request.raw_path == '/mikka/api/mcp'
        is_github = request.raw_path == '/mikka/api/runs/github-token'
        is_git = request.path.startswith('/mikka/v1/git')
        service = git_service(request.raw_path, request.method) if is_git else None
        run_scope = {key: mcp[key] for key in SCOPE_FIELDS} if all(key in mcp for key in SCOPE_FIELDS) else None
        live_mcp = bool(mcp) and time.monotonic() < mcp['until']
        needs_live_scope = is_github or service == 'git-receive-pack'
        if is_git:
            if not service:
                raise web.HTTPNotFound()
            if repo_token is None:
                raise web.HTTPUnauthorized()
            require(request, repo_token)
            if service == 'git-receive-pack' and (not live_mcp or not run_scope or run_scope['repository'] != FIXTURE_REPOSITORY):
                raise web.HTTPForbidden()
        elif is_mcp or is_github:
            if not mcp or time.monotonic() >= mcp['until'] or request.method != 'POST':
                raise web.HTTPUnauthorized()
            require(request, mcp['token'])
            if is_github and not run_scope:
                raise web.HTTPForbidden()
        else:
            if not device_bound:
                raise web.HTTPUnauthorized()
            require(request, config['deviceToken'])
        if request.method not in ('GET', 'POST', 'PATCH', 'PUT', 'DELETE') or not (is_mcp or is_github or is_git or allowed_path(request.raw_path)):
            raise web.HTTPNotFound()
        if len(pending) >= 64:
            raise web.HTTPServiceUnavailable()
        body = await request.read()
        if is_github and body:
            try:
                supplied = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                raise web.HTTPBadRequest()
            if not isinstance(supplied, dict) or set(supplied) != set(SCOPE_FIELDS) or supplied != run_scope:
                raise web.HTTPForbidden()
        bound_run = mcp.get('runId') if live_mcp else None
        bound_token = mcp.get('token') if live_mcp else None
        def scope_still_live():
            return (bool(mcp) and mcp.get('runId') == bound_run and mcp.get('token') == bound_token
                    and time.monotonic() < mcp['until']
                    and {key: mcp.get(key) for key in SCOPE_FIELDS} == run_scope)
        rid = str(uuid4())
        item = {'headers': asyncio.get_running_loop().create_future(), 'body': asyncio.Queue(maxsize=32)}
        pending[rid] = item
        headers = {key.lower(): value for key, value in request.headers.items() if key.lower() in SAFE_HEADERS or key.lower().startswith('x-mikka-')}
        try:
            await queued.put({'id': rid, 'origin': config['origin'], 'path': request.raw_path, 'method': request.method,
                              'scope': 'git' if is_git else 'mcp' if is_mcp or is_github else 'device',
                              'runId': bound_run if is_git or is_mcp or is_github else None,
                              'runScope': run_scope if is_git or is_github else None,
                              'headers': headers, 'body': base64.b64encode(body).decode()})
            info = await asyncio.wait_for(item['headers'], 180)
            if needs_live_scope and not scope_still_live():
                raise web.HTTPUnauthorized()
            if is_github:
                # A credential response is small and must remain bound until
                # delivery; do not stream a token after its run was unbound.
                chunks, size = [], 0
                while True:
                    chunk = await asyncio.wait_for(item['body'].get(), 300)
                    if chunk is None:
                        break
                    size += len(chunk)
                    if size > 64 * 1024:
                        raise web.HTTPBadGateway()
                    chunks.append(chunk)
                if not scope_still_live():
                    raise web.HTTPUnauthorized()
                return web.Response(status=info['status'], headers=info['headers'], body=b''.join(chunks))
            response = web.StreamResponse(status=info['status'], headers=info['headers'])
            await response.prepare(request)
            while True:
                chunk = await asyncio.wait_for(item['body'].get(), 300)
                if chunk is None:
                    break
                await response.write(chunk)
            await response.write_eof()
            return response
        except (asyncio.TimeoutError, ConnectionError):
            raise web.HTTPBadGateway()
        finally:
            pending.pop(rid, None)

    async def next_request(request):
        require(request, config['controlToken'])
        try:
            while True:
                item = await asyncio.wait_for(queued.get(), 25)
                if item['id'] in pending:
                    return web.json_response(item)
        except asyncio.TimeoutError:
            return web.Response(status=204)

    async def bind_mcp(request):
        require(request, config['controlToken'])
        if request.method == 'DELETE':
            mcp.clear()
            return web.Response(status=204)
        info = await request.json()
        if not re.fullmatch(UUID, info.get('runId', '')) or not re.fullmatch(r'[A-Za-z0-9_.-]{32,4096}', info.get('token', '')):
            raise web.HTTPBadRequest()
        if info['token'] in (config['deviceToken'], config['controlToken'], repo_token):
            raise web.HTTPBadRequest()
        if mcp and mcp['runId'] != info['runId']:
            raise web.HTTPConflict()
        if any(key in info for key in SCOPE_FIELDS):
            if (not all(isinstance(info.get(key), str) for key in SCOPE_FIELDS)
                or not re.fullmatch(UUID, info['issueId'])
                or not re.fullmatch(r'[a-z0-9_.-]+/[a-z0-9_.-]+', info['repository'])
                or not re.fullmatch(r'mikka/[a-z0-9-]+-[1-9][0-9]*', info['branch'])):
                raise web.HTTPBadRequest()
        mcp.clear()
        mcp.update(token=info['token'], runId=info['runId'], until=time.monotonic() + 900)
        if all(key in info for key in SCOPE_FIELDS):
            mcp.update({key: info[key] for key in SCOPE_FIELDS})
        return web.Response(status=204)

    async def bind_device(request):
        nonlocal device_bound
        require(request, config['controlToken'])
        info = await request.json()
        if device_bound or not re.fullmatch(r'orv_[A-Za-z0-9_-]{43}', info.get('token', '')) or not re.fullmatch(r'[0-9a-f-]{36}', info.get('deviceId', '')):
            raise web.HTTPConflict()
        config['deviceToken'], device_bound = info['token'], True
        return web.Response(status=204)

    async def reply(request):
        require(request, config['controlToken'])
        item = pending.get(request.match_info['id'])
        if not item:
            raise web.HTTPNotFound()
        action = request.match_info['action']
        if action == 'start':
            info = await request.json()
            if not isinstance(info.get('status'), int) or not 200 <= info['status'] <= 599 or item['headers'].done():
                raise web.HTTPBadRequest()
            headers = {key: value for key, value in info.get('headers', {}).items() if key.lower() not in HOP_HEADERS}
            item['headers'].set_result({'status': info['status'], 'headers': headers})
        elif action == 'chunk':
            if not item['headers'].done():
                raise web.HTTPConflict()
            await item['body'].put(await request.read())
        elif action == 'end':
            await item['body'].put(None)
        else:
            raise web.HTTPNotFound()
        return web.Response(status=204)

    app.router.add_get('/control/next', next_request)
    app.router.add_post('/control/bind-device', bind_device)
    app.router.add_post('/control/bind-mcp', bind_mcp)
    app.router.add_delete('/control/bind-mcp', bind_mcp)
    app.router.add_post('/control/{id}/{action}', reply)
    app.router.add_route('*', '/{tail:.*}', proxy)
    return app

def main():
    path = Path(sys.argv[1])
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError('Private relay configuration required')
    config = json.loads(path.read_text())
    path.unlink()
    web.run_app(create_app(config), host='0.0.0.0', port=8765, print=None, access_log=None)

if __name__ == '__main__':
    main()
