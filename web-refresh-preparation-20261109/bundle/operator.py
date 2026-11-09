#!/usr/bin/env python3
"""One normal Web workflow dispatch. No production credentials, polling, retries or Web lock."""
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = "alexj11324/Mikka"
BRANCH = "ops/1505-web-overlay-refresh-20261109"
GO = "root-reviewed-1505-web-overlay-refresh-v1"
API = "https://api.github.com/repos/" + REPO + "/"
API_VERSION = "2026-03-10"
WEB = ".github/workflows/web-deploy.yml"
WORKFLOW = ".github/workflows/issue1505-web-overlay-refresh.yml"
COPY = "scripts/ops/issue1505-fresh-h-web-refresh.json"
H_WORKFLOW = ".github/workflows/issue1505-diagnostic-window.yml"
PIN_NAMES = (
 "APP_SOURCE", "APP_TREE", "WEB_WORKFLOW_SHA256", "H_HEAD", "H_BRANCH", "H_RUN_ID", "H_ATTEMPT",
 "H_ARTIFACT_ID", "H_ARTIFACT_NAME", "H_ARTIFACT_SIZE", "H_ARTIFACT_SHA256",
 "H_RECEIPT_MEMBER", "H_ORIGINAL_RECEIPT_SHA256", "RECEIPT_SHA256",
 "H_SCOPE_ID", "H_SCOPE_VALUE_SHA256", "H_SCOPE_EXPIRES_AT",
 "NOT_BEFORE", "ENTRY_DEADLINE", "HARD_DEADLINE", "DISPATCH_GO",
)
E = os.environ
class GuardError(Exception):
    pass
def require(ok, code):
    if not ok:
        raise GuardError(code)
def now():
    return dt.datetime.now(dt.timezone.utc)
def timestamp(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z", value), "timestamp_invalid")
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise GuardError("timestamp_invalid") from None
def positive(value):
    return isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,15}", value) and int(value) <= 9007199254740991
def sha(data):
    return hashlib.sha256(data).hexdigest()
def decode(data):
    def object_pairs(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "duplicate_json_key")
            value[key] = item
        return value
    try:
        return json.loads(data, object_pairs_hook=object_pairs)
    except GuardError:
        raise
    except Exception:
        raise GuardError("json_invalid") from None
def save(path, report):
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL).decode("utf-8").strip()
def window(entry=False):
    instant = now()
    require(timestamp(E["NOT_BEFORE"]) <= instant < timestamp(E["ENTRY_DEADLINE"] if entry else E["HARD_DEADLINE"]),
            "entry_window_closed" if entry else "hard_window_closed")
def remaining():
    window()
    return max(0.001, min(20.0, (timestamp(E["HARD_DEADLINE"]) - now()).total_seconds()))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
OPENER = urllib.request.build_opener(NoRedirect)
def request(path, method="GET", body=None):
    window()
    headers = {"Authorization": "Bearer " + E["GITHUB_TOKEN"], "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": API_VERSION, "Content-Type": "application/json"}
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    return OPENER.open(urllib.request.Request(API + path, method=method, headers=headers, data=data), timeout=remaining())
def metadata(path):
    try:
        with request(path) as response:
            require(response.status == 200, "metadata_http_failed")
            data = response.read(1_048_577)
            require(len(data) <= 1_048_576, "metadata_too_large")
        window()
        return decode(data)
    except GuardError:
        raise
    except Exception:
        raise GuardError("metadata_request_failed") from None
def validate_pins():
    require(all(isinstance(E.get(key), str) and E[key] and "__" not in E[key] for key in PIN_NAMES), "pins_unfilled")
    for key in ("APP_SOURCE", "APP_TREE", "H_HEAD"):
        require(re.fullmatch(r"[0-9a-f]{40}", E[key]), "source_pin_invalid")
    for key in ("WEB_WORKFLOW_SHA256", "H_ARTIFACT_SHA256", "H_ORIGINAL_RECEIPT_SHA256", "RECEIPT_SHA256", "H_SCOPE_VALUE_SHA256"):
        require(re.fullmatch(r"[0-9a-f]{64}", E[key]), "hash_pin_invalid")
    for key in ("H_RUN_ID", "H_ATTEMPT", "H_ARTIFACT_ID", "H_ARTIFACT_SIZE"):
        require(positive(E[key]), "integer_pin_invalid")
    require(E["DISPATCH_GO"] == GO, "go_invalid")
    require(E["H_BRANCH"].startswith("ops/1505-") and re.fullmatch(r"[A-Za-z0-9_./-]{1,200}", E["H_BRANCH"]), "h_branch_invalid")
    require(re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", E["H_ARTIFACT_NAME"]), "artifact_name_invalid")
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,200}", E["H_SCOPE_ID"]), "scope_id_invalid")
    member = E["H_RECEIPT_MEMBER"]
    require(member and not member.startswith("/") and "\\" not in member and all(x not in ("", ".", "..") for x in member.split("/")), "receipt_member_invalid")
    start, entry, hard = (timestamp(E[name]) for name in ("NOT_BEFORE", "ENTRY_DEADLINE", "HARD_DEADLINE"))
    require(start < entry <= hard and 0 < (hard-start).total_seconds() <= 900, "window_budget_invalid")
    require(timestamp(E["H_SCOPE_EXPIRES_AT"]) > hard, "scope_expires_before_dispatch_window")
    require(E.get("GITHUB_REPOSITORY") == REPO and E.get("GITHUB_EVENT_NAME") == "push"
            and E.get("GITHUB_REF") == "refs/heads/" + BRANCH and E.get("GITHUB_RUN_ATTEMPT") == "1"
            and re.fullmatch(r"[0-9a-f]{40}", E.get("GITHUB_SHA", "")), "operator_identity_invalid")
    require(E.get("GITHUB_TOKEN"), "github_token_missing")
    window(True)
def local_source_and_receipt():
    head = E["GITHUB_SHA"]
    require(git("rev-parse", "HEAD") == head, "operator_checkout_mismatch")
    require(git("rev-list", "--parents", "-n", "1", "HEAD").split()[1:] == [E["APP_SOURCE"]], "operator_parent_mismatch")
    require(git("rev-parse", E["APP_SOURCE"] + "^{tree}") == E["APP_TREE"], "application_tree_mismatch")
    entries = git("diff", "--raw", "--no-renames", "--abbrev=40", E["APP_SOURCE"], "HEAD").splitlines()
    require(len(entries) == 2, "operator_scope_mismatch")
    seen = set()
    for line in entries:
        pair = line.split("\t")
        fields = pair[0].split()
        require(len(pair) == 2 and pair[1] in {WORKFLOW, COPY} and pair[1] not in seen
                and len(fields) == 5 and fields[0] == ":000000" and fields[1] == "100644" and fields[4] == "A",
                "operator_scope_mismatch")
        seen.add(pair[1])
    require(not git("diff", "--name-only", "HEAD") and not git("diff", "--cached", "--name-only"), "operator_checkout_dirty")
    web_bytes = subprocess.check_output(["git", "show", E["APP_SOURCE"] + ":" + WEB], stderr=subprocess.DEVNULL)
    require(sha(web_bytes) == E["WEB_WORKFLOW_SHA256"], "target_workflow_bytes_changed")
    event = decode(Path(E["GITHUB_EVENT_PATH"]).read_bytes())
    require(event.get("ref") == "refs/heads/" + BRANCH and event.get("after") == head
            and event.get("deleted") is False and event.get("forced") is False, "operator_push_identity_invalid")
    raw = Path(COPY).read_bytes()
    require(len(raw) <= 262144 and sha(raw) == E["RECEIPT_SHA256"], "fresh_receipt_bytes_changed")
    receipt = decode(raw)
    require(isinstance(receipt, dict) and receipt.get("version") == 1 and receipt.get("issue") == 1505
            and receipt.get("status") == "prepared" and receipt.get("sourceCommit") == E["APP_SOURCE"]
            and receipt.get("sourceTree") == E["APP_TREE"] and receipt.get("applicationAtPreparation") == E["APP_SOURCE"]
            and receipt.get("workflowHead") == E["H_HEAD"] and str(receipt.get("workflowRunId")) == E["H_RUN_ID"]
            and str(receipt.get("attempt")) == E["H_ATTEMPT"] and receipt.get("helperBranch") == E["H_BRANCH"],
            "fresh_receipt_provenance_mismatch")
    require(receipt.get("modelsDispatched") == 0 and receipt.get("virtualMachinesCreated") == 0
            and receipt.get("profilesCreated") == 0 and receipt.get("botCreationAttempted") is False
            and receipt.get("botStopAttempted") is False, "fresh_receipt_scope_invalid")
    cleanup = receipt.get("cleanup", {})
    require(cleanup.get("botIdleVerified") is True and cleanup.get("workspaceRestored") is True
            and cleanup.get("signedOut") is True and cleanup.get("errors") == [], "fresh_receipt_cleanup_incomplete")
    scope = receipt.get("window", {})
    require(scope.get("key") == "MIKKA_CLOUD_DIAGNOSTIC_WINDOW" and scope.get("id") == E["H_SCOPE_ID"]
            and scope.get("valueSha256") == E["H_SCOPE_VALUE_SHA256"] and scope.get("expiresAt") == E["H_SCOPE_EXPIRES_AT"]
            and scope.get("durationMinutes") == 120 and scope.get("writeAttempted") is True
            and scope.get("creationAcknowledged") is True and scope.get("readbackVerified") is True
            and scope.get("requiresSubsequentWebBuild") is True, "fresh_scope_not_prepared")
    require(timestamp(receipt["startedAt"]) <= timestamp(receipt["finishedAt"]) <= now(), "fresh_receipt_time_invalid")
    return receipt
def ref_guards(stage, report):
    window(True)
    ref = metadata("git/ref/heads/" + BRANCH)
    require(ref.get("ref") == "refs/heads/" + BRANCH and ref.get("object", {}).get("type") == "commit"
            and ref["object"].get("sha") == E["GITHUB_SHA"], "operator_ref_changed")
    main = metadata("git/ref/heads/main")
    require(main.get("ref") == "refs/heads/main" and main.get("object", {}).get("type") == "commit"
            and main["object"].get("sha") == E["APP_SOURCE"], "current_main_changed")
    window(True)
    report["guards"].append({"stage": stage, "main": E["APP_SOURCE"], "operatorHead": E["GITHUB_SHA"], "at": now().isoformat()})
def validate_h_run(run):
    require(run.get("id") == int(E["H_RUN_ID"]) and run.get("run_attempt") == int(E["H_ATTEMPT"])
            and run.get("head_sha") == E["H_HEAD"] and run.get("head_branch") == E["H_BRANCH"]
            and run.get("event") == "push" and run.get("path") == H_WORKFLOW
            and run.get("repository", {}).get("full_name") == REPO
            and run.get("status") == "completed" and run.get("conclusion") == "success", "h_run_not_exact_success")
def provenance(report):
    run_path = "actions/runs/" + E["H_RUN_ID"]
    validate_h_run(metadata(run_path))
    artifact = metadata("actions/artifacts/" + E["H_ARTIFACT_ID"])
    binding = artifact.get("workflow_run", {})
    require(artifact.get("id") == int(E["H_ARTIFACT_ID"]) and artifact.get("name") == E["H_ARTIFACT_NAME"]
            and artifact.get("size_in_bytes") == int(E["H_ARTIFACT_SIZE"]) and artifact.get("expired") is False
            and artifact.get("digest") == "sha256:" + E["H_ARTIFACT_SHA256"]
            and binding.get("id") == int(E["H_RUN_ID"]) and binding.get("head_sha") == E["H_HEAD"]
            and binding.get("head_branch") == E["H_BRANCH"], "h_artifact_provenance_mismatch")
    validate_h_run(metadata(run_path))
    report["freshH"] = {key: E[key] for key in PIN_NAMES if key.startswith("H_")}
    report["freshH"]["copiedReceiptSha256"] = E["RECEIPT_SHA256"]
    report["freshH"]["zipMemberPairing"] = "root_verified_once_offline_not_downloaded_by_operator"
def dispatch_once(report, path):
    body = {"ref": "main", "inputs": {"overlay-refresh": True}, "return_run_details": True}
    window(True)
    report["status"] = "dispatch_checkpoint"
    report["dispatch"] = {"attempted": True, "attemptedAt": now().isoformat(), "accepted": None,
                          "outcomeUnknown": True, "automaticRetryAllowed": False, "body": body}
    save(path, report)  # Persist before the one non-idempotent POST.
    try:
        with request("actions/workflows/web-deploy.yml/dispatches", method="POST", body=body) as response:
            report["dispatch"]["httpStatus"] = response.status
            report["dispatch"]["responseAt"] = now().isoformat()
            report["dispatch"]["accepted"] = response.status in (200, 204)
            save(path, report)
            if response.status == 204:
                report["status"] = "accepted_without_run_identity"
                report["dispatch"]["outcomeUnknown"] = False
                report["dispatch"]["runIdentityUnknown"] = True
                save(path, report)
                window()
                return False
            require(response.status == 200, "dispatch_unexpected_status")
            data = response.read(65537)
            require(len(data) <= 65536, "dispatch_response_too_large")
            result = decode(data)
            run_id = result.get("workflow_run_id")
            require(isinstance(run_id, int) and not isinstance(run_id, bool) and 0 < run_id <= 9007199254740991,
                    "dispatch_run_identity_invalid")
            require(result.get("run_url") == API + "actions/runs/" + str(run_id)
                    and result.get("html_url") == "https://github.com/" + REPO + "/actions/runs/" + str(run_id),
                    "dispatch_run_identity_invalid")
            report["dispatch"].update({"runId": run_id, "runUrl": result["run_url"], "htmlUrl": result["html_url"],
                                       "outcomeUnknown": False, "runIdentityUnknown": False})
            save(path, report)  # Keep known acceptance/identity even if the following hard fence fails.
            window()
            report["status"] = "dispatched"
            return True
    except urllib.error.HTTPError as error:
        report["dispatch"]["httpStatus"] = error.code
        report["status"] = "dispatch_response_without_accepted_proof"
        error.close()
        return False
    except GuardError as error:
        report["status"] = "dispatch_unconfirmed"
        report["code"] = str(error)
        return False
    except Exception:
        report["status"] = "dispatch_transport_uncertain"
        report["code"] = "dispatch_transport_uncertain"
        return False
def main():
    output = Path(E["RUNNER_TEMP"]) / "issue1505-web-overlay-dispatch.json"
    report = {"version": 1, "issue": 1505, "status": "preflight", "startedAt": now().isoformat(),
              "operatorRunId": E.get("GITHUB_RUN_ID"), "operatorAttempt": E.get("GITHUB_RUN_ATTEMPT"),
              "operatorHead": E.get("GITHUB_SHA"), "operatorBranch": BRANCH, "guards": [],
              "productionSecretsRead": 0, "webQueueHeld": False, "downstreamPolled": False,
              "automaticRetryAllowed": False, "dispatch": {"attempted": False, "accepted": None}}
    passed = False
    try:
        save(output, report)
        validate_pins()
        report["application"] = {"sourceCommit": E["APP_SOURCE"], "sourceTree": E["APP_TREE"],
                                 "webWorkflowSha256": E["WEB_WORKFLOW_SHA256"]}
        report["window"] = {key: E[key] for key in ("NOT_BEFORE", "ENTRY_DEADLINE", "HARD_DEADLINE")}
        local_source_and_receipt()
        ref_guards("preflight", report)
        provenance(report)
        ref_guards("immediately_before_dispatch", report)
        save(output, report)
        passed = dispatch_once(report, output)
    except GuardError as error:
        report["status"] = "failed"; report["code"] = str(error)
    except Exception:
        report["status"] = "failed"; report["code"] = "operator_internal_error"
    finally:
        report["finishedAt"] = now().isoformat()
        print(json.dumps({"status": report["status"], "dispatchAttempted": report["dispatch"]["attempted"],
                          "accepted": report["dispatch"].get("accepted"), "runId": report["dispatch"].get("runId")}))
        try:
            save(output, report)
        except Exception:
            passed = False
            print(json.dumps({"status": "failed", "code": "checkpoint_save_failed", "automaticRetryAllowed": False}))
    return 0 if passed else 1
if __name__ == "__main__":
    sys.exit(main())
