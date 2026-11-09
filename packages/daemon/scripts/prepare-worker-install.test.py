import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("worker_install", Path(__file__).with_name("prepare-worker-install.py"))
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)
LOCK = """lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

overrides:
  web-only: 1.0.0

importers:

  .:
    dependencies:
      web-only:
        specifier: 1.0.0
        version: 1.0.0

  packages/daemon:
    dependencies:
      '@mikka/protocol':
        specifier: workspace:*
        version: link:../protocol
    devDependencies:
      '@mikka/config':
        specifier: workspace:*
        version: link:../config
      esbuild:
        specifier: 0.28.2
        version: 0.28.2

  packages/protocol: {}

  packages/config: {}

  apps/desktop: {}

packages:

  esbuild@0.28.2:
    resolution: {integrity: unchanged}

  web-only@1.0.0:
    resolution: {integrity: unchanged}

snapshots:

  esbuild@0.28.2: {}

  web-only@1.0.0: {}
"""


class WorkerInstallTests(unittest.TestCase):
    def test_only_importers_are_projected(self):
        projected = INSTALL.project_lock(LOCK)
        self.assertIn("  .: {}", projected)
        self.assertNotIn("  apps/desktop:", projected)
        self.assertNotIn("specifier: 1.0.0", projected)
        self.assertIn("specifier: 0.28.2", projected)
        self.assertEqual(projected.split("packages:\n", 1)[1], LOCK.split("packages:\n", 1)[1])
        self.assertEqual(projected.split("importers:\n", 1)[0], LOCK.split("importers:\n", 1)[0])

    def test_missing_importer_refuses(self):
        with self.assertRaisesRegex(ValueError, "Missing"):
            INSTALL.project_lock(LOCK.replace("  packages/config: {}", "  packages/other: {}"))

    def test_additional_workspace_dependency_refuses(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            INSTALL.project_lock(LOCK.replace("link:../protocol", "link:../unreviewed"))

    def test_sources_settings_and_lifecycle_stay_intact(self):
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary) / "stage"
            source, destination = stage / "source", stage / "install"
            source.mkdir(parents=True)
            root = {"packageManager": "pnpm@10.34.3", "engines": {"node": "24.x"},
                    "pnpm": {"overrides": {"kept": "1.0.0"}}, "dependencies": {"web-only": "1.0.0"},
                    "scripts": {"postinstall": "web-only-command"}}
            (source / "package.json").write_text(json.dumps(root))
            (source / "pnpm-lock.yaml").write_text(LOCK)
            settings = b"packages:\n  - packages/*\nallowBuilds:\n  esbuild: true\n"
            (source / "pnpm-workspace.yaml").write_bytes(settings)
            for name in INSTALL.PROJECTS:
                path = source / name
                path.mkdir(parents=True)
                (path / "package.json").write_text('{"scripts":{"postinstall":"normal-script"},"devDependencies":{"tool":"1.0.0"}}')
                (path / "source.ts").write_text("export const unchanged = true\n")
            (source / "patches").mkdir()
            (source / "patches/fixed.patch").write_text("original patch\n")
            originals = {p.relative_to(source): p.read_bytes() for p in source.rglob("*") if p.is_file()}
            INSTALL.prepare(source, destination)
            self.assertEqual(originals, {p.relative_to(source): p.read_bytes() for p in source.rglob("*") if p.is_file()})
            self.assertEqual((destination / "pnpm-workspace.yaml").read_bytes(), settings)
            self.assertEqual(json.loads((destination / "package.json").read_text()),
                             {"private": True, **{key: root[key] for key in INSTALL.ROOT_KEYS}})
            for name in INSTALL.PROJECTS:
                self.assertEqual((source / name / "package.json").read_bytes(), (destination / name / "package.json").read_bytes())
                (destination / name / "node_modules").mkdir()
                (destination / name / "node_modules/runtime.txt").write_text("installed runtime")
            INSTALL.link_modules(source, destination)
            for name in INSTALL.PROJECTS:
                self.assertEqual((source / name / "node_modules").resolve(), destination / name / "node_modules")
            with self.assertRaisesRegex(ValueError, "fresh"):
                INSTALL.link_modules(source, destination)
            final = stage.with_name("final")
            stage.rename(final)
            for name in INSTALL.PROJECTS:
                linked = final / "source" / name / "node_modules"
                self.assertEqual(linked.resolve(strict=True), final / "install" / name / "node_modules")
                self.assertEqual((linked / "runtime.txt").read_text(), "installed runtime")

    def test_changed_frozen_lock_refuses_link(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, destination = Path(temporary) / "source", Path(temporary) / "install"
            source.mkdir()
            destination.mkdir()
            (source / "pnpm-lock.yaml").write_text(LOCK)
            (destination / "pnpm-lock.yaml").write_text(LOCK + "# changed\n")
            (destination / "worker-install-projection.json").write_text(json.dumps({
                "sourceLockSha256": INSTALL.digest(LOCK.encode()),
                "installLockSha256": INSTALL.digest(LOCK.encode()),
            }))
            with self.assertRaisesRegex(ValueError, "Frozen"):
                INSTALL.link_modules(source, destination)


if __name__ == "__main__":
    unittest.main()
