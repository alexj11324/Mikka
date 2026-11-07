import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
from urllib.parse import urlsplit
from urllib.request import urlopen
import zipfile

ROOT = Path('/workspace/scratch/812e3b7d6d45/ops1512/evidence/desktop-ad8d')
SOURCE = '212b65491909f064a732c6c1af69a54a6022f184'
HEAD = 'ad8d257129989be43a3cb92e48ccd1197a6d096c'
RUN = 42376245091
KNOWN = {'lifecycle.json', 'parity/parity.json', 'smoke.json', 'native-crypto.json', 'mac-acceptance-package.json'}
PATTERNS = {
    'email': re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}'),
    'credential': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|ph[cp]_[A-Za-z0-9]{20,})'),
    'private_key': re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
    'bearer': re.compile(r'\bBearer\s+[A-Za-z0-9._~+/=\-]{16,}', re.I),
    'signed_query': re.compile(r'(?:X-Amz-(?:Signature|Credential)|X-Goog-Signature|[?&]sig=)', re.I),
}
SENSITIVE = re.compile(r'^(?:email|password|authorization|cookie|set-cookie|access_token|refresh_token|id_token|client_secret|api_key|token|secret)$', re.I)

def check(value, code):
    if not value:
        raise ValueError(code)

def safe_json(member, data):
    check(len(data) <= 4 * 1024 * 1024, 'REPORT_TOO_LARGE')
    text = data.decode('utf-8')
    value = json.loads(text)
    matches = {name: len(pattern.findall(text)) for name, pattern in PATTERNS.items()}
    sensitive = 0
    def walk(item):
        nonlocal sensitive
        if isinstance(item, dict):
            for key, item_value in item.items():
                if SENSITIVE.fullmatch(key) and isinstance(item_value, str) and item_value:
                    sensitive += 1
                walk(item_value)
        elif isinstance(item, list):
            for child in item:
                walk(child)
    walk(value)
    check(not any(matches.values()) and sensitive == 0, 'REPORT_PRIVACY_SCAN_FAILED')
    return value, {'member': member, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                   'patternMatches': matches, 'sensitiveNonemptyStringFields': sensitive}

try:
    request = json.loads(sys.stdin.readline())
    check(request['runId'] == RUN and request['head'] == HEAD and request['source'] == SOURCE, 'SOURCE_IDENTITY_MISMATCH')
    check(len(request['artifacts']) <= 3 and len({item['kind'] for item in request['artifacts']}) == len(request['artifacts']), 'ARTIFACT_SET_INVALID')
    pending, scans, receipts = {}, {}, []
    for item in request['artifacts']:
        kind = item['kind']
        check(kind in {'native', 'package', 'compiled'}, 'ARTIFACT_KIND_INVALID')
        expected_name = {'native': 'desktop-native-evidence-', 'package': 'desktop-package-evidence-', 'compiled': 'desktop-api-build-'}[kind] + SOURCE
        check(item['name'] == expected_name and re.fullmatch(r'[a-f0-9]{64}', item['sha256']), 'ARTIFACT_METADATA_INVALID')
        target = urlsplit(item['url'])
        check(target.scheme == 'https' and target.hostname and not target.username and not target.password, 'DOWNLOAD_URL_INVALID')
        check(isinstance(item['bytes'], int) and 0 < item['bytes'] <= 64 * 1024 * 1024, 'ARTIFACT_SIZE_INVALID')
        content = bytearray()
        with urlopen(item['url'], timeout=90) as response:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                content.extend(block)
                check(len(content) <= item['bytes'], 'ARTIFACT_SIZE_MISMATCH')
        check(len(content) == item['bytes'], 'ARTIFACT_SIZE_MISMATCH')
        digest = hashlib.sha256(content).hexdigest()
        check(digest == item['sha256'], 'ARTIFACT_DIGEST_MISMATCH')
        extracted = []
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            infos = archive.infolist()
            check(len(infos) <= 2000 and len({entry.filename for entry in infos}) == len(infos), 'ARCHIVE_ENTRIES_INVALID')
            for entry in infos:
                name = PurePosixPath(entry.filename)
                check(not name.is_absolute() and '..' not in name.parts and '\\' not in entry.filename, 'ARCHIVE_PATH_INVALID')
                if kind == 'compiled':
                    check(len(infos) == 1 and entry.filename == 'desktop-api-build.tar.gz' and entry.file_size <= 128 * 1024 * 1024, 'COMPILED_ARCHIVE_INVALID')
                    tar_bytes = archive.read(entry)
                    found = False
                    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode='r|gz') as tar:
                        for index, member in enumerate(tar):
                            check(index < 25000, 'COMPILED_ARCHIVE_ENTRIES_EXCEEDED')
                            if member.name.removeprefix('./') != '.output/mikka-build.json':
                                continue
                            check(member.isfile() and member.size <= 65536, 'COMPILED_RECEIPT_INVALID')
                            data = tar.extractfile(member).read()
                            value, scan = safe_json('compiled/mikka-build.json', data)
                            check(value.get('revision') == SOURCE, 'COMPILED_REVISION_MISMATCH')
                            pending['compiled/mikka-build.json'], scans['compiled/mikka-build.json'] = data, scan
                            extracted.append(scan['member'])
                            found = True
                            break
                    check(found, 'COMPILED_RECEIPT_MISSING')
                elif entry.filename in KNOWN:
                    check(entry.file_size <= 4 * 1024 * 1024, 'REPORT_TOO_LARGE')
                    data = archive.read(entry)
                    _, scan = safe_json(entry.filename, data)
                    check(entry.filename not in pending or pending[entry.filename] == data, 'DUPLICATE_REPORT_MISMATCH')
                    pending[entry.filename], scans[entry.filename] = data, scan
                    extracted.append(entry.filename)
        receipts.append({'id': item['id'], 'kind': kind, 'name': item['name'], 'bytes': len(content), 'sha256': digest,
                         'headSha': HEAD, 'workflowRunId': RUN, 'digestVerified': True, 'zipRetained': False,
                         'knownMembersExtracted': extracted})
    compiled_only = {item['kind'] for item in request['artifacts']} == {'compiled'}
    required = {'compiled/mikka-build.json'} if compiled_only else KNOWN
    missing_reports = sorted(required.difference(pending))
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(ROOT, 0o700)
    for member, data in pending.items():
        destination = ROOT / member
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as file:
            file.write(data)
    scope = 'Known JSON members only; ZIP digests verified in memory then discarded; no URL, PNG or runtime log retained.'
    prefix = 'compiled-' if compiled_only else ''
    output = {prefix + 'download-receipt.json': {'version': 1, 'repository': 'alexj11324/Mikka', 'runId': RUN, 'attempt': 1,
              'source': HEAD, 'harness': SOURCE, 'artifacts': receipts, 'scope': scope,
              'reportsComplete': not missing_reports, 'missingReports': missing_reports},
              prefix + 'privacy-scan.json': {'version': 1, 'status': 'passed', 'scope': scope, 'files': list(scans.values())}}
    for member, value in output.items():
        descriptor = os.open(ROOT / member, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as file:
            json.dump(value, file, indent=2)
            file.write('\n')
    print(json.dumps({'status': 'verified', 'runId': RUN, 'source': SOURCE,
                      'artifacts': receipts, 'files': list(scans.values()), 'signedUrlsPersisted': False,
                      'reportsComplete': not missing_reports, 'missingReports': missing_reports}))
except Exception as error:
    codes = {'SOURCE_IDENTITY_MISMATCH', 'ARTIFACT_SET_INVALID', 'ARTIFACT_KIND_INVALID', 'ARTIFACT_METADATA_INVALID',
             'DOWNLOAD_URL_INVALID', 'ARTIFACT_SIZE_INVALID', 'ARTIFACT_SIZE_MISMATCH', 'ARTIFACT_DIGEST_MISMATCH',
             'ARCHIVE_ENTRIES_INVALID', 'ARCHIVE_PATH_INVALID', 'COMPILED_ARCHIVE_INVALID', 'COMPILED_ARCHIVE_ENTRIES_EXCEEDED',
             'COMPILED_RECEIPT_INVALID', 'COMPILED_REVISION_MISMATCH', 'COMPILED_RECEIPT_MISSING', 'REPORT_TOO_LARGE',
             'DUPLICATE_REPORT_MISMATCH', 'REQUIRED_REPORT_MISSING', 'REPORT_PRIVACY_SCAN_FAILED'}
    code = str(error) if isinstance(error, ValueError) and str(error) in codes else 'ARTIFACT_DOWNLOAD_OR_AUDIT_FAILED'
    print(json.dumps({'status': 'failed', 'code': code}))
    raise SystemExit(1)
