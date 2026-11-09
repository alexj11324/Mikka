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
import shutil
import stat
import sys
import time
from pathlib import Path

ROOTS = ('/',)
# Kernel mounts, process state, temporary files and live logs are not shipped
# software. Every other original path is protected, including /var/lib, /srv,
# /data, unusual CLI locations and future base-template directories.
TRANSIENT = frozenset(map(Path, ('/dev', '/proc', '/sys', '/run', '/tmp', '/var/tmp', '/var/log')))
PRIVATE = Path('/opt/mikka')
FINALIZATION_POLICY = Path(__file__).with_name('e2b-finalization-files.json')
CERTIFICATE_RELINKS = Path(__file__).with_name('e2b-certificate-relinks.json')
CLI_NAMES = {'claude_code': 'claude', 'codex': 'codex'}


def capture_cli(kind, manifest=None):
    if kind not in ('claude', 'codex', 'desktop'):
        raise ValueError('official_cli_kind_invalid')
    paths = [path for path in os.environ.get('PATH', '').split(os.pathsep)
             if path.startswith('/') and not Path(path).is_relative_to(PRIVATE)]
    paths.append('/home/user/.local/bin')
    original = {}
    baseline = {row['path']: row for row in manifest['entries']} if manifest else None
    for harness, command in CLI_NAMES.items():
        found = shutil.which(command, path=os.pathsep.join(paths))
        if not found:
            original[harness] = None
            continue
        path = Path(found).resolve(strict=True)
        row = entry(path)
        if path.is_relative_to(PRIVATE) or row.get('kind') != 'file':
            raise ValueError('official_cli_path_invalid')
        if baseline is not None and baseline.get(str(path)) != row:
            raise ValueError('official_cli_baseline_mismatch')
        original[harness] = {'path': str(path), 'sha256': row['sha256']}
    required = {'claude': 'claude_code', 'codex': 'codex'}.get(kind)
    if required and original[required] is None:
        raise ValueError('official_cli_missing')
    return {'version': 1, 'kind': kind, 'original': original, 'added': {}}


def validate_cli_manifest(manifest, kind, complete=True):
    if (not isinstance(manifest, dict) or set(manifest) != {'version', 'kind', 'original', 'added'}
            or kind not in ('claude', 'codex', 'desktop') or manifest.get('version') != 1 or manifest.get('kind') != kind
            or not isinstance(manifest.get('original'), dict) or set(manifest['original']) != set(CLI_NAMES)
            or not isinstance(manifest.get('added'), dict) or set(manifest['added']) - set(CLI_NAMES)):
        raise ValueError('official_cli_manifest_invalid')
    for origin in ('original', 'added'):
        for harness, binary in manifest[origin].items():
            if origin == 'original' and binary is None:
                continue
            if (not isinstance(binary, dict) or set(binary) != {'path', 'sha256'}
                    or not isinstance(binary['path'], str) or not Path(binary['path']).is_absolute()
                    or str(Path(binary['path'])) != binary['path'] or '..' in Path(binary['path']).parts
                    or not isinstance(binary['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', binary['sha256'])
                    or Path(binary['path']).is_relative_to(PRIVATE) != (origin == 'added')
                    or (origin == 'added' and manifest['original'][harness] is not None)):
                raise ValueError('official_cli_manifest_invalid')
    required = ('claude_code', 'codex') if kind == 'desktop' else ({'claude': 'claude_code', 'codex': 'codex'}[kind],)
    if kind != 'desktop' and manifest['original'][required[0]] is None:
        raise ValueError('official_cli_missing')
    if complete and any(manifest['original'][harness] is None and harness not in manifest['added'] for harness in required):
        raise ValueError('runtime_cli_missing')
    return manifest


def finalize_cli(manifest, kind, added_paths, relocate_from=None, relocate_to=None):
    validate_cli_manifest(manifest, kind, complete=False)
    if (bool(relocate_from) != bool(relocate_to)
            or (relocate_from and (not relocate_from.is_relative_to(PRIVATE) or not relocate_to.is_relative_to(PRIVATE)))):
        raise ValueError('cli_relocation_invalid')
    if not isinstance(added_paths, dict) or set(added_paths) - set(CLI_NAMES):
        raise ValueError('added_cli_paths_invalid')
    added = {}
    for harness, original in manifest['original'].items():
        if original is not None:
            path = Path(original['path']).resolve(strict=True)
            row = entry(path)
            if (str(path) != original['path'] or path.is_relative_to(PRIVATE) or row.get('kind') != 'file'
                    or row['sha256'] != original.get('sha256') or not os.access(path, os.X_OK)):
                raise ValueError('official_cli_changed')
        elif added_paths.get(harness):
            path = Path(added_paths[harness]).resolve(strict=True)
            row = entry(path)
            if not path.is_relative_to(PRIVATE) or row.get('kind') != 'file' or not os.access(path, os.X_OK):
                raise ValueError('added_cli_path_invalid')
            if relocate_from and path.is_relative_to(relocate_from):
                path = relocate_to / path.relative_to(relocate_from)
            added[harness] = {'path': str(path), 'sha256': row['sha256']}
    return validate_cli_manifest({**manifest, 'added': added}, kind)


def file_sha256(handle):
    digest = hashlib.sha256()
    for block in iter(lambda: handle.read(1024 * 1024), b''):
        digest.update(block)
    return digest.hexdigest()


def file_identity(info):
    # Reading may change atime. Content, permissions and ownership changes
    # change mtime/ctime; a replacement also changes the device/inode pair.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def verify_cli(manifest_path, kind):
    """Read the existing release receipt and verify every selected CLI's bytes.

    This deliberately never calls finalize_cli: finalization establishes an
    added binary's digest, whereas a release check must compare that digest.
    All reads stay inside the caller's catalogue command deadline.
    """
    began = time.perf_counter()
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        canonical_manifest = manifest_path.resolve(strict=True)
        if not canonical_manifest.is_relative_to(PRIVATE):
            raise ValueError('official_cli_manifest_untrusted')
        # The worker directory is an intentional version-selection symlink;
        # the root-owned 0444 receipt itself must be a bounded regular file.
        with os.fdopen(os.open(manifest_path, flags), 'rb') as handle:
            before = os.fstat(handle.fileno())
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0
                    or stat.S_IMODE(before.st_mode) != 0o444 or before.st_size > 8192):
                raise ValueError('official_cli_manifest_untrusted')
            raw = handle.read(8193)
            if len(raw) > 8192:
                raise ValueError('official_cli_manifest_untrusted')
            manifest = validate_cli_manifest(json.loads(raw), kind)
            checked = []
            for harness in CLI_NAMES:
                selected = manifest['original'][harness] or manifest['added'].get(harness)
                if selected is None:
                    continue
                started = time.perf_counter()
                path = Path(selected['path'])
                if path.resolve(strict=True) != path:
                    raise ValueError('runtime_cli_changed')
                with os.fdopen(os.open(path, flags), 'rb') as binary:
                    initial = os.fstat(binary.fileno())
                    if not stat.S_ISREG(initial.st_mode) or not os.access(path, os.X_OK):
                        raise ValueError('runtime_cli_unavailable')
                    digest = file_sha256(binary)
                    if (digest != selected['sha256']
                            or file_identity(os.fstat(binary.fileno())) != file_identity(initial)
                            or path.resolve(strict=True) != path
                            or file_identity(path.lstat()) != file_identity(initial)):
                        raise ValueError('runtime_cli_changed')
                checked.append({'harness': harness, 'bytes': initial.st_size,
                                'elapsedMs': round((time.perf_counter() - started) * 1000), 'matched': True})
            if (manifest_path.resolve(strict=True) != canonical_manifest
                    or file_identity(os.fstat(handle.fileno())) != file_identity(before)
                    or file_identity(manifest_path.lstat()) != file_identity(before)):
                raise ValueError('official_cli_manifest_changed')
    except OSError as error:
        raise ValueError('runtime_cli_unavailable') from error
    return {'kind': kind, 'files': checked, 'elapsedMs': round((time.perf_counter() - began) * 1000)}


def finalization_policy(kind):
    raw = FINALIZATION_POLICY.read_bytes()
    policy = json.loads(raw)
    if policy.get('version') != 1 or kind not in policy.get('templates', {}):
        raise ValueError('e2b_finalization_policy_invalid')
    certificate_bytes = CERTIFICATE_RELINKS.read_bytes()
    if hashlib.sha256(certificate_bytes).hexdigest() != policy.get('certificateRelinksSha256'):
        raise ValueError('e2b_certificate_policy_invalid')
    rules = {**policy['common'], **policy['templates'][kind]}
    # Exact paths, source bytes and link targets observed in an official-only
    # control. This is not an exclusion for /etc/ssl or for software generally.
    for certificate in json.loads(certificate_bytes):
        if kind not in certificate['templates']:
            continue
        rules[certificate['path']] = {
            'kind': {'before': 'file', 'after': 'link'},
            'sha256': {'before': certificate['sha256'], 'after': None},
            'target': {'before': None, 'after': certificate['target']},
            **({'mode': certificate['mode']} if 'mode' in certificate else {}),
            '_certificate': certificate,
        }
    return rules, hashlib.sha256(raw).hexdigest()


def permitted_provider_change(change, rules):
    allowed = rules.get(change['path'], {})
    # Reserved rule metadata keeps kind protected in the stable receipt.
    expected_kind = allowed.get('_kind')
    if expected_kind is not None and change.get('kind') != expected_kind:
        return False
    certificate = allowed.get('_certificate')
    if certificate:
        if (change.get('kind') != 'file' or change['before'].get('kind') != 'file' or change['after'].get('kind') != 'link'
                or not re.fullmatch(r'[a-f0-9]{64}', change.get('resolvedSha256', ''))
                or (not certificate.get('providerRoot') and change['resolvedSha256'] != certificate['sha256'])):
            return False
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
        with path.open('rb') as handle:
            digest = file_sha256(handle)
        row.update(kind='file', sha256=digest)
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
    if not isinstance(proof, dict) or not isinstance(proof.get('finalization'), dict):
        raise ValueError('official_conservation_invalid')
    before, after, final = proof.get('before'), proof.get('after'), proof['finalization']
    rules, policy_sha = finalization_policy(kind)
    if (not valid_digest(before) or before != after or final.get('kind') != kind
            or final.get('policySha256') != policy_sha or final.get('originalBefore') != before
            or not valid_digest(final.get('originalAfter'))
            or not valid_digest(final.get('before')) or final['before'] != final.get('after')
            or final['before']['entries'] != before['entries']
            or final['originalAfter']['entries'] != before['entries']):
        raise ValueError('official_conservation_invalid')
    changes = final.get('providerChanges')
    if (not isinstance(changes, list) or any(not isinstance(change, dict) or not isinstance(change.get('path'), str) for change in changes)
            or len({change['path'] for change in changes}) != len(changes)
            or any(not isinstance(change.get('before'), dict) or not isinstance(change.get('after'), dict)
                   or change['before'].keys() != change['after'].keys()
                   or not permitted_provider_change(change, rules) for change in changes)):
        raise ValueError('official_conservation_invalid')
    return proof


def verify(manifest, e2b_finalization=None):
    if manifest.get('version') != 1 or not manifest.get('entries'):
        raise ValueError('official_manifest_invalid')
    before = manifest['entries']
    after = []
    for row in before:
        try:
            after.append(entry(Path(row['path'])))
        except (FileNotFoundError, NotADirectoryError) as error:
            # Identify the protected entry, not arbitrary exception text or a
            # symlink target outside the original manifest. Refusal is unchanged.
            detail = json.dumps({'path': row['path']}, separators=(',', ':'))
            raise RuntimeError('official_files_removed ' + detail) from error
    changed = [{'path': original['path'], 'kind': original['kind'], 'before': {key: original.get(key) for key in set(original) | set(current) if original.get(key) != current.get(key)},
                'after': {key: current.get(key) for key in set(original) | set(current) if original.get(key) != current.get(key)}}
               for original, current in zip(before, after) if original != current]
    rules, policy_sha = finalization_policy(e2b_finalization) if e2b_finalization else ({}, None)
    for change in changed:
        certificate = rules.get(change['path'], {}).get('_certificate')
        if certificate and change['after'].get('kind') == 'link':
            # Converting a duplicated certificate into a link must keep the
            # certificate bytes. Only the two explicit E2B root references may
            # instead point to the freshly supplied provider root certificate.
            resolved = Path(change['path']).resolve(strict=True)
            resolved_row = entry(resolved)
            if resolved_row.get('kind') != 'file':
                raise RuntimeError('e2b_certificate_target_invalid')
            if certificate.get('providerRoot') and resolved != Path('/usr/local/share/ca-certificates/e2b-ca.crt'):
                raise RuntimeError('e2b_certificate_target_invalid')
            change['resolvedSha256'] = resolved_row['sha256']
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
    parser.add_argument('action', choices=['capture', 'verify', 'cli-capture', 'cli-finalize', 'cli-check', 'cli-verify'])
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--e2b-finalization', choices=['claude', 'codex', 'desktop'])
    parser.add_argument('--kind', choices=['claude', 'codex', 'desktop'])
    parser.add_argument('--cli-manifest', type=Path)
    parser.add_argument('--added')
    parser.add_argument('--inherit', type=Path)
    parser.add_argument('--relocate-from', type=Path)
    parser.add_argument('--relocate-to', type=Path)
    args = parser.parse_args()
    if args.action == 'cli-verify':
        if args.receipt:
            parser.error('cli_verify_is_read_only')
        result = verify_cli(args.manifest, args.kind)
        # Keep the following catalogue command's stdout an array only.
        print('mikka-cli-verification ' + json.dumps(result, separators=(',', ':')), file=sys.stderr, flush=True)
        return
    if args.action == 'capture':
        # Refuse to replace a prior baseline, including a dangling symlink.
        with args.manifest.open('x') as handle:
            manifest = capture()
            json.dump(manifest, handle, separators=(',', ':'))
        result = receipt(manifest['entries'])
        if args.cli_manifest:
            with args.cli_manifest.open('x') as handle:
                json.dump(capture_cli(args.kind, manifest), handle, separators=(',', ':'))
            args.cli_manifest.chmod(0o444)
    elif args.action == 'cli-capture':
        if args.inherit:
            inherited = validate_cli_manifest(json.loads(args.inherit.read_text()), args.kind, complete=False)
            result = {**inherited, 'added': {}}
        else:
            result = capture_cli(args.kind)
        with args.manifest.open('x') as handle:
            json.dump(result, handle, separators=(',', ':'))
        args.manifest.chmod(0o444)
    elif args.action == 'cli-finalize':
        if bool(args.relocate_from) != bool(args.relocate_to):
            raise ValueError('cli_relocation_invalid')
        if args.relocate_from and (not args.relocate_from.is_relative_to(PRIVATE) or not args.relocate_to.is_relative_to(PRIVATE)):
            raise ValueError('cli_relocation_invalid')
        result = finalize_cli(json.loads(args.manifest.read_text()), args.kind, json.loads(args.added or '{}'), args.relocate_from, args.relocate_to)
        temporary = args.manifest.with_suffix('.new')
        with temporary.open('x') as handle:
            json.dump(result, handle, separators=(',', ':'))
        temporary.chmod(0o444)
        temporary.replace(args.manifest)
    elif args.action == 'cli-check':
        result = validate_cli_manifest(json.loads(args.manifest.read_text()), args.kind)
    else:
        result = verify(json.loads(args.manifest.read_text()), args.e2b_finalization)
    if args.receipt:
        with args.receipt.open('x') as handle:
            json.dump(result, handle, separators=(',', ':'))
            handle.write('\n')
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    main()
