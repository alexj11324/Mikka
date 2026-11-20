"""Read a verified service ZIP and extract only its bounded, regular UI files."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import zipfile


def require(condition):
    if not condition:
        raise ValueError('nightly_ui_archive_invalid')


def safe_name(name):
    require(isinstance(name, str) and name and '\\' not in name and '\x00' not in name)
    parts = name.rstrip('/').split('/')
    require(all(part and part not in ('.', '..') for part in parts))
    require(not PurePosixPath(name).is_absolute())
    return name.rstrip('/')


def unpack(archive, destination, expected):
    require(expected['artifacts']['assets']['path'] == 'web.tar.gz')
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        require(1 <= len(entries) <= 100 and sum(entry.file_size for entry in entries) <= 256 * 1024 * 1024)
        names = set()
        allowed = {'service-receipt.json'} | {value['path'] for value in expected['artifacts'].values()}
        for entry in entries:
            name = safe_name(entry.orig_filename)
            require(name not in names and not entry.flag_bits & 1)
            names.add(name)
            require(stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR))
            if not entry.is_dir():
                require(name in allowed)
        receipt = json.loads(bundle.read('service-receipt.json'))
        require(receipt['service'] == 'web' and receipt['reused'] is False)
        for field in ('kind', 'contextDigest', 'sourceCommit', 'overlayCommit', 'release', 'artifacts'):
            require(receipt[field] == expected[field])
        for field in ('runId', 'runAttempt', 'workflow'):
            require(receipt['build'][field] == expected['build'][field])
        for artifact in expected['artifacts'].values():
            content = bundle.read(artifact['path'])
            require('sha256:' + hashlib.sha256(content).hexdigest() == artifact['digest'])
        tar_bytes = bundle.read('web.tar.gz')
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode='r:gz') as tar:
        members = tar.getmembers()
        require(1 <= len(members) <= 10000 and sum(member.size for member in members) <= 512 * 1024 * 1024)
        files, seen = {}, set()
        for member in members:
            name = safe_name(member.name)
            require(name not in seen)
            seen.add(name)
            require(member.isdir() or member.isfile())
            require(name in ('site', 'proof') or name.startswith('site/') or name == 'proof/renderer-manifest.json')
            require(name != 'site/renderer-manifest.json')
            if member.isfile():
                require(member.size <= 64 * 1024 * 1024)
                files[name] = tar.extractfile(member).read()
        proof = json.loads(files['proof/renderer-manifest.json'])
        require(proof['target'] == 'web' and proof['serverModules'] == [])
        require(any(path.startswith('.hosted-ui/slots/') for path in proof['inputs']))
        html = files['site/index.html'].decode()
        shell_assets = re.findall(r'\b(?:src|href)=["\'](/mikka/[^"\']*)["\']', html)
        require(any(path.startswith('/mikka/assets/') for path in shell_assets))
        from urllib.parse import parse_qs, urlsplit
        require(all(parse_qs(urlsplit(path.replace('&amp;', '&')).query).get('dpl') == [expected['release']] for path in shell_assets))
        destination = Path(destination)
        destination.mkdir(mode=0o700)
        for name, content in files.items():
            path = destination / ('renderer-manifest.json' if name == 'proof/renderer-manifest.json' else name.removeprefix('site/'))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)


if __name__ == '__main__':
    try:
        unpack(sys.argv[1], sys.argv[2], json.load(sys.stdin))
    except Exception:
        sys.stderr.write('nightly_ui_archive_invalid\n')
        sys.exit(1)
