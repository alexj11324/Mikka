"""Attest that additions leave every original official file and link intact.

Run capture before any Mikka installation and verify afterwards. The manifest
contains paths and hashes, never file contents. New paths are allowed; changes
to an original entry's bytes, type, permissions, ownership or link are refused.
"""
import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path

ROOTS = ('/',)
# Kernel mounts, process state, temporary files and live logs are not shipped
# software. Every other original path is protected, including /var/lib, /srv,
# /data, unusual CLI locations and future base-template directories.
TRANSIENT = frozenset(map(Path, ('/dev', '/proc', '/sys', '/run', '/tmp', '/var/tmp', '/var/log')))
PRIVATE = Path('/opt/mikka')
FINALIZATION_POLICY = Path(__file__).with_name('e2b-finalization-files.json')


def finalization_policy(kind):
    raw = FINALIZATION_POLICY.read_bytes()
    policy = json.loads(raw)
    if policy.get('version') != 1 or kind not in policy.get('templates', {}):
        raise ValueError('e2b_finalization_policy_invalid')
    return {**policy['common'], **policy['templates'][kind]}, hashlib.sha256(raw).hexdigest()


def permitted_provider_change(change, rules):
    allowed = rules.get(change['path'], {})
    for field, before in change['before'].items():
        after, rule = change['after'][field], allowed.get(field)
        if rule == 'per-boot':
            if field != 'sha256' or not all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in (before, after)):
                return False
        elif not isinstance(rule, dict) or rule != {'before': before, 'after': after}:
            return False
    return bool(change['before'])


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
    excluded = TRANSIENT | {private}
    def refused_scan(error):
        raise error
    for base in map(Path, roots):
        if not base.exists() and not base.is_symlink():
            continue
        paths.add(base)
        if base.is_dir() and not base.is_symlink():
            for directory, directories, files in os.walk(base, followlinks=False, onerror=refused_scan):
                here = Path(directory)
                directories[:] = [name for name in directories if here / name not in excluded]
                paths.update(here / name for name in (*directories, *files)
                             if here / name not in excluded)
    return {'version': 1, 'roots': list(roots),
            'entries': [entry(path) for path in sorted(paths) if path != private]}


def receipt(rows):
    encoded = json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()
    return {'entries': len(rows), 'sha256': hashlib.sha256(encoded).hexdigest()}


def validate_receipt(proof, kind):
    def valid_digest(value):
        return (isinstance(value, dict) and type(value.get('entries')) is int and value['entries'] > 0
                and isinstance(value.get('sha256'), str) and re.fullmatch(r'[a-f0-9]{64}', value['sha256']))
    before, after, final = proof.get('before'), proof.get('after'), proof.get('finalization', {})
    rules, policy_sha = finalization_policy(kind)
    if (not valid_digest(before) or before != after or final.get('kind') != kind
            or final.get('policySha256') != policy_sha or final.get('originalBefore') != before
            or not valid_digest(final.get('originalAfter'))
            or not valid_digest(final.get('before')) or final['before'] != final.get('after')
            or final['before']['entries'] != before['entries']
            or final['originalAfter']['entries'] != before['entries']):
        raise ValueError('official_conservation_invalid')
    changes = final.get('providerChanges')
    if (not isinstance(changes, list) or len({change.get('path') for change in changes}) != len(changes)
            or any(not isinstance(change.get('before'), dict) or not isinstance(change.get('after'), dict)
                   or change['before'].keys() != change['after'].keys()
                   or not permitted_provider_change(change, rules) for change in changes)):
        raise ValueError('official_conservation_invalid')
    return proof


def verify(manifest, e2b_finalization=None):
    if manifest.get('version') != 1 or not manifest.get('entries'):
        raise ValueError('official_manifest_invalid')
    before = manifest['entries']
    try:
        after = [entry(Path(row['path'])) for row in before]
    except (FileNotFoundError, NotADirectoryError) as error:
        raise RuntimeError('official_files_removed') from error
    changed = [{'path': original['path'], 'kind': original['kind'], 'before': {key: original.get(key) for key in set(original) | set(current) if original.get(key) != current.get(key)},
                'after': {key: current.get(key) for key in set(original) | set(current) if original.get(key) != current.get(key)}}
               for original, current in zip(before, after) if original != current]
    rules, policy_sha = finalization_policy(e2b_finalization) if e2b_finalization else ({}, None)
    refused = [change for change in changed if not permitted_provider_change(change, rules)]
    if refused:
        # Diagnostics contain metadata/digests only, never file bytes. Keep the
        # precise path so platform-managed changes cannot justify broad exclusions.
        raise RuntimeError('official_files_changed ' + json.dumps(refused, sort_keys=True, separators=(',', ':')))
    if e2b_finalization:
        # The installation receipt remains an exact whole-original-files check.
        # Only the final E2B boot has the separately measured provider mutations;
        # every other field, including every original CLI byte, stays protected.
        def stable(rows):
            return [{key: value for key, value in row.items() if key not in rules.get(row['path'], {})} for row in rows]
        return {'kind': e2b_finalization, 'policySha256': policy_sha,
                'before': receipt(stable(before)), 'after': receipt(stable(after)),
                'originalBefore': receipt(before), 'originalAfter': receipt(after),
                'providerChanges': changed}
    return {'before': receipt(before), 'after': receipt(after)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['capture', 'verify'])
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--e2b-finalization', choices=['claude', 'codex', 'desktop'])
    args = parser.parse_args()
    if args.action == 'capture':
        # Refuse to replace a prior baseline, including a dangling symlink.
        with args.manifest.open('x') as handle:
            manifest = capture()
            json.dump(manifest, handle, separators=(',', ':'))
        result = receipt(manifest['entries'])
    else:
        result = verify(json.loads(args.manifest.read_text()), args.e2b_finalization)
    if args.receipt:
        with args.receipt.open('x') as handle:
            json.dump(result, handle, separators=(',', ':'))
            handle.write('\n')
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()
