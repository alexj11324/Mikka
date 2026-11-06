"""Attest that additions leave every original official file and link intact.

Run capture before any Mikka installation and verify afterwards. The manifest
contains paths and hashes, never file contents. New paths are allowed; changes
to an original entry's bytes, type, permissions, ownership or link are refused.
"""
import argparse
import hashlib
import json
import os
import stat
from pathlib import Path

ROOTS = ('/bin', '/sbin', '/lib', '/lib64', '/usr', '/etc', '/opt', '/root',
         '/home', '/var/lib/dpkg')
PRIVATE = Path('/opt/mikka')


def entry(path):
    info = path.lstat()
    row = {'path': str(path), 'mode': stat.S_IMODE(info.st_mode),
           'uid': info.st_uid, 'gid': info.st_gid}
    if stat.S_ISLNK(info.st_mode):
        row.update(kind='link', target=os.readlink(path))
    elif stat.S_ISREG(info.st_mode):
        digest = hashlib.sha256()
        with path.open('rb') as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(block)
        row.update(kind='file', sha256=digest.hexdigest())
    elif stat.S_ISDIR(info.st_mode):
        row.update(kind='directory')
    else:
        row.update(kind='special', type=stat.S_IFMT(info.st_mode), device=info.st_rdev)
    return row


def capture(roots=ROOTS, private=PRIVATE):
    paths = set()
    for base in map(Path, roots):
        if not base.exists() and not base.is_symlink():
            continue
        paths.add(base)
        if base.is_dir() and not base.is_symlink():
            for directory, directories, files in os.walk(base, followlinks=False):
                here = Path(directory)
                directories[:] = [name for name in directories if here / name != private]
                paths.update(here / name for name in (*directories, *files)
                             if here / name != private)
    return {'version': 1, 'roots': list(roots),
            'entries': [entry(path) for path in sorted(paths) if path != private]}


def receipt(rows):
    encoded = json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()
    return {'entries': len(rows), 'sha256': hashlib.sha256(encoded).hexdigest()}


def verify(manifest):
    if manifest.get('version') != 1 or not manifest.get('entries'):
        raise ValueError('official_manifest_invalid')
    before = manifest['entries']
    try:
        after = [entry(Path(row['path'])) for row in before]
    except (FileNotFoundError, NotADirectoryError) as error:
        raise RuntimeError('official_files_removed') from error
    if before != after:
        raise RuntimeError('official_files_changed')
    return {'before': receipt(before), 'after': receipt(after)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['capture', 'verify'])
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    if args.action == 'capture':
        # Refuse to replace a prior baseline, including a dangling symlink.
        with args.manifest.open('x') as handle:
            manifest = capture()
            json.dump(manifest, handle, separators=(',', ':'))
        result = receipt(manifest['entries'])
    else:
        result = verify(json.loads(args.manifest.read_text()))
    if args.receipt:
        with args.receipt.open('x') as handle:
            json.dump(result, handle, separators=(',', ':'))
            handle.write('\n')
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()
