#!/usr/bin/env python3
"""No network or models: immutable real Git objects plus guard fault injection."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("recovery_prepare", ROOT / "prepare.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
REPO = "/vercel/Mikka"
APP = "0d379dd92fd2d7b3f2b307030c3bcd8234426d0e"
TREE = "c7efece9d5a2f9e5fb4d01536daaf18d3bdcd97d"

class RecoveryGuards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = p.contract()

    def test_exact_checkpoint_tree_hash_without_writing_git_objects(self):
        elements = [{"path": path, "mode": "100644", "type": "blob",
            "content": p.blob(REPO, self.c["checkpoint"], path).decode()}
            for path in self.c["checkpointFiles"]]
        self.assertEqual(p.hash_overlay_tree(REPO, self.c["baseTree"], elements), self.c["checkpointTree"])

    def test_eleven_paths_remain_disabled_and_four_checkpoint_bytes_are_exact(self):
        payload, delta, manifest = p.render(REPO, APP, TREE)
        self.assertEqual(len(payload["tree_elements"]), 11)
        self.assertEqual(set(e["path"] for e in payload["tree_elements"]), set(self.c["paths"]))
        entries = {e["path"]: e["content"] for e in payload["tree_elements"]}
        for path, expected in self.c["checkpointFiles"].items():
            self.assertEqual(p.sha256(entries[path].encode()), expected)
        self.assertEqual(manifest["controlUnchanged"]["enabled"], False)
        self.assertEqual(manifest["controlUnchanged"]["phase"], "tool")
        self.assertIsNone(manifest["controlUnchanged"]["expectedSha"])
        self.assertEqual(manifest["stopCase"], "during_tool")
        self.assertEqual(manifest["mcpApplicationSha"], "")
        self.assertTrue(manifest["presenceDisabled"])
        self.assertFalse(manifest["activationAuthorized"])
        self.assertFalse(manifest["productionDeploymentVerified"])
        flow = entries[".github/workflows/issue-1506-alex-continue.yml"]
        self.assertIn("tool-stop-no-boundary.test.mjs", flow)
        self.assertEqual(len(manifest["sourcePins"]), 12)
        self.assertEqual(manifest["modelMessagesAddedForLive"], 0)
        self.assertEqual(manifest["nextPhaseRecommendation"], "cache-live")
        self.assertIn("ref: " + APP, flow)
        self.assertIn("continue-on-error: true", flow)
        self.assertIn("steps.haiku.outcome != 'skipped'", flow)
        self.assertNotIn("scripts/acceptance/issue-1506-alex/control/continue.json", entries)
        (ROOT / "offline-preview-0d.json").write_text(json.dumps({
            "notActualMergedOrDeployedApplication": True, "payload": payload, "manifest": manifest}, ensure_ascii=False, indent=2) + "\n")
        (ROOT / "offline-preview-0d.patch").write_text(delta)

    def test_application_tree_mismatch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "application_tree_mismatch"):
            p.render(REPO, APP, "0" * 40)

    def test_unknown_pin_drift_is_rejected(self):
        original = p.blob
        def changed(repo, ref, path):
            data = original(repo, ref, path)
            return data + b"\n// unknown drift\n" if ref == APP and path == "lib/live/channel.ts" else data
        with patch.object(p, "blob", changed):
            with self.assertRaisesRegex(ValueError, "unreviewed_source_pin:lib/live/channel.ts|introduced_pin_mismatch"):
                p.render(REPO, APP, TREE)

    def test_decoder_drift_is_rejected(self):
        original = p.blob
        def changed(repo, ref, path):
            data = original(repo, ref, path)
            return data + b"\n" if ref == APP and path == self.c["decoderPath"] else data
        with patch.object(p, "blob", changed):
            with self.assertRaisesRegex(ValueError, "decoder_drift"):
                p.render(REPO, APP, TREE)

    def test_checkpoint_bytes_cannot_silently_change(self):
        original = p.blob
        target = next(iter(self.c["checkpointFiles"]))
        def changed(repo, ref, path):
            data = original(repo, ref, path)
            return data + b"\n" if ref == self.c["checkpoint"] and path == target else data
        with patch.object(p, "blob", changed):
            with self.assertRaisesRegex(ValueError, "checkpoint_file_mismatch"):
                p.render(REPO, APP, TREE)

    def test_new_observer_and_wiring_source_drift_is_rejected(self):
        original = p.blob
        for target in ["lib/swr/read-observer.ts", "components/swr-defaults.tsx"]:
            def changed(repo, ref, path):
                data = original(repo, ref, path)
                return data + b"\\n" if ref == APP and path == target else data
            with patch.object(p, "blob", changed):
                with self.assertRaisesRegex(ValueError, "introduced_addition_mismatch|unreviewed_source_pin"):
                    p.render(REPO, APP, TREE)

    def test_frozen_worker_overlay_cannot_silently_change(self):
        original = Path.read_bytes
        target = (ROOT / self.c["extraOverlayFiles"]["scripts/acceptance/issue-1506-alex/live-worker.mjs"]["path"]).resolve()
        def changed(path):
            data = original(path)
            return data + b"\\n" if path.resolve() == target else data
        with patch.object(Path, "read_bytes", changed):
            with self.assertRaisesRegex(ValueError, "extra_overlay_digest_mismatch"):
                p.render(REPO, APP, TREE)

    def test_disabled_guards_reject_activation_and_legacy_resume_mutation(self):
        control = {"enabled": False, "phase": "tool", "expectedSha": None, "cacheTurns": 3}
        continuation = "      MIKKA_STOP_CASE: during_tool\n"
        presence = "if: $" + "{{ false && scoped }}\nMIKKA_ACCEPTANCE_SHA: ''"
        mcp = presence + "\ntimeout-minutes: 12"
        resume = {"phase": "resume-and-1490-baseline"}
        p.validate_disabled(control, continuation, presence, mcp, resume)
        cases = [
            ({**control, "enabled": True}, continuation, presence, mcp, resume),
            ({**control, "phase": "cache"}, continuation, presence, mcp, resume),
            ({**control, "expectedSha": APP}, continuation, presence, mcp, resume),
            (control, continuation.replace("during_tool", "before_tool"), presence, mcp, resume),
            (control, continuation, presence.replace("false && ", ""), mcp, resume),
            (control, continuation, presence, mcp.replace("false && ", ""), resume),
            (control, continuation, presence, mcp, {**resume, "enabled": False}),
        ]
        for args in cases:
            with self.assertRaises(ValueError):
                p.validate_disabled(*args)

if __name__ == "__main__":
    unittest.main(verbosity=2)
