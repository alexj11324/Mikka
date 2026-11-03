"""Fixed #1166 physical reader. Sent over stdin; no file is installed on the VM."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path("/home/user/.mikka/worker")
WORKTREE = ROOT / "worktrees/e2cc22fa-5644-4fad-8d98-070472e609d2"
RUNS = ("c7bdd043-22fa-4ea3-8705-dcdc372262f3", "e57a6d03-510e-496f-bd88-97375318cd9e")
SID = "01a1a2a5-76f1-7881-b182-311eba17fa98"
FILE = "factory-1146-codex-d8f3d3f2.txt"
FILE_HASH = "4e80716f5de244c05cab6f9fdf3d93c90f35fc2cabcf4a07ae79772c48d35032"
SNAPSHOT = "8f418086fff9bcd42d17e32de7b7f4a968fdfc0a"
ANCESTOR = "627f9af9e1a1e76154e6343aeb72c110a53f3e28"
WORKSPACE = "de300000-154f-4875-832f-70e7ffc3b62b"
SHA = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def regular_bytes(path, cap=32 * 1024 * 1024):
    # Reject parent/final symlinks, special files and unbounded reads. O_NOATIME
    # keeps the evidence reads from changing file access timestamps.
    require(path.is_absolute() and path.resolve(strict=True) == path, "path_rejected")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NOATIME
    fd = os.open(path, flags)
    try:
        metadata = os.fstat(fd)
        require(stat.S_ISREG(metadata.st_mode) and 0 < metadata.st_size <= cap, "file_shape_rejected")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(cap + 1)
        require(len(data) == metadata.st_size and len(data) <= cap, "file_changed_during_read")
        return data
    finally:
        os.close(fd)


def git(*args, allowed=(0,)):
    # No shell, hooks, external diff/textconv, credential helpers or optional
    # locks. The fixed commands do not fetch, checkout, reset, add or commit.
    result = subprocess.run(
        ["/usr/bin/git", "-c", "safe.directory=" + str(WORKTREE),
         "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
         "-c", "maintenance.auto=false", "-c", "gc.auto=0",
         "-C", str(WORKTREE), *args],
        env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent",
             "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
             "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_OPTIONAL_LOCKS": "0",
             "GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat",
             "LC_ALL": "C"},
        capture_output=True, check=False, timeout=5,
    )
    require(result.returncode in allowed, "git_check_failed")
    require(len(result.stdout) <= 1024 * 1024, "git_output_too_large")
    return result.stdout


def collect(config):
    target = config.get("target", {})
    require(config.get("phase") in ("before", "after") and
            target.get("sandboxId") == "itxw486q7r74fasogje2v" and
            target.get("worktree") == str(WORKTREE) and
            target.get("sessionId") == SID and target.get("filename") == FILE,
            "fixed_scope_rejected")
    require(WORKTREE.resolve(strict=True) == WORKTREE and WORKTREE.is_dir(), "worktree_rejected")
    data = regular_bytes(WORKTREE / FILE, 1024)
    require(len(data) == 85 and digest(data) == FILE_HASH, "retained_file_changed")
    head = git("rev-parse", "HEAD").decode("ascii").strip()
    require(COMMIT.fullmatch(head), "git_head_rejected")
    if config["phase"] == "before":
        require(head == SNAPSHOT, "before_git_head_changed")
    git("merge-base", "--is-ancestor", SNAPSHOT, "HEAD")
    git("merge-base", "--is-ancestor", ANCESTOR, "HEAD")
    git("diff", "--no-ext-diff", "--no-textconv", "--exit-code", "HEAD", "--", FILE)
    snapshot_file = git("cat-file", "blob", SNAPSHOT + ":" + FILE)
    require(digest(snapshot_file) == FILE_HASH, "snapshot_file_changed")
    tracked_status = git("status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=all")
    worker_sha = regular_bytes(Path("/opt/mikka/worker-source-sha"), 100).decode("ascii").strip()
    require(COMMIT.fullmatch(worker_sha), "worker_receipt_rejected")

    # Never select assignment, tokens, raw error, prompt, taskEnv or credentials.
    # runs.json is hashed locally as a whole; only the named safe projection
    # of the two original entries is emitted, not the parsed JSON document.
    journal_bytes = regular_bytes(ROOT / "runs.json")
    journal = json.loads(journal_bytes).get("runs", {})
    journals = []
    ledgers = []
    for index, run_id in enumerate(RUNS):
        entry = journal.get(run_id, {})
        require(entry.get("sessionId") == SID and entry.get("worktree") == str(WORKTREE) and
                entry.get("state") == ("stopped" if index == 0 else "failed"), "journal_scope_rejected")
        projection = {key: entry.get(key) for key in (
            "state", "sessionId", "worktree", "baseCommit", "deliverableCommit",
            "lastSeq", "stopReason", "questionResumeState", "waitingQuestionId", "updatedAt")}
        journals.append({
            "runId": run_id, "state": entry["state"], "sessionId": SID,
            "worktree": str(WORKTREE), "projectionSha256": digest(canonical(projection)),
        })
        ledger_bytes = regular_bytes(ROOT / "adapters/native-ledgers" / (run_id + ".json"), 1024 * 1024)
        ledger = json.loads(ledger_bytes)
        scope = ledger.get("scope", {})
        require(ledger.get("sessionId") == SID and scope.get("runId") == run_id and
                scope.get("workspaceId") == WORKSPACE and scope.get("route") == "codex_cli" and
                isinstance(scope.get("accountId"), str), "ledger_scope_rejected")
        ledgers.append({
            "runId": run_id, "sessionId": SID, "workspaceId": WORKSPACE,
            "bindingId": scope.get("bindingId"), "consumerId": scope.get("consumerId"),
            "route": scope.get("route"), "revision": scope.get("revision"),
            "accountIdSha256": digest(scope["accountId"].encode("utf-8")),
            "fileSha256": digest(ledger_bytes),
        })

    # Only the original SID's JSONL files under C7/e57's two history folders.
    # No auth/config/bootstrap files, log SQLite, or general home directory scan.
    prefixes = config.get("prefixes", [])
    require(isinstance(prefixes, list) and len(prefixes) <= 64, "prefix_manifest_rejected")
    for row in prefixes:
        require(row.get("runId") in RUNS and SHA.fullmatch(row.get("filenameSha256", "")) and
                SHA.fullmatch(row.get("sha256", "")) and isinstance(row.get("bytes"), int) and
                0 < row["bytes"] <= 32 * 1024 * 1024, "prefix_manifest_rejected")
    sessions = []
    total_bytes = 0
    for run_id in RUNS:
        for kind in ("sessions", "archived_sessions"):
            folder = ROOT / "adapters/runs" / run_id / "codex-home" / kind
            if not folder.exists():
                continue
            require(folder.resolve(strict=True) == folder and folder.is_dir(), "session_folder_rejected")
            for directory, directories, filenames in os.walk(folder, followlinks=False):
                directories[:] = sorted(name for name in directories
                                        if not (Path(directory) / name).is_symlink())
                for filename in sorted(filenames):
                    if SID not in filename or not filename.endswith(".jsonl"):
                        continue
                    history = regular_bytes(Path(directory) / filename)
                    total_bytes += len(history)
                    require(total_bytes <= 64 * 1024 * 1024 and len(sessions) < 64, "history_size_rejected")
                    first = json.loads(history.split(b"\n", 1)[0])
                    require(first.get("type") == "session_meta" and
                            first.get("payload", {}).get("id") == SID, "session_id_rejected")
                    name_hash = digest(filename.encode("utf-8"))
                    old = [row for row in prefixes
                           if row["runId"] == run_id and row["filenameSha256"] == name_hash]
                    prefix_matches = None if not old else all(
                        len(history) >= row["bytes"] and digest(history[:row["bytes"]]) == row["sha256"]
                        for row in old)
                    sessions.append({
                        "runId": run_id, "kind": kind, "sessionId": SID,
                        "filenameSha256": name_hash, "bytes": len(history),
                        "sha256": digest(history), "prefixMatches": prefix_matches,
                    })
    require(all(any(row["runId"] == run_id for row in sessions) for run_id in RUNS), "session_history_missing")
    return {
        "version": 1, "sessionId": SID,
        "file": {"bytes": 85, "sha256": FILE_HASH},
        "git": {"head": head, "snapshotAncestor": True, "initialAncestor": True,
                "fileMatchesHead": True, "snapshotFileSha256": FILE_HASH,
                "trackedStatusSha256": digest(tracked_status)},
        "workerSourceSha": worker_sha,
        "journalFileSha256": digest(journal_bytes),
        "journals": journals, "ledgers": ledgers, "sessions": sessions,
    }


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2 and len(sys.argv[1]) <= 32768, "input_rejected")
        result = collect(json.loads(base64.b64decode(sys.argv[1], validate=True)))
        print(json.dumps(result, separators=(",", ":")))
    except Exception as error:
        # Never return raw exception text, traceback, filesystem data or stderr.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-z_]{1,64}", str(error)) else "physical_probe_failed"
        print(json.dumps({"error": code}, separators=(",", ":")))
        sys.exit(1)
