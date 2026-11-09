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

ROOT_CA = '/usr/local/share/ca-certificates/e2b-ca.crt'
# Desktop: official-only control artifact 13538924302, controls.desktop.created.
# Claude: d63 runtime 42326876749 / job 128264238545 fresh-conservation failure.
# The Claude failure is not by itself an official-only control or release pass.
ROOT_CA_ROTATIONS = {
    'desktop': ('7177f680c9c87f91ff9ab72a4409511cc4781d7c3dc549f302bfa17bd973b6b9',
                '88a5a279fec06a155bf9de1dd28abc93aae0f17db5f9febe69d5e25b15f8ff4d'),
    'claude': ('fd1175201e861f159f0d6ae42523b0f5d754ade8a36d105e8b7110b180101862',
               '21899698fbaa1da5314e42bc049b146f16cddb2e7540822b2a15f009f8342996'),
}


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
    def test_measured_exact_root_ca_rotation_requires_finalization_and_strict_installation(self):
        observations = []
        for kind, (before_sha, after_sha) in ROOT_CA_ROTATIONS.items():
            for after_mode in (0o644, 0o777):
                observations.append((kind, before_sha, after_sha, after_mode))
        observations.extend([
            # Independent official-only controls 42329203806 and 42336374269:
            # two creates on each resolved template/envd changed CA bytes while
            # retaining 0644. Neither control reproduced the combined 0777 shape.
            ('claude', '39092cfcc8ab45433c2f03884bc5e73540f1aec21fcd7b6047d8e1c37b22d488',
             'b65c9222bdbe3f7aeecd78ad299a40b9a8440ac718b9102f28799df376cf8643', 0o644),
            ('desktop', '767be311dc40f53638de0a6d09c76dae3e15785b122eae89b55d5873d70c7fed',
             '492c78708de3514ad7bf8cafd5290fb044c450ce66759e2047ebed310e6bd92a', 0o644),
            # Exact derived Desktop fresh-scan failure 42334937454 / 128289718639.
            ('desktop', '4e067e215d0664f4cfeb733d74824a4ba52eb57635a6e365fd27bac0b19e5a9e',
             '98d3ae906242016c071b5d1902c7b5c6fd5fe56b277c51b407d80d14cf6dde2d', 0o777),
        ])
        for kind, before_sha, after_sha, after_mode in observations:
            with self.subTest(kind=kind, mode=after_mode, before=before_sha):
                original = {'path': ROOT_CA, 'kind': 'file', 'mode': 0o644,
                            'uid': 0, 'gid': 0, 'sha256': before_sha}
                baseline = {'version': 1, 'entries': [original]}
                with patch.object(files, 'entry', return_value=original):
                    proof = files.verify(baseline)
                updated = {**original, 'mode': after_mode, 'sha256': after_sha}
                with patch.object(files, 'entry', return_value=updated):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify(baseline)
                    proof['finalization'] = files.verify(baseline, kind)
                self.assertIs(files.validate_receipt(proof, kind), proof)
                final = proof['finalization']
                self.assertEqual(final['before'], final['after'])
                self.assertNotEqual(final['originalBefore'], final['originalAfter'])
                expected_before, expected_after = {'sha256': before_sha}, {'sha256': after_sha}
                if after_mode != original['mode']:
                    expected_before['mode'] = original['mode']
                    expected_after['mode'] = after_mode
                self.assertEqual(final['providerChanges'], [{'path': ROOT_CA, 'kind': 'file',
                                 'before': expected_before, 'after': expected_after}])
                invalid = deepcopy(proof)
                invalid['after'] = final['originalAfter']
                with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                    files.validate_receipt(invalid, kind)

    def test_exact_root_ca_exception_keeps_type_owner_target_mode_and_other_paths_protected(self):
        before_sha, after_sha = ROOT_CA_ROTATIONS['desktop']
        original = {'path': ROOT_CA, 'kind': 'file', 'mode': 0o644,
                    'uid': 0, 'gid': 0, 'sha256': before_sha}
        forbidden = [
            {'uid': 1000}, {'gid': 1000}, {'mode': 0o666}, {'mode': 0o700}, {'sha256': 'not-a-digest'},
            {'kind': 'link', 'sha256': None, 'target': '/opt/mikka/replaced.crt'},
            {'kind': 'link', 'sha256': None, 'target': ROOT_CA},
            {'kind': 'directory', 'sha256': None},
        ]
        # A permitted hash rotation must not hide a simultaneous forbidden change.
        forbidden += [{**update, 'sha256': after_sha} for update in forbidden if 'sha256' not in update]
        for kind in ('claude', 'desktop', 'codex'):
            baseline = {'version': 1, 'entries': [original]}
            for update in forbidden:
                with self.subTest(kind=kind, update=update), patch.object(files, 'entry', return_value={**original, **update}):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify(baseline, kind)
            with self.subTest(kind=kind, removed=True), patch.object(files, 'entry', side_effect=FileNotFoundError(ROOT_CA)):
                with self.assertRaisesRegex(RuntimeError, 'official_files_removed'):
                    files.verify(baseline, kind)
            for path in ('/usr/local/share/ca-certificates/unobserved.crt',
                         '/usr/local/share/ca-certificates/e2b-ca.crt.backup',
                         '/etc/ssl/certs/unobserved.crt', '/usr/local/bin/claude', '/usr/local/bin/codex'):
                before = {**original, 'path': path}
                with self.subTest(kind=kind, path=path), patch.object(files, 'entry', return_value={**before, 'sha256': after_sha}):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify({'version': 1, 'entries': [before]}, kind)
        with patch.object(files, 'entry', return_value={**original, 'sha256': after_sha}):
            files.verify({'version': 1, 'entries': [original]}, 'codex')
        with patch.object(files, 'entry', return_value={**original, 'mode': 0o755}):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify({'version': 1, 'entries': [original]}, 'codex')

    def test_exact_root_ca_rotation_receipts_reject_invalid_hashes(self):
        before_sha, after_sha = ROOT_CA_ROTATIONS['desktop']
        for kind in ('claude', 'desktop', 'codex'):
            rules, _ = files.finalization_policy(kind)
            for side in ('before', 'after'):
                for value in (None, '', 'f' * 63, 'g' * 64, 'A' * 64, 123):
                    change = {'path': ROOT_CA, 'kind': 'file', 'before': {'sha256': before_sha}, 'after': {'sha256': after_sha}}
                    change[side]['sha256'] = value
                    with self.subTest(kind=kind, side=side, value=value):
                        self.assertFalse(files.permitted_provider_change(change, rules))

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

    def test_rotating_provider_ca_bytes_are_accepted_only_at_fresh_finalization(self):
        # The d63 Claude fresh scan observed both the existing control-proven
        # 0644 -> 0777 transition and a new provider CA. Codex already permits
        # this exact path's per-boot bytes; preserve its existing mode here.
        path = '/usr/local/share/ca-certificates/e2b-ca.crt'
        for kind, mode in [('claude', 0o644), ('desktop', 0o644), ('codex', 0o777)]:
            with self.subTest(kind=kind):
                original = {'path': path, 'kind': 'file', 'mode': mode, 'uid': 0, 'gid': 0, 'sha256': 'a' * 64}
                baseline = {'version': 1, 'entries': [original]}
                with patch.object(files, 'entry', return_value=original):
                    installation = files.verify(baseline)
                rotated = {**original, 'mode': 0o777, 'sha256': 'b' * 64}
                with patch.object(files, 'entry', return_value=rotated):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify(baseline)
                    final = files.verify(baseline, kind)
                self.assertEqual(final['before'], final['after'])
                self.assertEqual(final['originalBefore'], installation['before'])
                self.assertNotEqual(final['originalBefore'], final['originalAfter'])
                self.assertEqual(len(final['providerChanges']), 1)
                self.assertEqual(final['providerChanges'][0]['path'], path)
                self.assertEqual(final['providerChanges'][0]['after']['sha256'], 'b' * 64)
                proof = {**installation, 'finalization': final}
                self.assertIs(files.validate_receipt(proof, kind), proof)
                proof['after'] = final['originalAfter']
                with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                    files.validate_receipt(proof, kind)

    def test_provider_ca_finalization_keeps_exact_path_type_owner_and_mode_guards(self):
        path = '/usr/local/share/ca-certificates/e2b-ca.crt'
        original = {'path': path, 'kind': 'file', 'mode': 0o644, 'uid': 0, 'gid': 0, 'sha256': 'a' * 64}
        forbidden = [
            ('uid', {**original, 'uid': 1000}),
            ('gid', {**original, 'gid': 1000}),
            ('mode', {**original, 'mode': 0o600}),
            ('kind', {'path': path, 'kind': 'link', 'mode': 0o777, 'uid': 0, 'gid': 0, 'target': '/opt/mikka/replaced.crt'}),
            ('invalid_hash', {**original, 'sha256': 'not-a-sha256'}),
        ]
        for kind in ('claude', 'desktop', 'codex'):
            for field, updated in forbidden:
                with self.subTest(kind=kind, field=field), patch.object(files, 'entry', return_value=updated):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify({'version': 1, 'entries': [original]}, kind)
            for other in ('/usr/local/share/ca-certificates/other-ca.crt', '/etc/ssl/certs/unobserved.crt', '/usr/local/bin/claude'):
                before = {**original, 'path': other}
                with self.subTest(kind=kind, path=other), patch.object(files, 'entry', return_value={**before, 'sha256': 'b' * 64}):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify({'version': 1, 'entries': [before]}, kind)
        # The independent official Codex control proves 0644 -> 0777, not 0755.
        with patch.object(files, 'entry', return_value={**original, 'mode': 0o755}):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify({'version': 1, 'entries': [original]}, 'codex')

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



class ProviderDirectoryFinalization(unittest.TestCase):
    @staticmethod
    def original_directory():
        return {'path': '/usr/local/share/e2b', 'kind': 'directory',
                'mode': 0o755, 'uid': 0, 'gid': 0}

    def directory_proof(self):
        original = self.original_directory()
        baseline = {'version': 1, 'entries': [original]}
        with patch.object(files, 'entry', return_value=original):
            installation = files.verify(baseline)
        with patch.object(files, 'entry', return_value={**original, 'mode': 0o777}):
            # The candidate exception applies only after the strict install receipt.
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(baseline)
            final = files.verify(baseline, 'claude')
        return original, {**installation, 'finalization': final}

    def test_exact_claude_directory_mode_requires_finalization_and_preserves_kind(self):
        original, proof = self.directory_proof()
        final = proof['finalization']
        self.assertEqual(final['providerChanges'], [{
            'path': original['path'], 'kind': 'directory',
            'before': {'mode': 0o755}, 'after': {'mode': 0o777},
        }])
        self.assertEqual(final['originalBefore'], proof['before'])
        self.assertNotEqual(final['originalBefore'], final['originalAfter'])
        # Entry type stays in the normalized digest; _kind is rule metadata.
        protected = {'path': original['path'], 'kind': 'directory', 'uid': 0, 'gid': 0}
        self.assertEqual(final['before'], files.receipt([protected]))
        self.assertEqual(final['before'], final['after'])
        self.assertIs(files.validate_receipt(proof, 'claude'), proof)

    def test_directory_rule_rejects_other_identity_fields_modes_paths_and_templates(self):
        directory = self.original_directory()
        file = {**directory, 'kind': 'file', 'sha256': 'a' * 64}
        link = {**directory, 'kind': 'link', 'target': '/official/directory'}
        sibling = {**directory, 'path': '/usr/local/share/e2b-other'}
        child = {**file, 'path': '/usr/local/share/e2b/existing-file'}
        cases = [
            ('stable file', 'claude', file, {**file, 'mode': 0o777}),
            ('stable link', 'claude', link, {**link, 'mode': 0o777}),
            ('directory becomes file', 'claude', directory, {**file, 'mode': 0o777}),
            ('directory becomes link', 'claude', directory, {**link, 'mode': 0o777}),
            ('owner changes', 'claude', directory, {**directory, 'mode': 0o777, 'uid': 1000}),
            ('group changes', 'claude', directory, {**directory, 'mode': 0o777, 'gid': 1000}),
            ('different old mode', 'claude', {**directory, 'mode': 0o700}, {**directory, 'mode': 0o777}),
            ('different new mode', 'claude', directory, {**directory, 'mode': 0o775}),
            ('sibling directory', 'claude', sibling, {**sibling, 'mode': 0o777}),
            ('existing child bytes', 'claude', child, {**child, 'sha256': 'b' * 64}),
            ('desktop scope', 'desktop', directory, {**directory, 'mode': 0o777}),
            ('codex scope', 'codex', directory, {**directory, 'mode': 0o777}),
        ]
        for label, kind, original, updated in cases:
            with self.subTest(case=label), patch.object(files, 'entry', return_value=updated):
                with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                    files.verify({'version': 1, 'entries': [original]}, kind)

    def test_directory_receipt_rejects_missing_wrong_kind_and_replaced_installation(self):
        _, proof = self.directory_proof()
        for kind in (None, 'file', 'link', 'special'):
            invalid = deepcopy(proof)
            change = invalid['finalization']['providerChanges'][0]
            if kind is None:
                change.pop('kind')
            else:
                change['kind'] = kind
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                    files.validate_receipt(invalid, 'claude')
        invalid = deepcopy(proof)
        invalid['after'] = invalid['finalization']['originalAfter']
        with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
            files.validate_receipt(invalid, 'claude')


class DesktopCertificateRelinks(unittest.TestCase):
    # Official-only run 42628079564 / artifact 13678489689: both packaged
    # Desktop files kept 0777/root ownership and became these exact links.
    PATHS = ('/etc/ssl/certs/1560546e.0', '/etc/ssl/certs/e2b-ca.pem')
    TARGETS = ('e2b-ca.pem', ROOT_CA)
    DESKTOP_SHA = '4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1'
    CODEX_SHA = 'a35101e5d97b20191320ecfcb75e4bea784ba8fa9715193eb3a759d54528eda5'
    ROOT_BEFORE_SHA = '3d3bf4eda47ee4754c04202fe5ac919ae609f21aa750de1f6bdc91e83c16a686'
    ROOT_FRESH_SHA = 'ffe5cadf73f8a4b863034daae2fdd9b861fb32049d2b4d4d68e49282f396b40e'

    def rows(self, digest=None):
        digest = digest or self.DESKTOP_SHA
        before = {path: {'path': path, 'kind': 'file', 'mode': 0o777,
                         'uid': 0, 'gid': 0, 'sha256': digest} for path in self.PATHS}
        before[ROOT_CA] = {**before[self.PATHS[0]], 'path': ROOT_CA, 'sha256': self.ROOT_BEFORE_SHA}
        after = {path: {'path': path, 'kind': 'link', 'mode': 0o777,
                        'uid': 0, 'gid': 0, 'target': target} for path, target in zip(self.PATHS, self.TARGETS)}
        after[ROOT_CA] = {**before[ROOT_CA], 'sha256': self.ROOT_FRESH_SHA}
        return before, after

    def proof(self, kind='desktop', digest=None):
        before, after = self.rows(digest)
        manifest = {'version': 1, 'entries': list(before.values())}
        with patch.object(files, 'entry', side_effect=lambda path: deepcopy(before[str(path)])):
            strict = files.verify(manifest)
        with patch.object(files, 'entry', side_effect=lambda path: deepcopy(after[str(path)])), \
                patch.object(files.Path, 'resolve', return_value=Path(ROOT_CA)):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(manifest)
            final = files.verify(manifest, kind)
        return {**strict, 'finalization': final}

    def test_measured_desktop_relinks_and_legacy_codex_scope(self):
        # The Codex case preserves the existing a351 rule, not a claim that
        # this control reproduced Codex links or any Codex mode transition.
        for kind, digest in [('desktop', self.DESKTOP_SHA), ('codex', self.CODEX_SHA)]:
            with self.subTest(kind=kind):
                proof = self.proof(kind, digest)
                self.assertIs(files.validate_receipt(proof, kind), proof)
                final = proof['finalization']
                self.assertEqual(final['before'], final['after'])
                self.assertNotEqual(final['originalBefore'], final['originalAfter'])
                changes = {row['path']: row for row in final['providerChanges']}
                for path, target in zip(self.PATHS, self.TARGETS):
                    self.assertEqual(changes[path], {
                        'path': path, 'kind': 'file',
                        'before': {'kind': 'file', 'sha256': digest, 'target': None},
                        'after': {'kind': 'link', 'sha256': None, 'target': target},
                        'resolvedSha256': self.ROOT_FRESH_SHA,
                    })
                self.assertNotEqual(self.ROOT_FRESH_SHA, digest)
                rules, _ = files.finalization_policy(kind)
                self.assertEqual([rules[path]['_certificate']['sha256'] for path in self.PATHS], [digest, digest])
                self.assertTrue(all('mode' not in rules[path] for path in self.PATHS))

    def test_relinks_keep_exact_path_digest_target_identity_and_scope_guards(self):
        for path in self.PATHS:
            mutations = [
                ('wrong baseline digest', 'desktop', 'before', {'sha256': self.CODEX_SHA}),
                ('wrong raw target', 'desktop', 'after', {'target': '/opt/mikka/replaced.crt'}),
                ('different old mode', 'desktop', 'before', {'mode': 0o644}),
                ('different new mode', 'desktop', 'after', {'mode': 0o775}),
                ('owner', 'desktop', 'after', {'uid': 1000}),
                ('group', 'desktop', 'after', {'gid': 1000}),
                ('type', 'desktop', 'after', {'kind': 'directory'}),
                ('codex scope', 'codex', 'after', {}),
                ('claude rejects legacy codex baseline', 'claude', 'before', {'sha256': self.CODEX_SHA}),
            ]
            for label, kind, side, update in mutations:
                before, after = self.rows()
                (before if side == 'before' else after)[path].update(update)
                with self.subTest(path=path, defect=label), \
                        patch.object(files, 'entry', side_effect=lambda p: deepcopy(after[str(p)])), \
                        patch.object(files.Path, 'resolve', return_value=Path(ROOT_CA)):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify({'version': 1, 'entries': list(before.values())}, kind)
        before, after = self.rows()
        unknown = '/etc/ssl/certs/unobserved-provider-root.pem'
        original = {**before[self.PATHS[0]], 'path': unknown}
        changed = {**after[self.PATHS[0]], 'path': unknown}
        with patch.object(files, 'entry', return_value=changed):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify({'version': 1, 'entries': [original]}, 'desktop')

    def test_verify_requires_exact_regular_provider_root_terminal(self):
        for path in self.PATHS:
            before, after = self.rows()
            for label, terminal_path, terminal in [
                ('wrong terminal', '/opt/mikka/e2b-ca.crt', after[ROOT_CA]),
                ('directory terminal', ROOT_CA, {**after[ROOT_CA], 'kind': 'directory'}),
                ('link terminal', ROOT_CA, {**after[ROOT_CA], 'kind': 'link', 'target': '/opt/mikka/replaced.crt'}),
            ]:
                def actual_entry(requested):
                    return deepcopy(after[path] if str(requested) == path else terminal)
                with self.subTest(path=path, defect=label), \
                        patch.object(files, 'entry', side_effect=actual_entry), \
                        patch.object(files.Path, 'resolve', return_value=Path(terminal_path)):
                    with self.assertRaisesRegex(RuntimeError, '^e2b_certificate_target_invalid$'):
                        files.verify({'version': 1, 'entries': [before[path]]}, 'desktop')

    def test_relink_receipt_rejects_tampering_and_replacement_of_strict_proof(self):
        proof = self.proof()
        for defect in ('missing resolved hash', 'invalid resolved hash', 'wrong raw target',
                       'wrong baseline', 'missing original kind', 'duplicate path', 'replaced installation'):
            invalid = deepcopy(proof)
            change = next(row for row in invalid['finalization']['providerChanges'] if row['path'] == self.PATHS[0])
            if defect == 'missing resolved hash':
                change.pop('resolvedSha256')
            elif defect == 'invalid resolved hash':
                change['resolvedSha256'] = 'not-a-digest'
            elif defect == 'wrong raw target':
                change['after']['target'] = ROOT_CA
            elif defect == 'wrong baseline':
                change['before']['sha256'] = self.CODEX_SHA
            elif defect == 'missing original kind':
                change.pop('kind')
            elif defect == 'duplicate path':
                invalid['finalization']['providerChanges'].append(deepcopy(change))
            else:
                invalid['after'] = invalid['finalization']['originalAfter']
            with self.subTest(defect=defect):
                with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                    files.validate_receipt(invalid, 'desktop')


class ClaudeCertificateRelinks(unittest.TestCase):
    # Official-only control 42661569263/1, not a Desktop inference or a product
    # build failure. The evidence export preserves both actual artifact files.
    PATHS = ('/etc/ssl/certs/1560546e.0', '/etc/ssl/certs/e2b-ca.pem')
    TARGETS = ('e2b-ca.pem', ROOT_CA)
    ORIGINAL_SHA = '4e04ce0bc2dcacdcc12cbf8b5ea06d12efb0fbffd80c77a13e08660cf8255aa1'
    LEGACY_CODEX_SHA = 'a35101e5d97b20191320ecfcb75e4bea784ba8fa9715193eb3a759d54528eda5'

    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[2] / 'docs/operations/evidence/1782-official-claude-certificate-relinks-20261109.json'
        cls.evidence = json.loads(path.read_text())
        cls.control = cls.evidence['controls']['claude']

    def rows(self):
        def phase_rows(phase):
            return {row['path']: {field: row[field] for field in
                    ('path', 'kind', 'mode', 'uid', 'gid', 'sha256', 'target') if field in row}
                    for row in self.control['observations'][phase]['nodes']}
        return phase_rows('before'), phase_rows('fresh')

    def proof(self):
        before, after = self.rows()
        manifest = {'version': 1, 'entries': list(before.values())}
        with patch.object(files, 'entry', side_effect=lambda path: deepcopy(before[str(path)])):
            strict = files.verify(manifest)
        with patch.object(files, 'entry', side_effect=lambda path: deepcopy(after[str(path)])), \
                patch.object(files.Path, 'resolve', return_value=Path(ROOT_CA)):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify(manifest)
            final = files.verify(manifest, 'claude')
        return {**strict, 'finalization': final}

    def test_actual_claude_control_relinks_require_finalization_and_preserve_strict_proof(self):
        self.assertEqual(self.control['identity']['runId'], '42661569263')
        self.assertEqual(self.control['identity']['opsCommit'], '7fd8a2681cd71bb6603a485854c8beda2044911b')
        self.assertEqual(self.control['probe'], {'phase': 'complete', 'status': 'observed'})
        self.assertEqual(self.control['cleanup']['status'], 'complete')
        self.assertFalse(self.evidence['releaseAccepted'])
        for phase in ('before', 'pre_finalization', 'ready'):
            nodes = self.control['observations'][phase]['nodes']
            self.assertEqual([row['sha256'] for row in nodes[:2]], [self.ORIGINAL_SHA] * 2)
            self.assertTrue(all(row['kind'] == 'file' and row['mode'] == 0o777
                                and row['uid'] == row['gid'] == 0 for row in nodes))
        before, after = self.rows()
        self.assertEqual(before[ROOT_CA]['sha256'], 'ee836ee305e23a18319640cafe0c7ebe628d7fbf985c23cfc5bf453d2ea7224d')
        self.assertEqual(after[ROOT_CA]['sha256'], '0459a4cfe2cc288afae322259a84a08910e65282d89dc06e94f5e1b80d3c6cb4')
        proof = self.proof()
        self.assertIs(files.validate_receipt(proof, 'claude'), proof)
        final = proof['finalization']
        self.assertEqual(final['before'], final['after'])
        self.assertNotEqual(final['originalBefore'], final['originalAfter'])
        self.assertEqual(final['originalBefore'], proof['before'])
        self.assertEqual(proof['before'], proof['after'])
        self.assertEqual(final['before']['entries'], 3)
        changes = {row['path']: row for row in final['providerChanges']}
        self.assertEqual(set(changes), {*self.PATHS, ROOT_CA})
        for path, target in zip(self.PATHS, self.TARGETS):
            self.assertEqual(changes[path], {'path': path, 'kind': 'file',
                'before': {'kind': 'file', 'sha256': self.ORIGINAL_SHA, 'target': None},
                'after': {'kind': 'link', 'sha256': None, 'target': target},
                'resolvedSha256': after[ROOT_CA]['sha256']})
        rules, _ = files.finalization_policy('claude')
        self.assertTrue(all('mode' not in rules[path] for path in self.PATHS))
        self.assertEqual([rules[path]['_certificate']['templates'] for path in self.PATHS], [['claude'], ['claude']])

    def test_claude_relinks_keep_exact_baseline_target_identity_and_path_guards(self):
        for path in self.PATHS:
            for label, side, update in [
                ('wrong original digest', 'before', {'sha256': 'a' * 64}),
                ('legacy codex baseline', 'before', {'sha256': self.LEGACY_CODEX_SHA}),
                ('wrong raw target', 'after', {'target': '/opt/mikka/replaced.crt'}),
                ('different old mode', 'before', {'mode': 0o644}),
                ('different new mode', 'after', {'mode': 0o775}),
                ('owner', 'after', {'uid': 1000}),
                ('group', 'after', {'gid': 1000}),
                ('type', 'after', {'kind': 'directory'}),
            ]:
                before, after = self.rows()
                (before if side == 'before' else after)[path].update(update)
                with self.subTest(path=path, defect=label), \
                        patch.object(files, 'entry', side_effect=lambda p: deepcopy(after[str(p)])), \
                        patch.object(files.Path, 'resolve', return_value=Path(ROOT_CA)):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify({'version': 1, 'entries': list(before.values())}, 'claude')
            before, after = self.rows()
            for unknown in ('/etc/ssl/certs/unobserved-provider-root.pem', path + '.backup'):
                original = {**before[path], 'path': unknown}
                changed = {**after[path], 'path': unknown}
                with self.subTest(path=unknown), patch.object(files, 'entry', return_value=changed):
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify({'version': 1, 'entries': [original]}, 'claude')
        # This Claude observation never changes the existing Codex baseline.
        before, after = self.rows()
        with patch.object(files, 'entry', side_effect=lambda p: deepcopy(after[str(p)])), \
                patch.object(files.Path, 'resolve', return_value=Path(ROOT_CA)):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify({'version': 1, 'entries': list(before.values())}, 'codex')

    def test_claude_verify_requires_actual_regular_fixed_provider_root(self):
        for path in self.PATHS:
            before, after = self.rows()
            for label, terminal_path, terminal in [
                ('wrong terminal', '/opt/mikka/e2b-ca.crt', after[ROOT_CA]),
                ('directory terminal', ROOT_CA, {**after[ROOT_CA], 'kind': 'directory'}),
                ('link terminal', ROOT_CA, {**after[ROOT_CA], 'kind': 'link', 'target': '/opt/mikka/replaced.crt'}),
            ]:
                def actual_entry(requested):
                    return deepcopy(after[path] if str(requested) == path else terminal)
                with self.subTest(path=path, defect=label), \
                        patch.object(files, 'entry', side_effect=actual_entry), \
                        patch.object(files.Path, 'resolve', return_value=Path(terminal_path)):
                    with self.assertRaisesRegex(RuntimeError, '^e2b_certificate_target_invalid$'):
                        files.verify({'version': 1, 'entries': [before[path]]}, 'claude')

    def test_claude_receipt_rejects_tampering_and_strict_proof_replacement(self):
        proof = self.proof()
        for defect in ('missing resolved hash', 'invalid resolved hash', 'wrong raw target',
                       'wrong baseline', 'missing original kind', 'duplicate path',
                       'wrong policy hash', 'replaced installation'):
            invalid = deepcopy(proof)
            change = next(row for row in invalid['finalization']['providerChanges'] if row['path'] == self.PATHS[0])
            if defect == 'missing resolved hash':
                change.pop('resolvedSha256')
            elif defect == 'invalid resolved hash':
                change['resolvedSha256'] = 'not-a-digest'
            elif defect == 'wrong raw target':
                change['after']['target'] = ROOT_CA
            elif defect == 'wrong baseline':
                change['before']['sha256'] = self.LEGACY_CODEX_SHA
            elif defect == 'missing original kind':
                change.pop('kind')
            elif defect == 'duplicate path':
                invalid['finalization']['providerChanges'].append(deepcopy(change))
            elif defect == 'wrong policy hash':
                invalid['finalization']['policySha256'] = 'a' * 64
            else:
                invalid['after'] = invalid['finalization']['originalAfter']
            with self.subTest(defect=defect):
                with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                    files.validate_receipt(invalid, 'claude')


class CodexRootCaFinalization(unittest.TestCase):
    # Actual metadata from official-only control 42670291715 / attempt 1,
    # ops b75871ea1753f75769daa33b095704475cf9a4a2. This replays the
    # observed path through the real verifier; it is not a filesystem scan.
    BEFORE_SHA = '713ed37b92f312cf89345677c1d7f413c55b38ca0c1c636ce0fecc672d08ed9a'
    FRESH_SHA = '545244c4bc7f902ed9a6d843dd6ccaed08d0a59bbfc1b60064bd0278e026da5a'

    def setUp(self):
        self.original = {'path': ROOT_CA, 'kind': 'file', 'mode': 0o644,
                         'uid': 0, 'gid': 0, 'sha256': self.BEFORE_SHA}

    def test_observed_mode_then_digest_changes_require_finalization_and_strict_proof(self):
        baseline = {'version': 1, 'entries': [self.original]}
        with patch.object(files, 'entry', return_value=self.original):
            installation = files.verify(baseline)
        for phase, mode, sha in [('pre_finalization', 0o644, self.BEFORE_SHA),
                                 ('ready', 0o777, self.BEFORE_SHA),
                                 ('fresh', 0o777, self.FRESH_SHA)]:
            updated = {**self.original, 'mode': mode, 'sha256': sha}
            with self.subTest(phase=phase), patch.object(files, 'entry', return_value=updated):
                if phase == 'pre_finalization':
                    self.assertEqual(files.verify(baseline), installation)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                        files.verify(baseline)
                final = files.verify(baseline, 'codex')
                proof = {**installation, 'finalization': final}
                self.assertIs(files.validate_receipt(proof, 'codex'), proof)
                expected_before, expected_after = {}, {}
                if mode != 0o644:
                    expected_before['mode'], expected_after['mode'] = 0o644, mode
                if sha != self.BEFORE_SHA:
                    expected_before['sha256'], expected_after['sha256'] = self.BEFORE_SHA, sha
                expected = ([{'path': ROOT_CA, 'kind': 'file', 'before': expected_before,
                              'after': expected_after}] if expected_before else [])
                self.assertEqual(final['providerChanges'], expected)
                if phase != 'pre_finalization':
                    proof['after'] = final['originalAfter']
                    with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                        files.validate_receipt(proof, 'codex')

    def test_unobserved_modes_and_owner_or_file_kind_changes_are_rejected(self):
        cases = []
        for before_mode, after_mode in [(0o600, 0o777), (0o640, 0o777),
                                        (0o644, 0o666), (0o644, 0o755),
                                        (0o777, 0o644), (0o777, 0o755)]:
            original = {**self.original, 'mode': before_mode}
            cases.append((f'mode {before_mode:o}->{after_mode:o}', original,
                          {**original, 'mode': after_mode, 'sha256': self.FRESH_SHA}))
        for field, value in [('uid', 1000), ('gid', 1000), ('sha256', 'not-a-digest')]:
            cases.append((field, self.original,
                          {**self.original, 'mode': 0o777, 'sha256': self.FRESH_SHA, field: value}))
        for kind in ('directory', 'link'):
            nonfile = {'path': ROOT_CA, 'kind': kind, 'mode': 0o644, 'uid': 0, 'gid': 0}
            if kind == 'link':
                nonfile['target'] = '/opt/mikka/replaced.crt'
            cases.append((f'unchanged {kind}', nonfile, {**nonfile, 'mode': 0o777}))
            cases.append((f'file to {kind}', self.original, {**nonfile, 'mode': 0o777}))
        for name, original, updated in cases:
            with self.subTest(case=name), patch.object(files, 'entry', return_value=updated):
                with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                    files.verify({'version': 1, 'entries': [original]}, 'codex')

    def test_other_paths_cli_and_desktop_backup_keep_their_existing_protection(self):
        for path in ('/usr/local/share/ca-certificates/unobserved.crt', ROOT_CA + '.backup',
                     '/usr/local/bin/codex', '/var/backups/apt.extended_states.0'):
            original = {**self.original, 'path': path}
            with self.subTest(path=path), patch.object(files, 'entry', return_value={
                    **original, 'mode': 0o777, 'sha256': self.FRESH_SHA}):
                with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                    files.verify({'version': 1, 'entries': [original]}, 'codex')
        cli = {**self.original, 'path': '/usr/local/bin/codex', 'mode': 0o755}
        after = {ROOT_CA: {**self.original, 'mode': 0o777},
                 cli['path']: {**cli, 'sha256': self.FRESH_SHA}}
        with patch.object(files, 'entry', side_effect=lambda path: after[str(path)]):
            with self.assertRaisesRegex(RuntimeError, '/usr/local/bin/codex'):
                files.verify({'version': 1, 'entries': [self.original, cli]}, 'codex')
        # Desktop's observed backup stayed unchanged; a synthetic digest change
        # remains forbidden, even though Codex now has one additional mode rule.
        backup = {**self.original, 'path': '/var/backups/apt.extended_states.0',
                  'sha256': '52f87bdad074b319ed8b601e4c5e97ab0d5ce235bafac3213d32f1873f7413ac'}
        with patch.object(files, 'entry', return_value={**backup, 'sha256': 'b' * 64}):
            with self.assertRaisesRegex(RuntimeError, 'official_files_changed'):
                files.verify({'version': 1, 'entries': [backup]}, 'desktop')

    def test_receipts_cannot_widen_the_measured_codex_transition(self):
        baseline = {'version': 1, 'entries': [self.original]}
        with patch.object(files, 'entry', return_value=self.original):
            proof = files.verify(baseline)
        with patch.object(files, 'entry', return_value={**self.original, 'mode': 0o777}):
            proof['finalization'] = files.verify(baseline, 'codex')
        self.assertIs(files.validate_receipt(proof, 'codex'), proof)
        for defect in ('before mode', 'after mode', 'kind', 'path', 'owner'):
            invalid = deepcopy(proof)
            change = invalid['finalization']['providerChanges'][0]
            if defect == 'before mode':
                change['before']['mode'] = 0o600
            elif defect == 'after mode':
                change['after']['mode'] = 0o755
            elif defect == 'kind':
                change['kind'] = 'directory'
            elif defect == 'path':
                change['path'] = ROOT_CA + '.backup'
            else:
                change['before']['uid'], change['after']['uid'] = 0, 1000
            with self.subTest(defect=defect):
                with self.assertRaisesRegex(ValueError, 'official_conservation_invalid'):
                    files.validate_receipt(invalid, 'codex')


if __name__ == '__main__':
    unittest.main()
