#!/usr/bin/env python3
"""One bounded, credential-free Go RED/GREEN proof. No production APIs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time


BASELINE = "14fe545869b71c79c8bafa6254c671bad5cbdb47"
BASELINE_TREE = "7fe64fd8ac98d7addaa9a04ed4f73a15d10577f5"
CPA = "8289ec4c71ad914d0612c2776352b76ba3d355a6"
IMAGE = "golang:1.26.10-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af"
PACKAGE = "github.com/alexj11324/Mikka/subscription-worker"
TEST = "TestCodexSubscriptionStableSystemCacheBreakpoints"
SENTINEL = "codex_stable_cache_breakpoints_missing: want 2 explicit stable-system markers, got 0"
TEST_PATH = "packages/subscription-worker/codex_cache_breakpoints_test.go"
HELPER_PATHS = {
    ".github/workflows/codex-cache-offline-proof.yml",
    "scripts/diagnostics/codex-cache-offline-proof.py",
    "scripts/diagnostics/codex-cache-offline-proof.json",
}
REGRESSION_TESTS = [
    "TestPlainModelUpstreamRefusalIsLoggedByStatusAndTypeOnly",
    "TestPlainModelProviderStatusKeepsOnlyActionableRefusal",
    "TestPlainModelProviderStreamErrorKeepsOnlyKnownTypes",
    "TestUpstreamErrorTypeKeepsOnlyTheEnum",
    "TestRequestDiagnosticsAcceptOnlyLocalEnumsAndByteCounts",
    "TestPlainModelRequestBoundariesDoNotReachProviderOrExposeInput",
    "TestClaudeSubscriptionSystemPreservesHostBlocks",
    "TestClaudeSubscriptionRequestPreservesInstructionsAndToolHistory",
    "TestClaudeSubscriptionLayeredCacheBreakpoints",
    "TestCodexSubscriptionStreamWithoutContentType",
    "TestCodexSubscriptionCacheBreakpointCompatibility",
    "TestCodexSubscriptionCacheBreakpointAlignment",
]
DEPENDENCY_PATHS = [
    "packages/subscription-worker/CPA_COMMIT",
    "packages/subscription-worker/bootstrap.mjs",
    "packages/subscription-worker/go.mod",
    "packages/subscription-worker/go.sum",
    "packages/subscription-worker/compat/bridge.go.txt",
    "packages/subscription-worker/compat/codex-http.go.txt",
    "packages/subscription-worker/compat/claude-http.go.txt",
]


class ProofFailure(RuntimeError):
    pass


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def safe_env() -> dict[str, str]:
    # Do not forward GitHub tokens, workload identity, DB URLs or model settings.
    return {"PATH": os.environ["PATH"], "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, env=safe_env(),
                                   stderr=subprocess.PIPE, timeout=30).decode().strip()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def classify_go(raw: str, exit_code: int | None, *, red: bool,
                expected_tests: list[str], timed_out: bool = False) -> dict:
    """Require actual go -json test events; setup/build failures cannot be RED."""
    result = {"accepted": False, "kind": "unclassified", "exitCode": exit_code}
    if timed_out:
        return {**result, "kind": "timeout"}
    events = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return {**result, "kind": "invalid_go_json"}
        if not isinstance(event, dict) or not isinstance(event.get("Action"), str):
            return {**result, "kind": "invalid_go_event"}
        events.append(event)
    if not events:
        return {**result, "kind": "no_go_events"}
    if any(event["Action"] == "build-fail" or event.get("FailedBuild") for event in events):
        return {**result, "kind": "build_failure"}
    tests = [event for event in events if event.get("Package") == PACKAGE and event.get("Test")]
    started = {event["Test"] for event in tests if event["Action"] == "run"}
    passed = {event["Test"] for event in tests if event["Action"] == "pass"}
    failed = {event["Test"] for event in tests if event["Action"] == "fail"}
    skipped = {event["Test"] for event in tests if event["Action"] == "skip"}
    packages = [event for event in events if event.get("Package") == PACKAGE and not event.get("Test")]
    terminal = [event["Action"] for event in packages if event["Action"] in {"pass", "fail", "skip"}]
    result.update({"startedTests": sorted(started), "passedTests": sorted(passed),
                   "failedTests": sorted(failed), "skippedTests": sorted(skipped),
                   "packageTerminalEvents": terminal})
    if not set(expected_tests).issubset(started):
        return {**result, "kind": "expected_test_not_executed"}
    if skipped:
        return {**result, "kind": "unexpected_skip"}
    if red:
        sentinel_events = [event for event in tests if event["Action"] == "output"
                           and (event["Test"] == TEST or event["Test"].startswith(TEST + "/"))
                           and SENTINEL in str(event.get("Output", ""))]
        expected_failures = failed and all(name == TEST or name.startswith(TEST + "/") for name in failed)
        accepted = (exit_code == 1 and TEST in failed and expected_failures
                    and bool(sentinel_events) and terminal == ["fail"])
        return {**result, "accepted": bool(accepted),
                "kind": "expected_missing_marker_assertion" if accepted else "unexpected_baseline_result",
                "sentinelEventCount": len(sentinel_events)}
    accepted = (exit_code == 0 and not failed and set(expected_tests).issubset(passed)
                and terminal == ["pass"]
                and not any(event["Action"] == "fail" for event in events))
    return {**result, "accepted": accepted, "kind": "passed" if accepted else "candidate_test_failure"}


def docker_command(name: str, run_key: str, worker: Path, cache: Path,
                   command: list[str], *, network: bool) -> list[str]:
    args = ["docker", "run", "--rm", "--name", name,
            "--label", f"mikka.codex-cache-proof={run_key}",
            "--memory=6g", "--cpus=2", "--user", f"{os.getuid()}:{os.getgid()}",
            "--network", "bridge" if network else "none",
            "--mount", f"type=bind,src={worker},dst=/work,readonly",
            "--mount", f"type=bind,src={cache / 'build'},dst=/cache/build",
            "--mount", f"type=bind,src={cache / 'mod'},dst=/cache/mod" + ("" if network else ",readonly"),
            "--mount", f"type=bind,src={cache / 'go'},dst=/cache/go",
            "--workdir", "/work", "--env", "GOCACHE=/cache/build",
            "--env", "GOMODCACHE=/cache/mod", "--env", "GOPATH=/cache/go",
            "--env", "GOTOOLCHAIN=local", "--env", "CGO_ENABLED=0",
            "--env", "GOTELEMETRY=off"]
    if not network:
        args.extend(["--env", "GOPROXY=off", "--env", "GOSUMDB=off"])
    return [*args, IMAGE, *command]


class Runner:
    def __init__(self, out: Path, run_key: str):
        self.out = out
        self.run_key = run_key
        self.deadline = time.monotonic() + 20 * 60
        self.owned: list[str] = []
        self.out.mkdir(parents=True, exist_ok=True)

    def run(self, label: str, command: list[str], cwd: Path, seconds: int, *, cleanup=False) -> dict:
        stdout = self.out / f"{label}.stdout.log"
        stderr = self.out / f"{label}.stderr.log"
        budget = seconds if cleanup else min(seconds, max(0, self.deadline - time.monotonic()))
        record = {"label": label, "command": command, "timeoutSeconds": budget,
                  "exitCode": None, "timedOut": False, "startedAt": time.time()}
        with stdout.open("wb") as output, stderr.open("wb") as errors:
            if budget <= 0:
                record["timedOut"] = True
            else:
                try:
                    proc = subprocess.Popen(command, cwd=cwd, env=safe_env(), stdout=output,
                                            stderr=errors, start_new_session=True)
                    try:
                        record["exitCode"] = proc.wait(timeout=budget)
                    except subprocess.TimeoutExpired:
                        record["timedOut"] = True
                        try:
                            os.killpg(proc.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        try:
                            record["exitCode"] = proc.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            try:
                                os.killpg(proc.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            record["exitCode"] = proc.wait(timeout=10)
                except OSError as error:
                    record["startErrorClass"] = type(error).__name__
        record["finishedAt"] = time.time()
        write_json(self.out / f"{label}.command.json", record)
        print(json.dumps({key: record[key] for key in ("label", "exitCode", "timedOut")}))
        return record

    def required(self, label: str, command: list[str], cwd: Path, seconds: int) -> dict:
        record = self.run(label, command, cwd, seconds)
        if record["timedOut"] or record["exitCode"] != 0:
            raise ProofFailure(f"preparation_failed:{label}")
        return record

    def docker(self, phase: str, worker: Path, cache: Path, command: list[str],
               seconds: int, *, network=False) -> dict:
        name = f"mikka-codex-cache-proof-{self.run_key}-{phase}"
        self.owned.append(name)
        write_json(self.out / "owned-containers.json", {"runKey": self.run_key, "names": self.owned})
        return self.run(phase, docker_command(name, self.run_key, worker, cache, command, network=network),
                        worker, seconds)

    def cleanup(self) -> bool:
        okay = True
        for index, name in enumerate(self.owned):
            if not re.fullmatch(rf"mikka-codex-cache-proof-{re.escape(self.run_key)}-(modules|format|red|green|regression)", name):
                raise ProofFailure("invalid_owned_container")
            label = f"cleanup-list-{index}"
            check = self.run(label, ["docker", "ps", "-aq", "--filter", f"name=^/{name}$",
                "--filter", f"label=mikka.codex-cache-proof={self.run_key}"], self.out, 20, cleanup=True)
            if check["exitCode"] != 0 or check["timedOut"]:
                okay = False
                continue
            ids = (self.out / f"{label}.stdout.log").read_text().splitlines()
            if len(ids) > 1 or any(not re.fullmatch(r"[a-f0-9]{12,64}", item) for item in ids):
                okay = False
                continue
            if ids:
                removed = self.run(f"cleanup-remove-{index}", ["docker", "rm", "-f", ids[0]], self.out, 30, cleanup=True)
                okay = okay and removed["exitCode"] == 0 and not removed["timedOut"]
        write_json(self.out / "cleanup.json", {"runKey": self.run_key, "ownedNames": self.owned, "okay": okay})
        return okay


def source_fence(config: dict, helper: Path, baseline: Path, candidate: Path, out: Path) -> dict:
    actual_sha = os.environ.get("GITHUB_SHA", "")
    if os.environ.get("GITHUB_REPOSITORY") != "alexj11324/Mikka" or os.environ.get("GITHUB_EVENT_NAME") != "push":
        raise ProofFailure("wrong_workflow_scope")
    if os.environ.get("GITHUB_RUN_ATTEMPT") != "1" or os.environ.get("GITHUB_REF") != "refs/heads/" + config["branch"]:
        raise ProofFailure("wrong_ref_or_attempt")
    if config["baseline"] != BASELINE or config["baselineTree"] != BASELINE_TREE:
        raise ProofFailure("baseline_pin_mismatch")
    if config["cpa"] != CPA or config["image"] != IMAGE or config["testPath"] != TEST_PATH:
        raise ProofFailure("dependency_pin_mismatch")
    for sha in (actual_sha, config["candidate"], config["candidateTree"]):
        if not re.fullmatch(r"[a-f0-9]{40}", sha):
            raise ProofFailure("invalid_source_sha")
    if git(helper, "rev-parse", "HEAD") != actual_sha:
        raise ProofFailure("helper_head_mismatch")
    if git(helper, "status", "--porcelain", "--untracked-files=all"):
        raise ProofFailure("helper_checkout_not_clean")
    if git(helper, "show", "-s", "--format=%P", "HEAD").split() != [config["candidate"]]:
        raise ProofFailure("helper_not_direct_child_of_candidate")
    if set(git(helper, "diff", "--name-only", config["candidate"], actual_sha).splitlines()) != HELPER_PATHS:
        raise ProofFailure("helper_changes_product_files")
    for path, expected_sha, expected_tree in ((baseline, BASELINE, BASELINE_TREE),
            (candidate, config["candidate"], config["candidateTree"])):
        if git(path, "rev-parse", "HEAD") != expected_sha or git(path, "rev-parse", "HEAD^{tree}") != expected_tree:
            raise ProofFailure("checkout_source_mismatch")
        if git(path, "status", "--porcelain", "--untracked-files=all"):
            raise ProofFailure("checkout_not_clean")
    for path in DEPENDENCY_PATHS:
        if sha256(baseline / path) != sha256(candidate / path):
            raise ProofFailure("dependency_changed_between_red_green")
    test = candidate / TEST_PATH
    if sha256(test) != config["testSha256"] or (baseline / TEST_PATH).exists():
        raise ProofFailure("entry_fixture_pin_mismatch")
    result = {"helper": actual_sha, "helperParent": config["candidate"], "baseline": BASELINE,
        "candidate": config["candidate"], "candidateTree": config["candidateTree"],
        "testPath": TEST_PATH, "testSha256": config["testSha256"], "cpa": CPA, "image": IMAGE,
        "credentialEnvironmentForwarded": False, "databaseStarted": False, "modelRequests": 0,
        "realGoProofStarted": False}
    write_json(out / "source-proof.json", result)
    return result


def execute(args, config: dict, runner: Runner) -> dict:
    source = source_fence(config, args.helper, args.baseline, args.candidate, args.out)
    baseline_worker = args.baseline / "packages/subscription-worker"
    candidate_worker = args.candidate / "packages/subscription-worker"
    cache = args.out.parent / ("codex-cache-proof-dependencies-" + runner.run_key)
    for name in ("build", "mod", "go"):
        (cache / name).mkdir(parents=True, exist_ok=False)
    shutil.copyfile(args.candidate / TEST_PATH, args.baseline / TEST_PATH)
    if sha256(args.baseline / TEST_PATH) != config["testSha256"]:
        raise ProofFailure("copied_entry_fixture_mismatch")
    runner.required("bootstrap-baseline", ["node", "packages/subscription-worker/bootstrap.mjs"], args.baseline, 240)
    if git(baseline_worker / ".upstream", "rev-parse", "HEAD") != CPA:
        raise ProofFailure("baseline_cpa_mismatch")
    shutil.copytree(baseline_worker / ".upstream", candidate_worker / ".upstream")
    runner.required("bootstrap-candidate", ["node", "packages/subscription-worker/bootstrap.mjs"], args.candidate, 45)
    if git(candidate_worker / ".upstream", "rev-parse", "HEAD") != CPA:
        raise ProofFailure("candidate_cpa_mismatch")
    runner.required("pull-image", ["docker", "pull", IMAGE], args.helper, 240)
    prepared = runner.docker("modules", baseline_worker, cache,
        ["sh", "-eu", "-c", "go version\ngo mod download all\ngo mod verify"], 300, network=True)
    if prepared["exitCode"] != 0 or prepared["timedOut"]:
        raise ProofFailure("module_preparation_failed")
    if "go version go1.26.10 linux/amd64" not in (args.out / "modules.stdout.log").read_text():
        raise ProofFailure("go_version_mismatch")
    source["realGoProofStarted"] = True
    write_json(args.out / "source-proof.json", source)
    formatting = runner.docker("format", candidate_worker, cache,
        ["gofmt", "-l", "-d", "plain_model.go", "codex_cache_breakpoints_test.go"], 30)
    formatting_result = {"exitCode": formatting["exitCode"], "timedOut": formatting["timedOut"],
        "hasDiff": bool((args.out / "format.stdout.log").read_text().strip())}
    formatting_result["clean"] = (formatting_result["exitCode"] == 0
        and not formatting_result["timedOut"] and not formatting_result["hasDiff"])
    write_json(args.out / "format.classification.json", formatting_result)
    # A formatting difference must not waste the real one-shot RED/GREEN proof.
    classifications = {}
    commands = [
        ("red", baseline_worker, "^" + TEST + "$", [TEST], 420),
        ("green", candidate_worker, "^" + TEST + "$", [TEST], 180),
        ("regression", candidate_worker, "^(TestPlainModel.*|TestClaudeSubscription.*|TestCodexSubscription.*|TestUpstreamErrorTypeKeepsOnlyTheEnum|TestRequestDiagnosticsAcceptOnlyLocalEnumsAndByteCounts)$", REGRESSION_TESTS + [TEST], 180),
    ]
    for phase, worker, pattern, expected, timeout in commands:
        command = ["go", "test", "-mod=readonly", "-p=2", "-timeout=90s", "-count=1", "-json", "-run", pattern, "."]
        record = runner.docker(phase, worker, cache, command, timeout)
        classification = classify_go((args.out / f"{phase}.stdout.log").read_text(), record["exitCode"],
            red=phase == "red", expected_tests=expected, timed_out=record["timedOut"])
        classifications[phase] = classification
        write_json(args.out / f"{phase}.classification.json", classification)
        if not classification["accepted"]:
            raise ProofFailure(f"{phase}:{classification['kind']}")
    if git(args.baseline, "diff", "--name-only", "HEAD") or git(args.candidate, "diff", "--name-only", "HEAD"):
        raise ProofFailure("tracked_sources_modified_during_proof")
    return {"status": "passed" if formatting_result["clean"] else "failed",
            "scope": "offline_request_construction_only", "classifications": classifications,
            "formatting": formatting_result,
            "productionCacheHitProven": False, "productionLatencyProven": False}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cleanup-only", action="store_true")
    args = parser.parse_args()
    for name in ("config", "helper", "baseline", "candidate", "out"):
        setattr(args, name, getattr(args, name).resolve())
    run_id, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not re.fullmatch(r"[0-9]+", run_id) or attempt != "1":
        raise ProofFailure("not_authorized_first_actions_attempt")
    config = json.loads(args.config.read_text())
    runner = Runner(args.out, run_id + "-" + attempt)
    owned = args.out / "owned-containers.json"
    if args.cleanup_only:
        if owned.exists():
            state = json.loads(owned.read_text())
            if state["runKey"] != runner.run_key:
                raise ProofFailure("cleanup_run_mismatch")
            runner.owned = state["names"]
        return 0 if runner.cleanup() else 1
    outcome = {"status": "failed", "scope": "offline_request_construction_only"}
    try:
        outcome = execute(args, config, runner)
    except Exception as error:
        outcome.update({"errorClass": type(error).__name__,
                        "failureCode": str(error) if isinstance(error, ProofFailure) else "runner_exception"})
    finally:
        try:
            cleanup_ok = runner.cleanup()
        except Exception as error:
            cleanup_ok = False
            outcome["cleanupErrorClass"] = type(error).__name__
        outcome["cleanupOkay"] = cleanup_ok
        if not cleanup_ok:
            outcome["status"] = "failed"
        write_json(args.out / "summary.json", outcome)
    print(json.dumps(outcome, ensure_ascii=False))
    return 0 if outcome["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
