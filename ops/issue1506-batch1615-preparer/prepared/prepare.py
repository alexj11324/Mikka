#!/usr/bin/env python3
"""Offline-only recovery preparer. Reads immutable Git objects; writes no refs/index."""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent
CONTRACT_SHA256 = "b0ffc8c3a4c346e6db04be3625302c8c7b361a09cec02a77035f756c539d84cc"
TEMPLATE_SHA256 = "a3086b32eaefa29742ebc9bb819123ed53e76f0a7dddb1d79ae636df891b4ac4"
SHA40 = re.compile(r"^[0-9a-f]{40}$")
sha256 = lambda value: hashlib.sha256(value).hexdigest()

def require(condition, code):
    if not condition:
        raise ValueError(code)

def contract():
    raw = (ROOT / "contract.json").read_bytes()
    require(sha256(raw) == CONTRACT_SHA256, "contract_digest_mismatch")
    return json.loads(raw)

def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True,
        env={"PATH": os.environ.get("PATH", ""), "LC_ALL": "C", "GIT_OPTIONAL_LOCKS": "0"},
        timeout=15)
    require(result.returncode == 0, "git_object_read_failed")
    return result.stdout

def blob(repo, ref, path):
    return git(repo, "show", ref + ":" + path)

def commit(repo, ref):
    require(bool(SHA40.fullmatch(ref or "")), "commit_sha_required")
    require(git(repo, "cat-file", "-t", ref).strip() == b"commit", "commit_type_invalid")
    header = git(repo, "cat-file", "-p", ref).split(b"\n\n", 1)[0].decode()
    tree = re.findall(r"^tree ([0-9a-f]{40})$", header, re.M)
    parents = re.findall(r"^parent ([0-9a-f]{40})$", header, re.M)
    require(len(tree) == 1, "commit_header_invalid")
    return {"sha": ref, "tree": tree[0], "parents": parents}

def ancestor(repo, parent, child):
    git(repo, "merge-base", "--is-ancestor", parent, child)

def replace_once(value, old, new, code):
    require(value.count(old) == 1, code)
    return value.replace(old, new, 1)

def validate_disabled(control, continuation, presence, mcp, resume):
    require(control.get("enabled") is False and control.get("phase") == "tool" and
        control.get("expectedSha") is None and control.get("cacheTurns") == 3, "control_not_original_disabled")
    require("      MIKKA_STOP_CASE: during_tool\n" in continuation, "stop_case_changed")
    require("if: $" + "{{ false && " in presence and "MIKKA_ACCEPTANCE_SHA: ''" in presence, "presence_not_disabled")
    require("if: $" + "{{ false && " in mcp and "MIKKA_ACCEPTANCE_SHA: ''" in mcp and
        "timeout-minutes: 12" in mcp, "mcp_not_disabled")
    require("enabled" not in resume and resume.get("phase") == "resume-and-1490-baseline", "legacy_resume_changed")

def hash_overlay_tree(repo, base_tree, elements):
    """Compute exact Git tree hashes without writing Git objects or using an index."""
    edits = {}
    for entry in elements:
        cursor = edits
        parts = entry["path"].split("/")
        for part in parts[:-1]:
            cursor = cursor.setdefault(part, {})
        raw = entry["content"].encode("utf-8")
        cursor[parts[-1]] = ("100644", "blob",
            hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest())
    def update(tree, changes):
        entries = {}
        if tree:
            for raw in git(repo, "ls-tree", "-z", tree).split(b"\0"):
                if not raw:
                    continue
                meta, name = raw.split(b"\t", 1)
                mode, kind, oid = meta.decode().split(" ")
                entries[name.decode()] = ("40000" if kind == "tree" else mode, kind, oid)
        for name, change in changes.items():
            if isinstance(change, dict):
                previous = entries.get(name)
                require(previous is None or previous[1] == "tree", "overlay_parent_not_tree")
                entries[name] = ("40000", "tree", update(previous[2] if previous else None, change))
            else:
                require(name not in entries or entries[name][1] == "blob", "overlay_target_not_blob")
                entries[name] = change
        ordered = sorted(entries, key=lambda name: (name + ("/" if entries[name][1] == "tree" else "")).encode())
        raw = b"".join(entries[name][0].encode() + b" " + name.encode() + b"\0" +
            bytes.fromhex(entries[name][2]) for name in ordered)
        return hashlib.sha1(b"tree " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    return update(base_tree, edits)

def render(repo, application_sha, application_tree):
    c = contract()
    app = commit(repo, application_sha)
    require(bool(SHA40.fullmatch(application_tree or "")) and app["tree"] == application_tree, "application_tree_mismatch")
    base, checkpoint = commit(repo, c["base"]), commit(repo, c["checkpoint"])
    require(base["tree"] == c["baseTree"], "base_tree_mismatch")
    require(checkpoint["tree"] == c["checkpointTree"] and checkpoint["parents"] == [c["base"]], "checkpoint_provenance_mismatch")
    ancestor(repo, c["productAncestor"], application_sha)
    ancestor(repo, c["reviewedSourceAncestor"], application_sha)
    changes = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", c["base"], c["checkpoint"]).decode().splitlines()
    require(set(changes) == set(c["checkpointFiles"]) and len(changes) == 4, "checkpoint_scope_mismatch")
    for path, transition in c["transitions"].items():
        require(c["basePins"][path] == transition["old"] and c["expectedPins"][path] == transition["new"], "transition_contract_mismatch")
        ancestor(repo, transition["introducedBy"], application_sha)
        require(sha256(blob(repo, transition["introducedBy"], path)) == transition["new"], "introduced_pin_mismatch")
    for path, addition in c["sourceAdditions"].items():
        require(c["expectedPins"][path] == addition["sha256"], "addition_contract_mismatch")
        ancestor(repo, addition["introducedBy"], application_sha)
        require(sha256(blob(repo, addition["introducedBy"], path)) == addition["sha256"], "introduced_addition_mismatch")
    source_proof = []
    for path, expected in c["expectedPins"].items():
        data = blob(repo, application_sha, path)
        require(sha256(data) == expected, "unreviewed_source_pin:" + path)
        source_proof.append({"path": path, "sha256": expected, "gitBlob": git(repo, "rev-parse", application_sha + ":" + path).decode().strip()})
    for ref in [c["base"], application_sha]:
        require(sha256(blob(repo, ref, c["decoderPath"])) == c["decoderSha256"], "decoder_drift")
    values = {}
    for path, expected in c["checkpointFiles"].items():
        data = blob(repo, c["checkpoint"], path)
        require(sha256(data) == expected, "checkpoint_file_mismatch")
        values[path] = data.decode("utf-8")
    for path, expected in c["baseFiles"].items():
        data = blob(repo, c["base"], path)
        require(sha256(data) == expected, "base_file_mismatch")
        values[path] = data.decode("utf-8")
    for path, entry in c["extraOverlayFiles"].items():
        local = (ROOT / entry["path"]).resolve()
        require(local.is_relative_to(ROOT), "extra_overlay_path_invalid")
        data = local.read_bytes()
        require(sha256(data) == entry["sha256"], "extra_overlay_digest_mismatch")
        values[path] = data.decode("utf-8")
    protected = {}
    for path, expected in c["protected"].items():
        data = blob(repo, c["base"], path)
        require(sha256(data) == expected["sha256"], "protected_file_mismatch")
        protected[path] = {**expected, "unchanged": True}
    live_path, continue_path, docs_path, mcp_path = c["paths"][4:8]
    original_live = values[live_path]
    parsed = dict(re.findall(r"  '([^']+)': '([0-9a-f]{64})',", original_live))
    require(parsed == c["basePins"] and len(parsed) == 10, "source_pin_list_changed")
    template = (ROOT / "live-source.template.mjs").read_bytes()
    require(sha256(template) == c["liveTemplateSha256"], "live_template_digest_mismatch")
    live = template.decode("utf-8")
    parsed = dict(re.findall(r"  '([^']+)': '([0-9a-f]{64})',", live))
    require(parsed == c["expectedPins"] and len(parsed) == 12, "reviewed_pin_list_changed")
    live = replace_once(live, "@APPLICATION_SHA@", application_sha, "live_source_reference_mismatch")
    values[live_path] = live
    continuation = replace_once(values[continue_path], "ref: efb95d951ddbeca1af04bc80d011ccbc2a9f0188",
        "ref: " + application_sha, "continuation_source_reference_mismatch")
    test_path = "scripts/acceptance/issue-1506-alex/stop-completion.test.mjs"
    continuation = replace_once(continuation, test_path + "\n",
        test_path + " scripts/acceptance/issue-1506-alex/tool-stop-no-boundary.test.mjs\n", "offline_test_entry_mismatch")
    values[continue_path] = continuation
    values[mcp_path] = replace_once(values[mcp_path],
        "MIKKA_ACCEPTANCE_SHA: '26ef4de15129e22503e152258ee9cb2e4aeae8bd'",
        "MIKKA_ACCEPTANCE_SHA: ''", "mcp_old_sha_mismatch")
    control_path = "scripts/acceptance/issue-1506-alex/control/continue.json"
    control = json.loads(blob(repo, c["base"], control_path))
    presence = blob(repo, c["base"], ".github/workflows/issue-1212-presence.yml").decode()
    resume = json.loads(blob(repo, c["base"], "scripts/acceptance/issue-1506-alex/control/resume-baseline.json"))
    validate_disabled(control, continuation, presence, values[mcp_path], resume)
    template = (ROOT / "LIVE-ACCEPTANCE.template.md").read_bytes()
    require(sha256(template) == TEMPLATE_SHA256, "template_digest_mismatch")
    values[docs_path] = template.decode().replace("@APPLICATION_SHA@", application_sha).replace("@APPLICATION_TREE@", application_tree)
    require(set(values) == set(c["paths"]) and len(values) == 11 and control_path not in values, "overlay_scope_mismatch")
    elements = [{"path": p, "mode": "100644", "type": "blob", "content": values[p]} for p in c["paths"]]
    expected_tree = hash_overlay_tree(repo, c["baseTree"], elements)
    patch = ""
    for element in elements:
        path, new = element["path"], element["content"]
        old = "" if path.endswith("/tool-stop-no-boundary.test.mjs") else blob(repo, c["base"], path).decode()
        require(old != new, "overlay_entry_unchanged")
        patch += "diff --git a/" + path + " b/" + path + "\n"
        if not old:
            patch += "new file mode 100644\n"
        patch += "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
            fromfile="a/" + path if old else "/dev/null", tofile="b/" + path))
    manifest = {"schemaVersion": 1, "recoveryVersion": "disabled-eleven-path-batch1615-v2",
        "base": base, "checkpoint": checkpoint, "application": app, "expectedTree": expected_tree,
        "productionDeploymentVerified": False, "activationAuthorized": False,
        "controlUnchanged": control, "stopCase": "during_tool", "presenceDisabled": True,
        "mcpDisabled": True, "mcpApplicationSha": "", "mcpTimeoutMinutes": 12,
        "legacyResumeUnchanged": True, "sourcePins": source_proof,
        "decoderSha256": c["decoderSha256"], "approvedTransitions": c["transitions"],
        "reviewedSourceAncestor": c["reviewedSourceAncestor"], "sourceAdditions": c["sourceAdditions"],
        "modelMessagesAddedForLive": 0, "nextPhaseRecommendation": "cache-live",
        "protected": protected, "files": [{"path": p, "bytes": len(values[p].encode()),
            "sha256": sha256(values[p].encode())} for p in c["paths"]]}
    return {"base_tree_sha": c["baseTree"], "tree_elements": elements}, patch, manifest

def write_preparation(repo, application_sha, application_tree, output):
    out = Path(output).resolve()
    require(out.is_relative_to(ROOT) and out != ROOT and not out.exists(), "new_output_directory_required")
    payload, patch, manifest = render(repo, application_sha, application_tree)
    out.mkdir(mode=0o700)
    for element in payload["tree_elements"]:
        path = out / "payload" / element["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(element["content"])
    (out / "tree-overlay.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    (out / "candidate.patch").write_text(patch)
    for path in ["tree-overlay.json", "candidate.patch"]:
        raw = (out / path).read_bytes()
        manifest.setdefault("artifacts", []).append({"path": path, "bytes": len(raw), "sha256": sha256(raw)})
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--application-sha", required=True)
    parser.add_argument("--application-tree", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = write_preparation(args.repo, args.application_sha, args.application_tree, args.output)
    print(json.dumps({"status": "prepared_disabled_only", "files": len(result["files"]),
        "application": result["application"], "expectedTree": result["expectedTree"],
        "productionDeploymentVerified": False, "activationAuthorized": False}))
