import importlib.util
import hashlib
import json
import os
import stat
import sys
from copy import deepcopy
from contextlib import redirect_stderr, redirect_stdout
import io
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('official_files', Path(__file__).with_name('official-files.py'))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


def root_file_metadata(uid=0):
    """Model root ownership on unprivileged CI; all bytes/modes/inodes are real."""
    original = os.fstat
    def metadata(fd):
        value = original(fd)
        fields = {name: getattr(value, name) for name in dir(value) if name.startswith('st_')}
        return SimpleNamespace(**{**fields, 'st_uid': uid})
    return patch.object(files.os, 'fstat', side_effect=metadata)


class CliVerification(unittest.TestCase):
    def inventory(self, root):
        private = root / 'mikka'
        release = private / 'releases' / 'pinned' / 'source'
        release.mkdir(parents=True)
        worker = private / 'worker'
        worker.symlink_to(release, target_is_directory=True)
        original = root / 'official-claude'
        original.write_bytes(b'official fixture executable\n')
        original.chmod(0o755)
        added = release / 'codex'
        added.write_bytes(b'private fixture executable\n' + b'x' * (1024 * 1024))
        added.chmod(0o755)
        row = lambda path: {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        manifest = release / '.mikka-original-cli.json'
        manifest.write_text(json.dumps({'version': 1, 'kind': 'desktop',
            'original': {'claude_code': row(original), 'codex': None}, 'added': {'codex': row(added)}}))
        manifest.chmod(0o444)
        return private, worker / manifest.name, original, added

    def test_verifies_real_selected_bytes_through_worker_symlink_without_rewriting_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            private, manifest, original, added = self.inventory(Path(directory))
            before, metadata = manifest.read_bytes(), manifest.stat()
            with patch.object(files, 'PRIVATE', private), root_file_metadata():
                result = files.verify_cli(manifest, 'desktop')
            self.assertEqual(set(result), {'kind', 'files', 'elapsedMs'})
            self.assertEqual(result['kind'], 'desktop')
            self.assertEqual({row['harness']: row['bytes'] for row in result['files']}, {
                'claude_code': original.stat().st_size, 'codex': added.stat().st_size})
            for row in result['files']:
                self.assertEqual(set(row), {'harness', 'bytes', 'elapsedMs', 'matched'})
                self.assertIs(row['matched'], True)
                self.assertGreaterEqual(row['elapsedMs'], 0)
            self.assertNotIn(str(private), json.dumps(result))
            self.assertNotIn('fixture executable', json.dumps(result))
            self.assertEqual(manifest.read_bytes(), before)
            self.assertEqual((manifest.stat().st_ino, manifest.stat().st_mtime_ns, stat.S_IMODE(manifest.stat().st_mode)),
                             (metadata.st_ino, metadata.st_mtime_ns, 0o444))

    def test_changed_added_byte_fails_without_resigning_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            private, manifest, _, added = self.inventory(Path(directory))
            before, metadata = manifest.read_bytes(), manifest.stat()
            with added.open('r+b') as handle:
                handle.write(b'!')
            with patch.object(files, 'PRIVATE', private), root_file_metadata():
                with self.assertRaisesRegex(ValueError, '^runtime_cli_changed$'):
                    files.verify_cli(manifest, 'desktop')
            self.assertEqual(manifest.read_bytes(), before)
            self.assertEqual((manifest.stat().st_ino, manifest.stat().st_mtime_ns, stat.S_IMODE(manifest.stat().st_mode)),
                             (metadata.st_ino, metadata.st_mtime_ns, 0o444))

    def test_manifest_owner_mode_symlink_size_and_cli_canonical_path_fail_closed(self):
        for defect in ('owner', 'writable', 'manifest_link', 'oversized', 'binary_link', 'original_changed', 'missing_harness'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                private, manifest, original, added = self.inventory(Path(directory))
                if defect == 'writable': manifest.chmod(0o644)
                elif defect == 'manifest_link':
                    actual = manifest.resolve()
                    retained = actual.with_suffix('.retained')
                    actual.rename(retained)
                    actual.symlink_to(retained)
                elif defect == 'oversized':
                    manifest.chmod(0o644)
                    manifest.write_text(' ' * 8193)
                    manifest.chmod(0o444)
                elif defect == 'binary_link':
                    retained = added.with_suffix('.retained')
                    added.rename(retained)
                    added.symlink_to(retained)
                elif defect == 'original_changed': original.write_text('changed original')
                elif defect == 'missing_harness':
                    data = json.loads(manifest.read_text())
                    data['added'] = {}
                    manifest.chmod(0o644)
                    manifest.write_text(json.dumps(data))
                    manifest.chmod(0o444)
                with patch.object(files, 'PRIVATE', private), root_file_metadata(uid=1 if defect == 'owner' else 0):
                    with self.assertRaises((ValueError, OSError)):
                        files.verify_cli(manifest, 'desktop')

    def test_cli_emits_only_closed_verification_metadata_on_stderr(self):
        with tempfile.TemporaryDirectory() as directory:
            private, manifest, _, _ = self.inventory(Path(directory))
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(files, 'PRIVATE', private), root_file_metadata(), \
                    patch.object(sys, 'argv', ['official-files.py', 'cli-verify', str(manifest), '--kind', 'desktop']), \
                    redirect_stdout(stdout), redirect_stderr(stderr):
                files.main()
            self.assertEqual(stdout.getvalue(), '')
            result = json.loads(stderr.getvalue().removeprefix('mikka-cli-verification '))
            self.assertEqual([row['harness'] for row in result['files']], ['claude_code', 'codex'])
            self.assertNotIn(str(private), stderr.getvalue())
            self.assertNotIn('fixture executable', stderr.getvalue())

    def test_replacing_a_verified_file_or_manifest_with_identical_bytes_is_rejected(self):
        for target in ('binary', 'manifest'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                private, manifest, original, _ = self.inventory(Path(directory))
                actual_hash, replaced = files.file_sha256, []
                def change_identity(handle):
                    digest = actual_hash(handle)
                    if not replaced:
                        path = original if target == 'binary' else manifest.resolve()
                        replacement = path.with_suffix('.replacement')
                        replacement.write_bytes(path.read_bytes())
                        replacement.chmod(stat.S_IMODE(path.stat().st_mode))
                        replacement.replace(path)
                        replaced.append(True)
                    return digest
                with patch.object(files, 'PRIVATE', private), root_file_metadata(), \
                        patch.object(files, 'file_sha256', side_effect=change_identity):
                    with self.assertRaisesRegex(ValueError, 'runtime_cli_changed|official_cli_manifest_changed'):
                        files.verify_cli(manifest, 'desktop')


class OfficialFiles(unittest.TestCase):
    def test_missing_original_reports_the_exact_manifest_path_and_preserves_the_filesystem_cause(self):
        with tempfile.TemporaryDirectory() as name:
            cli = Path(name) / 'official-cli'
            cli.write_text('original file contents must never be in diagnostics')
            baseline = files.capture([name])
            cli.unlink()
            with self.assertRaisesRegex(RuntimeError, 'official_files_removed ') as raised:
                files.verify(baseline)
            self.assertEqual(json.loads(str(raised.exception).removeprefix('official_files_removed ')), {'path': str(cli)})
            self.assertIsInstance(raised.exception.__cause__, FileNotFoundError)
            self.assertNotIn('original file contents', str(raised.exception))

    def test_provider_certificate_relinks_require_exact_measured_target_and_same_certificate_bytes(self):
        rules, _ = files.finalization_policy('claude')
        certificate = next(value['_certificate'] for value in rules.values() if value.get('_certificate') and not value['_certificate'].get('providerRoot'))
        original = {'path': certificate['path'], 'kind': 'file', 'mode': 0o644, 'uid': 0, 'gid': 0, 'sha256': certificate['sha256']}
        updated = {'path': certificate['path'], 'kind': 'link', 'mode': 0o777, 'uid': 0, 'gid': 0, 'target': certificate['target']}
        with patch.object(files.Path, 'resolve', return_value=Path('/usr/share/ca-certificates/mozilla/fixture.crt')), \
             patch.object(files, 'entry', side_effect=[updated, {**original, 'path': '/usr/share/ca-certificates/mozilla/fixture.crt'}]):
            final = files.verify({'version': 1, 'entries': [original]}, 'claude')
        self.assertEqual(final['before'], final['after'])
        change = final['providerChanges'][0]
        self.assertEqual(change['resolvedSha256'], certificate['sha256'])
        for mutate in [lambda row: row['after'].update(target='/opt/mikka/replaced.crt'),
                       lambda row: row.update(resolvedSha256='a' * 64),
                       lambda row: row.update(path='/etc/ssl/certs/unobserved.pem'),
                       lambda row: row['before'].update(sha256='a' * 64),
                       lambda row: row['after'].update(uid=1000)]:
            bad = deepcopy(change)
            mutate(bad)
            if 'uid' in bad['after']: bad['before']['uid'] = 0
            self.assertFalse(files.permitted_provider_change(bad, rules))
        with patch.object(files, 'entry', return_value=updated):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify({'version': 1, 'entries': [original]})

    def test_cli_capture_uses_original_realpath_without_executing_or_accepting_private_fallback(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            private = root / 'mikka'
            private.mkdir()
            original = root / 'official-claude'
            original.write_text('#!/bin/sh\nexit 49\n')
            original.chmod(0o755)
            (root / 'claude').symlink_to(original)
            replacement = private / 'claude'
            replacement.write_text('wrong fallback')
            replacement.chmod(0o755)
            baseline = files.capture([str(root)], private)
            with patch.object(files, 'PRIVATE', private), patch.dict(os.environ, {'PATH': f'{private}:{root}'}):
                captured = files.capture_cli('claude', baseline)
                self.assertEqual(captured['original']['claude_code'], {
                    'path': str(original), 'sha256': hashlib.sha256(original.read_bytes()).hexdigest()})
                self.assertIsNone(captured['original']['codex'])
                original.write_text('changed original')
                with self.assertRaisesRegex(ValueError, 'official_cli_baseline_mismatch'):
                    files.capture_cli('claude', baseline)
                with patch.dict(os.environ, {'PATH': str(private)}):
                    with self.assertRaisesRegex(ValueError, 'official_cli_missing'):
                        files.capture_cli('claude')

    def test_versioned_cli_inventory_survives_atomic_stage_move_and_preserves_previous(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            private = root / 'mikka'
            old = private / 'releases' / 'old'
            stage = private / 'releases' / '.stage-new'
            destination = private / 'releases' / 'new'
            old.mkdir(parents=True)
            stage.mkdir()
            original = root / 'codex'
            original.write_text('official codex')
            original.chmod(0o755)
            inventory = {'version': 1, 'kind': 'codex', 'original': {
                'claude_code': None, 'codex': {'path': str(original), 'sha256': hashlib.sha256(original.read_bytes()).hexdigest()}}, 'added': {}}
            prior = old / '.mikka-original-cli.json'
            prior.write_text(json.dumps(inventory))
            previous_bytes = prior.read_bytes()
            private_cli = stage / 'claude'
            private_cli.write_text('private missing harness')
            private_cli.chmod(0o755)
            with patch.object(files, 'PRIVATE', private):
                finalized = files.finalize_cli(inventory, 'codex', {'claude_code': str(private_cli)}, stage, destination)
                manifest = stage / '.mikka-original-cli.json'
                manifest.write_text(json.dumps(finalized))
                stage.rename(destination)
                self.assertEqual(finalized['added']['claude_code']['path'], str(destination / 'claude'))
                self.assertEqual(hashlib.sha256((destination / 'claude').read_bytes()).hexdigest(), finalized['added']['claude_code']['sha256'])
                self.assertEqual(prior.read_bytes(), previous_bytes)
                self.assertEqual(finalized['original'], inventory['original'])
                original.write_text('overwritten official CLI')
                with self.assertRaisesRegex(ValueError, 'official_cli_changed'):
                    files.finalize_cli(finalized, 'codex', {'claude_code': str(destination / 'claude')})

    def test_cli_manifest_rejects_missing_desktop_harness_and_replacement_of_original(self):
        original = {'path': '/usr/local/bin/claude', 'sha256': 'a' * 64}
        private = {'path': '/opt/mikka/releases/current/claude', 'sha256': 'b' * 64}
        manifest = {'version': 1, 'kind': 'desktop', 'original': {'claude_code': None, 'codex': None}, 'added': {'claude_code': private}}
        with self.assertRaisesRegex(ValueError, 'runtime_cli_missing'):
            files.validate_cli_manifest(manifest, 'desktop')
        files.validate_cli_manifest(manifest, 'desktop', complete=False)
        manifest['original']['claude_code'] = original
        with self.assertRaisesRegex(ValueError, 'official_cli_manifest_invalid'):
            files.validate_cli_manifest(manifest, 'desktop', complete=False)
        manifest['added'] = {}
        manifest['extra'] = True
        with self.assertRaisesRegex(ValueError, 'official_cli_manifest_invalid'):
            files.validate_cli_manifest(manifest, 'desktop', complete=False)
        for malformed in [None, [], {'version': 1, 'kind': 'codex', 'original': [], 'added': {}}]:
            with self.assertRaisesRegex(ValueError, 'official_cli_manifest_invalid'):
                files.validate_cli_manifest(malformed, 'codex')

    def test_only_control_proven_fields_may_change_during_e2b_finalization(self):
        original = {'path': '/.e2b', 'kind': 'file', 'mode': 0o644, 'uid': 0, 'gid': 0, 'sha256': 'a' * 64}
        baseline = {'version': 1, 'entries': [original]}
        updated = {**original, 'sha256': 'b' * 64}
        with patch.object(files, 'entry', return_value=updated):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)
            final = files.verify(baseline, 'codex')
            self.assertEqual(final['before'], final['after'])
            self.assertNotEqual(final['originalBefore'], final['originalAfter'])
            self.assertEqual(final['providerChanges'][0]['path'], '/.e2b')
        for path, update in [('/usr/local/bin/codex', {'sha256': 'b' * 64}),
                             ('/.e2b', {'uid': 1000}),
                             ('/usr/local/share/e2b/ssl-certs.tar', {'mode': 0o666}),
                             ('/etc/ssl/certs/unobserved.crt', {'sha256': 'b' * 64})]:
            before = {**original, 'path': path}
            with patch.object(files, 'entry', return_value={**before, **update}):
                with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                    files.verify({'version': 1, 'entries': [before]}, 'codex')
        certificate = {**original, 'path': '/usr/local/share/e2b/ssl-certs.tar'}
        with patch.object(files, 'entry', return_value={**certificate, 'mode': 0o777}):
            self.assertEqual(files.verify({'version': 1, 'entries': [certificate]}, 'codex')['providerChanges'][0]['after'], {'mode': 0o777})

    def test_provider_ca_digest_changes_only_during_finalization_with_unchanged_identity(self):
        path = '/usr/local/share/ca-certificates/e2b-ca.crt'
        cases = [('claude', 'a' * 64, 'b' * 64),
                 # Actual desktop fresh_scan failure from main run 42334937454.
                 ('desktop', '4e067e215d0664f4cfeb733d74824a4ba52eb57635a6e365fd27bac0b19e5a9e',
                  '98d3ae906242016c071b5d1902c7b5c6fd5fe56b277c51b407d80d14cf6dde2d')]
        for template, before_sha, after_sha in cases:
            with self.subTest(template=template):
                original = {'path': path, 'kind': 'file', 'mode': 0o644, 'uid': 0, 'gid': 0, 'sha256': before_sha}
                baseline = {'version': 1, 'entries': [original]}
                updated = {**original, 'mode': 0o777, 'sha256': after_sha}
                with patch.object(files, 'entry', return_value=original):
                    installation = files.verify(baseline)
                with patch.object(files, 'entry', return_value=updated):
                    # Ordinary installation still rejects the exact observed difference.
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify(baseline)
                    final = files.verify(baseline, template)
                    self.assertEqual(final['before'], final['after'])
                    self.assertNotEqual(final['originalBefore'], final['originalAfter'])
                    self.assertEqual(final['providerChanges'], [{'path': path, 'kind': 'file',
                        'before': {'mode': 0o644, 'sha256': before_sha}, 'after': {'mode': 0o777, 'sha256': after_sha}}])
                proof = {**installation, 'finalization': final}
                self.assertIs(files.validate_receipt(proof, template), proof)
                with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                    files.validate_receipt({**proof, 'after': final['originalAfter']}, template)
                for change in [{'mode': 0o755}, {'uid': 1000}, {'gid': 1000}, {'kind': 'link', 'target': '/tmp/replaced'},
                               {'sha256': 'not-a-digest'}]:
                    with self.subTest(change=change), patch.object(files, 'entry', return_value={**updated, **change}):
                        with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                            files.verify(baseline, template)
                other = {**original, 'path': '/usr/local/share/ca-certificates/unobserved.crt'}
                with patch.object(files, 'entry', return_value={**other, 'sha256': after_sha}):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify({'version': 1, 'entries': [other]}, template)

    def test_finalization_receipt_cannot_replace_strict_installation_proof(self):
        original = {'path': '/.e2b', 'kind': 'file', 'mode': 0o644, 'uid': 0, 'gid': 0, 'sha256': 'a' * 64}
        baseline = {'version': 1, 'entries': [original]}
        with patch.object(files, 'entry', return_value=original):
            proof = files.verify(baseline)
            with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                files.validate_receipt(proof, 'claude')
            proof['finalization'] = files.verify(baseline, 'claude')
        self.assertIs(files.validate_receipt(proof, 'claude'), proof)
        with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
            files.validate_receipt(proof, 'desktop')
        proof['after'] = {**proof['after'], 'sha256': 'c' * 64}
        with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
            files.validate_receipt(proof, 'claude')

    def test_an_unreadable_original_directory_cannot_be_silently_skipped(self):
        with tempfile.TemporaryDirectory() as name:
            with patch.object(files.os, 'scandir', side_effect=PermissionError('fixture unreadable directory')):
                with self.assertRaises(PermissionError):
                    files.capture([name])

    def test_persistent_paths_outside_package_directories_are_protected(self):
        self.assertEqual(files.ROOTS, ('/',))
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            for relative in ('var/lib/official-runtime/state', 'srv/official/cli', 'data/base/vendor.js'):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original')
            baseline = files.capture([str(root)])
            (root / 'var/lib/official-runtime/state').write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)

    def test_addition_is_allowed_but_modifying_or_removing_an_original_fails(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            cli = root / 'claude'
            cli.write_text('official complete CLI')
            cli.chmod(0o755)
            (root / 'codex').symlink_to('claude')
            baseline = files.capture([str(root)])
            (root / 'mikka').mkdir()
            (root / 'mikka' / 'node').write_text('private runtime')
            proof = files.verify(baseline)
            self.assertEqual(proof['before'], proof['after'])
            cli.write_text('broken replacement')
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)
            cli.write_text('official complete CLI')
            cli.chmod(0o700)
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)
            cli.chmod(0o755)
            cli.unlink()
            with self.assertRaisesRegex(RuntimeError, 'official_files_removed'):
                files.verify(baseline)

    def test_private_root_is_excluded_but_original_links_and_packages_are_protected(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            private = root / 'mikka'
            private.mkdir()
            (private / 'cache').write_text('before')
            official = root / 'package'
            official.mkdir()
            (official / 'dependency.js').write_text('dependency')
            link = root / 'cli'
            link.symlink_to('package/dependency.js')
            baseline = files.capture([str(root)], private)
            (private / 'cache').write_text('after')
            self.assertEqual(files.verify(baseline)['before'], files.verify(baseline)['after'])
            link.unlink()
            link.symlink_to('mikka/cache')
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)


if __name__ == '__main__':
    unittest.main()
