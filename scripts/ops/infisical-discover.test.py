#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler
from socketserver import BaseRequestHandler, ThreadingTCPServer

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name('infisical-discover.py')
spec = importlib.util.spec_from_file_location('discovery', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MetadataAPI:
    def __init__(self, responses=None, project_status=200):
        self.calls = []
        self.responses = responses or {}
        self.project_status = project_status

    def get(self, path, query=None):
        self.calls.append((path, query))
        if path == '/api/v1/workspace/project':
            return self.project_status, {'workspace': {'id': 'project', 'environments': [
                {'slug': 'production-blue'}, {'slug': 'stage'}]}}
        if path != '/api/v4/secrets':
            raise AssertionError('Discovery must not guess a folder API or read a value endpoint')
        assert query['recursive'] == 'true' and query['includeImports'] == 'true'
        assert query['viewSecretValue'] == 'false' and query['expandSecretReferences'] == 'false'
        assert query['secretPath'] == '/'
        return self.responses.get(query['environment'], (200, {'secrets': [], 'imports': []}))


class DiscoveryTests(unittest.TestCase):
    def test_actual_environments_and_all_direct_imported_locators(self):
        api = MetadataAPI({
            'production-blue': (200, {'secrets': [{'secretKey': 'SLACK_BOT_TOKEN', 'secretPath': '/platform',
                                                   'secretValue': {'secretKey': 'VALUE_MUST_NOT_LEAK'}}], 'imports': []}),
            'stage': (200, {'secrets': [{'secretKey': 'SLACK_APP_ID', 'secretPath': '/branches/slackbot-oauth/slack'}],
                            'imports': [{'environment': 'production-blue', 'secretPath': '/platform',
                                         'secrets': [{'secretKey': 'SLACK_APP_ACCESS_TOKEN', 'secretValue': 'DO_NOT_LOG'}],
                                         'imports': [{'environment': 'archive', 'secretPath': '/old-slack',
                                                      'secrets': [{'secretKey': 'SLACK_SIGNING_SECRET'}]}]}]}),
        })
        result = module.discover(api, 'project', ['SLACK'])
        self.assertTrue(result['traversalComplete'])
        self.assertEqual(len(result['matches']), 4)
        imported = result['matches'][2]
        self.assertEqual(imported['locator'], {'projectId': 'project', 'environment': 'production-blue',
                                              'path': '/platform', 'key': 'SLACK_APP_ACCESS_TOKEN'})
        self.assertEqual(imported['requestedScope']['environment'], 'stage')
        self.assertEqual(imported['importSource']['path'], '/platform')
        self.assertEqual(result['matches'][3]['locator']['environment'], 'archive')
        self.assertNotIn('DO_NOT_LOG', json.dumps(result))
        self.assertNotIn('VALUE_MUST_NOT_LEAK', json.dumps(result))
        self.assertEqual([call[1]['environment'] for call in api.calls[1:]], ['production-blue', 'stage'])

    def test_http_failures_and_acl_filtered_empty_are_not_missing(self):
        for status, kind in [(403, 'action_denied'), (404, 'resource_unresolved'), (422, 'request_rejected')]:
            result = module.discover(MetadataAPI({'stage': (status, {'message': 'PRIVATE_ERROR'})}), 'project', ['SLACK'])
            self.assertFalse(result['traversalComplete'])
            self.assertEqual(result['requests'][-1]['kind'], kind)
            self.assertEqual(result['outcome'], 'incomplete')
            self.assertNotIn('PRIVATE_ERROR', json.dumps(result))
        result = module.discover(MetadataAPI(), 'project', ['SLACK'])
        self.assertEqual(result['outcome'], 'no_visible_match')
        self.assertEqual(result['permissionCompleteness'], 'not_proven')
        self.assertEqual(result['requests'][-1]['kind'], 'visible_empty')
        self.assertNotIn('missing', json.dumps(result))

    def test_failed_project_inventory_never_guesses_environment_or_folder(self):
        for status in (403, 404, 422):
            api = MetadataAPI(project_status=status)
            result = module.discover(api, 'project', ['SLACK'])
            self.assertEqual(len(api.calls), 1)
            self.assertEqual(result['outcome'], 'incomplete')

    def test_incomplete_locator_and_pagination_stay_explicit(self):
        api = MetadataAPI({'stage': (200, {'secrets': [{'secretKey': 'SLACK_TOKEN'}], 'pagination': {'nextCursor': 'opaque'}})})
        result = module.discover(api, 'project', ['SLACK'])
        self.assertFalse(result['traversalComplete'])
        self.assertIsNone(result['matches'][0]['locator']['path'])
        self.assertIn('locator_incomplete', result['requests'][-1]['warnings'])
        self.assertIn('pagination_or_partial_coverage_unresolved', result['requests'][-1]['warnings'])

    def test_invalid_destination_and_cli_options_do_not_echo_inputs(self):
        for destination in ['http://app.infisical.com', 'https://untrusted.invalid', 'https://user:DO_NOT_LOG@app.infisical.com']:
            with self.assertRaises(module.DiscoveryFailure):
                module.UniversalAuthAPI({'INFISICAL_API_URL': destination})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(module.main(['--secret-value', 'DO_NOT_LOG']), 2)
        self.assertNotIn('DO_NOT_LOG', output.getvalue())

    def test_proxy_bypass_and_unknown_import_source_are_not_silently_accepted(self):
        for bypass in ('*', '.infisical.com', 'app.infisical.com'):
            with self.assertRaises(module.DiscoveryFailure) as caught:
                module.UniversalAuthAPI({'INFISICAL_API_URL': 'https://app.infisical.com',
                                         'INFISICAL_PROJECT_ID': 'project', 'INFISICAL_CLIENT_ID': 'client',
                                         'INFISICAL_CLIENT_SECRET': 'fixture', 'NO_PROXY': bypass})
            self.assertEqual(caught.exception.code, 'configured_proxy_bypass_rejected')
        api = MetadataAPI({'stage': (200, {'imports': [{'secretPath': '/platform',
                                                       'secrets': [{'secretKey': 'SLACK_APP_ID'}]}]})})
        result = module.discover(api, 'project', ['SLACK'])
        self.assertFalse(result['traversalComplete'])
        self.assertIsNone(result['matches'][0]['locator']['environment'])
        self.assertEqual(result['matches'][0]['requestedScope']['environment'], 'stage')


class TLSProxy(BaseRequestHandler):
    def handle(self):
        stream = self.request.makefile('rb')
        request = stream.readline().decode().strip()
        self.server.connects.append(request)
        if not request.startswith('CONNECT app.infisical.com:443 '):
            return
        while stream.readline() not in (b'\r\n', b'\n', b''):
            pass
        self.request.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        try:
            with self.server.tls.wrap_socket(self.request, server_side=True) as encrypted:
                FixtureHTTP(encrypted, self.client_address, self.server)
        except ssl.SSLError:
            pass  # The negative CA case intentionally refuses this fixture certificate.


class FixtureHTTP(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send_json(self, status, value):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())

    def do_POST(self):
        self.server.calls.append(('POST', self.path))
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        assert self.path == '/api/v1/auth/universal-auth/login'
        assert body == {'clientId': 'fixture-client', 'clientSecret': 'FIXTURE_SECRET_MUST_NOT_LEAK'}
        self.send_json(200, {'accessToken': 'FIXTURE_TOKEN_MUST_NOT_LEAK'})

    def do_GET(self):
        self.server.calls.append(('GET', self.path))
        assert self.headers['authorization'] == 'Bearer FIXTURE_TOKEN_MUST_NOT_LEAK'
        if self.server.redirect:
            self.send_response(307)
            self.send_header('Location', 'https://untrusted.invalid/secret-destination')
            self.end_headers()
        elif self.path == '/api/v1/workspace/project':
            self.send_json(200, {'workspace': {'id': 'project', 'environments': [{'slug': 'actual-prod'}]}})
        else:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            assert query['viewSecretValue'] == ['false'] and query['includeImports'] == ['true']
            self.send_json(200, {'secrets': [{'secretKey': 'SLACK_APP_ID', 'secretPath': '/platform',
                                             'secretValue': 'PRIVATE_VALUE_MUST_NOT_LEAK'}], 'imports': []})


class RealCLITests(unittest.TestCase):
    def test_portable_ua_proxy_verified_tls_metadata_redaction_and_redirect_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            cert, key = Path(directory) / 'ca.pem', Path(directory) / 'key.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                            '-subj', '/CN=app.infisical.com', '-addext', 'subjectAltName=DNS:app.infisical.com',
                            '-keyout', str(key), '-out', str(cert)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            with ThreadingTCPServer(('127.0.0.1', 0), TLSProxy) as server:
                server.tls, server.calls, server.connects, server.redirect = tls, [], [], False
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    env = {'PATH': os.environ['PATH'], 'INFISICAL_API_URL': 'https://app.infisical.com',
                           'INFISICAL_PROJECT_ID': 'project', 'INFISICAL_CLIENT_ID': 'fixture-client',
                           'INFISICAL_CLIENT_SECRET': 'FIXTURE_SECRET_MUST_NOT_LEAK', 'SSL_CERT_FILE': str(cert),
                           'HTTPS_PROXY': 'http://127.0.0.1:' + str(server.server_address[1])}
                    result = subprocess.run([sys.executable, str(SCRIPT), '--query', '  SLACK  '],
                                            env=env, cwd=directory, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    body = json.loads(result.stdout)
                    self.assertEqual(body['query'], ['SLACK'])
                    self.assertEqual(body['matches'][0]['locator']['environment'], 'actual-prod')
                    self.assertNotIn('MUST_NOT_LEAK', result.stdout + result.stderr)
                    self.assertEqual(len(server.calls), 3)
                    untrusted_env = {key: value for key, value in env.items() if key != 'SSL_CERT_FILE'}
                    result = subprocess.run([sys.executable, str(SCRIPT), '--query', 'SLACK'],
                                            env=untrusted_env, cwd=directory, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(json.loads(result.stdout)['code'], 'verified_transport_unavailable')
                    self.assertEqual(len(server.calls), 3, 'no credentials sent over unverified TLS')
                    server.redirect = True
                    result = subprocess.run([sys.executable, str(SCRIPT), '--query', 'SLACK'],
                                            env=env, cwd=directory, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(json.loads(result.stdout)['requests'][0]['kind'], 'redirect_refused')
                    self.assertTrue(all(x.startswith('CONNECT app.infisical.com:443 ') for x in server.connects))
                    self.assertNotIn('MUST_NOT_LEAK', result.stdout + result.stderr)
                finally:
                    server.shutdown()


if __name__ == '__main__':
    unittest.main()
