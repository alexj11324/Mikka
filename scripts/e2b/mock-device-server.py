"""Disposable E2B worker smoke only: no real users or provider tokens."""
import asyncio
import hashlib
import json
import os
from aiohttp import web

workspace = os.environ['MIKKA_TEST_WORKSPACE']
marker = '/tmp/mikka-worker-registration.json'

async def request_handler(request):
    auth = request.headers.get('authorization', '')
    if not auth.startswith('Bearer orv_'):
        return web.json_response({'error': 'unauthorized'}, status=401)
    path = request.path
    if path.endswith('/devices/register'):
        body = await request.json()
        if body.get('workspaceId') != workspace or not body.get('deviceId'):
            return web.json_response({'error': 'invalid device'}, status=400)
        with open(marker + '.next', 'w', encoding='utf8') as output:
            json.dump({'deviceId': body['deviceId'], 'hash': hashlib.sha256(auth[7:].encode()).hexdigest()}, output)
        os.replace(marker + '.next', marker)
        return web.json_response({'deviceId': body['deviceId'], 'workspaceId': workspace})
    if path.endswith('/heartbeat'):
        return web.json_response({'leases': {}})
    if path.endswith('/computer'):
        return web.json_response({'decisions': []})
    if path.endswith('/repos'):
        return web.json_response({'repos': []})
    if path.endswith('/runs'):
        return web.json_response({'runIds': []})
    if path.endswith('/commands'):
        await asyncio.sleep(.5)
        return web.json_response({'commands': []})
    if path.endswith('/fs/requests'):
        await asyncio.sleep(.5)
        return web.json_response({'requests': []})
    return web.json_response({'error': 'not found'}, status=404)

app = web.Application()
app.router.add_route('*', '/{tail:.*}', request_handler)
web.run_app(app, host='127.0.0.1', port=8765, print=None)
