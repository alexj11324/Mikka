import importlib.util
import hashlib
import json
import os
from copy import deepcopy
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('official_files', Path(__file__).with_name('official-files.py'))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


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
        # this exact path's per-boot bytes; its mode rule must not be widened.
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
        # Codex's measured policy still allows only byte rotation, not a new
        # permission transition inferred from the other official templates.
        with patch.object(files, 'entry', return_value={**original, 'mode': 0o777}):
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


if __name__ == '__main__':
    unittest.main()
