"""Short-lived noVNC grants. No unauthenticated VNC or CDP forwarding.

Start as the infrastructure service, outside the agent's OS account. Signing
key and revocation state belong to that service, never the agent. A shell with
root/sudo access violates this boundary and is not a supported tenant runtime.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import time
from pathlib import Path
from aiohttp import web, WSMsgType

STATE = Path('/run/mikka-viewer')
VIEWERS = {}

def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))

def authorize(token, now=None):
    now = time.time() if now is None else now
    if not isinstance(token, str) or len(token) > 4096:
        raise ValueError('invalid grant')
    payload, signature = token.split('.')
    expected = hmac.new((STATE / 'key').read_bytes(), payload.encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(expected, decode(signature)):
        raise ValueError('invalid signature')
    grant = json.loads(decode(payload))
    if not (now < grant['exp'] <= now + 305) or grant['mode'] not in ('view', 'control'):
        raise ValueError('expired grant')
    display = grant['display']
    if type(display) is not int or not 1 <= display <= 999:
        raise ValueError('invalid display')
    if (STATE / f'{display}.guard').exists(): raise ValueError('credentials are private')
    state = json.loads((STATE / f'{display}.json').read_text())
    if grant['botId'] != state['botId'] or grant['ownerId'] != state['ownerId'] or grant['epoch'] != state['epoch']:
        raise ValueError('revoked grant')
    if grant['mode'] == 'control' and (state.get('controlledBy') != grant['userId'] or state.get('controlUntil', 0) <= now):
        raise ValueError('control not held')
    return grant

async def viewer(request):
    token = request.query.get('token', '')
    try:
        grant = authorize(token)
    except (ValueError, KeyError, OSError, TypeError):
        raise web.HTTPUnauthorized()
    # View-only is enforced by x11vnc, not a client-side toggle.
    socket = f"/home/user/.mikka/vnc/{grant['display']}-{grant['mode']}.sock"
    try:
        reader, writer = await asyncio.open_unix_connection(socket)
    except OSError:
        raise web.HTTPServiceUnavailable()
    display=grant['display']
    VIEWERS[display]=VIEWERS.get(display,0)+1
    (STATE/f'{display}-viewers').write_text(str(VIEWERS[display]))
    try: authorize(token)
    except Exception:
        VIEWERS[display]-=1;(STATE/f'{display}-viewers').write_text(str(VIEWERS[display]));writer.close();await writer.wait_closed();raise web.HTTPUnauthorized()
    ws = web.WebSocketResponse(protocols=('binary',), max_msg_size=1024 * 1024)
    await ws.prepare(request)

    async def receive():
        async for message in ws:
            if message.type != WSMsgType.BINARY:
                break
            authorize(token)
            writer.write(message.data)
            await writer.drain()

    async def send():
        while chunk := await reader.read(65536):
            await ws.send_bytes(chunk)

    async def lease():
        while True:
            await asyncio.sleep(.05)
            authorize(token)

    tasks = [asyncio.create_task(fn()) for fn in (receive, send, lease)]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        await writer.wait_closed()
        await ws.close()
        VIEWERS[display]-=1;(STATE/f'{display}-viewers').write_text(str(VIEWERS[display]))
    return ws

def main():
    (STATE/'guard-protocol').write_text('1')
    for path in STATE.glob('*-viewers'): path.write_text('0')
    app = web.Application()
    app.router.add_get('/vnc', viewer)
    # URL contains a bearer grant: access logging must stay disabled.
    web.run_app(app, host='0.0.0.0', port=6080, access_log=None, print=None)

if __name__ == '__main__':
    main()
