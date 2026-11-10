"""Run-scoped preview data plane. Started as root, never as the Agent user.

The only control listener is a root-only Unix socket. Each run gets a fresh
public origin; forwarding is restricted to a pinned loopback listener owned by
the task worktree's user. There are no access logs, database calls or pollers.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import socket
import stat
import subprocess
import sys
import time
from urllib.parse import urljoin, urlsplit

# Additive template dependency; never install/modify system Python on a preview
# request. The exact version is installed by the official runtime bootstrap.
DEPENDENCIES = Path('/opt/mikka/runtime/preview-python-3.14.0')
if DEPENDENCIES.is_dir():
    sys.path.insert(0, str(DEPENDENCIES))

from aiohttp import ClientConnectionError, ClientError, ClientSession, ClientTimeout, DummyCookieJar, WSMsgType, web
from multidict import CIMultiDict
from yarl import URL
from preview_firewall import FirewallError, protect_port

ROOT = Path('/run/mikka-preview')
VERSION = hashlib.sha256(Path(__file__).read_bytes() + Path(__file__).with_name('preview_firewall.py').read_bytes()).hexdigest()
COOKIE = '__Host-mikka_preview'
ENTRY = '/__mikka/preview/open'
MAX_SESSION_SECONDS = 300
MAX_TICKET_SECONDS = 30
MAX_CONCURRENT = 16
MAX_SESSION_BYTES = 64 * 1024 * 1024
MAX_BODY = 2 * 1024 * 1024
MAX_MESSAGE = 1024 * 1024
MAX_CANDIDATES = 16
DISCOVERY_SECONDS = 12
MAX_SESSIONS = 4
RESERVED_PORTS = frozenset((2375, 2376, 5432, 5900, 6080, 6081, 6082, 6083, 6084, 6379, 9222, 9229, 49983, 50005))
HOP_HEADERS = frozenset(('connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'))
PRIVATE_HEADERS = frozenset(('authorization', 'cookie', 'host', 'origin', 'referer', 'forwarded', 'x-real-ip', 'x-api-key'))
IDENTITY = ('taskId', 'runId', 'ownerId', 'workspaceId', 'deviceId', 'repoId', 'sandboxId', 'epoch', 'worktreePath')


class PreviewFailure(Exception):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code, self.status = code, status


def checked_binding(value):
    if not isinstance(value, dict):
        raise PreviewFailure('invalid_scope', 400)
    for key in IDENTITY[:-2]:
        if not isinstance(value.get(key), str) or not 1 <= len(value[key]) <= 200 or any(ord(c) < 32 for c in value[key]):
            raise PreviewFailure('invalid_scope', 400)
    if type(value.get('epoch')) is not int or value['epoch'] < 0:
        raise PreviewFailure('invalid_scope', 400)
    path = value.get('worktreePath')
    if not isinstance(path, str) or not path.startswith('/') or '\x00' in path or '..' in Path(path).parts or Path(path) == Path('/'):
        raise PreviewFailure('invalid_scope', 400)
    if not isinstance(value.get('expiresAt'), (int, float)) or not time.time() < value['expiresAt'] <= time.time() + MAX_SESSION_SECONDS + 5:
        raise PreviewFailure('authorization_expired', 403)
    return {key: value[key] for key in (*IDENTITY, 'expiresAt')}


def identity(binding):
    return tuple(binding[key] for key in IDENTITY)


def valid_port(port):
    return type(port) is int and 1024 <= port <= 65535 and port not in RESERVED_PORTS


def proc_start(pid):
    text = Path(f'/proc/{pid}/stat').read_text()
    return text[text.rfind(')') + 2:].split()[19]


def listeners():
    """Only true loopback listeners are eligible, never wildcard/public binds.

    The external E2B ingress must not expose the application's unguarded socket.
    HTTP to the selected loopback socket happens locally, with no DNS lookup.
    """
    result = {}
    for filename, address, host in (('tcp', '0100007F', '127.0.0.1'), ('tcp6', '00000000000000000000000001000000', '[::1]')):
        for row in Path('/proc/net', filename).read_text().splitlines()[1:]:
            fields = row.split()
            ip, raw_port = fields[1].split(':')
            port = int(raw_port, 16)
            if fields[3] == '0A' and ip == address and valid_port(port):
                result[fields[9]] = (port, host)
    return result


def discover(worktree, user_id, requested_port=None, *, diagnostic=None):
    if diagnostic is not None:
        diagnostic.update({'vanishedFds': 0, 'processReadErrors': 0})
    if requested_port is not None and not valid_port(requested_port):
        raise PreviewFailure('invalid_port', 400)
    try:
        root = Path(worktree).resolve(strict=True)
        root_info = root.stat()
        if str(root) != worktree or root_info.st_uid != user_id or not root.is_dir():
            raise PreviewFailure('worktree_unavailable', 404)
    except OSError as error:
        raise PreviewFailure('worktree_unavailable', 404) from error
    available = listeners()
    found = []
    for process in list(Path('/proc').glob('[0-9]*'))[:4096]:
        try:
            if process.stat().st_uid != user_id:
                continue
            cwd = (process / 'cwd').resolve(strict=True)
            if cwd != root and not cwd.is_relative_to(root):
                continue
            start = proc_start(process.name)
            for descriptor in list((process / 'fd').iterdir())[:1024]:
                try:
                    link = os.readlink(descriptor)
                except FileNotFoundError:
                    if diagnostic is not None:
                        diagnostic['vanishedFds'] += 1
                    continue  # An unrelated FD can close after enumeration.
                inode = link[8:-1] if link.startswith('socket:[') else ''
                if inode not in available:
                    continue
                port, host = available[inode]
                if requested_port is not None and port != requested_port:
                    continue
                found.append({'port': port, 'host': host, 'pid': int(process.name), 'start': start, 'inode': inode,
                              'worktree': worktree, 'rootDevice': root_info.st_dev, 'rootInode': root_info.st_ino, 'userId': user_id})
        except (OSError, ValueError, IndexError):
            if diagnostic is not None:
                diagnostic['processReadErrors'] += 1
            continue  # A process may exit between procfs reads; it grants nothing.
    unique = {(item['port'], item['host']): item for item in found}
    if len(unique) > MAX_CANDIDATES:
        raise PreviewFailure('port_limit', 429)
    return sorted(unique.values(), key=lambda item: ((5173, 3000, 4173, 8080).index(item['port']) if item['port'] in (5173, 3000, 4173, 8080) else 4, item['port']))


def pinned(target):
    try:
        root = Path(target['worktree'])
        info = root.stat()
        cwd = Path(f"/proc/{target['pid']}/cwd").resolve(strict=True)
        if str(root.resolve(strict=True)) != target['worktree'] or (info.st_dev, info.st_ino, info.st_uid) != (target['rootDevice'], target['rootInode'], target['userId']):
            return False
        if (cwd != root and not cwd.is_relative_to(root)) or Path(f"/proc/{target['pid']}").stat().st_uid != target['userId']:
            return False
        if proc_start(target['pid']) != target['start'] or listeners().get(target['inode']) != (target['port'], target['host']):
            return False
        for descriptor in Path(f"/proc/{target['pid']}/fd").iterdir():
            try:
                link = os.readlink(descriptor)
            except FileNotFoundError:
                continue
            if link == f"socket:[{target['inode']}]":
                return True
        return False
    except (OSError, ValueError, IndexError):
        return False


def clean_headers(headers, *, response=False):
    connection = {item.strip().lower() for item in headers.get('Connection', '').split(',')}
    result = CIMultiDict()
    for name, value in headers.items():
        lower = name.lower()
        if lower in HOP_HEADERS or lower in connection or lower in PRIVATE_HEADERS or lower.startswith(('x-forwarded-', 'sec-websocket-')):
            continue
        if response and (lower in ('set-cookie', 'location', 'content-length', 'content-security-policy', 'x-frame-options', 'refresh') or lower.startswith('access-control-')):
            continue
        result.add(name, value)
    return result


def redirect_location(value, target, origin, path):
    if len(value) > 8192 or any(ord(c) < 32 for c in value) or '\\' in value or value.startswith('//'):
        raise PreviewFailure('redirect_denied', 502)
    upstream = f"http://{target['host']}:{target['port']}"
    parsed = urlsplit(urljoin(upstream + path, value))
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.port != target['port'] or parsed.username or parsed.password:
        raise PreviewFailure('redirect_denied', 502)
    return origin + parsed.path + ('?' + parsed.query if parsed.query else '') + ('#' + parsed.fragment if parsed.fragment else '')


class Gateway:
    def __init__(self, root=ROOT, user_id=None, protect=protect_port):
        self.root = root
        self.user_id = pwd.getpwnam('user').pw_uid if user_id is None else user_id
        self.protect = protect
        self.binding = None
        self.target = None
        self.origin = None
        self.parent_origin = None
        self.site = None
        self.runner = None
        self.port = None
        self.http = None
        self.tickets = {}
        self.sessions = {}
        self.active = {}
        self.deadline = None
        self.lock = asyncio.Lock()
        self.stopping = False
        self.revoked = set()
        self.revoked_leases = set()
        used_file = self.root / 'ports.json'
        self.used_ports = set(json.loads(used_file.read_text())) if used_file.exists() else set()

    async def start(self):
        self.http = ClientSession(cookie_jar=DummyCookieJar(), trust_env=False, auto_decompress=False,
                                  timeout=ClientTimeout(total=30, connect=2, sock_read=20))

    async def close(self):
        await self.revoke()
        await self.http.close()

    async def revoke(self, run_id=None, lease_ids=None):
        if lease_ids == []:
            lease_ids = None
        if lease_ids is not None:
            if not isinstance(lease_ids, list) or len(lease_ids) > 128 or any(not isinstance(item, str) or not 1 <= len(item) <= 128 for item in lease_ids):
                raise PreviewFailure('invalid_scope', 400)
            self.revoked_leases.update(lease_ids)
            matches = any(value['leaseId'] in lease_ids for value in (*self.tickets.values(), *self.sessions.values())) or any(lease in lease_ids for lease in self.active.values())
            if not matches:
                # A terminal lease revoke is also delivered here. Record its
                # tombstone for late issue, but leave unrelated previews alone.
                return
            self.tickets = {key: value for key, value in self.tickets.items() if value['leaseId'] not in self.revoked_leases}
            self.sessions = {key: value for key, value in self.sessions.items() if value['leaseId'] not in self.revoked_leases}
            tasks = [task for task, lease in self.active.items() if lease in self.revoked_leases]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self.sessions or self.tickets:
                return
        if run_id is not None:
            if lease_ids is None:
                self.revoked.add(run_id)
            if not self.binding or self.binding['runId'] != run_id:
                return
        self.tickets.clear()
        self.sessions.clear()
        if self.deadline:
            self.deadline.cancel()
            self.deadline = None
        # Stop accepting new traffic first, then cancel in-flight HTTP and WS.
        if self.site:
            await self.site.stop()
            self.site = None
        current = asyncio.current_task()
        tasks = [task for task in self.active if task is not current]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.runner:
            await self.runner.cleanup()
            self.runner = None
        self.binding = self.target = self.origin = self.parent_origin = self.port = None

    def live(self):
        if not self.binding or self.binding['expiresAt'] <= time.time() or self.binding['runId'] in self.revoked:
            raise PreviewFailure('authorization_expired', 403)
        if not pinned(self.target):
            raise PreviewFailure('server_stopped', 409)

    async def prepare(self, message):
        if self.stopping:
            raise PreviewFailure('control_unavailable', 503)
        binding = checked_binding(message.get('binding'))
        if binding['runId'] in self.revoked:
            raise PreviewFailure('authorization_revoked', 403)
        # Only a trusted control-plane request can switch a run's target.
        diagnostic = {}
        candidates = discover(binding['worktreePath'], self.user_id, message.get('port'), diagnostic=diagnostic)
        diagnostic.update({'candidateCount': len(candidates), 'probes': [], 'budgetExpired': False})
        target = None
        discovery_deadline = time.monotonic() + DISCOVERY_SECONDS
        for candidate in candidates:
            # Verify the actual pre-worker policy in both families. This
            # read cannot install rules or turn an older VM into a safe one.
            try:
                await asyncio.to_thread(self.protect, candidate['port'])
            except FirewallError as cause:
                raise PreviewFailure(cause.code, 404 if cause.code == 'firewall_unsupported' else 503) from cause
            remaining = discovery_deadline - time.monotonic()
            if remaining <= 0:
                diagnostic['budgetExpired'] = True
                break
            started = time.monotonic()
            outcome = 'http_error'
            try:
                # Next compiles the first document lazily. A one-second probe
                # misclassifies its real listening server as absent. Keep a
                # bounded overall discovery budget without retry/polling.
                async with self.http.get(f"http://{candidate['host']}:{candidate['port']}/", allow_redirects=False,
                                         timeout=ClientTimeout(total=min(8, remaining)), headers={'Host': f"localhost:{candidate['port']}"}) as reply:
                    if 100 <= reply.status <= 599:
                        if pinned(candidate):
                            target = candidate
                            outcome = 'selected'
                            break
                        outcome = 'pin_changed'
                    else:
                        outcome = 'invalid_status'
            except asyncio.TimeoutError:
                outcome = 'timeout'
                continue
            except ClientConnectionError:
                outcome = 'connection_failed'
                continue
            except (ClientError, OSError):
                continue
            finally:
                diagnostic['probes'].append({'outcome': outcome, 'elapsedMs': int((time.monotonic() - started) * 1000)})
        if target is None:
            # Root control diagnostics contain no socket/process identity,
            # paths, URLs or exception text. The application rebuilds its
            # ordinary four-field unavailable DTO instead of forwarding this.
            return {'running': False, 'state': 'unavailable', 'code': 'no_loopback_server',
                    'observedAt': int(time.time() * 1000), 'diagnostic': diagnostic}
        # Discovery may wait for a cold framework compile. It must never hold
        # the control lock that a stop/revocation needs to close live sockets.
        async with self.lock:
            if self.stopping:
                raise PreviewFailure('control_unavailable', 503)
            checked_binding(binding)
            if binding['runId'] in self.revoked:
                raise PreviewFailure('authorization_revoked', 403)
            if not pinned(target):
                raise PreviewFailure('server_stopped', 409)
            return await self.activate(binding, target)

    async def activate(self, binding, target):
        if self.binding and identity(self.binding) == identity(binding) and self.target == target:
            self.live()
            return {'running': True, 'gatewayPort': self.port, 'port': target['port'], 'expiresAt': self.binding['expiresAt'], 'version': VERSION}
        await self.revoke()
        if len(self.used_ports) >= 256:
            raise PreviewFailure('origin_limit', 429)
        self.binding, self.target = binding, target
        app = web.Application(client_max_size=MAX_BODY)
        app.router.add_route('*', '/{path:.*}', self.handle)
        self.runner = web.AppRunner(app, access_log=None, shutdown_timeout=1)
        await self.runner.setup()
        for _ in range(16):
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            # Matches the early workspace ingress policy; ordinary dev sockets
            # never inherit public access when this listener closes.
            try:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, 0x4D4B5056)
                listener.bind(('0.0.0.0', 0))
            except BaseException:
                listener.close()
                raise
            port = listener.getsockname()[1]
            if valid_port(port) and port not in self.used_ports:
                break
            listener.close()
        else:
            raise PreviewFailure('origin_limit', 429)
        self.used_ports.add(port)
        temporary = self.root / 'ports.next'
        temporary.write_text(json.dumps(sorted(self.used_ports)))
        temporary.replace(self.root / 'ports.json')
        self.port = port
        self.site = web.SockSite(self.runner, listener)
        await self.site.start()
        # One absolute lease timer, never a recurring poll or page keepalive.
        self.deadline = asyncio.get_running_loop().call_later(max(0, binding['expiresAt'] - time.time()),
            lambda: asyncio.create_task(self.expire(binding['runId'])))
        return {'running': True, 'gatewayPort': port, 'port': target['port'], 'expiresAt': binding['expiresAt'], 'version': VERSION}

    async def expire(self, run_id):
        async with self.lock:
            if self.binding and self.binding['runId'] == run_id:
                await self.revoke()

    def issue(self, message):
        self.live()
        lease_id = message.get('leaseId')
        if not isinstance(lease_id, str) or not 1 <= len(lease_id) <= 128 or lease_id in self.revoked_leases:
            raise PreviewFailure('authorization_revoked', 403)
        binding = checked_binding(message.get('binding'))
        if identity(binding) != identity(self.binding) or message.get('gatewayPort') != self.port:
            raise PreviewFailure('scope_changed', 409)
        if binding['expiresAt'] > self.binding['expiresAt']:
            raise PreviewFailure('scope_changed', 409)
        if binding['expiresAt'] < self.binding['expiresAt']:
            self.binding['expiresAt'] = binding['expiresAt']
            self.deadline.cancel()
            self.deadline = asyncio.get_running_loop().call_later(max(0, binding['expiresAt'] - time.time()),
                lambda: asyncio.create_task(self.expire(binding['runId'])))
        origin = urlsplit(message.get('origin', ''))
        parent = urlsplit(message.get('parentOrigin', ''))
        if origin.scheme != 'https' or not origin.hostname or origin.path or origin.query or origin.fragment or origin.username or origin.password:
            raise PreviewFailure('invalid_origin', 400)
        if parent.scheme not in ('https', 'http') or not parent.hostname or parent.path or parent.query or parent.fragment or parent.username or parent.password or parent.netloc == origin.netloc:
            raise PreviewFailure('invalid_origin', 400)
        if self.origin and (self.origin != message['origin'] or self.parent_origin != message['parentOrigin']):
            raise PreviewFailure('scope_changed', 409)
        self.origin, self.parent_origin = message['origin'], message['parentOrigin']
        now = time.time()
        self.tickets = {key: value for key, value in self.tickets.items() if value['expiresAt'] > now and value['leaseId'] != lease_id}
        other_sessions = {value['leaseId'] for value in self.sessions.values() if value['expiresAt'] > now and value['leaseId'] != lease_id}
        if len(self.tickets) + len(other_sessions) >= MAX_SESSIONS:
            raise PreviewFailure('session_limit', 429)
        ticket = secrets.token_urlsafe(32)
        self.tickets[hashlib.sha256(ticket.encode()).hexdigest()] = {'expiresAt': min(self.binding['expiresAt'], now + MAX_TICKET_SECONDS), 'leaseId': lease_id}
        return {'ticket': ticket, 'expiresAt': self.binding['expiresAt']}

    async def control(self, message):
        operation = message.get('operation')
        if operation == 'prepare':
            return await self.prepare(message)
        async with self.lock:
            if self.stopping:
                raise PreviewFailure('control_unavailable', 503)
            if operation == 'version':
                return {'version': VERSION}
            if operation == 'issue':
                return self.issue(message)
            if operation == 'revoke':
                await self.revoke(message.get('runId'), message.get('leaseIds'))
                return {'revoked': True}
            raise PreviewFailure('invalid_operation', 400)

    def authorize(self, request):
        self.live()
        if not self.origin or request.headers.get('Host') != urlsplit(self.origin).netloc:
            raise PreviewFailure('invalid_host', 403)
        raw = request.cookies.get(COOKIE, '')
        session = self.sessions.get(hashlib.sha256(raw.encode()).hexdigest())
        if not session or session['expiresAt'] <= time.time() or session['leaseId'] in self.revoked_leases:
            raise PreviewFailure('authorization_required', 401)
        # Cross-site navigation to the one-use entry is intentional; subsequent
        # resource/API/WS requests belong to this preview origin only.
        if request.headers.get('Sec-Fetch-Site') == 'cross-site' or request.headers.get('Origin', self.origin) != self.origin:
            raise PreviewFailure('invalid_origin', 403)
        if request.method not in ('GET', 'HEAD') and request.headers.get('Origin') != self.origin:
            raise PreviewFailure('invalid_origin', 403)
        return session

    def security_headers(self):
        return {'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
                'Origin-Agent-Cluster': '?1', 'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': f"frame-ancestors {self.parent_origin}; object-src 'none'"}

    async def handle(self, request):
        task = asyncio.current_task()
        try:
            if request.path == ENTRY:
                self.live()
                if request.method != 'GET' or not self.origin or request.headers.get('Host') != urlsplit(self.origin).netloc or set(request.query) != {'ticket'}:
                    raise PreviewFailure('authorization_required', 401)
                digest = hashlib.sha256(request.query['ticket'].encode()).hexdigest()
                ticket = self.tickets.pop(digest, None)
                if not ticket or ticket['expiresAt'] <= time.time() or ticket['leaseId'] in self.revoked_leases:
                    raise PreviewFailure('authorization_required', 401)
                # Reopening the same review lease rotates its browser session;
                # closing/reopening the existing UI must not exhaust a quota.
                self.sessions = {key: value for key, value in self.sessions.items() if value['leaseId'] != ticket['leaseId']}
                prior = [active for active, lease in self.active.items() if lease == ticket['leaseId']]
                for active in prior:
                    active.cancel()
                await asyncio.gather(*prior, return_exceptions=True)
                raw = secrets.token_urlsafe(32)
                self.sessions[hashlib.sha256(raw.encode()).hexdigest()] = {'expiresAt': self.binding['expiresAt'], 'leaseId': ticket['leaseId'], 'cookies': {}, 'bytes': 0}
                # Commit a trusted document on the preview origin before the
                # next navigation. A cross-site 303 redirect retains the
                # original Fetch Metadata and would be denied below.
                nonce = secrets.token_urlsafe(24)
                headers = {**self.security_headers(), 'Content-Security-Policy': f"default-src 'none'; script-src 'nonce-{nonce}'; frame-ancestors {self.parent_origin}; base-uri 'none'; form-action 'none'"}
                result = web.Response(text=f'<!doctype html><meta charset="utf-8"><script nonce="{nonce}">history.replaceState(null,"","/");location.replace("/")</script>',
                                      content_type='text/html', headers=headers)
                result.headers.add('Set-Cookie', f'{COOKIE}={raw}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age={max(1, int(self.binding["expiresAt"] - time.time()))}')
                return result
            if request.path.startswith('/__mikka/'):
                raise PreviewFailure('invalid_path', 404)
            if request.headers.get('Service-Worker') == 'script':
                raise PreviewFailure('service_worker_denied', 403)
            session = self.authorize(request)
            if len(self.active) >= MAX_CONCURRENT:
                raise PreviewFailure('connection_limit', 429)
            self.active[task] = session['leaseId']
            if request.headers.get('Upgrade', '').lower() == 'websocket':
                return await self.websocket(request, session)
            return await self.proxy(request, session)
        except PreviewFailure as error:
            return web.json_response({'code': error.code}, status=error.status, headers={'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer'})
        except (ClientError, OSError, asyncio.TimeoutError):
            return web.json_response({'code': 'server_unavailable'}, status=502, headers={'Cache-Control': 'private, no-store'})
        finally:
            self.active.pop(task, None)

    def account(self, session, amount):
        self.live()
        if session['leaseId'] in self.revoked_leases:
            raise PreviewFailure('authorization_revoked', 403)
        session['bytes'] += amount
        if session['bytes'] > MAX_SESSION_BYTES:
            raise PreviewFailure('byte_limit', 429)

    def upstream_headers(self, request, session):
        result = clean_headers(request.headers)
        result['Host'] = f"localhost:{self.target['port']}"
        result['Origin'] = f"http://localhost:{self.target['port']}"
        # The browser's ambient cookies/Authorization never cross the boundary.
        # Only cookies set by this exact upstream in this session are returned.
        cookies = [f'{name}={item["value"]}' for name, item in session['cookies'].items()
                   if (request.path == item['path'] or request.path.startswith(item['path'].rstrip('/') + '/')) and item['expiresAt'] > time.time()]
        if cookies:
            result['Cookie'] = '; '.join(cookies)
        return result

    async def proxy(self, request, session):
        if request.method not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'):
            raise PreviewFailure('invalid_method', 405)
        if len(request.raw_path) > 8192 or request.raw_path.startswith('//'):
            raise PreviewFailure('invalid_path', 400)
        target = dict(self.target)
        endpoint = URL(f"http://{target['host']}:{target['port']}" + request.raw_path, encoded=True)
        body = await request.read()
        self.account(session, len(body))
        async with self.http.request(request.method, endpoint, headers=self.upstream_headers(request, session), data=body,
                                     allow_redirects=False) as upstream:
            self.live()
            headers = clean_headers(upstream.headers, response=True)
            headers.update(self.security_headers())
            if 'Location' in upstream.headers:
                headers['Location'] = redirect_location(upstream.headers['Location'], target, self.origin, request.path)
            mirrors = []
            for name, item in upstream.cookies.items():
                # Domain cookies cannot set a sibling/main-site cookie; store
                # app cookies server-side and never forward Set-Cookie verbatim.
                if name.startswith(('__Host-mikka', '__Secure-', 'better-auth', 'mikka')) or item['domain'] or len(item.value) > 4096 or any(c in item.value for c in '\r\n;'):
                    continue
                if len(session['cookies']) >= 64 and name not in session['cookies']:
                    continue
                path = item['path'] if item['path'].startswith('/') else '/'
                expires = session['expiresAt']
                if item['max-age']:
                    try:
                        expires = min(expires, time.time() + int(item['max-age']))
                    except ValueError:
                        continue
                session['cookies'][name] = {'value': item.value, 'path': path, 'expiresAt': expires}
                if not item['httponly']:
                    mirrors.append((name, item.value, path, max(0, int(expires - time.time()))))
            response = web.StreamResponse(status=upstream.status, headers=headers)
            # JS can read app-issued CSRF/display cookies. Ambient browser
            # cookies still never go upstream: only the server-owned jar does.
            # Client-only cookie writes have no authority to change that jar.
            for name, value, path, maximum in mirrors:
                response.set_cookie(name, value, path=path, secure=True, samesite='None', max_age=maximum)
                headers.add('Set-Cookie', response.cookies[name].OutputString() + '; Partitioned')
            response.cookies.clear()
            response.headers.update(headers)
            await response.prepare(request)
            try:
                async for chunk in upstream.content.iter_chunked(65536):
                    self.account(session, len(chunk))
                    await response.write(chunk)
                await response.write_eof()
            except BaseException:
                if request.transport:
                    request.transport.close()
                raise
            return response

    async def websocket(self, request, session):
        if request.headers.get('Origin') != self.origin or len(request.raw_path) > 8192 or request.raw_path.startswith('//'):
            raise PreviewFailure('invalid_origin', 403)
        protocols = tuple(item.strip() for item in request.headers.get('Sec-WebSocket-Protocol', '').split(',') if item.strip())
        if len(protocols) > 8 or any(len(item) > 128 for item in protocols):
            raise PreviewFailure('invalid_protocol', 400)
        endpoint = URL(f"http://{self.target['host']}:{self.target['port']}" + request.raw_path, encoded=True)
        async with self.http.ws_connect(endpoint, headers=self.upstream_headers(request, session), protocols=protocols,
                                        max_msg_size=MAX_MESSAGE, autoclose=True, autoping=True) as upstream:
            self.live()
            # A malicious/stalled peer cannot hold the revoke ACK for aiohttp's
            # default ten-second graceful close window.
            downstream = web.WebSocketResponse(protocols=(upstream.protocol,) if upstream.protocol else (), max_msg_size=MAX_MESSAGE, timeout=0.2)
            await downstream.prepare(request)

            async def relay(source, destination):
                async for message in source:
                    if message.type == WSMsgType.TEXT:
                        self.account(session, len(message.data.encode()))
                        await destination.send_str(message.data)
                    elif message.type == WSMsgType.BINARY:
                        self.account(session, len(message.data))
                        await destination.send_bytes(message.data)
                    else:
                        break

            tasks = [asyncio.create_task(relay(upstream, downstream)), asyncio.create_task(relay(downstream, upstream))]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await downstream.close()
            return downstream


async def serve(ready_fd=None):
    gateway = Gateway()
    await gateway.start()
    stopped = asyncio.Event()

    async def command(reader, writer):
        try:
            data = await asyncio.wait_for(reader.readline(), timeout=10)
            message = json.loads(data)
            shutdown = message.get('operation') == 'shutdown'
            if shutdown:
                async with gateway.lock:
                    if gateway.stopping:
                        raise PreviewFailure('control_unavailable', 503)
                    # A discovery already outside this lock must not reactivate
                    # after the stopped ACK; its final locked check sees this.
                    gateway.stopping = True
                    server.close()
                    socket_path.unlink(missing_ok=True)
                    await gateway.revoke()
                # The outer server context drains clients after this writer's
                # ACK/close; waiting here would wait on this same connection.
                reply = {'stopped': True}
            else:
                reply = await gateway.control(message)
        except PreviewFailure as error:
            reply = {'error': error.code, 'status': error.status}
        except (ValueError, TypeError, KeyError, OSError, asyncio.TimeoutError):
            reply = {'error': 'control_unavailable', 'status': 503}
        writer.write(json.dumps(reply).encode() + b'\n')
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        if reply.get('stopped') is True:
            stopped.set()

    socket_path = ROOT / 'control.sock'
    socket_path.unlink(missing_ok=True)
    server = await asyncio.start_unix_server(command, path=str(socket_path), limit=16384)
    socket_path.chmod(0o600)
    socket_inode = socket_path.stat().st_ino
    if ready_fd is not None:
        os.write(ready_fd, b'1')
        os.close(ready_fd)
    try:
        async with server:
            await stopped.wait()
    finally:
        await gateway.close()
        if socket_path.exists() and socket_path.stat().st_ino == socket_inode:
            socket_path.unlink()


def call_control(message):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(25)
        client.connect(str(ROOT / 'control.sock'))
        client.sendall(json.dumps(message).encode() + b'\n')
        with client.makefile('rb') as incoming:
            return json.loads(incoming.readline(16384))


def ensure():
    import fcntl
    import select
    ROOT.mkdir(mode=0o700, exist_ok=True)
    ROOT.chmod(0o700)
    with (ROOT / 'install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            version = call_control({'operation': 'version'})
        except (FileNotFoundError, ConnectionRefusedError):
            version = None
        if version:
            if version.get('version') != VERSION:
                if call_control({'operation': 'shutdown'}).get('stopped') is not True:
                    raise PreviewFailure('runtime_version_mismatch', 409)
            else:
                return version
        read_fd, write_fd = os.pipe()
        try:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'serve', '--ready-fd', str(write_fd)],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             close_fds=True, pass_fds=(write_fd,), start_new_session=True)
            os.close(write_fd)
            if not select.select([read_fd], [], [], 10)[0] or os.read(read_fd, 1) != b'1':
                raise PreviewFailure('runtime_unavailable', 503)
        finally:
            os.close(read_fd)
        return call_control({'operation': 'version'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('ensure', 'control', 'serve'))
    parser.add_argument('input', nargs='?')
    parser.add_argument('--ready-fd', type=int)
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise PreviewFailure('infrastructure_only', 403)
        if args.operation == 'serve':
            asyncio.run(serve(args.ready_fd))
        elif args.operation == 'ensure':
            print(json.dumps(ensure()))
        else:
            source = Path(args.input)
            # Inputs may contain one-use capabilities. Only root can read them,
            # and consumption removes the temporary file even on failure.
            if source.parent != ROOT or source.stat().st_uid != 0 or stat.S_IMODE(source.stat().st_mode) & 0o077:
                raise PreviewFailure('invalid_control_file', 403)
            try:
                print(json.dumps(call_control(json.loads(source.read_text()))))
            finally:
                source.unlink(missing_ok=True)
    except PreviewFailure as error:
        print(json.dumps({'error': error.code, 'status': error.status}))
        sys.exit(1)
