#!/usr/bin/env python3
"""Run-bound PTY gateway. Root controls admission; the shell runs as user.

No transcript, command, environment, HTTP access log, or capability is written
to disk. Only a bounded in-memory scrollback survives a short disconnect.
The app proxies this private protocol into the existing review SSE contract.
"""
import asyncio
import base64
import codecs
import ctypes
import errno
import fcntl
import hashlib
import hmac
import http
import json
import os
import pwd
import re
import resource
import signal
import socket
import stat
import struct
import sys
import termios
import time
import uuid
from collections import deque
from pathlib import Path

ROOT = Path('/run/mikka-terminal')
CONTROL = Path('/run/mikka-review-control')
PORT = 6084
MAX_INPUT = 16_384
MAX_BODY = 100_000
SCROLLBACK = 262_144
MAX_OUTPUT = 16 * 1024 * 1024
LEASE_SECONDS = 300
SESSION_SECONDS = 15 * 60
IDLE_SECONDS = 120
DETACH_SECONDS = 30
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
VERSION = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


class Refusal(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def refuse(status, code):
    raise Refusal(status, code)


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=')


def fixed_file(directory, name, flags):
    fd = os.open(name, flags | os.O_NOFOLLOW, dir_fd=directory)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
        os.close(fd)
        refuse(404, 'terminal_unsupported')
    return fd


def execution_fence(scope, control=CONTROL):
    """Check the same fixed inode the daemon holds, then retain it for PTY life."""
    directory = os.open(control, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        info = os.fstat(directory)
        if info.st_uid != 0 or info.st_mode & 0o022:
            refuse(404, 'terminal_unsupported')
        version = fixed_file(directory, 'version', os.O_RDONLY)
        try:
            if os.fstat(version).st_mode & 0o022 or os.read(version, 16) != b'1\n':
                refuse(404, 'terminal_unsupported')
        finally:
            os.close(version)
        lock = fixed_file(directory, 'machine.lock', os.O_RDWR)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            refuse(423, 'terminal_already_controlled')
        receipt_fd = fixed_file(directory, 'machine.json', os.O_RDONLY)
        try:
            receipt = json.loads(os.read(receipt_fd, 16_384))
        finally:
            os.close(receipt_fd)
        if receipt.get('version') != 1 or receipt.get('phase') != 'idle' or receipt.get('nativeExited') is not True:
            refuse(423, 'terminal_already_controlled')
        if receipt.get('runId') != scope['runId'] or receipt.get('deviceId') != scope['deviceId'] or receipt.get('worktreePath') != scope['worktreePath']:
            refuse(409, 'terminal_binding_changed')
        result, lock = lock, None
        return result
    except (FileNotFoundError, PermissionError, json.JSONDecodeError, UnicodeError):
        refuse(404, 'terminal_unsupported')
    finally:
        if lock is not None:
            os.close(lock)
        os.close(directory)


class Tickets:
    def __init__(self, key, boot, clock=time.time):
        self.key, self.boot, self.clock, self.used = key, boot, clock, {}

    def consume(self, token, operation, body):
        now = self.clock()
        if not token or len(token) > 12_000 or not token.startswith('Bearer '):
            refuse(401, 'terminal_ticket_invalid')
        try:
            encoded, signature = token[7:].split('.')
            expected = b64(hmac.new(self.key, encoded.encode(), hashlib.sha256).digest()).decode()
            if not hmac.compare_digest(signature, expected):
                refuse(401, 'terminal_ticket_invalid')
            raw = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))
            if b64(raw).decode() != encoded:
                refuse(401, 'terminal_ticket_invalid')
            grant = json.loads(raw)
        except (ValueError, UnicodeError, TypeError):
            refuse(401, 'terminal_ticket_invalid')
        if not isinstance(grant, dict) or grant.get('version') != 1 or grant.get('operation') != operation or grant.get('boot') != self.boot:
            refuse(401, 'terminal_ticket_invalid')
        expiry = grant.get('expiresAt')
        if type(expiry) is not int or not now * 1000 < expiry <= (now + 35) * 1000:
            refuse(401, 'terminal_ticket_expired')
        nonce = grant.get('nonce')
        if not isinstance(nonce, str) or not UUID.fullmatch(nonce) or grant.get('bodyDigest') != hashlib.sha256(body).hexdigest():
            refuse(401, 'terminal_ticket_invalid')
        self.used = {key: value for key, value in self.used.items() if value > now * 1000}
        if nonce in self.used:
            refuse(401, 'terminal_ticket_replayed')
        if len(self.used) >= 4096:
            refuse(429, 'terminal_limit')
        self.used[nonce] = expiry
        if any(not isinstance(grant.get(key), str) or not UUID.fullmatch(grant[key]) for key in ('runId', 'workspaceId')) or not isinstance(grant.get('ownerId'), str):
            refuse(401, 'terminal_ticket_invalid')
        if operation in ('revoke', 'inspect'):
            return grant
        for key in ('sessionId', 'taskId', 'deviceId', 'repoId'):
            if not isinstance(grant.get(key), str) or not UUID.fullmatch(grant[key]):
                refuse(401, 'terminal_ticket_invalid')
        for key in ('bindingId', 'credentialId', 'worktreePath'):
            if not isinstance(grant.get(key), str) or not 0 < len(grant[key]) <= 4096 or '\x00' in grant[key]:
                refuse(401, 'terminal_ticket_invalid')
        lease = grant.get('sessionExpiresAt')
        if type(lease) is not int or not now * 1000 < lease <= (now + LEASE_SECONDS + 1) * 1000:
            refuse(401, 'terminal_ticket_expired')
        return grant


def event(kind, value, seq=None):
    return ((f'id: {seq}\n' if seq is not None else '') + 'event: ' + kind + '\ndata: ' + json.dumps(value, ensure_ascii=True, separators=(',', ':')) + '\n\n').encode()


class Viewer:
    def __init__(self):
        self.queue = asyncio.Queue(maxsize=32)
        self.closed = asyncio.Event()

    def push(self, frame):
        if self.closed.is_set():
            return
        try:
            self.queue.put_nowait(frame)
        except asyncio.QueueFull:
            self.closed.set()


class Session:
    def __init__(self, gateway, grant, account):
        self.gateway, self.grant, self.account = gateway, grant, account
        self.id, self.run_id = grant['sessionId'], grant['runId']
        self.created = time.monotonic()
        self.absolute_deadline = min(time.time() + SESSION_SECONDS, grant['sessionExpiresAt'] / 1000)
        self.idle_deadline = time.time() + IDLE_SECONDS
        self.detach_deadline = None
        self.readable = True
        self.lock = execution_fence(grant, gateway.control)
        self.master = None
        self.pid = None
        self.exit_code = None
        self.ended = False
        self.closing = None
        self.viewer = None
        self.seq, self.history_bytes, self.total_bytes = 0, 0, 0
        self.history = deque()
        self.decoder = codecs.getincrementaldecoder('utf8')(errors='replace')
        self.requests = {}
        self.last_input = time.monotonic()
        self.input_tokens, self.output_tokens = 65_536.0, 262_144.0
        self.output_at = self.input_at = time.monotonic()
        self.connections = deque()
        self.lease_timer = self.idle_timer = self.detach_timer = self.retention_timer = None
        self.hard_timer = asyncio.get_running_loop().call_later(SESSION_SECONDS, self.stop, 'terminal_expired')
        try:
            self.start()
            self.renew(grant)
            self.touch()
        except BaseException:
            self.hard_timer.cancel()
            if self.lock is not None:
                os.close(self.lock)
                self.lock = None
            raise

    def start(self):
        directory = self.grant['worktreePath']
        if not os.path.isabs(directory) or os.path.realpath(directory) != directory or directory == '/':
            refuse(409, 'terminal_binding_changed')
        cwd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            pid, master = os.forkpty()
            if pid == 0:
                try:
                    os.fchdir(cwd)
                    if self.gateway.cloudflare:
                        # Match the native Cloudflare task process. In particular,
                        # a setuid executable in the image cannot raise privilege.
                        if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
                            os._exit(127)
                    os.setgroups([])
                    os.setgid(self.account.pw_gid)
                    os.setuid(self.account.pw_uid)
                    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                    resource.setrlimit(resource.RLIMIT_NOFILE, (512, 512))
                    resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))
                    resource.setrlimit(resource.RLIMIT_CPU, (300, 301))
                    env = {'HOME': self.account.pw_dir, 'USER': self.account.pw_name, 'LOGNAME': self.account.pw_name,
                           'SHELL': '/bin/bash', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
                           'PATH': '/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:/usr/local/bin:/usr/bin:/bin',
                           'MIKKA_RUN_ID': self.run_id, 'HISTFILE': '/dev/null'}
                    os.execve('/bin/bash', ['/bin/bash', '--noprofile', '--norc', '-i'], env)
                except BaseException:
                    os._exit(127)
            self.pid, self.master = pid, master
            os.set_blocking(master, False)
            self.resize(80, 24)
            asyncio.get_running_loop().add_reader(master, self.output)
        finally:
            os.close(cwd)

    def matches(self, grant):
        return all(grant.get(key) == self.grant.get(key) for key in (
            'sessionId', 'runId', 'taskId', 'ownerId', 'workspaceId', 'deviceId', 'repoId',
            'bindingId', 'credentialId', 'worktreePath', 'machineEpoch', 'sessionExpiresAt'))

    def can_read(self):
        # A paused VM freezes event-loop timers. Check wall time at every data
        # boundary as well, before a resumed VM can deliver queued output.
        now = time.time()
        if self.readable and (now >= self.absolute_deadline or now >= self.idle_deadline or
                              (self.detach_deadline is not None and now >= self.detach_deadline)):
            self.stop('terminal_expired')
        return self.readable

    def authorize(self):
        if not self.can_read():
            refuse(409, 'terminal_ended')

    def renew(self, grant):
        if not self.matches(grant):
            refuse(409, 'terminal_binding_changed')
        self.authorize()
        if self.lease_timer:
            self.lease_timer.cancel()
        self.lease_timer = asyncio.get_running_loop().call_later(max(0, grant['sessionExpiresAt'] / 1000 - time.time()), self.stop, 'terminal_expired')

    def touch(self):
        self.last_input = time.monotonic()
        self.idle_deadline = time.time() + IDLE_SECONDS
        if self.idle_timer:
            self.idle_timer.cancel()
        self.idle_timer = asyncio.get_running_loop().call_later(IDLE_SECONDS, self.stop, 'terminal_idle')

    def output(self):
        if not self.can_read() or self.master is None:
            return False
        try:
            data = os.read(self.master, 16_384)
        except BlockingIOError:
            return False
        except OSError as error:
            asyncio.get_running_loop().remove_reader(self.master)
            if error.errno != errno.EIO:
                self.stop('terminal_io_failed')
            return False
        if not data:
            return False
        now = time.monotonic()
        self.output_tokens = min(262_144, self.output_tokens + (now - self.output_at) * 131_072)
        self.output_at = now
        self.output_tokens -= len(data)
        self.total_bytes += len(data)
        if self.output_tokens < 0 or self.total_bytes > MAX_OUTPUT:
            self.stop('terminal_limit')
            return False
        text = self.decoder.decode(data)
        if text:
            self.append(text)
        return True

    def append(self, text):
        if not self.can_read():
            return
        self.seq += 1
        frame = event('output', {'text': text}, self.seq)
        self.history.append((self.seq, frame))
        self.history_bytes += len(frame)
        while self.history and self.history_bytes > SCROLLBACK:
            self.history_bytes -= len(self.history.popleft()[1])
        if self.viewer:
            self.viewer.push(frame)

    def input(self, data, request_id=None):
        self.authorize()
        if self.ended or self.closing or self.master is None:
            refuse(409, 'terminal_ended')
        if not isinstance(data, str) or len(data.encode()) > MAX_INPUT:
            refuse(413, 'terminal_input_too_large')
        encoded = data.encode()
        if request_id is not None:
            if not isinstance(request_id, str) or not UUID.fullmatch(request_id):
                refuse(400, 'terminal_invalid_request')
            digest = hashlib.sha256(encoded).digest()
            if request_id in self.requests:
                prior = self.requests[request_id]
                if prior[0] != digest:
                    refuse(409, 'terminal_request_conflict')
                if not prior[1]:
                    refuse(409, 'terminal_input_uncertain')
                return
            if len(self.requests) >= 4096:
                refuse(429, 'terminal_limit')
            # Reserve before the first byte. A partial write or lost response
            # must not replay a command with side effects.
            self.requests[request_id] = (digest, False)
        now = time.monotonic()
        self.input_tokens = min(65_536, self.input_tokens + (now - self.input_at) * 65_536)
        self.input_at = now
        if len(encoded) > self.input_tokens:
            refuse(429, 'terminal_limit')
        self.input_tokens -= len(encoded)
        try:
            if os.write(self.master, encoded) != len(encoded):
                refuse(409, 'terminal_input_uncertain')
        except (BlockingIOError, OSError):
            refuse(409, 'terminal_input_uncertain')
        if request_id is not None:
            self.requests[request_id] = (digest, True)
        self.touch()

    def resize(self, cols, rows):
        self.authorize()
        if type(cols) is not int or type(rows) is not int or not 2 <= cols <= 512 or not 2 <= rows <= 256:
            refuse(400, 'terminal_invalid_request')
        if self.master is None or self.ended or self.closing:
            refuse(409, 'terminal_ended')
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def attach(self, grant):
        self.renew(grant)
        now = time.monotonic()
        while self.connections and self.connections[0] < now - 60:
            self.connections.popleft()
        if len(self.connections) >= 6:
            refuse(429, 'terminal_limit')
        self.connections.append(now)
        if self.detach_timer:
            self.detach_timer.cancel()
        self.detach_deadline = None
        if self.viewer:
            self.viewer.closed.set()
        viewer = self.viewer = Viewer()
        return viewer, list(self.history)

    def detach(self, viewer):
        viewer.closed.set()
        if self.viewer is not viewer:
            return
        self.viewer = None
        if not self.ended and not self.closing:
            self.detach_deadline = time.time() + DETACH_SECONDS
            self.detach_timer = asyncio.get_running_loop().call_later(DETACH_SECONDS, self.stop, 'terminal_detached')

    def stop(self, reason, exit_code=None):
        if reason != 'terminal_exited':
            self.readable = False
            self.history.clear()
            self.history_bytes = 0
            if self.viewer:
                self.viewer.closed.set()
        if not self.closing and not self.ended:
            self.closing = asyncio.create_task(self.finish(reason, exit_code))
        return self.closing

    async def finish(self, reason, exit_code):
        for timer in (self.lease_timer, self.idle_timer, self.detach_timer, self.hard_timer):
            if timer:
                timer.cancel()
        # This process is a Linux subreaper and owns exactly one PTY. Children
        # cannot escape cleanup with setsid/double-fork. No other task/worker
        # process is a descendant of this root gateway.
        await self.gateway.reap_shells()
        if self.master is not None:
            # Natural exit preserves the final output; revocation, expiration
            # and close discard pending bytes before their close ACK.
            while self.output():
                pass
            asyncio.get_running_loop().remove_reader(self.master)
            os.close(self.master)
            self.master = None
        tail = self.decoder.decode(b'', final=True) if self.can_read() else ''
        if tail:
            self.append(tail)
        self.ended, self.exit_code = True, exit_code
        # The ended frame is a close acknowledgement. Fence every pre-exit
        # ticket before the API may remove the persistent lease; otherwise a
        # late open could replay history after its membership was revoked.
        self.gateway.revoked[self.id] = time.time() + LEASE_SECONDS + 35
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None
        if self.viewer and self.can_read():
            self.viewer.push(event('ended', {'exitCode': exit_code}))
            self.viewer.push(None)
        self.retention_timer = asyncio.get_running_loop().call_later(DETACH_SECONDS, self.gateway.forget, self)


class Gateway:
    def __init__(self, key, control=CONTROL, account=None, *, cloudflare=False):
        self.boot = str(uuid.uuid4())
        self.tickets = Tickets(key, self.boot)
        self.revoked = {}
        self.control = control
        self.cloudflare = cloudflare
        self.account = account or pwd.getpwnam('node' if cloudflare else 'user')
        if cloudflare and (self.account.pw_uid, self.account.pw_gid) != (1000, 1000):
            raise RuntimeError('terminal_task_account_unavailable')
        if self.account.pw_uid == 0:
            raise RuntimeError('terminal_user_required')
        self.session = None
        self.connection_count = 0
        self.children_changed = asyncio.Event()
        # PR_SET_CHILD_SUBREAPER. It is local process containment, not a claim
        # that equal-UID code is isolated from another user process on this VM.
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
            raise RuntimeError('terminal_subreaper_unavailable')
        asyncio.get_running_loop().add_signal_handler(signal.SIGCHLD, self.reap)

    def reap(self):
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == 0:
                break
            if self.session and pid == self.session.pid:
                code = os.waitstatus_to_exitcode(status)
                self.session.stop('terminal_exited', code if code >= 0 else 128 - code)
        self.children_changed.set()

    def children(self):
        parents = {}
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
                parents[int(path.name)] = (int(fields[1]), fields[19])
            except (OSError, ValueError, IndexError):
                continue
        owned, pending = set(), [os.getpid()]
        while pending:
            parent = pending.pop()
            for pid, (ppid, _) in parents.items():
                if ppid == parent and pid not in owned:
                    owned.add(pid)
                    pending.append(pid)
        return {pid: parents[pid][1] for pid in owned}

    async def reap_shells(self):
        deadline = asyncio.get_running_loop().time() + 3
        while True:
            self.children_changed.clear()
            owned = self.children()
            if not owned:
                return
            for pid, born in owned.items():
                try:
                    # Pin each process when the kernel supports pidfds. The
                    # start tick check also fences reuse on older kernels.
                    descriptor = os.pidfd_open(pid)
                    try:
                        current = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
                        if current == born:
                            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                    finally:
                        os.close(descriptor)
                except (OSError, ProcessLookupError):
                    pass
            self.reap()
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                # Never release the execution fence with surviving writers.
                raise RuntimeError('terminal_cleanup_unconfirmed')
            try:
                await asyncio.wait_for(self.children_changed.wait(), remaining)
            except asyncio.TimeoutError:
                raise RuntimeError('terminal_cleanup_unconfirmed') from None

    def forget(self, session):
        if self.session is session and session.ended:
            session.history.clear()
            session.requests.clear()
            self.session = None

    def current(self, grant, create=False):
        if self.revoked.get(grant['sessionId'], 0) > time.time() or self.revoked.get('run:' + grant['runId'], 0) > time.time():
            refuse(409, 'terminal_binding_changed')
        session = self.session
        if session and session.ended and session.id != grant['sessionId']:
            self.forget(session)
            session = None
        if session and not session.matches(grant):
            refuse(423, 'terminal_already_controlled')
        if session is None:
            if not create:
                refuse(409, 'terminal_ended')
            session = self.session = Session(self, grant, self.account)
        session.authorize()
        if not session.ended:
            session.renew(grant)
        return session

    async def stream(self, reader, writer, grant):
        session = self.current(grant, create=True)
        viewer, history = session.attach(grant)
        await response_headers(writer, 200, {'Content-Type': 'text/event-stream; charset=utf-8',
            'X-Terminal-Session-Id': session.id, 'X-Accel-Buffering': 'no'})
        if not session.can_read():
            session.detach(viewer)
            return
        # The shipped hook becomes live on its first output frame.
        writer.write(event('output', {'text': ''}))
        writer.write(event('session', {'terminalSessionId': session.id, 'runId': grant['runId'],
            'ownerId': grant['ownerId'], 'rights': ['read', 'write', 'resize', 'close'],
            'machineStatus': 'running', 'expiresAt': grant['sessionExpiresAt']}))
        for _, frame in history:
            if not session.can_read():
                session.detach(viewer)
                return
            writer.write(frame)
        await writer.drain()
        disconnected = asyncio.create_task(reader.read(1))
        stopped = asyncio.create_task(viewer.closed.wait())
        try:
            if session.ended:
                writer.write(event('ended', {'exitCode': session.exit_code}))
                await writer.drain()
                return
            while True:
                next_frame = asyncio.create_task(viewer.queue.get())
                ready, _ = await asyncio.wait([next_frame, disconnected, stopped], return_when=asyncio.FIRST_COMPLETED)
                if next_frame not in ready or stopped in ready or not session.can_read():
                    next_frame.cancel()
                    break
                frame = next_frame.result()
                if frame is None:
                    break
                writer.write(frame)
                await asyncio.wait_for(writer.drain(), 10)
        finally:
            disconnected.cancel()
            stopped.cancel()
            session.detach(viewer)

    async def serve(self, reader, writer):
        streaming = False
        self.connection_count += 1
        try:
            if self.connection_count > 16:
                refuse(429, 'terminal_limit')
            method, path, headers, body = await request(reader)
            if method == 'GET' and path.startswith('/health?challenge=') and not body:
                # Version and boot nonce are not grants or task identifiers.
                # The app captures this nonce BEFORE its final DB fence.
                challenge = path[len('/health?challenge='):]
                if not UUID.fullmatch(challenge):
                    refuse(400, 'terminal_invalid_request')
                proof = hmac.new(self.tickets.key, f'health:v1:{challenge}:{self.boot}:{VERSION}'.encode(), hashlib.sha256).hexdigest()
                await respond(writer, 200, {'version': VERSION, 'boot': self.boot, 'proof': proof})
                return
            operations = {'/stream': ('GET', 'stream'), '/input': ('POST', 'input'), '/resize': ('POST', 'resize'),
                          '/close': ('POST', 'close'), '/revoke': ('POST', 'revoke'), '/inspect': ('GET', 'inspect')}
            if path not in operations or method != operations[path][0]:
                refuse(404, 'terminal_unsupported')
            operation = operations[path][1]
            grant = self.tickets.consume(headers.get('authorization'), operation, body)
            if operation == 'inspect':
                await respond(writer, 200, {'version': VERSION})
            elif operation == 'revoke':
                try:
                    value = json.loads(body)
                except (ValueError, UnicodeError):
                    refuse(400, 'terminal_invalid_request')
                ids = value.get('leaseIds') if isinstance(value, dict) else None
                if not isinstance(ids, list) or len(ids) > 64 or any(not isinstance(item, str) or not UUID.fullmatch(item) for item in ids):
                    refuse(400, 'terminal_invalid_request')
                now = time.time()
                self.revoked = {key: expiry for key, expiry in self.revoked.items() if expiry > now}
                if len(self.revoked) + len(ids) > 4096:
                    # Capacity exhaustion must never drop a live tombstone.
                    refuse(503, 'terminal_unavailable')
                for lease_id in ids:
                    self.revoked[lease_id] = now + LEASE_SECONDS + 35
                if not ids:
                    self.revoked['run:' + grant['runId']] = now + LEASE_SECONDS + 35
                session = self.session
                if session and (not ids or session.id in ids) and all(session.grant.get(key) == grant.get(key) for key in ('runId', 'ownerId', 'workspaceId')):
                    closing = session.stop('terminal_revoked')
                    if closing:
                        await closing
                await respond(writer, 204)
            elif operation == 'stream':
                # Admission errors still return an HTTP error; once headers
                # leave, failures end this stream and never append JSON.
                self.current(grant, create=True)
                streaming = True
                await self.stream(reader, writer, grant)
            else:
                session = self.current(grant)
                try:
                    value = json.loads(body)
                except (ValueError, UnicodeError):
                    refuse(400, 'terminal_invalid_request')
                if not isinstance(value, dict):
                    refuse(400, 'terminal_invalid_request')
                if operation == 'input':
                    if set(value) - {'data', 'requestId'}:
                        refuse(400, 'terminal_invalid_request')
                    session.input(value.get('data'), value.get('requestId'))
                elif operation == 'resize':
                    if set(value) != {'cols', 'rows'}:
                        refuse(400, 'terminal_invalid_request')
                    session.resize(value['cols'], value['rows'])
                else:
                    closing = session.stop('terminal_closed')
                    if closing:
                        await closing
                await respond(writer, 204)
        except Refusal as error:
            if not streaming:
                await respond(writer, error.status, {'error': error.code})
        except (OSError, asyncio.TimeoutError, asyncio.CancelledError, RuntimeError):
            if not streaming:
                try:
                    await respond(writer, 503, {'error': 'terminal_unavailable'})
                except OSError:
                    pass
        finally:
            self.connection_count -= 1
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass


async def request(reader):
    try:
        block = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)
        if len(block) > 16_384:
            refuse(431, 'terminal_invalid_request')
        lines = block.decode('ascii').split('\r\n')
        method, path, protocol = lines[0].split(' ')
        if protocol != 'HTTP/1.1':
            refuse(400, 'terminal_invalid_request')
        headers = {}
        for line in lines[1:]:
            if not line:
                continue
            name, value = line.split(':', 1)
            name = name.lower()
            if name in headers:
                refuse(400, 'terminal_invalid_request')
            headers[name] = value.strip()
        if 'transfer-encoding' in headers:
            refuse(400, 'terminal_invalid_request')
        length = int(headers.get('content-length', '0'))
        if length < 0 or length > MAX_BODY:
            refuse(413, 'terminal_input_too_large')
        body = await asyncio.wait_for(reader.readexactly(length), 10)
        return method, path, headers, body
    except (ValueError, UnicodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        refuse(400, 'terminal_invalid_request')


async def response_headers(writer, status, headers):
    values = {'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Connection': 'close', **headers}
    writer.write((f'HTTP/1.1 {status} {http.HTTPStatus(status).phrase}\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in values.items()) + '\r\n').encode())
    await writer.drain()


async def respond(writer, status, value=None):
    body = b'' if value is None else json.dumps(value, separators=(',', ':')).encode()
    await response_headers(writer, status, {'Content-Type': 'application/json', 'Content-Length': str(len(body))})
    writer.write(body)
    await writer.drain()


async def main(*, cloudflare=False):
    if os.geteuid() != 0:
        raise RuntimeError('terminal_root_required')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    info = ROOT.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError('terminal_root_required')
    service = os.open(ROOT / 'service.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(service, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # The app derives a VM-specific key from its configured auth secret and
    # installs it over E2B's root channel. It is never given to the shell.
    fd = os.open(ROOT / 'key', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode):
            raise RuntimeError('terminal_key_unavailable')
        key = os.read(fd, 33)
        if len(key) != 32:
            raise RuntimeError('terminal_key_unavailable')
    finally:
        os.close(fd)
    gateway = Gateway(key, cloudflare=cloudflare)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, 0x4D4B5056)
    listener.bind(('0.0.0.0', PORT))
    listener.listen(128)
    server = await asyncio.start_server(gateway.serve, sock=listener, limit=16_384)
    print('terminal-ready', flush=True)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    try:
        if sys.argv[1:] not in ([], ['--cloudflare-task']):
            raise RuntimeError('terminal_gateway_unavailable')
        asyncio.run(main(cloudflare=bool(sys.argv[1:])))
    except (KeyboardInterrupt, SystemExit):
        pass
    except BaseException:
        raise SystemExit('terminal_gateway_unavailable') from None
