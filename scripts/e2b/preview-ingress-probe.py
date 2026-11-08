"""Disposable, synthetic socket-mark probe. Never run in an existing task VM.

Only the explicitly created fixture ports enter its temporary INPUT chain.
E2B envd, provider MCP, viewers and unrelated traffic are untouched. Commands
arrive over the root process's SDK stdin; no public control endpoint is added.
"""
import http.server
import json
import os
from pathlib import Path
import pwd
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import threading

MARKER = b'mikka-synthetic-socket-mark-probe-v1'
MARK = 0x4D4B5056
TOOL_PATH = '/opt/mikka/runtime/netfilter/sbin:/opt/mikka/runtime/netfilter/bin:/opt/mikka/runtime/iptables/sbin:/opt/mikka/runtime/iptables/bin:/usr/sbin:/sbin:/usr/bin:/bin'


class Refused(Exception):
    pass


def emit(**value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def capabilities():
    text = Path('/proc/self/status').read_text()
    effective = int(re.search(r'^CapEff:\s*([0-9a-f]+)', text, re.M).group(1), 16)
    return {'netAdmin': bool(effective & (1 << 12)), 'netRaw': bool(effective & (1 << 13))}


def tools():
    result = {}
    for name in ('iptables', 'ip6tables'):
        path = shutil.which(name, path=TOOL_PATH)
        receipt = {'present': path is not None, 'source': 'private' if path and path.startswith('/opt/mikka/') else 'system', 'version': None}
        if path:
            response = subprocess.run([path, '--version'], capture_output=True, timeout=5, check=False)
            version = re.search(rb'v([0-9]+\.[0-9]+\.[0-9]+)', response.stdout)
            receipt['version'] = version.group(1).decode() if version else None
        result[name] = receipt
    return result


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(MARKER)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(MARKER)


def serve(host, port=0, marked=False):
    class Server(http.server.ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ':' in host else socket.AF_INET
        daemon_threads = True
        allow_reuse_address = True
    server = Server((host, port), Handler, bind_and_activate=False)
    if marked:
        server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, MARK)
    if server.address_family == socket.AF_INET6:
        server.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    server.server_bind()
    server.server_activate()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def as_user(port=None):
    if os.geteuid() == 0:
        raise Refused('user_identity_invalid')
    marker_allowed = False
    with socket.socket() as testing:
        try:
            testing.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, MARK)
            marker_allowed = True
        except PermissionError:
            pass
    sudo = shutil.which('sudo', path='/usr/bin:/bin')
    sudo_root = bool(sudo and subprocess.run([sudo, '-n', 'true'], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False).returncode == 0)
    servers = {'replacement': serve('0.0.0.0', port)} if port else {
        'userLoopback4': serve('127.0.0.1'), 'userPublic4': serve('0.0.0.0')}
    if not port:
        try:
            servers['userLoopback6'] = serve('::1')
        except OSError:
            pass
    emit(phase='user_ready', ports={name: server.server_address[1] for name, server in servers.items()},
         capabilities=capabilities(), canSetSocketMark=marker_allowed, sudoNonInteractiveRoot=sudo_root)
    signal.pause()


def user_process(port=None):
    user = pwd.getpwnam('user')
    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'user', *([str(port)] if port else [])],
        user=user.pw_uid, group=user.pw_gid, extra_groups=[], cwd=user.pw_dir,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/bin:/bin', 'HOME': user.pw_dir, 'PYTHONDONTWRITEBYTECODE': '1'})
    if not select.select([process.stdout], [], [], 15)[0]:
        process.kill(); process.wait()
        raise Refused('user_fixture_start_timeout')
    try:
        value = json.loads(process.stdout.readline(8192))
        if value.get('phase') != 'user_ready':
            raise Refused('user_fixture_invalid')
        return process, value
    except BaseException:
        process.kill(); process.wait()
        raise


class Policy:
    def __init__(self, ports):
        self.chain = 'MKPV_' + os.urandom(5).hex()
        self.ports = ','.join(str(port) for port in sorted(set(ports)))
        self.created = []
        self.linked = []

    def command(self, program, arguments):
        return subprocess.run([program, '--wait', '5', *arguments], stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=7, check=False).returncode

    def install(self):
        proof = {}
        for family, name in (('ipv4', 'iptables'), ('ipv6', 'ip6tables')):
            program = shutil.which(name, path=TOOL_PATH)
            if not program:
                raise Refused('tool_missing_' + family)
            if self.command(program, ['--new-chain', self.chain]):
                raise Refused('chain_unavailable_' + family)
            self.created.append(program)
            marked = ['-p', 'tcp', '-m', 'socket', '--nowildcard', '--restore-skmark', '-m', 'mark', '--mark', str(MARK), '-j', 'ACCEPT']
            if self.command(program, ['--append', self.chain, *marked]):
                raise Refused('socket_match_unavailable_' + family)
            if self.command(program, ['--append', self.chain, '-p', 'tcp', '-j', 'REJECT', '--reject-with', 'tcp-reset']):
                raise Refused('reject_unavailable_' + family)
            jump = ['!', '-i', 'lo', '-p', 'tcp', '-m', 'multiport', '--dports', self.ports, '-j', self.chain]
            if self.command(program, ['--insert', 'INPUT', '1', *jump]):
                raise Refused('input_unavailable_' + family)
            self.linked.append((program, jump))
            if self.command(program, ['--check', 'INPUT', *jump]) or self.command(program, ['--check', self.chain, *marked]):
                raise Refused('rule_unverified_' + family)
            proof[family] = True
        return proof

    def close(self):
        okay = True
        for program, jump in reversed(self.linked):
            okay = self.command(program, ['--delete', 'INPUT', *jump]) == 0 and okay
        for program in reversed(self.created):
            okay = self.command(program, ['--flush', self.chain]) == 0 and okay
            okay = self.command(program, ['--delete-chain', self.chain]) == 0 and okay
        self.linked.clear(); self.created.clear()
        return okay


def root_probe():
    if os.geteuid() != 0:
        raise Refused('root_required')
    diagnostic = {'capabilities': capabilities(), 'tools': tools()}
    children = []
    marked = policy = None
    try:
        try:
            marked = serve('0.0.0.0', marked=True)
        except OSError as cause:
            raise Refused('socket_mark_unavailable') from cause
        child, user = user_process()
        children.append(child)
        ports = {**user['ports'], 'rootMarked': marked.server_address[1]}
        if len(set(ports.values())) != len(ports) or any(type(port) is not int or not 1024 < port < 65536 for port in ports.values()):
            raise Refused('ports_invalid')
        policy = Policy(ports.values())
        emit(phase='ready', ports=ports, user={key: user[key] for key in ('capabilities', 'canSetSocketMark', 'sudoNonInteractiveRoot')}, **diagnostic)
        for line in sys.stdin:
            operation = line.strip()
            if operation == 'protect':
                emit(phase='protected', rules=policy.install())
            elif operation == 'replace':
                port = marked.server_address[1]
                marked.shutdown(); marked.server_close(); marked = None
                replacement, _receipt = user_process(port)
                children.append(replacement)
                emit(phase='replaced', port=port)
            elif operation == 'finish':
                break
            else:
                raise Refused('operation_invalid')
        return True
    except Exception as error:
        emit(phase='failed', code=str(error) if isinstance(error, Refused) else 'probe_internal_failure', **diagnostic)
        return False
    finally:
        if marked:
            marked.shutdown(); marked.server_close()
        for child in children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
        emit(phase='finished', rulesRemoved=policy.close() if policy else True)


if __name__ == '__main__':
    try:
        if len(sys.argv) > 1 and sys.argv[1] == 'user':
            as_user(int(sys.argv[2]) if len(sys.argv) > 2 else None)
        else:
            sys.exit(0 if root_probe() else 1)
    except Exception as error:
        emit(phase='failed', code=str(error) if isinstance(error, Refused) else 'probe_internal_failure')
        sys.exit(1)
