import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "alexj11324/Mikka"
BRANCH = "ops/1505-smoke-github-readonly-20261109"
PARENT = "376298951e4eee5970e2f0d00e21acb3ffba4e18"
FILE = ".github/workflows/issue1505-ci-recovery.yml"
PR_HEAD = "cb2f771eeac0c8793e9f94b485dd87c7d5866b4c"
PR_BRANCH = "root/issue1505-claude-ca-relinks-20261109"
GO = "root-reviewed-1505-ci-recovery-20261109-v1"
TARGETS = [
    (42673937331, 391052823, ".github/workflows/ui-policy.yml"),
    (42673937047, 403212562, ".github/workflows/browser-gate.yml"),
    (42673936949, 405833668, ".github/workflows/e2b-official-runtime.yml"),
    (42673937322, 397567916, ".github/workflows/cloud-computer.yml"),
    (42673936960, 400369360, ".github/workflows/unattended-sandbox.yml"),
]
OUT = Path(os.environ["RUNNER_TEMP"]) / "issue1505-ci-recovery"
OUT.mkdir(parents=True, exist_ok=True)
receipt = {"schema": 1, "repository": REPO, "pr": 1835, "prHead": PR_HEAD,
           "operatorSha": os.environ.get("GITHUB_SHA"), "operatorRun": os.environ.get("GITHUB_RUN_ID"),
           "operatorAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "targets": [], "complete": False}


def now():
    return dt.datetime.now(dt.timezone.utc)


def utc(text):
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


def check(value, message):
    if not value:
        raise RuntimeError(message)


def save():
    receipt["updatedAt"] = now().isoformat()
    temp = OUT / "receipt.tmp"
    with temp.open("w", encoding="utf-8") as f:
        json.dump(receipt, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    temp.replace(OUT / "receipt.json")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(NoRedirect)
deadline = utc(os.environ["RECOVERY_DEADLINE"])


def request(method, path):
    check(path.startswith(f"/repos/{REPO}/") and "?" not in path and "#" not in path, "API path refused")
    if method == "POST":
        check(path in {f"/repos/{REPO}/actions/runs/{t[0]}/rerun" for t in TARGETS}, "POST path refused")
    else:
        check(method == "GET", "HTTP method refused")
    budget = (deadline - now()).total_seconds()
    check(budget > 2, "absolute deadline reached")
    data = b'{"enable_debug_logging":false}' if method == "POST" else None
    req = urllib.request.Request("https://api.github.com" + path, data=data, method=method,
        headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                 "Accept": "application/vnd.github+json", "Content-Type": "application/json",
                 "X-GitHub-Api-Version": "2026-03-10"})
    try:
        with opener.open(req, timeout=min(15, budget - 1)) as response:
            body = response.read(2_000_000)
            return response.status, response.headers.get("X-GitHub-Request-Id"), body
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("X-GitHub-Request-Id"), error.read(20_000)


def get(path):
    status, request_id, body = request("GET", f"/repos/{REPO}/" + path)
    check(status == 200, f"GET {path}: HTTP {status}; request {request_id}")
    return json.loads(body)


def head_guards():
    check(get("git/ref/heads/" + BRANCH)["object"]["sha"] == os.environ["GITHUB_SHA"], "operator head moved")
    pr = get("pulls/1835")
    check(pr["state"] == "open" and pr["head"]["sha"] == PR_HEAD
          and pr["head"]["ref"] == PR_BRANCH and pr["head"]["repo"]["full_name"] == REPO, "PR identity moved")
    check(get("git/ref/heads/" + PR_BRANCH)["object"]["sha"] == PR_HEAD, "PR branch moved")


def target_guard(target):
    run_id, workflow_id, path = target
    run = get(f"actions/runs/{run_id}")
    check(run["id"] == run_id and run["workflow_id"] == workflow_id and run["path"] == path
          and run["head_sha"] == PR_HEAD and run["head_branch"] == PR_BRANCH
          and run["event"] == "pull_request" and run["run_attempt"] == 1
          and run["status"] == "completed" and run["conclusion"] == "failure"
          and run["repository"]["full_name"] == REPO and run["head_repository"]["full_name"] == REPO,
          f"run {run_id} identity/state changed")
    check(any(p["number"] == 1835 and p["head"]["sha"] == PR_HEAD for p in run["pull_requests"]), "run PR mismatch")
    jobs = get(f"actions/runs/{run_id}/attempts/1/jobs")
    check(jobs["total_count"] == 0 and jobs["jobs"] == [], f"run {run_id} is no longer zero-job")
    workflow = get(f"actions/workflows/{workflow_id}")
    check(workflow["id"] == workflow_id and workflow["path"] == path and workflow["state"] == "active", "workflow not active")
    return {"runId": run_id, "workflowId": workflow_id, "path": path, "attempt": 1,
            "headSha": PR_HEAD, "status": "completed", "conclusion": "failure", "jobs": 0}


def main():
    check(os.environ.get("GITHUB_REPOSITORY") == REPO and os.environ.get("GITHUB_REF") == "refs/heads/" + BRANCH
          and os.environ.get("GITHUB_EVENT_NAME") == "push" and os.environ.get("GITHUB_RUN_ATTEMPT") == "1"
          and os.environ.get("RECOVERY_GO") == GO, "operator identity refused")
    start, entry = utc(os.environ["RECOVERY_NOT_BEFORE"]), utc(os.environ["RECOVERY_ENTRY_DEADLINE"])
    check(start <= now() <= entry < deadline and (deadline-start).total_seconds() <= 600, "entry window refused")
    git = lambda *args: subprocess.check_output(["git", *args], text=True).strip()
    check(git("rev-parse", "HEAD") == os.environ["GITHUB_SHA"], "checkout mismatch")
    check(git("show", "-s", "--format=%P", "HEAD") == PARENT, "operator parent mismatch")
    check(git("diff", "--name-status", PARENT, "HEAD") == "A\t" + FILE, "operator diff refused")
    check(git("ls-tree", "HEAD", "--", FILE).startswith("100644 blob "), "operator file mode refused")
    head_guards()
    receipt["preflight"] = [target_guard(t) for t in TARGETS]
    save()
    for target in TARGETS:
        head_guards()
        item = target_guard(target)
        item.update({"intentAt": now().isoformat(), "postAttempts": 1, "outcome": "unknown"})
        receipt["targets"].append(item)
        save()
        try:
            status, request_id, body = request("POST", f"/repos/{REPO}/actions/runs/{target[0]}/rerun")
        except Exception as error:
            item["transportErrorType"] = type(error).__name__
            save()
            raise RuntimeError("POST outcome unknown; no retry") from None
        item.update({"httpStatus": status, "requestId": request_id, "respondedAt": now().isoformat(),
                     "outcome": "accepted" if status == 201 else ("rejected" if 400 <= status < 500 else "unknown")})
        if status != 201:
            try:
                item["apiMessage"] = str(json.loads(body).get("message", ""))[:300]
            except (ValueError, AttributeError):
                item["apiMessage"] = "non-JSON response"
        save()
        check(status == 201, f"POST HTTP {status}; remaining writes stopped; no retry")
    receipt["complete"] = True
    receipt["meaning"] = "API accepted only; actual CI outcome must be independently verified"
    save()


try:
    main()
except Exception as error:
    receipt["errorType"] = type(error).__name__
    receipt["error"] = str(error)[:600]
    save()
    print(json.dumps({"complete": False, "error": receipt["error"], "posted": len(receipt["targets"])}))
    sys.exit(1)
print(json.dumps({"complete": True, "accepted": len(receipt["targets"]), "ciPassClaimed": False}))
