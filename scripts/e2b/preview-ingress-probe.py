"""Disposable, synthetic reply-mark probe. Never run in an existing task VM.

Only the explicitly created fixture ports enter its temporary OUTPUT chain.
E2B envd, provider MCP, viewers and unrelated traffic are untouched. Commands
arrive over the root process's SDK stdin; no public control endpoint is added.
"""
import gzip
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
import urllib.request
from urllib.parse import urlsplit

MARKER = b'mikka-synthetic-socket-mark-probe-v1'
MARK = 0x4D4B5056
TOOL_PATH = '/opt/mikka/runtime/netfilter/sbin:/opt/mikka/runtime/netfilter/bin:/opt/mikka/runtime/iptables/sbin:/opt/mikka/runtime/iptables/bin:/usr/sbin:/sbin:/usr/bin:/bin'
KERNEL_OPTIONS = ('CONFIG_MODULES', 'CONFIG_NETFILTER_XT_MATCH_SOCKET',
                  'CONFIG_NF_SOCKET_IPV4', 'CONFIG_NF_SOCKET_IPV6',
                  'CONFIG_NF_TABLES', 'CONFIG_NFT_META', 'CONFIG_NFT_CT')


class Refused(Exception):
    pass


def emit(**value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def capabilities():
    text = Path('/proc/self/status').read_text()
    effective = int(re.search(r'^CapEff:\s*([0-9a-f]+)', text, re.M).group(1), 16)
    return {'netAdmin': bool(effective & (1 << 12)), 'netRaw': bool(effective & (1 << 13))}


def provider_listeners():
    owners = {49983: set(), 50005: set()}
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            rows = Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            fields = row.split()
            if len(fields) < 10 or fields[3] != '0A':
                continue
            port = int(fields[1].split(':')[1], 16)
            if port in owners:
                owners[port].add(int(fields[7]))
    return {str(port): {'listening': bool(uids), 'allRoot': bool(uids) and uids == {0}}
            for port, uids in owners.items()}


def tools():
    result = {}
    for name in ('iptables', 'ip6tables', 'nft'):
        path = shutil.which(name, path=TOOL_PATH)
        receipt = {'present': path is not None, 'source': 'private' if path and path.startswith('/opt/mikka/') else 'system',
                   'version': None, 'backend': 'unknown'}
        if path:
            response = subprocess.run([path, '--version'], capture_output=True, timeout=5, check=False)
            version = re.search(rb'v([0-9]+\.[0-9]+\.[0-9]+)', response.stdout)
            receipt['version'] = version.group(1).decode() if version else None
            receipt['backend'] = ('nf_tables' if b'(nf_tables)' in response.stdout else
                                  'legacy' if b'(legacy)' in response.stdout else 'unknown')
        result[name] = receipt
    return result


def kernel():
    release = os.uname().release
    if not re.fullmatch(r'[A-Za-z0-9_.+-]{1,128}', release):
        release = None
    result = {'release': release, 'configSource': 'unavailable',
              'options': {name: 'unknown' for name in KERNEL_OPTIONS}}
    candidates = [('proc', Path('/proc/config.gz'))]
    if release:
        candidates.append(('boot', Path('/boot') / ('config-' + release)))
    for source, path in candidates:
        try:
            with (gzip.open(path, 'rb') if source == 'proc' else path.open('rb')) as handle:
                data = handle.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                continue
            text = data.decode('ascii')
        except (OSError, UnicodeError, EOFError):
            continue
        result['configSource'] = source
        for name in KERNEL_OPTIONS:
            selected = re.search(r'^' + re.escape(name) + r'=([ymn])$', text, re.M)
            result['options'][name] = selected.group(1) if selected else (
                'n' if re.search(r'^# ' + re.escape(name) + r' is not set$', text, re.M) else 'unknown')
        break
    return result


def rule_failure(returncode, stderr):
    # Never emit the command, chain name, raw stderr or arbitrary exception text.
    # Keep the observations independent: several kernels print both a revision
    # warning and a userspace extension error for the same failed insertion.
    text = stderr[:16384].lower()
    return {'exitCode': returncode if 0 <= returncode <= 255 else None,
            'unsupportedRevision': bool(re.search(rb'revision [0-9]+ not supported', text)),
            'missingKernelModule': b'missing kernel module' in text,
            'missingExtension': b"couldn't load match" in text or b'could not load match' in text,
            'operationNotSupported': b'operation not supported' in text,
            'permissionDenied': b'permission denied' in text or b'operation not permitted' in text,
            'invalidArgument': b'invalid argument' in text}


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
         capabilities=capabilities(), canSetSocketMark=marker_allowed, sudoNonInteractiveRoot=sudo_root,
         noNewPrivileges=bool(re.search(r'^NoNewPrivs:\s*1$', Path('/proc/self/status').read_text(), re.M)))
    signal.pause()


def outbound(url):
    if os.geteuid() == 0:
        raise Refused('user_identity_invalid')
    try:
        request = urllib.request.Request(url, headers={'Connection': 'close'})
        with urllib.request.urlopen(request, timeout=10) as response:
            emit(phase='user_outbound', status=response.status, markerMatched=response.read(len(MARKER) + 1) == MARKER)
    except Exception:
        emit(phase='user_outbound', status=None, markerMatched=False)


def user_outbound(url, port):
    target = urlsplit(url)
    # The only outbound target is this probe's own marked fixture through E2B's
    # public ingress, never an arbitrary host supplied to a product endpoint.
    if (target.scheme != 'https' or target.username or target.password or target.port
            or target.path != '/' or target.query or target.fragment
            or not target.hostname or not target.hostname.endswith('.e2b.app')
            or not target.hostname.startswith(str(port) + '-')
            or not re.fullmatch(r'[A-Za-z0-9.-]{1,253}', target.hostname)):
        raise Refused('outbound_target_invalid')
    user = pwd.getpwnam('user')
    reply = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'outbound', url],
                           user=user.pw_uid, group=user.pw_gid, extra_groups=[], cwd=user.pw_dir,
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           env={'PATH': '/usr/bin:/bin', 'HOME': user.pw_dir, 'PYTHONDONTWRITEBYTECODE': '1'},
                           timeout=15, check=False)
    if reply.returncode or len(reply.stdout) > 4096:
        raise Refused('outbound_probe_failed')
    value = json.loads(reply.stdout)
    if value.get('phase') != 'user_outbound':
        raise Refused('outbound_probe_failed')
    return {'status': value.get('status') if type(value.get('status')) is int else None,
            'markerMatched': value.get('markerMatched') is True}


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
        ports = tuple(ports)
        if (not ports or len(ports) > 15 or any(type(port) is not int or not 1024 < port < 65536
                                               or port in (49983, 50005) for port in ports)):
            raise Refused('ports_invalid')
        self.chain = 'MKPV_' + os.urandom(5).hex()
        self.ports = ','.join(str(port) for port in sorted(set(ports)))
        self.created = []
        self.linked = []
        self.failure = None

    def command(self, program, arguments):
        reply = subprocess.run([program, '--wait', '5', *arguments], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=7, check=False)
        if reply.returncode:
            self.failure = rule_failure(reply.returncode, reply.stderr)
        return reply.returncode

    def install(self):
        proof = {}
        for family, name in (('ipv4', 'iptables'), ('ipv6', 'ip6tables')):
            program = shutil.which(name, path=TOOL_PATH)
            if not program:
                raise Refused('tool_missing_' + family)
            version = subprocess.run([program, '--version'], capture_output=True, timeout=5, check=False)
            if version.returncode or b'(nf_tables)' not in version.stdout:
                raise Refused('nft_backend_unavailable_' + family)
            if self.command(program, ['--new-chain', self.chain]):
                raise Refused('chain_unavailable_' + family)
            self.created.append(program)
            # nf_tables translates these userspace matches to native ct/meta
            # expressions. No xt_socket lookup or socket kernel module is used.
            blocked = ['-p', 'tcp', '-m', 'conntrack', '--ctdir', 'REPLY', '-m', 'mark', '!', '--mark', str(MARK),
                       '-j', 'REJECT', '--reject-with', 'tcp-reset']
            if self.command(program, ['--append', self.chain, *blocked]):
                raise Refused('reply_rule_unavailable_' + family)
            jump = ['!', '-o', 'lo', '-p', 'tcp', '-m', 'multiport', '--sports', self.ports, '-j', self.chain]
            if self.command(program, ['--insert', 'OUTPUT', '1', *jump]):
                raise Refused('output_unavailable_' + family)
            self.linked.append((program, jump))
            if self.command(program, ['--check', 'OUTPUT', *jump]) or self.command(program, ['--check', self.chain, *blocked]):
                raise Refused('rule_unverified_' + family)
            proof[family] = True
        return proof

    def close(self):
        okay = True
        for program, jump in reversed(self.linked):
            okay = self.command(program, ['--delete', 'OUTPUT', *jump]) == 0 and okay
        for program in reversed(self.created):
            okay = self.command(program, ['--flush', self.chain]) == 0 and okay
            okay = self.command(program, ['--delete-chain', self.chain]) == 0 and okay
        self.linked.clear(); self.created.clear()
        return okay


def root_probe():
    if os.geteuid() != 0:
        raise Refused('root_required')
    diagnostic = {'capabilities': capabilities(), 'tools': tools(), 'kernel': kernel()}
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
        emit(phase='ready', ports=ports, providerListeners=provider_listeners(),
             user={key: user[key] for key in ('capabilities', 'canSetSocketMark', 'sudoNonInteractiveRoot', 'noNewPrivileges')}, **diagnostic)
        for line in sys.stdin:
            operation = line.strip()
            if operation == 'protect':
                emit(phase='protected', rules=policy.install(), providerListeners=provider_listeners())
            elif operation.startswith('outbound ') and len(operation) < 512 and marked:
                emit(phase='outbound', **user_outbound(operation[len('outbound '):], marked.server_address[1]))
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
        emit(phase='failed', code=str(error) if isinstance(error, Refused) else 'probe_internal_failure',
             ruleFailure=policy.failure if policy else None, **diagnostic)
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
        elif len(sys.argv) == 3 and sys.argv[1] == 'outbound':
            outbound(sys.argv[2])
        else:
            sys.exit(0 if root_probe() else 1)
    except Exception as error:
        emit(phase='failed', code=str(error) if isinstance(error, Refused) else 'probe_internal_failure')
        sys.exit(1)
