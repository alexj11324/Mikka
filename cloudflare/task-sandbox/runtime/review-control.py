"""Root gateway operations for one admitted review lease in the native task image."""
import base64
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import select
import stat
import subprocess
import sys
import time
import uuid

TERMINAL = Path('/opt/mikka/terminal/gateway.py')
PREVIEW = Path('/opt/mikka/preview/preview-gateway.py')
ROOT = Path('/run/mikka-terminal')

def terminal_health(key):
    nonce = str(uuid.uuid4())
    conn = http.client.HTTPConnection('127.0.0.1', 6084, timeout=4)
    try:
        conn.request('GET', '/health?challenge=' + nonce)
        reply = conn.getresponse()
        if reply.status != 200:
            raise ValueError('terminal unavailable')
        data = json.loads(reply.read(1025))
        version = hashlib.sha256(TERMINAL.read_bytes()).hexdigest()
        expected = hmac.digest(key, f"health:v1:{nonce}:{data['boot']}:{version}".encode(), 'sha256').hex()
        if data.get('version') != version or not hmac.compare_digest(data['proof'], expected):
            raise ValueError('terminal authentication failed')
        return {'boot': str(uuid.UUID(data['boot'])), 'version': version}
    finally:
        conn.close()

def checked_key(create=None):
    if create is not None:
        if len(create) != 32:
            raise ValueError('invalid terminal key')
        ROOT.mkdir(mode=0o700, exist_ok=True)
    info = ROOT.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('invalid terminal root')
    path = ROOT / 'key'
    if create is not None:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'wb') as destination:
                destination.write(create)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('invalid terminal key')
        key = source.read(33)
        if len(key) != 32:
            raise ValueError('invalid terminal key')
        return key

def terminal(presented, start):
    key = checked_key(presented if start else None)
    if not hmac.compare_digest(presented, key):
        raise ValueError('terminal key mismatch')
    try:
        return terminal_health(key)
    except (OSError, http.client.HTTPException):
        if not start:
            raise
    proc = subprocess.Popen([sys.executable, '-I', '-u', str(TERMINAL), '--cloudflare-task'], cwd='/',
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            start_new_session=True, close_fds=True)
    # Read one readiness notification from the existing gateway.
    with proc.stdout as ready:
        if select.select([ready], [], [], 5)[0] and ready.readline(128) == b'terminal-ready\n':
            return terminal_health(key)
    if proc.poll() is None:
        proc.terminate()
    return terminal_health(key)  # Another concurrent start may own the listener.

def terminal_revoke(message):
    ids = [str(uuid.UUID(item)) for item in message['leaseIds']]
    if len(ids) != 1 or not isinstance(message['ownerId'], str):
        raise ValueError('invalid terminal close')
    key = checked_key()
    current = terminal_health(key)
    body = json.dumps({'leaseIds': ids}, separators=(',', ':')).encode()
    grant = {'version': 1, 'operation': 'revoke', 'boot': current['boot'],
             'nonce': str(uuid.uuid4()), 'expiresAt': int(time.time() * 1000) + 30000,
             'bodyDigest': hashlib.sha256(body).hexdigest(), 'runId': str(uuid.UUID(message['runId'])),
             'ownerId': message['ownerId'], 'workspaceId': str(uuid.UUID(message['workspaceId']))}
    encoded = base64.urlsafe_b64encode(json.dumps(grant, separators=(',', ':')).encode()).rstrip(b'=')
    signature = base64.urlsafe_b64encode(hmac.digest(key, encoded, 'sha256')).rstrip(b'=')
    conn = http.client.HTTPConnection('127.0.0.1', 6084, timeout=8)
    try:
        conn.request('POST', '/revoke', body, {'authorization': 'Bearer ' + (encoded + b'.' + signature).decode(),
                                               'content-type': 'application/json'})
        reply = conn.getresponse()
        if reply.status != 204:
            raise ValueError('terminal close unconfirmed')
        return {'revoked': True}
    finally:
        conn.close()

def preview(message):
    sys.path.insert(0, str(PREVIEW.parent))
    spec = importlib.util.spec_from_file_location('review_preview_gateway', PREVIEW)
    gateway = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gateway)
    if message.get('operation') == 'prepare':
        if gateway.ensure(cloudflare=True).get('version') != gateway.VERSION:
            raise ValueError('preview version mismatch')
    if message.get('operation') not in ('prepare', 'issue', 'revoke'):
        raise ValueError('invalid preview control')
    return gateway.call_control(message)

if __name__ == '__main__':
    try:
        if os.geteuid() != 0 or len(sys.argv) != 2:
            raise ValueError('invalid control')
        value = sys.stdin.buffer.read(16385)
        if len(value) > 16384:
            raise ValueError('oversize control')
        data = json.loads(value)
        action = sys.argv[1]
        if action in ('terminal-prepare', 'terminal-existing'):
            result = terminal(base64.b64decode(data['key'], validate=True), action == 'terminal-prepare')
        elif action == 'terminal-revoke':
            result = terminal_revoke(data)
        elif action == 'preview':
            result = preview(data)
        else:
            raise ValueError('unknown control')
        print(json.dumps(result, separators=(',', ':')))
    except Exception:
        raise SystemExit('task_review_control_failed') from None
