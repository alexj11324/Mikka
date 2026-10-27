"""Short-lived, owner-scoped CDP screencast and input grants.

Chromium is attached through a per-subagent Unix socket; no raw CDP TCP
listener exists. Access logs are disabled because the URL holds a grant.
"""
import asyncio
import base64
import fcntl
import hashlib
import hmac
import json
import math
import os
import re
import time
from pathlib import Path
from aiohttp import web, WSMsgType

ROOT = Path('/run/mikka-viewer')
STATE = Path('/run/mikka-subagent')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)

def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))

def authorize(token, subagent, now=None):
    now = time.time() if now is None else now
    if not UUID.fullmatch(subagent) or not isinstance(token, str) or len(token) > 4096:
        raise ValueError('invalid grant')
    payload, signature = token.split('.')
    expected = hmac.new((ROOT / 'key').read_bytes(), payload.encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(expected, decode(signature)):
        raise ValueError('invalid signature')
    grant = json.loads(decode(payload))
    if grant.get('kind') != 'subagent' or grant.get('subagentId') != subagent or grant.get('mode') not in ('view', 'control') or not now < grant['exp'] <= now + 305:
        raise ValueError('invalid grant')
    state = json.loads((STATE / f'{subagent}.json').read_text())
    if any(grant.get(key) != state.get(key) for key in ('subagentId', 'botId', 'ownerId', 'workspaceId', 'epoch', 'policyVersion')) or state.get('computerAllowed') is not True or state.get('stopRequested'):
        raise ValueError('revoked grant')
    if grant['mode'] == 'control' and (state.get('controlledBy') != grant.get('userId') or state.get('controlUntil', 0) <= now):
        raise ValueError('control not held')
    return grant

def input_request(data):
    if not isinstance(data, dict) or not isinstance(data.get('id'), (str, int)) or len(str(data['id'])) > 64:
        raise ValueError('invalid input')
    if data.get('type') == 'mouse':
        x, y = data.get('x'), data.get('y')
        if type(x) not in (int, float) or type(y) not in (int, float) or not math.isfinite(x) or not math.isfinite(y) or not 0 <= x <= 1280 or not 0 <= y <= 800:
            raise ValueError('invalid input')
        kind = data.get('event')
        if kind not in ('mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'):
            raise ValueError('invalid input')
        result = {'id': data['id'], 'action': 'mouse', 'type': kind, 'x': x, 'y': y}
        if kind == 'mouseWheel':
            for key in ('deltaX', 'deltaY'):
                value = data.get(key, 0)
                if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 2000:
                    raise ValueError('invalid input')
                result[key] = value
        else:
            button = data.get('button', 'none')
            if button not in ('none', 'left', 'middle', 'right'):
                raise ValueError('invalid input')
            result['button'] = button
        return result
    if data.get('type') == 'key':
        kind, key, text = data.get('event'), data.get('key'), data.get('text')
        if kind not in ('keyDown', 'keyUp', 'char') or not isinstance(key, str) or len(key) > 64 or (text is not None and (not isinstance(text, str) or len(text) > 32)):
            raise ValueError('invalid input')
        return {'id': data['id'], 'action': 'key', 'type': kind, 'key': key, **({'text': text} if text else {})}
    raise ValueError('invalid input')

async def viewer(request):
    subagent, token = request.match_info['id'], request.query.get('token', '')
    try:
        grant = authorize(token, subagent)
    except (ValueError, KeyError, OSError, TypeError):
        raise web.HTTPUnauthorized()
    try:
        reader, writer = await asyncio.open_unix_connection(f'/home/user/.mikka/subagents/{subagent}/browser.sock', limit=8 * 1024 * 1024)
    except OSError:
        raise web.HTTPServiceUnavailable()
    ws = web.WebSocketResponse(max_msg_size=64 * 1024)
    await ws.prepare(request)
    writer.write(b'{"id":"viewer-init","action":"subscribe"}\n'); await writer.drain()
    pending = {}
    async def receive():
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                break
            current = authorize(token, subagent)
            if current['mode'] != 'control':
                await ws.close(code=1008); break
            try:
                operation = input_request(json.loads(message.data))
            except (ValueError, TypeError, json.JSONDecodeError):
                await ws.close(code=1008); break
            lock = os.open(STATE / f'{subagent}.lock', os.O_RDWR | os.O_NOFOLLOW)
            locked = False
            try:
                while not locked:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB); locked = True
                    except BlockingIOError:
                        await asyncio.sleep(.1)
                # The grant can be revoked while this input waits for a driver.
                authorize(token, subagent)
                ack = asyncio.get_running_loop().create_future()
                pending[str(operation['id'])] = ack
                writer.write((json.dumps(operation, separators=(',', ':')) + '\n').encode()); await writer.drain()
                await asyncio.wait_for(ack, timeout=30)
            finally:
                pending.pop(str(operation['id']), None)
                if locked: fcntl.flock(lock, fcntl.LOCK_UN)
                os.close(lock)
    async def send():
        while chunk := await reader.readline():
            value = json.loads(chunk)
            if str(value.get('id')) in pending and not pending[str(value['id'])].done():
                pending[str(value['id'])].set_result(None)
            await ws.send_str(chunk.decode())
    async def lease():
        while True:
            await asyncio.sleep(.5)
            authorize(token, subagent)
    tasks = [asyncio.create_task(fn()) for fn in (receive, send, lease)]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close(); await writer.wait_closed(); await ws.close()
    return ws

def main():
    app = web.Application()
    app.router.add_get('/subagents/{id}', viewer)
    web.run_app(app, host='0.0.0.0', port=6081, access_log=None, print=None)

if __name__ == '__main__':
    main()
