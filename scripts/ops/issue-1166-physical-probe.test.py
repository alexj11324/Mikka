"""Offline fixture only: no SDK, database, secrets, or VM calls."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("issue-1166-physical-probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class PhysicalProbeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mikka-1166-offline-")
        self.root = Path(self.temp.name)
        self.worktree = self.root / "worktree"
        self.worktree.mkdir()
        self.payload = b"x" * 85
        (self.worktree / probe.FILE).write_bytes(self.payload)
        self.git("init", "-q")
        self.git("add", probe.FILE)
        self.git("-c", "user.name=Offline fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-q", "-m", "Retained artifact")
        head = self.git("rev-parse", "HEAD").strip()
        self.patches = [
            patch.object(probe, "ROOT", self.root),
            patch.object(probe, "WORKTREE", self.worktree),
            patch.object(probe, "FILE_HASH", probe.digest(self.payload)),
            patch.object(probe, "SNAPSHOT", head),
            patch.object(probe, "ANCESTOR", head),
        ]
        for item in self.patches:
            item.start()
        runs = {}
        self.histories = []
        for index, run in enumerate(probe.RUNS):
            runs[run] = {"state": "stopped" if index == 0 else "failed",
                         "sessionId": probe.SID, "worktree": str(self.worktree),
                         "lastSeq": index, "updatedAt": "2026-11-03T00:00:00.000Z",
                         "assignment": {"token": "do-not-export"}, "error": "do-not-export"}
            ledger_path = self.root / "adapters/native-ledgers" / (run + ".json")
            ledger_path.parent.mkdir(parents=True, exist_ok=True)
            ledger_path.write_text(json.dumps({"sessionId": probe.SID, "scope": {
                "runId": run, "workspaceId": probe.WORKSPACE, "route": "codex_cli",
                "bindingId": "ad6c44e2-3961-4518-8874-42b4c041e902",
                "consumerId": "12345678-1234-1234-1234-123456789abc",
                "revision": 2, "accountId": "do-not-export",
            }}))
            home = self.root / "adapters/runs" / run / "codex-home"
            folder = home / "sessions/2026/11/03"
            folder.mkdir(parents=True)
            history = folder / ("rollout-2026-" + probe.SID + ".jsonl")
            history.write_text(json.dumps({"type": "session_meta", "payload": {"id": probe.SID}}) + "\n")
            (home / "auth.json").write_text("do-not-read")
            (home / "config.toml").write_text("do-not-read")
            self.histories.append(history)
        (self.root / "runs.json").write_text(json.dumps({"runs": runs}))
        self.opens = []
        original_read = probe.regular_bytes

        def reader(path, cap=32 * 1024 * 1024):
            self.opens.append(path)
            if path == Path("/opt/mikka/worker-source-sha"):
                return b"b" * 40 + b"\n"
            return original_read(path, cap)

        self.read_patch = patch.object(probe, "regular_bytes", reader)
        self.read_patch.start()
        self.config = {"phase": "before", "target": {
            "sandboxId": "itxw486q7r74fasogje2v", "worktree": str(self.worktree),
            "sessionId": probe.SID, "filename": probe.FILE,
        }, "prefixes": []}

    def tearDown(self):
        self.read_patch.stop()
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null",
                               "-C", str(self.worktree), *args],
                              env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent",
                                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                                   "GIT_CONFIG_SYSTEM": "/dev/null"},
                              check=True, capture_output=True, text=True).stdout

    def test_real_git_fixture_and_allowlisted_reads(self):
        result = probe.collect(self.config)
        self.assertEqual(result["file"]["bytes"], 85)
        self.assertTrue(result["git"]["snapshotAncestor"])
        self.assertEqual(len(result["sessions"]), 2)
        self.assertNotIn("do-not-export", json.dumps(result))
        self.assertFalse(any(path.name in ("auth.json", "config.toml") for path in self.opens))

    def test_append_keeps_old_prefix_but_overwrite_is_detected(self):
        before = probe.collect(self.config)
        after_config = {**self.config, "phase": "after", "prefixes": before["sessions"]}
        with self.histories[0].open("ab") as stream:
            stream.write(b'{"type":"event_msg","payload":{"text":"new"}}\n')
        after = probe.collect(after_config)
        self.assertTrue(all(row["prefixMatches"] for row in after["sessions"]))
        self.assertGreater(after["sessions"][0]["bytes"], before["sessions"][0]["bytes"])
        self.assertNotEqual(after["sessions"][0]["sha256"], before["sessions"][0]["sha256"])
        # Preserve the SID metadata but alter the original prefix bytes.
        old = self.histories[0].read_text()
        self.histories[0].write_text(old.replace('"type":', '"type" :', 1))
        changed = probe.collect(after_config)
        self.assertFalse(changed["sessions"][0]["prefixMatches"])

    def test_symlink_is_rejected_without_reading_its_target(self):
        file = self.worktree / probe.FILE
        file.unlink()
        file.symlink_to(self.root / "runs.json")
        with self.assertRaisesRegex(ValueError, "path_rejected"):
            probe.collect(self.config)


if __name__ == "__main__":
    unittest.main()
