#!/usr/bin/env python3
"""Offline-only #1505 workflow renderer. No network, credentials, dispatch, or Git writes."""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
BASE_SHA256 = "2fc8d8a480a35f0f97011dc4149d3e368bcb45901e604aeb354a1d5d9e2e1d89"
RAW_SHA256 = "bdb9b660d2e272794110c5a95d28f0e44d4634cdc3289b1f71806040053b9fe2"
BOT_ID = "fdeea45f-8cb2-450a-96a4-d9a682f71482"
RESOLVE_ONCE = "RESOLVE_ONCE_FROM_PRODUCTION_ALIAS"
ORIGINAL_IF = "    if: github.repository == 'alexj11324/Mikka'"
DISABLED_IF = "    if: false # OFFLINE_UNFILLED_DRAFT_DO_NOT_PUBLISH"
DRAFT_PREFIX = "# OFFLINE UNFILLED TEMPLATE: disabled job; not a runnable GitHub workflow.\n"
REVIEW_PREFIX = "# OFFLINE RENDERED REVIEW ONLY: root must verify actual evidence before publication.\n"
PINS = (
    "ACCEPTANCE_SOURCE_COMMIT", "ACCEPTANCE_SOURCE_TREE", "EXPECTED_APP_COMMIT",
    "EXPECTED_DEPLOYMENT_ID", "EXPECTED_WORKER_SHA", "EXPECTED_WORKER_SOURCE",
    "EXPECTED_TEMPLATE_DESKTOP", "EXPECTED_TEMPLATE_CLAUDE", "EXPECTED_TEMPLATE_CODEX",
    "EXPECTED_DIAGNOSTIC_BOT_ID", "EXPECTED_DIAGNOSTIC_ENV_ID",
    "EXPECTED_DIAGNOSTIC_VALUE_SHA256", "EXPECTED_DIAGNOSTIC_EXPIRES_AT",
    "DIAGNOSTIC_HELPER_COMMIT", "DIAGNOSTIC_HELPER_SHA256",
)
FIXED = {"EXPECTED_DEPLOYMENT_ID": RESOLVE_ONCE, "EXPECTED_DIAGNOSTIC_BOT_ID": BOT_ID}
DYNAMIC = tuple(key for key in PINS if key not in FIXED)
HEX40 = {"ACCEPTANCE_SOURCE_COMMIT", "ACCEPTANCE_SOURCE_TREE", "EXPECTED_APP_COMMIT",
         "EXPECTED_WORKER_SHA", "EXPECTED_WORKER_SOURCE", "DIAGNOSTIC_HELPER_COMMIT"}
HEX64 = {"EXPECTED_DIAGNOSTIC_VALUE_SHA256", "DIAGNOSTIC_HELPER_SHA256"}
DRIVER_FILES = (
    "scripts/acceptance/cloud-startup.mjs",
    "scripts/acceptance/cloud-startup-report.mjs",
    "scripts/acceptance/cloud-startup-evidence.mjs",
    "scripts/ops/deployment-regression.mjs",
)
HELPER_PATH = "scripts/ops/issue1505-diagnostic-window.mjs"
UPSTREAM_JOBS = ("test", "check", "validate / build", "await-web",
                 "subscriptions", "publish / deploy", "cleanup")

def require(condition: bool, code: str) -> None:
    if not condition:
        raise ValueError(code)

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def load_base() -> str:
    raw = (HERE / "base.yml.snapshot").read_bytes()
    require(sha(raw) == BASE_SHA256, "reviewed_base_digest_mismatch")
    return raw.decode("utf-8")

def original_pins(base: str) -> dict[str, str]:
    values = {}
    for key in PINS:
        matches = re.findall(r"^      " + re.escape(key) + r": ([^\n]+)$", base, re.M)
        require(len(matches) == 1, "base_pin_shape_changed:" + key)
        values[key] = matches[0]
    return values

def once(text: str, old: str, new: str, label: str) -> str:
    require(text.count(old) == 1, "replacement_not_unique:" + label)
    return text.replace(old, new, 1)

def marker(key: str) -> str:
    return "__REQUIRED_" + key + "__"

def template_from_base(base: str) -> str:
    values = original_pins(base)
    text = base
    for key in DYNAMIC:
        text = once(text, "      " + key + ": " + values[key] + "\n",
                    "      " + key + ": " + marker(key) + "\n", key)
    text = once(text, "    branches: [ops/1505-preflight]",
                "    branches: [" + marker("EXECUTION_BRANCH") + "]", "branch")
    text = once(text, "repository: 'alexj11324/Mikka', runId: 42423534091, runAttempt: 1,",
                "repository: 'alexj11324/Mikka', runId: " + marker("UPSTREAM_RUN_ID")
                + ", runAttempt: " + marker("UPSTREAM_RUN_ATTEMPT") + ",", "upstream_run")
    text = once(text, "sourceCommit: '" + values["EXPECTED_WORKER_SOURCE"] + "',",
                "sourceCommit: '" + marker("EXPECTED_WORKER_SOURCE") + "',", "upstream_source")
    text = once(text, ORIGINAL_IF, DISABLED_IF, "disabled_job")
    return DRAFT_PREFIX + text

def validate_config(config: object) -> dict:
    require(type(config) is dict and set(config) == {"schemaVersion", "executionBranch", "pins", "upstreamRelease"},
            "config_shape_invalid")
    require(type(config["schemaVersion"]) is int and config["schemaVersion"] == 1, "config_version_invalid")
    branch = config["executionBranch"]
    require(type(branch) is str and re.fullmatch(r"ops/1505-[a-z0-9][a-z0-9._/-]{0,150}", branch) is not None
            and ".." not in branch and "@{" not in branch and "//" not in branch
            and not branch.endswith(("/", ".", ".lock"))
            and all(part and not part.startswith(".") for part in branch.split("/")), "execution_branch_unfilled_or_invalid")
    pins = config["pins"]
    require(type(pins) is dict and set(pins) == set(PINS), "pins_shape_invalid")
    for key in PINS:
        value = pins[key]
        require(type(value) is str and value and not value.startswith(("READY_", "__REQUIRED_")),
                "pin_unfilled:" + key)
        if key in FIXED:
            require(value == FIXED[key], "fixed_contract_changed:" + key)
        elif key in HEX40:
            require(re.fullmatch(r"[a-f0-9]{40}", value) is not None, "pin_sha40_invalid:" + key)
        elif key in HEX64:
            require(re.fullmatch(r"[a-f0-9]{64}", value) is not None, "pin_sha256_invalid:" + key)
        elif key.startswith("EXPECTED_TEMPLATE_"):
            require(re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value) is not None
                    and value not in {"desktop", "claude", "codex"}, "derived_template_invalid:" + key)
        elif key == "EXPECTED_DIAGNOSTIC_ENV_ID":
            require(re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value) is not None, "scope_id_invalid")
        elif key == "EXPECTED_DIAGNOSTIC_EXPIRES_AT":
            require(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value) is not None,
                    "scope_expiry_invalid")
            dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    upstream = config["upstreamRelease"]
    require(type(upstream) is dict and set(upstream) == {"runId", "runAttempt"}, "upstream_shape_invalid")
    for key in ("runId", "runAttempt"):
        require(type(upstream[key]) is int and 0 < upstream[key] <= 9_007_199_254_740_991,
                "upstream_unfilled_or_invalid:" + key)
    return config

def filled_base(base: str, config: dict) -> str:
    old = original_pins(base)
    text = base
    for key in DYNAMIC:
        text = once(text, "      " + key + ": " + old[key] + "\n",
                    "      " + key + ": " + config["pins"][key] + "\n", key)
    text = once(text, "    branches: [ops/1505-preflight]",
                "    branches: [" + config["executionBranch"] + "]", "branch")
    text = once(text, "repository: 'alexj11324/Mikka', runId: 42423534091, runAttempt: 1,",
                "repository: 'alexj11324/Mikka', runId: " + str(config["upstreamRelease"]["runId"])
                + ", runAttempt: " + str(config["upstreamRelease"]["runAttempt"]) + ",", "upstream_run")
    text = once(text, "sourceCommit: '" + old["EXPECTED_WORKER_SOURCE"] + "',",
                "sourceCommit: '" + config["pins"]["EXPECTED_WORKER_SOURCE"] + "',", "upstream_source")
    return text

def render_text(base: str, template: str, config: object) -> str:
    config = validate_config(config)
    require(template == template_from_base(base), "template_business_logic_changed")
    text = template
    values = {**{key: config["pins"][key] for key in DYNAMIC},
              "EXECUTION_BRANCH": config["executionBranch"],
              "UPSTREAM_RUN_ID": str(config["upstreamRelease"]["runId"]),
              "UPSTREAM_RUN_ATTEMPT": str(config["upstreamRelease"]["runAttempt"])}
    for key, value in values.items():
        count = 2 if key == "EXPECTED_WORKER_SOURCE" else 1
        require(text.count(marker(key)) == count, "marker_count_invalid:" + key)
        text = text.replace(marker(key), value)
    text = once(text, DISABLED_IF, ORIGINAL_IF, "review_job_guard")
    text = once(text, DRAFT_PREFIX, REVIEW_PREFIX, "review_header")
    require("__REQUIRED_" not in text, "unfilled_template_marker")
    require(text == REVIEW_PREFIX + filled_base(base, config), "non_parameter_diff_rejected")
    return text

def git_bytes(repo: pathlib.Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)

def source_inventory(repo: pathlib.Path, config: dict) -> dict:
    pins = config["pins"]
    driver = pins["ACCEPTANCE_SOURCE_COMMIT"]
    tree = git_bytes(repo, "rev-parse", driver + "^{tree}").decode().strip()
    require(tree == pins["ACCEPTANCE_SOURCE_TREE"], "acceptance_source_tree_mismatch")
    result = {"driverCommit": driver, "driverTree": tree, "files": []}
    def file(commit: str, path: str) -> bytes:
        data = git_bytes(repo, "show", commit + ":" + path)
        result["files"].append({"commit": commit, "path": path,
                               "blob": git_bytes(repo, "rev-parse", commit + ":" + path).decode().strip(),
                               "bytes": len(data), "sha256": sha(data)})
        return data
    for path in DRIVER_FILES:
        data = file(driver, path)
        if path == DRIVER_FILES[0]:
            source = data.decode("utf-8")
            require("if (initialPinPassed && !finalPinAttempted)" in source
                    and "record.versionPinFailure" in source, "review_failed_case_closing_pin_source")
    helper = file(pins["DIAGNOSTIC_HELPER_COMMIT"], HELPER_PATH)
    require(sha(helper) == pins["DIAGNOSTIC_HELPER_SHA256"], "diagnostic_helper_hash_mismatch")
    # Inventory only: the root must separately bind this source to immutable release/gate artifacts.
    file(pins["EXPECTED_WORKER_SOURCE"], ".github/workflows/e2b-official-runtime.yml")
    result["productionOrArtifactProofVerified"] = False
    result["note"] = "Local Git provenance only. No fetch, execution, production read, release inference, or publication approval."
    return result

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=pathlib.Path, required=True)
    parser.add_argument("--repo", type=pathlib.Path, required=True, help="existing local Git object store; never fetched")
    parser.add_argument("--out", type=pathlib.Path, default=HERE / "workflow.rendered.yml.review")
    args = parser.parse_args()
    require(args.out.resolve().parent == HERE and args.out.name.endswith(".yml.review"),
            "output_must_remain_local_non_workflow_review_file")
    config = validate_config(json.loads(args.config.read_text()))
    base = load_base()
    result = render_text(base, (HERE / "workflow.template.yml.in").read_text(), config)
    inventory = source_inventory(args.repo, config)
    data = result.encode("utf-8")
    with args.out.open("xb") as target:
        target.write(data)
    record = {"version": 1, "status": "rendered_for_root_review_only", "published": False, "triggered": False,
              "renderedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "baseSha256": BASE_SHA256, "configSha256": sha(args.config.read_bytes()),
              "workflow": {"path": str(args.out), "bytes": len(data), "sha256": sha(data)},
              "sourceInventory": inventory,
              "remainingProofs": ["immutable runtime run/attempt and two real bootstrap-adoption subscription receipts",
                                  "public release artifact and exact three template IDs/worker/source",
                                  "fresh scope creation/readback and same Bot/shared-team identity",
                                  "new scope capture by an eligible READY APP deployment",
                                  "fresh main/private pins, writer/owner queue and root publication decision",
                                  "actual runner entry budget >=45 minutes; job remains40 minutes",
                                  "resolve alias exactly once under Web lock, then reject every drift"]}
    receipt = args.out.with_name(args.out.name + ".json")
    with receipt.open("x") as target:
        json.dump(record, target, indent=2); target.write("\n")
    print(json.dumps({"status": record["status"], "workflow": record["workflow"], "receipt": str(receipt)}))

if __name__ == "__main__":
    main()
