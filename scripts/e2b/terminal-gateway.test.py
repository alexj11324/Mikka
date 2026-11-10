#!/usr/bin/env python3
"""Real Linux PTY/API acceptance. No browser, E2B key, or model provider."""
import asyncio
import base64
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
import pwd
import signal
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


ROOT = Path(__file__).resolve().parents[2]
gateway = module('terminal_gateway', ROOT / 'scripts/e2b/terminal-gateway.py')
installer = module('terminal_control_install', ROOT / 'packages/daemon/scripts/workspace-control-install.py')


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


def ticket(key, grant):
    value = encode(json.dumps(grant, separators=(',', ':')).encode())
    return 'Bearer ' + value + '.' + encode(hmac.new(key, value.encode(), hashlib.sha256).digest())


def scope(boot='fixture-boot'):
    return {name: str(uuid.uuid4()) for name in ('runId', 'sessionId', 'deviceId', 'workspaceId', 'repoId', 'taskId', 'nonce')} | {
        'version': 1, 'operation': 'stream', 'boot': boot, 'ownerId': 'fixture-owner', 'machineEpoch': 2,
        'bindingId': 'b' * 64, 'credentialId': 'session:fixture', 'worktreePath': '/tmp/fixture',
        'expiresAt': int(time.time() * 1000) + 30_000, 'sessionExpiresAt': int(time.time() * 1000) + 300_000,
        'bodyDigest': hashlib.sha256(b'').hexdigest(),
    }


class TicketTests(unittest.TestCase):
    def test_one_use_expiry_boot_and_body_binding(self):
        key = b'isolated-unit-fixture-key-32-byte!'
        grant = scope()
        tickets = gateway.Tickets(key, grant['boot'])
        self.assertEqual(tickets.consume(ticket(key, grant), 'stream', b'')['runId'], grant['runId'])
        with self.assertRaises(gateway.Refusal) as replay:
            tickets.consume(ticket(key, grant), 'stream', b'')
        self.assertEqual(replay.exception.code, 'terminal_ticket_replayed')
        for changed in ({'expiresAt': 0}, {'boot': 'another-boot'}, {'bodyDigest': '0' * 64}, {'runId': 42}, {'operation': 'input'}):
            invalid = grant | changed | {'nonce': str(uuid.uuid4())}
            with self.subTest(changed=changed), self.assertRaises(gateway.Refusal):
                tickets.consume(ticket(key, invalid), 'stream', b'')
        with self.assertRaises(gateway.Refusal):
            tickets.consume(ticket(b'wrong-fixture-key', grant), 'stream', b'')


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc').exists(), 'requires isolated Linux root for a user PTY')
class PtyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mikka-terminal-')
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o755)
        self.account = pwd.getpwnam('nobody')
        self.control = self.root / 'control'
        installer.install(self.control, self.account)
        self.worktree = self.root / 'worktree'
        self.worktree.mkdir(mode=0o755)
        subprocess.run(['git', 'init', '-q', str(self.worktree)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (self.worktree / 'fixture.sh').write_text('test "$(printf check)" = check && printf "__TEST_PASSED__\\n"\n')
        for path in [self.worktree, *self.worktree.rglob('*')]:
            os.chown(path, self.account.pw_uid, self.account.pw_gid)
        self.key = b'real-pty-private-fixture-key-32!!'
        self.gateway = gateway.Gateway(self.key, self.control, self.account)
        self.grant = scope(self.gateway.boot) | {'worktreePath': str(self.worktree)}
        self.idle_receipt()
        self.server = await asyncio.start_server(self.gateway.serve, '127.0.0.1', 0, limit=16_384)
        self.port = self.server.sockets[0].getsockname()[1]

    def idle_receipt(self):
        (self.control / 'machine.json').write_text(json.dumps({'version': 1, 'runId': self.grant['runId'],
            'deviceId': self.grant['deviceId'], 'worktreePath': str(self.worktree), 'phase': 'idle', 'nativeExited': True}))

    async def asyncTearDown(self):
        if self.gateway.session:
            closing = self.gateway.session.stop('fixture_cleanup')
            if closing:
                await asyncio.wait_for(closing, 5)
            self.gateway.session.retention_timer.cancel()
        self.server.close()
        await self.server.wait_closed()
        asyncio.get_running_loop().remove_signal_handler(signal.SIGCHLD)
        self.temporary.cleanup()

    async def call(self, operation, value=None, grant=None):
        body = b'' if value is None else json.dumps(value, separators=(',', ':')).encode()
        claims = (grant or self.grant) | {'operation': operation, 'nonce': str(uuid.uuid4()), 'bodyDigest': hashlib.sha256(body).hexdigest()}
        reader, writer = await asyncio.open_connection('127.0.0.1', self.port)
        method = 'GET' if operation in ('stream', 'inspect') else 'POST'
        writer.write((f'{method} /{operation} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: {ticket(self.key, claims)}\r\nContent-Length: {len(body)}\r\n\r\n').encode() + body)
        await writer.drain()
        headers = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 3)
        status = int(headers.split(b' ')[1])
        if operation == 'stream' and status == 200:
            return status, reader, writer
        data = await asyncio.wait_for(reader.read(), 3)
        writer.close()
        await writer.wait_closed()
        return status, json.loads(data) if data else None

    async def until(self, reader, needle):
        text = ''
        while needle not in text:
            block = await asyncio.wait_for(reader.readuntil(b'\n\n'), 5)
            lines = block.decode().splitlines()
            kind = next((line[7:] for line in lines if line.startswith('event: ')), '')
            payload = json.loads(next(line[6:] for line in lines if line.startswith('data: ')))
            if kind == 'output':
                text += payload['text']
            elif kind == 'ended':
                self.fail('PTY ended before expected output')
        return text

    async def ready(self):
        status, reader, writer = await self.call('stream')
        self.assertEqual(status, 200)
        self.assertEqual((await self.call('input', {'data': "stty -echo; PS1=''; printf '\\n__READY__\\n'\n"}))[0], 204)
        await self.until(reader, '\r\n__READY__\r\n')
        return reader, writer

    async def test_real_pwd_git_test_resize_ctrl_c_exit_and_reconnect(self):
        reader, writer = await self.ready()
        self.assertEqual((await self.call('input', {'data': "pwd; git -c color.status=false status --short; bash fixture.sh; printf '__DONE__\\n'\n"}))[0], 204)
        output = await self.until(reader, '__DONE__\r\n')
        self.assertIn(str(self.worktree), output)
        self.assertIn('?? fixture.sh', output)
        self.assertIn('__TEST_PASSED__', output)
        self.assertEqual((await self.call('resize', {'cols': 111, 'rows': 37}))[0], 204)
        await self.call('input', {'data': "stty size; printf '__SIZE__\\n'\n"})
        self.assertIn('37 111', await self.until(reader, '__SIZE__\r\n'))
        await self.call('input', {'data': "printf '__SLEEP__\\n'; sleep 60\n"})
        await self.until(reader, '__SLEEP__\r\n')
        await self.call('input', {'data': '\x03'})
        await self.call('input', {'data': "printf '__INTERRUPTED__\\n'\n"})
        await self.until(reader, '__INTERRUPTED__\r\n')
        original = self.gateway.session.id
        writer.close()
        await writer.wait_closed()
        status, reader, writer = await self.call('stream')
        self.assertEqual(status, 200)
        self.assertEqual(self.gateway.session.id, original)
        await self.until(reader, '__INTERRUPTED__\r\n')
        await self.call('input', {'data': 'exit 7\n'})
        ended = None
        while ended is None:
            block = await asyncio.wait_for(reader.readuntil(b'\n\n'), 5)
            if b'event: ended\n' in block:
                ended = json.loads(block.decode().split('data: ', 1)[1])
        self.assertEqual(ended['exitCode'], 7)
        self.assertEqual(self.gateway.children(), {})
        writer.close()
        await writer.wait_closed()

    async def test_owner_binding_oversize_replay_and_no_input_create(self):
        self.assertEqual((await self.call('input', {'data': 'echo forbidden\n'}))[0], 409)
        self.assertIsNone(self.gateway.session)
        reader, writer = await self.ready()
        for field in ('runId', 'deviceId', 'repoId', 'workspaceId', 'ownerId', 'credentialId', 'bindingId'):
            foreign = self.grant | {field: str(uuid.uuid4())}
            self.assertEqual((await self.call('input', {'data': 'echo forbidden\n'}, foreign))[0], 423, field)
        self.assertEqual((await self.call('input', {'data': 'x' * 16_385}))[0], 413)
        request_id = str(uuid.uuid4())
        command = {'data': "printf '__ONCE__\\n'\n", 'requestId': request_id}
        self.assertEqual((await self.call('input', command))[0], 204)
        self.assertEqual((await self.call('input', command))[0], 204)
        self.assertEqual((await self.call('input', command | {'data': 'false\n'}))[0], 409)
        output = await self.until(reader, '__ONCE__\r\n')
        self.assertEqual(output.count('__ONCE__'), 1)
        writer.close()
        await writer.wait_closed()

    async def test_flock_active_receipt_and_fixed_inode(self):
        lock = os.open(self.control / 'machine.lock', os.O_RDWR)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertEqual((await self.call('stream'))[0], 423)
        os.close(lock)
        receipt = json.loads((self.control / 'machine.json').read_text())
        (self.control / 'machine.json').write_text(json.dumps(receipt | {'phase': 'active', 'nativeExited': False}))
        self.assertEqual((await self.call('stream'))[0], 423)
        self.assertIsNone(self.gateway.session)
        self.idle_receipt()
        self.assertEqual((self.control.stat().st_mode & 0o022), 0)
        replacement = self.control / 'replacement'
        (self.control / 'machine.lock').rename(replacement)
        (self.control / 'machine.lock').symlink_to(replacement)
        self.assertNotEqual((await self.call('stream'))[0], 200)

    async def test_revoke_closes_process_tree_and_blocks_late_open(self):
        reader, writer = await self.ready()
        await self.call('input', {'data': "setsid sh -c 'sleep 60' >/dev/null 2>&1 & printf '__BACKGROUND__\\n'\n"})
        await self.until(reader, '__BACKGROUND__\r\n')
        self.assertEqual((await self.call('revoke', {'leaseIds': [self.grant['sessionId']]}))[0], 204)
        self.assertEqual(self.gateway.children(), {})
        self.assertEqual((await self.call('stream'))[0], 409)
        writer.close()
        await writer.wait_closed()

    async def test_idle_deadline_closes_real_pty_without_another_request(self):
        with patch.object(gateway, 'IDLE_SECONDS', 0.3):
            reader, writer = await self.ready()
            await asyncio.wait_for(reader.read(), 5)
            await self.gateway.session.closing
        self.assertEqual(self.gateway.children(), {})
        self.assertIsNone(self.gateway.session.lock)
        writer.close()
        await writer.wait_closed()

    async def test_disconnect_grace_closes_real_pty_and_releases_execution_fence(self):
        with patch.object(gateway, 'DETACH_SECONDS', 0.3):
            reader, writer = await self.ready()
            session = self.gateway.session
            self.gateway.children_changed.clear()
            writer.close()
            await writer.wait_closed()
            await asyncio.wait_for(self.gateway.children_changed.wait(), 5)
            await session.closing
        self.assertEqual(self.gateway.children(), {})
        self.assertIsNone(session.lock)

    async def test_paused_wall_clock_expiry_blocks_input_and_queued_output_before_timers(self):
        reader, writer = await self.ready()
        session = self.gateway.session
        with patch.object(gateway.time, 'time', return_value=time.time() + 600):
            session.viewer.push(gateway.event('output', {'text': '__QUEUED_AFTER_EXPIRY__'}))
            with self.assertRaises(gateway.Refusal):
                session.input("printf '__LATE_INPUT__\\n'\n")
            session.append('__AFTER_EXPIRY__')
            remaining = await asyncio.wait_for(reader.read(), 5)
            await session.closing
        self.assertNotIn(b'__QUEUED_AFTER_EXPIRY__', remaining)
        self.assertNotIn(b'__AFTER_EXPIRY__', remaining)
        self.assertNotIn(b'__LATE_INPUT__', remaining)
        self.assertEqual(self.gateway.children(), {})
        writer.close()
        await writer.wait_closed()

    async def test_unrelated_lease_revoke_preserves_terminal_and_actual_close_discards_queued_bytes(self):
        reader, writer = await self.ready()
        self.assertEqual((await self.call('revoke', {'leaseIds': [str(uuid.uuid4())]}))[0], 204)
        self.assertEqual((await self.call('input', {'data': "printf '__STILL_OPEN__\\n'\n"}))[0], 204)
        await self.until(reader, '__STILL_OPEN__\r\n')
        session = self.gateway.session
        session.viewer.push(gateway.event('output', {'text': '__PRIVATE_PENDING__'}))
        await session.stop('terminal_revoked')
        self.assertNotIn(b'__PRIVATE_PENDING__', await asyncio.wait_for(reader.read(), 5))
        self.assertEqual((await self.call('stream'))[0], 409)
        writer.close()
        await writer.wait_closed()

    async def test_real_output_scrollback_is_bounded_without_logging_or_replaying_input(self):
        reader, writer = await self.ready()
        command = "python3 -c \"import time; [(print('x'*8192,flush=True),time.sleep(.1)) for _ in range(40)]\"; printf '__SCROLLBACK_DONE__\\n'\n"
        self.assertEqual((await self.call('input', {'data': command}))[0], 204)
        output = await self.until(reader, '__SCROLLBACK_DONE__\r\n')
        self.assertGreater(len(output), gateway.SCROLLBACK)
        self.assertLessEqual(self.gateway.session.history_bytes, gateway.SCROLLBACK)
        self.assertGreater(self.gateway.session.history[0][0], 1)
        writer.close()
        await writer.wait_closed()
        status, reader, writer = await self.call('stream')
        self.assertEqual(status, 200)
        replay = await self.until(reader, '__SCROLLBACK_DONE__\r\n')
        self.assertLess(len(replay), len(output))
        writer.close()
        await writer.wait_closed()


if __name__ == '__main__':
    if (os.environ.get('CI') or os.environ.get('REQUIRE_REAL_PTY') == '1' or os.environ.get('MIKKA_REQUIRE_REAL_PTY') == '1') and (os.geteuid() != 0 or not Path('/proc').exists()):
        raise SystemExit('real_terminal_pty_requires_isolated_linux_root')
    unittest.main(verbosity=2)
