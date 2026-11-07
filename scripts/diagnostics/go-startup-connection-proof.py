#!/usr/bin/env python3
"""Bounded, credential-free startup proof. Only an exact first helper push runs."""
from __future__ import annotations
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

BASELINE = "b268fbdb953c70a5e0dfee2f0013bf3a81b6dfac"
BASELINE_TREE = "a32509917eab6cea995d2a2401d8b984ce2b37d1"
CANDIDATE_TREE = "214b5119e802e4728e0ef0533659331e970cb1ba"
BRANCH = "diagnostic/issue-1506-go-startup-proof-20261107-01"
MAIN_PATH = "packages/subscription-worker/cmd/mikka-subscription-worker/main.go"
BASELINE_MAIN = "0c19b41a69bfeb136434bea87e6d6c96718dd1d91d6f831c35f1a42218a6013b"
CANDIDATE_MAIN = "0f171cf2c56667c0a17e42fd39f3cf1546870a848fd023b5d6fbf914f2824aab"
CPA = "8289ec4c71ad914d0612c2776352b76ba3d355a6"
GO_IMAGE = "golang:1.26.10-bookworm@sha256:632dff7351799a5a9954a48dc06670ade72ee44e8c351cdc0e5a57af2fea21af"
PG_IMAGE = "postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb"
PACKAGE = "github.com/alexj11324/Mikka/subscription-worker"
WIRE_PATH = "scripts/diagnostics/go-startup-pg-wire-proof.py"
WIRE_SHA = "1b062afc6ae60f3b16ba835302f00c969f2f7e365894f722add01c86b488b022"
HELPER_PATHS = {".github/workflows/go-startup-connection-proof.yml",
    "scripts/diagnostics/go-startup-connection-proof.py",
    "scripts/diagnostics/go-startup-connection-proof.json", WIRE_PATH}
DEPENDENCY_PATHS = ["packages/subscription-worker/" + name for name in (
    "CPA_COMMIT", "bootstrap.mjs", "go.mod", "go.sum", "compat/bridge.go.txt",
    "compat/codex-http.go.txt", "compat/claude-http.go.txt")]
PG_TESTS = ["TestExecutionReadsOnlyAccessProjectionAndEnforcesEveryBinding",
    "TestConcurrentRotationPreservesStreamButDisconnectStopsIt",
    "TestStreamChecksAuthorizeEveryChunkWithoutFetchingUnusedCredentialRecord"]
PARENT_TEST = "cancelling during preparation cannot start inference afterward"
PHASES = {"modules", "format", "build-baseline", "build-candidate", "binary-info", "pg", "pg-regression"}
PG_USER, PG_PASSWORD, PG_DATABASE = "mikka_test", "startup-wire-fixture-only", "mikka_cpa_e2e"


class ProofFailure(RuntimeError):
    pass


def need(ok, code):
    if not ok:
        raise ProofFailure(code)


def write_json(path: Path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def safe_env():
    return {"PATH": os.environ["PATH"], "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}


def git(root: Path, *args):
    return subprocess.check_output(["git", *args], cwd=root, env=safe_env(),
        stderr=subprocess.PIPE, timeout=30).decode().strip()


def commit_parents(root: Path, ref="HEAD"):
    header = git(root, "cat-file", "-p", ref).split("\n\n", 1)[0]
    parents = [line.removeprefix("parent ") for line in header.splitlines() if line.startswith("parent ")]
    need(all(re.fullmatch(r"[a-f0-9]{40}", value) for value in parents), "invalid_commit_parent")
    return parents


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1 << 20), b""):
            h.update(part)
    return h.hexdigest()


def check_main_bytes(baseline, candidate):
    before = b"\tif db.PingContext(ctx) != nil {\n\t\treturn worker.ErrDatabase\n\t}\n"
    after = b"\tconnection, err := db.Conn(ctx)\n\tif err != nil {\n\t\treturn worker.ErrDatabase\n\t}\n\tif connection.Close() != nil {\n\t\treturn worker.ErrDatabase\n\t}\n"
    need(hashlib.sha256(baseline).hexdigest() == BASELINE_MAIN, "baseline_main_bytes_changed")
    need(hashlib.sha256(candidate).hexdigest() == CANDIDATE_MAIN, "candidate_main_bytes_changed")
    need(baseline.count(before) == 1 and candidate == baseline.replace(before, after), "main_delta_not_exact_conn_close")


def classify_go(raw, exit_code, timed_out=False):
    result = {"accepted": False, "exitCode": exit_code, "timedOut": timed_out}
    try:
        events = [json.loads(line) for line in raw.splitlines() if line.strip()]
    except json.JSONDecodeError:
        return {**result, "reason": "invalid_go_json"}
    if not events or any(not isinstance(e, dict) or not isinstance(e.get("Action"), str) for e in events):
        return {**result, "reason": "no_valid_go_events"}
    if any(e["Action"] == "build-fail" or e.get("FailedBuild") for e in events):
        return {**result, "reason": "build_failure"}
    tests = [e for e in events if e.get("Package") == PACKAGE and e.get("Test")]
    started = {e["Test"] for e in tests if e["Action"] == "run"}
    passed = {e["Test"] for e in tests if e["Action"] == "pass"}
    failed = {e["Test"] for e in tests if e["Action"] == "fail"}
    skipped = {e["Test"] for e in tests if e["Action"] == "skip"}
    terminals = [e["Action"] for e in events if e.get("Package") == PACKAGE and not e.get("Test") and e["Action"] in {"pass", "fail", "skip"}]
    okay = exit_code == 0 and not timed_out and not failed and not skipped and set(PG_TESTS) <= started and set(PG_TESTS) <= passed and terminals == ["pass"] and not any(e["Action"] == "fail" for e in events)
    return {**result, "accepted": okay, "started": sorted(started), "passed": sorted(passed),
        "failed": sorted(failed), "skipped": sorted(skipped), "packageTerminal": terminals}


def classify_parent(report, exit_code, timed_out=False):
    assertions = [a for result in report.get("testResults", []) for a in result.get("assertionResults", [])]
    selected = [a for a in assertions if a.get("title") == PARENT_TEST]
    return {"accepted": exit_code == 0 and not timed_out and report.get("numPassedTests") == 1
        and report.get("numFailedTests") == 0 and len(selected) == 1 and selected[0].get("status") == "passed",
        "exitCode": exit_code, "timedOut": timed_out, "targetCount": len(selected),
        "targetStatus": selected[0].get("status") if len(selected) == 1 else None,
        "passedTests": report.get("numPassedTests"), "failedTests": report.get("numFailedTests")}


def source_fence(config, args):
    sha = os.environ.get("GITHUB_SHA", "")
    need(os.environ.get("GITHUB_REPOSITORY") == "alexj11324/Mikka" and os.environ.get("GITHUB_EVENT_NAME") == "push", "wrong_workflow_scope")
    need(os.environ.get("GITHUB_REF") == "refs/heads/" + BRANCH and os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "wrong_ref_or_attempt")
    need(config["productionCredentials"] is False and config["realProviderCalls"] is False and config["jobTimeoutMinutes"] == 15 and config["runtimeBudgetFromWorkflowStartSeconds"] == 720, "execution_budget_or_scope_changed")
    need(config["branch"] == BRANCH and config["baseline"] == BASELINE and config["baselineTree"] == BASELINE_TREE, "baseline_pin_mismatch")
    need(config["candidateTree"] == CANDIDATE_TREE and config["candidateParents"] == [BASELINE], "candidate_tree_or_parent_pin_mismatch")
    need(config["mainPath"] == MAIN_PATH and config["baselineMainSha256"] == BASELINE_MAIN and config["candidateMainSha256"] == CANDIDATE_MAIN, "main_pin_mismatch")
    need(config["cpa"] == CPA and config["goImage"] == GO_IMAGE and config["pgImage"] == PG_IMAGE, "runtime_dependency_pin_mismatch")
    need(config["requiredPgTests"] == PG_TESTS and config["parentCancellationTest"] == PARENT_TEST and config["wireCaseCount"] == 10, "test_contract_mismatch")
    need(config["wirePath"] == WIRE_PATH and config["wireSha256"] == WIRE_SHA and sha256(args.helper / WIRE_PATH) == WIRE_SHA, "reviewed_wire_fixture_changed")
    need(re.fullmatch(r"[a-f0-9]{40}", sha) and re.fullmatch(r"[a-f0-9]{40}", config["candidate"]), "invalid_source_sha")
    need(git(args.helper, "rev-parse", "HEAD") == sha and commit_parents(args.helper) == [config["candidate"]], "helper_not_exact_direct_child")
    need(set(git(args.helper, "diff", "--name-only", config["candidate"], sha).splitlines()) == HELPER_PATHS, "helper_changes_product_files")
    for path, ref, tree in ((args.baseline, BASELINE, BASELINE_TREE), (args.candidate, config["candidate"], CANDIDATE_TREE)):
        need(git(path, "rev-parse", "HEAD") == ref and git(path, "rev-parse", "HEAD^{tree}") == tree, "checkout_source_mismatch")
        need(not git(path, "status", "--porcelain", "--untracked-files=all"), "checkout_source_dirty")
    need(not git(args.helper, "status", "--porcelain", "--untracked-files=all"), "helper_checkout_dirty")
    need(commit_parents(args.candidate) == [BASELINE], "candidate_parent_mismatch")
    need(set(git(args.candidate, "diff", "--name-only", BASELINE, config["candidate"]).splitlines()) == {MAIN_PATH}, "candidate_delta_not_one_file")
    check_main_bytes((args.baseline / MAIN_PATH).read_bytes(), (args.candidate / MAIN_PATH).read_bytes())
    need(set(config["dependencySha256"]) == set(DEPENDENCY_PATHS), "dependency_pin_set_mismatch")
    for path in DEPENDENCY_PATHS:
        expected = config["dependencySha256"][path]
        need(re.fullmatch(r"[a-f0-9]{64}", expected) and sha256(args.baseline / path) == expected and sha256(args.candidate / path) == expected, "dependency_source_bytes_changed")
    proof = {"helper": sha, "helperParents": commit_parents(args.helper), "baseline": BASELINE,
        "baselineTree": BASELINE_TREE, "candidate": config["candidate"], "candidateTree": CANDIDATE_TREE,
        "candidateParents": [BASELINE], "mainExactBytesAndOnlyDelta": True,
        "baselineMainSha256": BASELINE_MAIN, "candidateMainSha256": CANDIDATE_MAIN,
        "dependencySha256": config["dependencySha256"], "wireSha256": WIRE_SHA,
        "modelRequests": 0, "productionCredentials": False}
    write_json(args.out / "source-proof.json", proof)
    return proof


class Runner:
    def __init__(self, args, config):
        self.args, self.config, self.out = args, config, args.out
        run_id, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
        need(re.fullmatch(r"[0-9]+", run_id) and attempt == "1", "not_first_actions_attempt")
        self.key = run_id + "-" + attempt
        self.prefix = "mikka-startup-ping-proof-" + self.key
        self.owned = []
        start = json.loads((self.out / "workflow-start.json").read_text())
        need(start["runId"] == run_id and start["attempt"] == attempt and start["helperSha"] == os.environ.get("GITHUB_SHA"), "workflow_start_mismatch")
        remaining = max(0, float(start["startedAt"]) + 720 - time.time())
        self.deadline = time.monotonic() + remaining

    def run(self, label, command, cwd, seconds, *, extra_env=None, cleanup=False):
        need(re.fullmatch(r"[a-z0-9-]+", label), "invalid_log_label")
        stdout, stderr = self.out / (label + ".stdout.log"), self.out / (label + ".stderr.log")
        need(not stdout.exists() and not stderr.exists(), "refuse_overwrite_original_phase_logs")
        budget = min(seconds, max(0, self.cleanup_deadline-time.monotonic())) if cleanup else min(seconds, max(0, self.deadline-time.monotonic()))
        record = {"label": label, "command": [str(x) for x in command], "timeoutSeconds": budget,
            "exitCode": None, "timedOut": False, "startedAt": time.time()}
        child_env = safe_env()
        if extra_env:
            need(set(extra_env) <= {"MIGRATE", "MIKKA_DATABASE_URL", "DATABASE_URL", "NEXT_TELEMETRY_DISABLED", "OPENUI_TELEMETRY_DISABLED"}, "unexpected_process_environment")
            child_env.update(extra_env)
        with stdout.open("xb") as output, stderr.open("xb") as errors:
            if budget <= 0:
                record["timedOut"] = True
            else:
                try:
                    child = subprocess.Popen(command, cwd=cwd, env=child_env, stdout=output,
                        stderr=errors, start_new_session=True)
                    try:
                        record["exitCode"] = child.wait(timeout=budget)
                    except subprocess.TimeoutExpired:
                        record["timedOut"] = True
                        try:
                            os.killpg(child.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        try:
                            record["exitCode"] = child.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            try:
                                os.killpg(child.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            record["exitCode"] = child.wait(timeout=5)
                except OSError as error:
                    record["startErrorClass"] = type(error).__name__
        record["finishedAt"] = time.time()
        write_json(self.out / (label + ".command.json"), record)
        print(json.dumps({k: record[k] for k in ("label", "exitCode", "timedOut")}), flush=True)
        return record

    def required(self, label, command, cwd, seconds, **kwargs):
        record = self.run(label, command, cwd, seconds, **kwargs)
        need(record["exitCode"] == 0 and not record["timedOut"], "phase_failed:" + label)
        return record

    def own(self, phase, image):
        need(phase in PHASES, "unknown_container_phase")
        name = self.prefix + "-" + phase
        check = subprocess.run(["docker", "ps", "-aq", "--no-trunc", "--filter", "name=^/"+name+"$"], env=safe_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        need(check.returncode == 0 and not check.stdout.strip(), "owned_name_already_exists_or_uncheckable")
        item = {"name": name, "phase": phase, "image": image, "candidate": self.config["candidate"], "runKey": self.key, "preexisting": False}
        self.owned.append(item)
        write_json(self.out / "owned-containers.json", {"runKey": self.key, "candidate": self.config["candidate"], "items": self.owned})
        return name

    def go(self, phase, worker, cache, command, seconds, *, network="none", mutable=False, binary_out=None, pg_url=None):
        need(network in {"none", "bridge", "host"}, "invalid_go_network")
        need((mutable and network == "bridge" and phase == "modules") or (not mutable and phase != "modules"), "mutable_source_outside_module_preparation")
        need((phase == "pg-regression") == (network == "host" and pg_url is not None), "pg_network_phase_mismatch")
        if pg_url is not None:
            need(re.fullmatch(r"postgresql://mikka_test:startup-wire-fixture-only@127\.0\.0\.1:[0-9]{1,5}/mikka_cpa_e2e", pg_url) is not None, "nonfixture_database_url_rejected")
        name = self.own(phase, GO_IMAGE)
        cmd = ["docker", "run", "--rm", "--name", name, "--label", "mikka.startup-ping-proof="+self.config["candidate"],
            "--label", "mikka.startup-ping-run="+self.key, "--memory=6g", "--cpus=2", "--user", f"{os.getuid()}:{os.getgid()}",
            "--network", network, "--mount", f"type=bind,src={worker},dst=/work"+("" if mutable else ",readonly"),
            "--mount", f"type=bind,src={cache/'build'},dst=/cache/build",
            "--mount", f"type=bind,src={cache/'mod'},dst=/cache/mod"+("" if mutable else ",readonly"),
            "--mount", f"type=bind,src={cache/'go'},dst=/cache/go", "--workdir", "/work",
            "--env", "GOCACHE=/cache/build", "--env", "GOMODCACHE=/cache/mod", "--env", "GOPATH=/cache/go",
            "--env", "GOTOOLCHAIN=local", "--env", "GOTELEMETRY=off", "--env", "CGO_ENABLED="+("1" if pg_url else "0")]
        if network != "bridge":
            cmd += ["--env", "GOPROXY=off", "--env", "GOSUMDB=off"]
        if binary_out is not None:
            cmd += ["--mount", f"type=bind,src={binary_out},dst=/out"]
        if pg_url is not None:
            cmd += ["--env", "MIKKA_BYOS_TEST_DATABASE_URL="+pg_url,
                "--mount", f"type=bind,src={cache/'binaries/candidate'},dst=/binary,readonly",
                "--env", "MIKKA_BYOS_WORKER_BINARY=/binary/mikka-subscription-worker"]
        return self.run(phase, [*cmd, GO_IMAGE, *command], worker, seconds)

    def cleanup(self, tag):
        self.cleanup_deadline = time.monotonic() + 75
        results, okay = [], True
        for index, item in enumerate(self.owned):
            name = item["name"]
            need(item["phase"] in PHASES and name == self.prefix+"-"+item["phase"] and item["runKey"] == self.key and item["candidate"] == self.config["candidate"] and item["preexisting"] is False and item["image"] == (PG_IMAGE if item["phase"] == "pg" else GO_IMAGE), "invalid_owned_cleanup_entry")
            label = f"cleanup-{tag}-{index}"
            check = self.run(label+"-list", ["docker", "ps", "-aq", "--no-trunc", "--filter", "name=^/"+name+"$"], self.out, 10, cleanup=True)
            ids = (self.out/(label+"-list.stdout.log")).read_text().splitlines()
            row = {"name": name, "checked": check["exitCode"] == 0 and not check["timedOut"], "removed": False, "absent": False}
            if not row["checked"] or len(ids)>1 or any(not re.fullmatch(r"[a-f0-9]{64}", x) for x in ids):
                okay=False;results.append(row);continue
            if ids:
                inspected = self.run(label+"-inspect", ["docker", "inspect", ids[0]], self.out, 10, cleanup=True)
                if inspected["exitCode"] != 0 or inspected["timedOut"]:
                    okay=False;results.append(row);continue
                info = json.loads((self.out/(label+"-inspect.stdout.log")).read_text())[0]
                labels = info["Config"].get("Labels") or {}
                matches = info["Name"] == "/"+name and info["Config"]["Image"] == item["image"] and labels.get("mikka.startup-ping-proof") == self.config["candidate"] and labels.get("mikka.startup-ping-run") == self.key
                if not matches:
                    row["ownershipMismatch"]=True;okay=False;results.append(row);continue
                removed = self.run(label+"-remove", ["docker", "rm", "-f", ids[0]], self.out, 15, cleanup=True)
                row["removed"] = removed["exitCode"] == 0 and not removed["timedOut"]
                if not row["removed"]:
                    okay=False
            final = self.run(label+"-absence", ["docker", "ps", "-aq", "--no-trunc", "--filter", "name=^/"+name+"$"], self.out, 10, cleanup=True)
            row["absent"] = final["exitCode"] == 0 and not final["timedOut"] and not (self.out/(label+"-absence.stdout.log")).read_text().strip()
            okay = okay and row["absent"]
            results.append(row)
        write_json(self.out/("cleanup-"+tag+".json"), {"runKey": self.key, "okay": okay, "results": results})
        return okay


def assert_unchanged(args):
    for root in (args.baseline, args.candidate, args.helper):
        need(not git(root, "status", "--porcelain", "--untracked-files=all"), "source_changed_during_proof")
    check_main_bytes((args.baseline/MAIN_PATH).read_bytes(), (args.candidate/MAIN_PATH).read_bytes())


def execute(args, config, runner):
    source_fence(config, args)
    workers = {name: getattr(args, name)/"packages/subscription-worker" for name in ("baseline", "candidate")}
    cache = args.out.parent/("go-startup-proof-cache-"+runner.key)
    need(not cache.exists(), "cache_directory_already_exists")
    for name in ("build", "mod", "go", "binaries/baseline", "binaries/candidate"):
        (cache/name).mkdir(parents=True, exist_ok=False)
    runner.required("bootstrap-baseline", ["node", "packages/subscription-worker/bootstrap.mjs"], args.baseline, 180)
    need(git(workers["baseline"]/".upstream", "rev-parse", "HEAD") == CPA, "baseline_cpa_mismatch")
    shutil.copytree(workers["baseline"]/".upstream", workers["candidate"]/".upstream")
    runner.required("bootstrap-candidate", ["node", "packages/subscription-worker/bootstrap.mjs"], args.candidate, 40)
    need(git(workers["candidate"]/".upstream", "rev-parse", "HEAD") == CPA, "candidate_cpa_mismatch")
    runner.required("pull-go-image", ["docker", "pull", GO_IMAGE], args.helper, 150)
    runner.required("pull-pg-image", ["docker", "pull", PG_IMAGE], args.helper, 60)
    module_copy = cache/"module-prefetch"
    shutil.copytree(workers["baseline"], module_copy, symlinks=True)
    modules = runner.go("modules", module_copy, cache, ["sh", "-eu", "-c", "go version\ngo mod download all\ngo mod verify"], 240, network="bridge", mutable=True)
    for name in ("go.mod", "go.sum"):
        (args.out/("module-"+name+".diff")).write_text("".join(difflib.unified_diff((workers["baseline"]/name).read_text().splitlines(True), (module_copy/name).read_text().splitlines(True), fromfile="baseline/"+name, tofile="isolated-prefetch/"+name)))
    need(modules["exitCode"] == 0 and not modules["timedOut"], "module_prefetch_failed")
    need("go version go1.26.10 linux/amd64" in (args.out/"modules.stdout.log").read_text(), "go_version_mismatch")
    assert_unchanged(args)
    formatting = runner.go("format", workers["candidate"], cache, ["gofmt", "-l", "-d", "cmd/mikka-subscription-worker/main.go"], 20)
    clean_format = formatting["exitCode"] == 0 and not formatting["timedOut"] and not (args.out/"format.stdout.log").read_text().strip()
    binaries = {}
    for variant in ("baseline", "candidate"):
        dest = cache/("binaries/"+variant)
        built = runner.go("build-"+variant, workers[variant], cache, ["go", "build", "-mod=readonly", "-p=2", "-trimpath", "-o", "/out/mikka-subscription-worker", "./cmd/mikka-subscription-worker"], 240 if variant == "baseline" else 90, binary_out=dest)
        need(built["exitCode"] == 0 and not built["timedOut"], "actual_binary_build_failed:"+variant)
        binary = dest/"mikka-subscription-worker"
        need(binary.is_file() and not binary.is_symlink() and os.access(binary, os.X_OK), "actual_binary_missing")
        binaries[variant] = {"path": str(binary), "sha256": sha256(binary), "mainSha256": sha256(workers[variant]/"cmd/mikka-subscription-worker/main.go"), "sourceReadonlyDuringBuild": True}
    write_json(args.out/"actual-binaries.json", binaries)
    info = runner.go("binary-info", workers["candidate"], cache, ["go", "version", "-m", "/out/baseline/mikka-subscription-worker", "/out/candidate/mikka-subscription-worker"], 20, binary_out=cache/"binaries")
    need(info["exitCode"] == 0 and not info["timedOut"], "binary_metadata_failed")
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0));port=reserve.getsockname()[1]
    pg_name = runner.own("pg", PG_IMAGE)
    runner.required("pg-start", ["docker", "run", "-d", "--rm", "--name", pg_name,
        "--label", "mikka.startup-ping-proof="+config["candidate"], "--label", "mikka.startup-ping-run="+runner.key,
        "--memory=256m", "--cpus=1", "-p", f"127.0.0.1:{port}:5432", "-e", "POSTGRES_USER="+PG_USER,
        "-e", "POSTGRES_PASSWORD="+PG_PASSWORD, "-e", "POSTGRES_DB="+PG_DATABASE,
        "--health-cmd", "pg_isready -U "+PG_USER+" -d "+PG_DATABASE, "--health-interval=1s", "--health-timeout=2s", "--health-retries=20", PG_IMAGE], args.helper, 30)
    ready_deadline=min(runner.deadline,time.monotonic()+30)
    ready=False
    while time.monotonic()<ready_deadline:
        check=subprocess.run(["docker", "inspect", "--format", "{{.State.Health.Status}}", pg_name], env=safe_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        need(check.returncode==0, "owned_pg_health_unavailable")
        if check.stdout.strip()==b"healthy":ready=True;break
        if check.stdout.strip()==b"unhealthy":break
        time.sleep(.25)  # Bounded disposable-service readiness, not application polling.
    need(ready,"owned_pg_not_ready")
    pg_url=f"postgresql://{PG_USER}:{PG_PASSWORD}@127.0.0.1:{port}/{PG_DATABASE}"
    runner.required("tracked-migrations", ["node", "scripts/migrate.mjs"], args.candidate, 120,
        extra_env={"MIGRATE":"1", "MIKKA_DATABASE_URL":pg_url, "DATABASE_URL":pg_url,
            "NEXT_TELEMETRY_DISABLED":"1", "OPENUI_TELEMETRY_DISABLED":"1"})
    wire = runner.run("pg-wire", [sys.executable, str(args.helper/WIRE_PATH), "--reviewed-run",
        "--baseline-binary", binaries["baseline"]["path"], "--candidate-binary", binaries["candidate"]["path"],
        "--baseline-sha256", binaries["baseline"]["sha256"], "--candidate-sha256", binaries["candidate"]["sha256"],
        "--candidate-commit",config["candidate"],"--pg-container",pg_name,"--output",str(args.out/"wire")], args.helper, 165)
    wire_path=args.out/"wire/pg-wire-report.json"
    wire_report=json.loads(wire_path.read_text()) if wire_path.exists() else {}
    wire_ok=wire["exitCode"]==0 and not wire["timedOut"] and wire_report.get("passed") is True and len(wire_report.get("cases",[]))==10 and all(c.get("assertionsPassed") is True for c in wire_report.get("cases",[]))
    write_json(args.out/"wire.classification.json",{"accepted":wire_ok,"exitCode":wire["exitCode"],"caseCount":len(wire_report.get("cases",[]))})
    pattern="^("+"|".join(PG_TESTS)+")$"
    tests=runner.go("pg-regression",workers["candidate"],cache,["go","test","-mod=readonly","-p=2","-race","-count=1","-timeout=90s","-json","-run",pattern,"."],180,network="host",pg_url=pg_url)
    pg_result=classify_go((args.out/"pg-regression.stdout.log").read_text(),tests["exitCode"],tests["timedOut"])
    write_json(args.out/"pg-regression.classification.json",pg_result)
    parent_report=args.out/"parent-cancellation.json"
    parent=runner.run("parent-cancellation",["node",str(args.candidate/"packages/daemon/node_modules/vitest/vitest.mjs"),"run","test/subscription-worker-client.test.ts","-t",PARENT_TEST,"--reporter=json","--outputFile",str(parent_report)],args.candidate/"packages/daemon",60)
    parent_result=classify_parent(json.loads(parent_report.read_text()) if parent_report.exists() else {},parent["exitCode"],parent["timedOut"])
    write_json(args.out/"parent-cancellation.classification.json",parent_result)
    assert_unchanged(args)
    return {"status":"passed" if wire_ok and clean_format and pg_result["accepted"] and parent_result["accepted"] else "failed",
        "formatClean":clean_format,"wirePassed":wire_ok,"wireCases":len(wire_report.get("cases",[])),
        "pgRegressions":pg_result,"parentCancellation":parent_result,"actualModels":0,
        "productionLatencyProven":False,"sourceUnchangedAfterRun":True}


def main():
    parser=argparse.ArgumentParser()
    for arg in ("config","helper","baseline","candidate","out"):
        parser.add_argument("--"+arg,type=Path,required=True)
    parser.add_argument("--cleanup-only",action="store_true")
    args=parser.parse_args()
    for name in ("config","helper","baseline","candidate","out"):
        setattr(args,name,getattr(args,name).resolve())
    os.umask(0o077)
    config=json.loads(args.config.read_text())
    runner=Runner(args,config)
    if args.cleanup_only:
        ledger=args.out/"owned-containers.json"
        if ledger.exists():
            state=json.loads(ledger.read_text())
            need(state["runKey"]==runner.key and state["candidate"]==config["candidate"],"cleanup_ledger_scope_mismatch")
            runner.owned=state["items"]
        return 0 if runner.cleanup("always") else 1
    outcome={"status":"failed","scope":"isolated_binary_pg_wire_and_existing_guards"}
    try:
        outcome.update(execute(args,config,runner))
    except Exception as error:
        outcome.update(errorClass=type(error).__name__,failureCode=str(error) if isinstance(error,ProofFailure) else "runner_exception")
    finally:
        try:
            cleanup=runner.cleanup("final")
        except Exception as error:
            cleanup=False;outcome["cleanupErrorClass"]=type(error).__name__
        outcome["cleanupOkay"]=cleanup
        if not cleanup:outcome["status"]="failed"
        write_json(args.out/"summary.json",outcome)
    print(json.dumps(outcome),flush=True)
    return 0 if outcome["status"]=="passed" else 1


if __name__=="__main__":
    sys.exit(main())
