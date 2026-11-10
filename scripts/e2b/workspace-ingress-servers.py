"""Owned synthetic listeners; import the installed guard, never install rules.

The parent is a root-marked positive control. Its children are ordinary user
listeners. Only ports and fixed receipts leave this process; no file serving.
"""
import argparse
import http.server
import importlib.util
import json
import os
from pathlib import Path
import pwd
import signal
import socket
import subprocess
import sys
import threading

MARKER = b'mikka-workspace-ingress-synthetic-v1'


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(MARKER)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(MARKER)


class IPv6Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6


def run(user_only=False, replacement_port=None):
    servers = []
    started = []
    child = None
    try:
        if user_only:
            if os.getuid() != pwd.getpwnam('user').pw_uid:
                raise ValueError('user_required')
            kinds = [('replacement', '0.0.0.0', http.server.ThreadingHTTPServer, replacement_port)] if replacement_port else [
                ('userLoopback4', '127.0.0.1', http.server.ThreadingHTTPServer, 0),
                ('userPublic4', '0.0.0.0', http.server.ThreadingHTTPServer, 0),
                ('userLoopback6', '::1', IPv6Server, 0),
            ]
            ports = {}
            for name, address, factory, port in kinds:
                server = factory((address, port), Handler)
                servers.append(server)
                ports[name] = server.server_address[1]
        else:
            if os.geteuid() != 0:
                raise ValueError('root_required')
            guard_path = Path('/opt/mikka/runtime/ingress-v1/guard.py')
            spec = importlib.util.spec_from_file_location('mikka_installed_ingress', guard_path)
            guard = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(guard)
            listener = guard.marked_listener()
            server = http.server.ThreadingHTTPServer(('0.0.0.0', 0), Handler, bind_and_activate=False)
            server.socket.close()
            server.socket = listener
            server.server_address = listener.getsockname()
            server.server_name = 'owned-marked-fixture'
            server.server_port = server.server_address[1]
            servers.append(server)
            user = pwd.getpwnam('user')
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--user'],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                user=user.pw_uid, group=user.pw_gid, extra_groups=[], start_new_session=True,
                env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': user.pw_dir, 'PYTHONDONTWRITEBYTECODE': '1'})
            row = json.loads(child.stdout.readline(4096))
            ports = {**row['ports'], 'rootMarked': server.server_port}
        for server in servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            started.append(server)
        print(json.dumps({'ports': ports}), flush=True)
        signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
        signal.signal(signal.SIGINT, lambda *_args: sys.exit(0))
        threading.Event().wait()
    finally:
        for server in servers:
            if server in started:
                server.shutdown()
            server.server_close()
        if child is not None:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--user', action='store_true')
    parser.add_argument('--replacement-port', type=int)
    args = parser.parse_args()
    if args.replacement_port is not None and not 1024 < args.replacement_port < 65536:
        parser.error('replacement_port_invalid')
    try:
        run(args.user, args.replacement_port)
    except Exception:
        print(json.dumps({'error': 'owned_listener_failed'}), flush=True)
        sys.exit(1)
