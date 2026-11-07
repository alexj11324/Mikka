"""Download two exact Actions artifacts; preserve only five known safe JSON reports.

Run in a PTY. The signed URLs arrive once on stdin with terminal echo disabled.
The caller supplies GitHub artifact metadata; ZIP bytes must match size and SHA256.
No URL, ZIP, PNG, credential, or raw runtime log is persisted or printed.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import termios
from urllib.parse import urlsplit
from urllib.request import urlopen
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--run', type=int, required=True)
parser.add_argument('--source', required=True)
parser.add_argument('--harness', required=True)
options = parser.parse_args()
assert all(re.fullmatch(r'[a-f0-9]{40}', x) for x in [options.source, options.harness])
root = Path(options.output)
assert not root.exists(), 'OUTPUT_ALREADY_EXISTS'
expected_members = {
    'native': {'lifecycle.json', 'parity/parity.json', 'smoke.json'},
    'package': {'mac-acceptance-package.json', 'native-crypto.json'},
}
patterns = {
    'email': re.compile(rb'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'),
    'credential': re.compile(rb'\b(?:phx_|ghp_|github_pat_|sk-(?:proj-|ant-)?)[A-Za-z0-9_-]{12,}'),
    'private_key': re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
    'bearer': re.compile(rb'Bearer\s+[A-Za-z0-9._~+/-]{12,}', re.I),
    'signed_query': re.compile(rb'(?:X-Amz-Signature|X-Goog-Signature|[?&]sig)=[A-Za-z0-9%]+', re.I),
}
sensitive_key = re.compile(r'^(?:password|secret|privatekey|authorization|cookie|email|access_token|refresh_token|id_token|code_verifier)$', re.I)

def sensitive_values(value):
    if isinstance(value, dict):
        return sum(int(bool(sensitive_key.fullmatch(str(k))) and isinstance(v, str) and bool(v)) + sensitive_values(v) for k, v in value.items())
    if isinstance(value, list):
        return sum(sensitive_values(v) for v in value)
    return 0

try:
    assert sys.stdin.isatty(), 'PTY_REQUIRED'
    terminal = termios.tcgetattr(sys.stdin.fileno())
    terminal[3] &= ~(termios.ECHO | termios.ICANON)
    terminal[6][termios.VMIN] = 1
    terminal[6][termios.VTIME] = 0
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, terminal)
    print(json.dumps({'awaiting': 'artifact_refs', 'echo': False}), flush=True)
    requests = json.loads(sys.stdin.readline())
    assert isinstance(requests, list) and len(requests) == 2
    assert {row['kind'] for row in requests} == set(expected_members)
    reports, artifacts, privacy = {}, [], []
    for row in requests:
        kind = row['kind']
        meta = row['metadata']
        assert isinstance(meta['id'], int) and meta['id'] > 0
        assert meta['name'] == f'desktop-{"native" if kind == "native" else "package"}-evidence-{options.harness}'
        assert meta['workflow_run']['id'] == options.run
        assert meta['workflow_run']['head_sha'] == options.source
        assert meta.get('expired') is False
        digest = meta['digest'].removeprefix('sha256:')
        assert re.fullmatch(r'[a-f0-9]{64}', digest)
        assert 0 < meta['size_in_bytes'] <= 64 * 1024 * 1024
        url = row['url']
        target = urlsplit(url)
        assert target.scheme == 'https' and target.hostname and target.username is None and target.password is None
        with urlopen(url, timeout=45) as response:
            data = response.read(64 * 1024 * 1024 + 1)
        assert len(data) == meta['size_in_bytes'], 'ZIP_SIZE_MISMATCH'
        assert hashlib.sha256(data).hexdigest() == digest, 'ZIP_DIGEST_MISMATCH'
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            assert len(entries) <= 2000
            assert all(not PurePosixPath(x.filename).is_absolute() and '..' not in PurePosixPath(x.filename).parts for x in entries)
            assert all(not stat.S_ISLNK(x.external_attr >> 16) for x in entries)
            assert len({x.filename for x in entries}) == len(entries)
            assert expected_members[kind].issubset({x.filename for x in entries})
            for name in sorted(expected_members[kind]):
                assert name not in reports
                info = archive.getinfo(name)
                assert 0 < info.file_size <= 16 * 1024 * 1024
                raw = archive.read(info)
                document = json.loads(raw)
                counts = {name: len(pattern.findall(raw)) for name, pattern in patterns.items()}
                sensitive = sensitive_values(document)
                assert not any(counts.values()) and sensitive == 0, 'PRIVACY_SCAN_FAILED'
                reports[name] = raw
                privacy.append({'member': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'patternMatches': counts, 'sensitiveNonemptyStringFields': sensitive})
        artifacts.append({'id': meta['id'], 'kind': kind, 'name': meta['name'], 'bytes': len(data), 'sha256': digest, 'headSha': options.source, 'workflowRunId': options.run, 'digestVerified': True, 'zipRetained': False})
        del data, url
    assert len(reports) == 5
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, raw in reports.items():
        destination = root / name
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(raw)
    receipt = {'version': 1, 'repository': 'alexj11324/Mikka', 'runId': options.run, 'source': options.source, 'harness': options.harness, 'artifacts': artifacts, 'scope': 'Known JSON members only; ZIP verified in memory then discarded; no URL, PNG or runtime log retained.'}
    (root / 'download-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (root / 'privacy-scan.json').write_text(json.dumps({'version': 1, 'status': 'passed', 'scope': receipt['scope'], 'files': privacy}, indent=2) + '\n')
    print(json.dumps({'ok': True, 'runId': options.run, 'files': privacy, 'artifacts': artifacts, 'output': str(root)}), flush=True)
except Exception as error:
    print(json.dumps({'ok': False, 'errorName': type(error).__name__, 'code': 'ARTIFACT_VERIFY_OR_PRIVACY_FAILED'}), flush=True)
    raise SystemExit(1)
