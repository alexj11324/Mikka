"""Runs inside this acceptance task's own VM, never on an Actions host.

The device credential and provider leases stay in this process. Only the closed
receipt is printed. No token lifetime, provider grant or daemon timer is changed.
"""
import datetime
import json
import pathlib
import time
import urllib.error
import urllib.request


def probe(marker, harness, max_wait=540):
    root = pathlib.Path('/home/user/.mikka/worker')
    device = json.loads((root / 'device.json').read_text())
    journal = json.loads((root / 'runs.json').read_text())
    matches = [row['assignment'] for row in journal['runs'].values()
               if row['state'] in ('preparing', 'running')
               and row['assignment']['harness'] == harness
               and marker in row['assignment'].get('prompt', '')
               and row['assignment']['deviceId'] == device['deviceId']]
    if len(matches) != 1:
        return {'status': 'scope_refused'}
    run = matches[0]
    url = 'https://app.aspectlylabs.com/mikka/v1/devices/' + device['deviceId'] + '/runs/' + run['runId'] + '/subscription-lease'

    def lease():
        request = urllib.request.Request(url, method='POST', headers={
            'Authorization': 'Bearer ' + device['credential'], 'Content-Type': 'application/json'})
        # urllib's default redirect handler must not forward this credential.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        try:
            with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
                value = json.load(response)
                expires = datetime.datetime.fromisoformat(value['expiresAt'].replace('Z', '+00:00')).timestamp()
                valid = response.status == 200 and bool(value.get('accessToken')) and expires > time.time()
                valid = valid and value['modelId'] == ('gpt-6-luna' if harness == 'codex' else 'claude-haiku-5-5')
                valid = valid and value.get('route') == ('codex_cli' if harness == 'codex' else 'claude_code_cli')
                identity = (value.get('accountId'), value.get('revision'))
                valid = valid and isinstance(identity[0], str) and bool(identity[0])
                return response.status, valid, expires, identity
        except urllib.error.HTTPError as error:
            return error.code, False, 0, None

    status, valid, expires, identity = lease()
    receipt = {'runId': run['runId'], 'harness': harness, 'httpStatus': status, 'valid': valid,
               'expiresAt': int(expires), 'naturalWindowObserved': False}
    if not valid:
        return {**receipt, 'status': 'lease_refused'}
    wait = expires - time.time() + 10
    if wait < 75 or wait > max_wait:
        return {**receipt, 'status': 'outside_natural_window'}
    # One real expiry event; no fake clock, shortened lease or explicit refresh.
    time.sleep(wait)
    next_status, next_valid, next_expiry, next_identity = lease()
    return {**receipt, 'status': 'renewed' if next_valid and next_expiry > expires and identity == next_identity else 'renewal_failed',
            'renewHttpStatus': next_status, 'renewValid': next_valid, 'renewExpiresAt': int(next_expiry),
            'naturalWindowObserved': True}


def main(marker, harness):
    try:
        result = probe(marker, harness)
    except Exception:
        result = {'status': 'probe_failed'}
    print('MIKKA_LEASE_AUDIT=' + json.dumps(result, separators=(',', ':')))
