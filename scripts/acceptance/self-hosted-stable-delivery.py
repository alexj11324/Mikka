#!/usr/bin/env python3
"""Exercise the installed MTA adapter, host receiver and upstream release API."""
import json
import os
from email.message import EmailMessage
from pathlib import Path
import re
import secrets
import select
import signal
import socket
import subprocess
import sys
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = 'https://api.github.com/repos/alexj11324/Mikka/releases/tags/'


def check(condition, error):
    if not condition:
        raise RuntimeError(error)


def main():
    tag, digest, revision = sys.argv[1:]
    check(re.fullmatch(r'v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', tag), 'invalid stable tag')
    check(re.fullmatch(r'sha256:[a-f0-9]{64}', digest) and re.fullmatch(r'[a-f0-9]{40}', revision), 'invalid release identity')
    with urlopen(Request(UPSTREAM + tag, headers={'User-Agent': 'mikka-stable-acceptance',
                 'Accept': 'application/vnd.github+json'}), timeout=20) as response:
        release = json.load(response)
    check(release['tag_name'] == tag and not release['draft'] and not release['prerelease'], 'upstream release mismatch')
    check(release['html_url'] in release['body'], 'the publisher must include a stable link in the email-visible release body')
    message = EmailMessage()
    message['Subject'] = release['name']
    message.set_content(release['body'])
    with tempfile.TemporaryDirectory(prefix='mikka-stable-delivery-') as installation:
        # The MTA supplies raw MIME to the adapter's stdin. Only the transport
        # envelope is constructed here; the release content and API are public.
        host = Path(installation)
        key = secrets.token_hex(32)
        keyfile = host / 'receiver-secret'
        keyfile.write_text(key)
        keyfile.chmod(0o600)
        state = host / 'state'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = {'PATH': os.environ['PATH'], 'HOME': str(host),
               'MIKKA_UPDATE_WEBHOOK_SECRET': key, 'MIKKA_UPDATE_WEBHOOK_PORT': str(port),
               'MIKKA_UPDATE_POLICY': 'notify', 'MIKKA_UPDATE_STATE_DIR': str(state)}
        with subprocess.Popen(['node', str(ROOT / 'scripts/self-hosted-update-webhook.mjs')],
                              env=env, cwd=host, stdout=subprocess.PIPE) as receiver:
            try:
                check(select.select([receiver.stdout], [], [], 15)[0], 'receiver did not start')
                check(receiver.stdout.readline().strip() == b'SELF_HOSTED_UPDATE_WEBHOOK_READY', 'receiver failed')
                deliver = [sys.executable, str(ROOT / 'scripts/self-hosted-release-mail.py'),
                           '--secret-file', str(keyfile), '--port', str(port)]
                subprocess.run(deliver, input=message.as_bytes(), cwd=host, env=env, check=True, timeout=30)
                record = state / 'pending-release.json'
                first = record.read_bytes()
                pending = json.loads(first)
                check(pending['tag'] == tag and pending['revision'] == revision and pending['status'] == 'notified',
                      'receiver did not resolve the exact stable release through the upstream API')
                subprocess.run(deliver, input=message.as_bytes(), cwd=host, env=env, check=True, timeout=30)
                check(record.read_bytes() == first, 'duplicate event replaced the original receipt')
                invalid = Request(f'http://127.0.0.1:{port}/self-hosted-release-hint', data=b'{}',
                                  headers={'X-Hub-Signature-256': 'sha256=' + '0' * 64})
                try:
                    with urlopen(invalid, timeout=5):
                        raise RuntimeError('invalid signature accepted')
                except HTTPError as error:
                    check(error.code == 401, 'invalid signature returned the wrong status')
                check(record.read_bytes() == first, 'invalid signature changed the receipt')
                result = subprocess.run(['node', str(ROOT / 'scripts/self-hosted-update.mjs'), 'check', tag],
                                        cwd=host, env=env, capture_output=True, check=True, timeout=30)
                verified = json.loads(result.stdout)
                check(verified['image'] == 'ghcr.io/alexj11324/mikka@' + digest and verified['revision'] == revision,
                      'operator CLI returned a different release identity')
            finally:
                receiver.send_signal(signal.SIGTERM)
                receiver.wait(timeout=10)
    evidence = {'policy': 'notify', 'release': release['html_url'], 'releaseId': release['id'],
                'tag': tag, 'revision': revision, 'image': verified['image'],
                'source': 'Live public GitHub Releases REST API', 'receivedAt': pending['receivedAt'],
                'adapter': 'Production MTA stdin pipe and host receiver on loopback',
                'transport': 'MIME constructed from the published body; Internet SMTP delivery was not observed',
                'duplicatePreserved': True, 'invalidSignatureHttpStatus': 401}
    output = ROOT / '.artifacts/self-hosted/delivery.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))


if __name__ == '__main__':
    main()
