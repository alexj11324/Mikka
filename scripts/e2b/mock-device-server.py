"""Disposable E2B worker smoke only: no real users or provider tokens."""
import asyncio
import hashlib
import json
import os
from aiohttp import web

workspace = os.environ['MIKKA_TEST_WORKSPACE']
marker = '/tmp/mikka-worker-registration.json'
run_file = '/tmp/mikka-worker-run.json'
claimed_file = '/tmp/mikka-worker-claimed'
review_file = '/tmp/mikka-worker-review.json'
decision_file = '/tmp/mikka-worker-decisions.json'
completion_file = '/tmp/mikka-worker-completion.json'
renewal_file = '/tmp/mikka-worker-renewal.json'
computer_event_file = '/tmp/mikka-worker-computer-event.json'

def run_config():
    try:
        with open(run_file, encoding='utf8') as source:
            return json.load(source)
    except FileNotFoundError:
        return None

def publish(path, data):
    with open(path + '.next', 'w', encoding='utf8') as output:
        json.dump(data, output)
    os.replace(path + '.next', path)

async def request_handler(request):
    auth = request.headers.get('authorization', '')
    if not auth.startswith('Bearer orv_'):
        return web.json_response({'error': 'unauthorized'}, status=401)
    path = request.path
    if path.endswith('/devices/register'):
        body = await request.json()
        if body.get('workspaceId') != workspace or not body.get('deviceId'):
            return web.json_response({'error': 'invalid device'}, status=400)
        publish(marker, {'deviceId': body['deviceId'], 'hash': hashlib.sha256(auth[7:].encode()).hexdigest()})
        return web.json_response({'deviceId': body['deviceId'], 'workspaceId': workspace})
    config = run_config()
    if path.endswith('/heartbeat'):
        response = {'leases': {config['runId']: config['leaseExpiresAt']} if config else {}}
        try:
            with open(renewal_file, encoding='utf8') as source:
                response['cloudCredential'] = json.load(source)['credential']
            os.unlink(renewal_file)
        except FileNotFoundError:
            pass
        return web.json_response(response)
    if path.endswith('/computer'):
        body = await request.json()
        if body.get('requests'):
            publish(review_file, body['requests'])
        try:
            with open(decision_file, encoding='utf8') as source:
                decisions = json.load(source)
        except FileNotFoundError:
            decisions = []
        return web.json_response({'decisions': decisions})
    if path.endswith('/repos'):
        return web.json_response({'repos': [{'repoId': config['repoId'], 'name': 'Synthetic', 'path': config['repoPath']}] if config else []})
    if path.endswith('/runs'):
        return web.json_response({'runIds': [config['runId']] if config and not os.path.exists(claimed_file) else []})
    if config and path.endswith('/runs/' + config['runId'] + '/claim'):
        with open(claimed_file, 'w', encoding='utf8'):
            pass
        return web.json_response(config['assignment'])
    if config and path.endswith('/runs/' + config['runId'] + '/subscription'):
        body = await request.json()
        if body.get('action') != 'context':
            return web.json_response({'error': 'synthetic provider is unavailable'}, status=503)
        return web.json_response(config['context'])
    if path.endswith('/commands'):
        await asyncio.sleep(.5)
        return web.json_response({'commands': []})
    if path.endswith('/fs/requests'):
        await asyncio.sleep(.5)
        return web.json_response({'requests': []})
    if config and path.endswith('/runs/' + config['runId'] + '/events'):
        body = await request.json()
        for chunk in body['chunks']:
            if chunk.get('type') == 'data-computer':
                publish(computer_event_file, chunk)
        return web.json_response({'offset': str(body['fromSeq'] + len(body['chunks']) - 1)})
    if config and path.endswith('/runs/' + config['runId'] + '/complete'):
        publish(completion_file, await request.json())
        return web.Response(status=204)
    if config and path.endswith('/runs/' + config['runId']) and request.method == 'PATCH':
        return web.Response(status=204)
    return web.json_response({'error': 'not found'}, status=404)

app = web.Application()
app.router.add_route('*', '/{tail:.*}', request_handler)
web.run_app(app, host='127.0.0.1', port=8765, print=None)
