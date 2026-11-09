#!/usr/bin/env python3
"""Offline tests of the actual issue1505 prepare guard using real Git objects."""
import argparse
import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import urllib.request

REAL_DATETIME = dt.datetime
CONFIG = None
SOURCES = (
    "scripts/ops/issue1505/github-readonly-provider.mjs",
    "scripts/ops/issue1505/github-readonly-helper.mjs",
    "scripts/ops/issue1505/github-readonly-store.mjs",
    "scripts/ops/issue1505/github-readonly-runner.mjs",
    "scripts/ops/issue1505/github-readonly.test.mjs",
)
WORKFLOW = ".github/workflows/issue1505-smoke-github-readonly.yml"
SCOPE = SOURCES + (WORKFLOW,)
PINS = ("__MAIN_SHA__", "__MAIN_TREE__", "__OPS_SHA__")
MAIN_URL = "https://api.github.com/repos/alexj11324/Mikka/git/ref/heads/main"

@contextlib.contextmanager
def working_directory(path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)

def deny_network(*_args, **_kwargs):
    raise RuntimeError("offline guard test attempted network access")

class PrepareGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = CONFIG.guard_template.read_text(encoding="utf-8")
        for pin in PINS:
            if pin not in cls.template:
                raise ValueError(f"guard template is missing {pin}")
        cls.source_bytes = {}
        for relative in SCOPE:
            path = CONFIG.source_dir / relative
            if not path.is_file() or path.is_symlink():
                raise ValueError(f"fixture source must be a regular file: {path}")
            cls.source_bytes[relative] = path.read_bytes()
        cls.deadline = REAL_DATETIME.fromisoformat(CONFIG.deadline.replace("Z", "+00:00"))
        if cls.deadline.tzinfo is None:
            raise ValueError("--deadline must include a timezone")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="issue1505-guard-")
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        hooks = Path(temporary.name) / "empty-hooks"
        hooks.mkdir()
        for key, value in (
            ("user.name", "Guard fixture"),
            ("user.email", "guard@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.filemode", "true"),
            ("core.hooksPath", str(hooks)),
        ):
            self.git("config", key, value)
        self.write("product.txt", b"initial product\n")
        self.base = self.commit("fixture base")
        self.git("checkout", "-q", "-b", "closed-ops")
        self.write("product.txt", b"historical OPS product\n")
        self.write("historical-closed-ops.txt", b"closed history only\n")
        self.closed_ops = self.commit("historical closed OPS")
        self.git("checkout", "-q", "main")
        self.write("product.txt", b"fresh current main product\n")
        self.main = self.commit("fresh current main")
        self.main_tree = self.git("rev-parse", self.main + "^{tree}")

    def git(self, *arguments, stdin=None):
        result = subprocess.run(
            ["git", *arguments], cwd=self.repo, input=stdin, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
        )
        return result.stdout.strip()

    def write(self, relative, content):
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(0o644)

    def commit(self, message):
        self.git("add", "--all")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def candidate(self, parents=None, mutate=None):
        self.git("checkout", "-q", "--detach", self.main)
        for relative, content in self.source_bytes.items():
            self.write(relative, content)
        if mutate is not None:
            mutate()
        self.git("add", "--all")
        tree = self.git("write-tree")
        parents = parents if parents is not None else (self.main, self.closed_ops)
        arguments = ["commit-tree", tree]
        for parent in parents:
            arguments.extend(("-p", parent))
        head = self.git(*arguments, stdin="reviewed prepare fixture\n")
        self.git("checkout", "-q", "--detach", head)
        return head

    def run_guard(self, head, *, tree_pin=None, current_main=None,
                  expired_at_entry=False, expires_during_response=False):
        replacements = {
            "__MAIN_SHA__": self.main,
            "__MAIN_TREE__": self.main_tree if tree_pin is None else tree_pin,
            "__OPS_SHA__": self.closed_ops,
        }
        code = self.template
        for pin, value in replacements.items():
            code = code.replace(pin, value)
        if any(pin in code for pin in PINS):
            raise ValueError("unexpanded Git pin")
        deadline = self.deadline
        clock = {"now": deadline + dt.timedelta(seconds=1) if expired_at_entry
                 else deadline - dt.timedelta(seconds=10)}
        requests = []
        response_main = self.main if current_main is None else current_main

        class FrozenDateTime(REAL_DATETIME):
            @classmethod
            def now(cls, tz=None):
                value = clock["now"]
                return value.replace(tzinfo=None) if tz is None else value.astimezone(tz)

        class FakeResponse(io.BytesIO):
            status = 200

        class FakeOpener:
            def open(self, request, timeout=None):
                # Harness errors must not count as successful negative guard tests.
                if request.full_url != MAIN_URL:
                    raise RuntimeError("unexpected URL in guard")
                if request.get_method() != "GET" or timeout != 20:
                    raise RuntimeError("unexpected request method or timeout")
                if request.get_header("Authorization") != "Bearer offline-only":
                    raise RuntimeError("unexpected fixture authorization")
                requests.append(request.full_url)
                if expires_during_response:
                    clock["now"] = deadline + dt.timedelta(seconds=1)
                return FakeResponse(json.dumps(
                    {"object": {"type": "commit", "sha": response_main}}
                ).encode("utf-8"))

        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "LANG": "C.UTF-8", "CI": "true",
            "GITHUB_REPOSITORY": "alexj11324/Mikka",
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_REF": "refs/heads/" + CONFIG.branch,
            "GITHUB_SHA": head,
            "MIKKA_GITHUB_REPAIR_GO": CONFIG.go,
            "GH_TOKEN": "offline-only",
        }
        output = io.StringIO()
        error = None
        with contextlib.ExitStack() as stack:
            for manager in (
                working_directory(self.repo),
                mock.patch.dict(os.environ, environment, clear=True),
                mock.patch.object(dt, "datetime", FrozenDateTime),
                mock.patch.object(urllib.request, "build_opener", return_value=FakeOpener()),
                mock.patch.object(urllib.request, "urlopen", side_effect=deny_network),
                mock.patch.object(socket, "create_connection", side_effect=deny_network),
                mock.patch.object(socket, "socket", side_effect=deny_network),
                contextlib.redirect_stdout(output),
            ):
                stack.enter_context(manager)
            try:
                exec(compile(code, str(CONFIG.guard_template), "exec"), {"__name__": "__main__"})
            except AssertionError as caught:
                error = caught
        return {"error": error, "requests": requests, "stdout": output.getvalue()}

    def rejected_before_get(self, head, **options):
        result = self.run_guard(head, **options)
        self.assertIsInstance(result["error"], AssertionError)
        self.assertEqual(result["requests"], [])

    def test_exact_two_parent_candidate_passes(self):
        head = self.candidate()
        self.assertEqual(self.git("rev-list", "--parents", "-n", "1", head).split()[1:],
                         [self.main, self.closed_ops])
        self.assertFalse((self.repo / "historical-closed-ops.txt").exists())
        self.assertEqual((self.repo / "product.txt").read_bytes(), b"fresh current main product\n")
        result = self.run_guard(head)
        self.assertIsNone(result["error"])
        self.assertEqual(result["requests"], [MAIN_URL])
        report = json.loads(result["stdout"])
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["source"], head)

    def test_wrong_main_parent_is_rejected(self):
        self.rejected_before_get(self.candidate(parents=(self.base, self.closed_ops)))

    def test_wrong_ops_parent_is_rejected(self):
        self.rejected_before_get(self.candidate(parents=(self.main, self.base)))

    def test_missing_ops_parent_is_rejected(self):
        self.rejected_before_get(self.candidate(parents=(self.main,)))

    def test_parent_order_is_significant(self):
        self.rejected_before_get(self.candidate(parents=(self.closed_ops, self.main)))

    def test_extra_parent_is_rejected(self):
        self.rejected_before_get(self.candidate(parents=(self.main, self.closed_ops, self.base)))

    def test_wrong_main_tree_pin_is_rejected(self):
        self.rejected_before_get(self.candidate(), tree_pin="0" * 40)

    def test_product_change_is_rejected(self):
        self.rejected_before_get(self.candidate(
            mutate=lambda: self.write("product.txt", b"unexpected change\n")))

    def test_executable_ops_file_is_rejected(self):
        path = self.repo / SOURCES[0]
        head = self.candidate(mutate=lambda: path.chmod(0o755))
        self.assertEqual(path.read_bytes(), self.source_bytes[SOURCES[0]])
        self.rejected_before_get(head)

    def test_symlink_with_matching_target_bytes_is_rejected(self):
        path = self.repo / SOURCES[0]
        def replace_with_symlink():
            path.unlink()
            path.symlink_to(CONFIG.source_dir / SOURCES[0])
        head = self.candidate(mutate=replace_with_symlink)
        self.assertTrue(path.is_symlink())
        self.assertEqual(path.read_bytes(), self.source_bytes[SOURCES[0]])
        self.rejected_before_get(head)

    def test_changed_source_bytes_are_rejected(self):
        relative = SOURCES[0]
        self.rejected_before_get(self.candidate(mutate=lambda: self.write(
            relative, self.source_bytes[relative] + b"\n")))

    def test_dirty_tracked_worktree_is_rejected(self):
        head = self.candidate()
        path = self.repo / SOURCES[0]
        path.write_bytes(path.read_bytes() + b"\n")
        self.rejected_before_get(head)

    def test_expired_entry_rejects_before_get(self):
        self.rejected_before_get(self.candidate(), expired_at_entry=True)

    def test_expiry_during_response_rejects_after_get(self):
        result = self.run_guard(self.candidate(), expires_during_response=True)
        self.assertIsInstance(result["error"], AssertionError)
        self.assertEqual(result["requests"], [MAIN_URL])

    def test_current_main_change_is_rejected(self):
        result = self.run_guard(self.candidate(), current_main=self.base)
        self.assertIsInstance(result["error"], AssertionError)
        self.assertEqual(result["requests"], [MAIN_URL])

def main():
    global CONFIG
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("guard_template", type=Path)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--branch", default="ops/1505-smoke-github-readonly-20261109")
    parser.add_argument("--go", default="root-reviewed-1505-github-trusted-v4")
    parser.add_argument("--deadline", default="2026-11-09T14:00:00+00:00")
    CONFIG = parser.parse_args()
    CONFIG.guard_template = CONFIG.guard_template.resolve()
    CONFIG.source_dir = CONFIG.source_dir.resolve()
    unittest.main(argv=[sys.argv[0]], verbosity=2)

if __name__ == "__main__":
    main()
