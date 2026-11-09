#!/usr/bin/env python3
"""Real-kernel ingress regression. Run only in a disposable privileged Linux CI job.

This script creates and removes its own network namespaces and veth pair. It does
not alter the host ruleset. Policy and the strict readback verifier come from the
supplied workspace-ingress.py. No credentials or external network are needed.

Exit 0: all required cases passed; 1: a behavioral assertion failed;
exit 2: prerequisite, harness, policy-installation, or verification error.

--mark-provider-listener is a mechanism control only: it sets SO_MARK on the root
fixture socket before listen(). It is NOT an implementation or proof of the
proposed cross-process pidfd_getfd preparation/race handling.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import socket
import struct
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
PROVIDER_PORT = 49983
DEV_PORT = 3000
SOCKET_MARK = 0x4D4B5056
PAYLOAD_SIZE = 8192
SCRIPT = str(Path(__file__).resolve())


class HarnessError(RuntimeError):
    pass


def run(argv, input_text=None):
    result = subprocess.run(argv, input=input_text, text=True, capture_output=True, timeout=10)
    if result.returncode:
        raise HarnessError(f'{argv[0]} failed ({result.returncode}): {result.stderr[-1200:]}')
    return result.stdout


def load_guard(path):
    spec = importlib.util.spec_from_file_location('mikka_guard_under_test', path)
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    return guard


def emit(value):
    print(json.dumps(value, sort_keys=True), flush=True)


def worker(role, address, port, uid, marked):
    # Drop privileges before socket creation for every non-root fixture.
    if uid:
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
    family = socket.AF_INET6 if ':' in address else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    conn = None
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.settimeout(3)
    if family == socket.AF_INET6:
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    if role == 'server':
        if marked:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, SOCKET_MARK)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 32768)
        sock.bind((address, port))
        sock.listen(128)
    else:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.bind((address, 40000))
    emit({'ok': True, 'ready': role, 'uid': os.geteuid()})
    try:
        for line in sys.stdin:
            req = json.loads(line)
            op = req['op']
            try:
                if op == 'connect':
                    sock.connect((req['address'], req['port']))
                    conn = sock
                    result = {'connected': True}
                elif op == 'accept':
                    conn, _ = sock.accept()
                    conn.settimeout(3)
                    result = {'accepted': True}
                elif op == 'send':
                    conn.sendall(b'x' * req['size'])
                    result = {'sent': req['size']}
                elif op == 'recv':
                    total = 0
                    while total < req['size']:
                        chunk = conn.recv(req['size'] - total)
                        if not chunk:
                            break
                        total += len(chunk)
                    result = {'received': total}
                elif op == 'info':
                    info = conn.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 256)
                    if len(info) < 128:
                        raise RuntimeError('TCP_INFO lacks bytes_acked field')
                    result = {
                        'state': info[0],
                        'unacked': struct.unpack_from('=I', info, 24)[0],
                        'bytes_acked': struct.unpack_from('=Q', info, 120)[0],
                    }
                elif op == 'stop':
                    emit({'ok': True, 'stopped': True})
                    return
                else:
                    raise RuntimeError('unknown worker operation')
                emit({'ok': True, **result})
            except Exception as exc:
                emit({'ok': False, 'error': type(exc).__name__,
                      'errno': getattr(exc, 'errno', None)})
    finally:
        if conn is not None and conn is not sock:
            conn.close()
        sock.close()


class Worker:
    def __init__(self, namespace, role, address, port, uid=0, marked=False):
        argv = ['ip', 'netns', 'exec', namespace, sys.executable, SCRIPT, '--worker', role,
                '--address', address, '--port', str(port), '--uid', str(uid)]
        if marked:
            argv += ['--mark-provider-listener']
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)
        self.read()

    def read(self):
        if not select.select([self.proc.stdout], [], [], 5)[0]:
            raise HarnessError('worker response deadline')
        line = self.proc.stdout.readline()
        if not line:
            detail = self.proc.stderr.read(1200)
            raise HarnessError('worker exited: ' + detail)
        return json.loads(line)

    def rpc(self, op, **kwargs):
        self.proc.stdin.write(json.dumps({'op': op, **kwargs}) + '\n')
        self.proc.stdin.flush()
        return self.read()

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=2)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            stream.close()


class Fixture:
    def __init__(self, guard_path, ipv6, marked):
        suffix = uuid.uuid4().hex[:8]
        self.server_ns, self.client_ns = 'mks-' + suffix, 'mkc-' + suffix
        self.server_if, self.client_if = 'mks' + suffix, 'mkc' + suffix
        self.namespaces = []
        self.workers = []
        self.guard_path, self.ipv6, self.marked = guard_path, ipv6, marked
        self.server_address = 'fd17:82::1' if ipv6 else '10.178.2.1'
        self.client_address = 'fd17:82::2' if ipv6 else '10.178.2.2'

    def __enter__(self):
        try:
            for namespace in (self.server_ns, self.client_ns):
                run(['ip', 'netns', 'add', namespace])
                self.namespaces.append(namespace)
            run(['ip', 'link', 'add', self.server_if, 'type', 'veth',
                 'peer', 'name', self.client_if])
            for namespace, interface, address in (
                    (self.server_ns, self.server_if, self.server_address),
                    (self.client_ns, self.client_if, self.client_address)):
                run(['ip', 'link', 'set', interface, 'netns', namespace])
                run(['ip', '-n', namespace, 'link', 'set', 'lo', 'up'])
                args = ['ip', '-n', namespace, 'addr', 'add',
                        address + ('/64' if self.ipv6 else '/24'), 'dev', interface]
                if self.ipv6:
                    args.append('nodad')
                run(args)
                run(['ip', '-n', namespace, 'link', 'set', interface, 'up'])
            self.provider = self.server(PROVIDER_PORT, marked=self.marked)
            guard = load_guard(self.guard_path)
            run(['ip', 'netns', 'exec', self.server_ns, 'nft', '-f', '-'],
                guard.policy([PROVIDER_PORT]))
            run(['ip', 'netns', 'exec', self.server_ns, sys.executable, SCRIPT,
                 '--verify-guard', self.guard_path])
            self.install_observers()
            return self
        except BaseException:
            self.close()
            raise

    def install_observers(self):
        # These accept-policy observer chains never change the guard's verdict.
        lines = ['add table inet mikka_test_observe']
        for chain, priority in [('before', -2), ('after', 1)]:
            lines.append(f'add chain inet mikka_test_observe {chain} '
                         f'{{ type filter hook output priority {priority}; policy accept; }}')
            prefix = f'add rule inet mikka_test_observe {chain} oifname != "lo" meta l4proto tcp tcp sport {PROVIDER_PORT}'
            for kind, condition in [('root', ' meta skuid 0'),
                                    ('nonroot', ' meta skuid != 0'), ('all', '')]:
                lines.append(prefix + condition + f' counter comment "{chain}_{kind}"')
        run(['ip', 'netns', 'exec', self.server_ns, 'nft', '-f', '-'], '\n'.join(lines) + '\n')

    def observe(self):
        raw = run(['ip', 'netns', 'exec', self.server_ns, 'nft', '-j', '-n',
                   'list', 'table', 'inet', 'mikka_test_observe'])
        counts = {}
        for row in json.loads(raw)['nftables']:
            rule = row.get('rule', {})
            comment = rule.get('comment')
            if comment:
                for expr in rule['expr']:
                    if 'counter' in expr:
                        counts[comment] = expr['counter']['packets']
        for stage in ('before', 'after'):
            counts[stage + '_without_uid'] = (counts[stage + '_all'] - counts[stage + '_root']
                                              - counts[stage + '_nonroot'])
        return counts

    def server(self, port, uid=0, marked=False):
        value = Worker(self.server_ns, 'server', self.server_address, port, uid, marked)
        self.workers.append(value)
        return value

    def client(self):
        value = Worker(self.client_ns, 'client', self.client_address, 0)
        self.workers.append(value)
        return value

    def close(self):
        for value in reversed(self.workers):
            value.close()
        for namespace in reversed(self.namespaces):
            subprocess.run(['ip', 'netns', 'del', namespace], capture_output=True, timeout=5)
        # A partially initialized peer can remain in the initial namespace.
        for interface in (self.server_if, self.client_if):
            subprocess.run(['ip', 'link', 'del', interface], capture_output=True, timeout=5)

    def __exit__(self, *_):
        self.close()


def require(result, key):
    if not result.get('ok') or not result.get(key):
        raise AssertionError(f'{key}: {result}')


def provider_before_accept(fixture, evidence):
    client = fixture.client()
    require(client.rpc('connect', address=fixture.server_address, port=PROVIDER_PORT), 'connected')
    evidence['syn_ack_received'] = True
    require(client.rpc('send', size=PAYLOAD_SIZE), 'sent')
    # No accept() occurs until TCP has acknowledged the complete synthetic data.
    # This deterministically exercises a child socket with no user-space file.
    deadline = time.monotonic() + 2
    acknowledged = False
    while time.monotonic() < deadline:
        info = client.rpc('info')
        evidence['client_tcp_info'] = info
        if not info.get('ok') or info.get('state') != 1:
            break
        if info['unacked'] == 0 and info['bytes_acked'] >= PAYLOAD_SIZE + 1:
            acknowledged = True
            break
        time.sleep(0.02)
    evidence['accept_called_before_ack'] = False
    evidence['observed'] = fixture.observe()
    assert acknowledged, 'provider_data_not_acknowledged_before_accept'
    assert evidence['observed']['before_without_uid'] > 0, 'fixture_did_not_observe_ownerless_reply'
    assert evidence['observed']['after_without_uid'] > 0, 'ownerless_reply_did_not_pass_guard'
    require(fixture.provider.rpc('accept'), 'accepted')
    received = fixture.provider.rpc('recv', size=PAYLOAD_SIZE)
    assert received.get('received') == PAYLOAD_SIZE, received
    require(fixture.provider.rpc('send', size=12), 'sent')
    response = client.rpc('recv', size=12)
    assert response.get('received') == 12, response
    evidence['application_roundtrip'] = True


def forbidden_listener(fixture, evidence, provider_port, uid):
    port = PROVIDER_PORT if provider_port else DEV_PORT
    if provider_port:
        fixture.provider.close()
    fixture.server(port, uid=uid)
    result = fixture.client().rpc('connect', address=fixture.server_address, port=port)
    evidence['connect_result'] = result
    assert not result.get('connected'), 'forbidden_listener_completed_handshake'
    evidence['application_connection_denied'] = True


def main(args):
    required = ('ip', 'nft')
    missing = [name for name in required if shutil.which(name) is None]
    cap_line = next(line for line in Path('/proc/self/status').read_text().splitlines()
                    if line.startswith('CapEff:'))
    cap_net_admin = bool(int(cap_line.split()[1], 16) & (1 << 12))
    if os.geteuid() != 0 or missing or not cap_net_admin:
        emit({'ok': False, 'kind': 'prerequisite', 'required': ['root', 'CAP_NET_ADMIN', *required],
              'missing_tools': missing, 'cap_net_admin': cap_net_admin})
        return 2
    rows = []
    infrastructure_error = False
    families = [False, True] if args.family == 'both' else [args.family == 'ipv6']
    for ipv6 in families:
        for name, operation in (
                ('root_provider_preaccept_ack', provider_before_accept),
                ('nonroot_rebound_provider_denied', lambda f, e: forbidden_listener(f, e, True, 1000)),
                ('nonroot_dev_listener_denied', lambda f, e: forbidden_listener(f, e, False, 1000)),
                ('root_dev_listener_denied', lambda f, e: forbidden_listener(f, e, False, 0))):
            row = {'case': name, 'family': 'ipv6' if ipv6 else 'ipv4', 'evidence': {}}
            try:
                with Fixture(str(Path(args.guard).resolve()), ipv6, args.mark_provider_listener) as fixture:
                    operation(fixture, row['evidence'])
                row['passed'] = True
            except AssertionError as exc:
                row.update(passed=False, kind='assertion', error=str(exc))
            except Exception as exc:
                infrastructure_error = True
                row.update(passed=False, kind='harness_or_policy', error=str(exc)[:1600])
            rows.append(row)
    passed = all(row['passed'] for row in rows)
    emit({'ok': passed, 'guard': str(Path(args.guard).resolve()),
          'listener_mark_mechanism_control': args.mark_provider_listener,
          'kernel': os.uname().release, 'cases': rows})
    return 2 if infrastructure_error else (0 if passed else 1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--guard')
    parser.add_argument('--family', choices=['ipv4', 'ipv6', 'both'], default='both')
    parser.add_argument('--mark-provider-listener', action='store_true')
    parser.add_argument('--worker', choices=['server', 'client'])
    parser.add_argument('--address')
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--uid', type=int, default=0)
    parser.add_argument('--verify-guard')
    args = parser.parse_args()
    if args.worker:
        worker(args.worker, args.address, args.port, args.uid, args.mark_provider_listener)
    elif args.verify_guard:
        guard = load_guard(args.verify_guard)
        ports = guard.provider_ports()
        if ports != [PROVIDER_PORT]:
            raise RuntimeError('fixture provider discovery mismatch')
        guard.check_rules(shutil.which('nft'), ports)
    else:
        if not args.guard:
            parser.error('--guard is required')
        raise SystemExit(main(args))
