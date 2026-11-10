#!/usr/bin/env python3
"""Read one immutable, successful UI artifact. No production or model access."""
import base64
import binascii
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import signal
import stat
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = "alexj11324/Mikka"
REPO_ID = 1427517699
OWNER_ID = 183887963
READER_BRANCH = "ops/1782-ui-evidence-reader-20261110"
READER_BASE = "ce6ad923bbb449023783052d0848db22e4360f1d"
READER_PATHS = (
    ".github/workflows/issue1782-ui-evidence-reader.yml",
    "scripts/ops/ui-evidence-reader-1782.py",
)
UI_RUN = 42762093106
UI_ATTEMPT = 1
UI_JOB = 129649935513
UI_WORKFLOW = 412661690
UI_BRANCH = "ops/1782-official-ui-proof-20261109"
UI_WORKFLOW_PATH = ".github/workflows/issue1782-official-ui-proof.yml"
CONTROL = "5ef8e721a0a2fc5f43ef62b710993a8938cb7be2"
CONTROL_TREE = "35a2a478dcffb1a1f5ece1b5a2c03b18871e0f6a"
CONTROL_PARENT = "05dcab368eb963393189d8edbe94a6da9e4a6a53"
PRODUCT = READER_BASE
PRODUCT_TREE = "dffda64a4975b22cfc649908a8c5e19749ea8a96"
PRODUCT_PARENTS = [
    "e3c0b0e050515986a8e42cc15ce0a3de15b8e88c",
    "ab2d00a43a79d35380b4d2db9014a3792fea63ca",
]
OVERLAY = "fe20f19bcf82e6541430b62c450920ba42c95fb0"
ARTIFACT_ID = 13738795402
ARTIFACT_NAME = "issue1782-official-ui-ce6ad923-fe20f19b"
ZIP_SIZE = 1202395
ZIP_SHA256 = "bb69f6e2a1b71da3363d62e97b1284ec69d3452fbdafb9c9ed6b3c7b5d1824eb"
PUBLIC_SOURCES = {
    "components/nav/all-threads-data.ts": "9be98108a308201d8d761138e420d8a15ba17fc6b8fa857d348ca0b179e80eb3",
    "hooks/use-bot-tasks.ts": "49c0f541d6f668ffa6ea2a9b9b97bf3e3c0be5440ecbf6ba7144f0e44a67fea9",
    "components/workspace/issue-detail-properties.tsx": "df341c8414b0c96dc481ef4355266db564ed012fb2edbceeaa4221fa72d3ec3c",
    "components/workspace/issue-activity-feed.tsx": "19d32df4a4d5fa0f4f8d862d65bc7091176eaeb0870f318e3ba5a54820cf88a0",
    "components/workspace/project-form.tsx": "a3abf3fbd959f8737e26cf6916262bb18015cbbc0daa87a42aff41e5271315f5",
    "components/workspace/issue-workspace.tsx": "68c900d070acb84d4c205efa976e39c254f9abc827f2e565e828306c6037949f",
    "components/nav/context-panel.tsx": "23703b344a6a6f6a397d69eb7fcd552e04c5fe78e9efcd63fe298f945052a939",
    "components/workspace/task-detail.tsx": "e348f11339de941b74f3a573d8075c1d49474230a1974c3c772a770dd57818c6",
    "components/workspace/task-detail-frame.tsx": "14532d01d68308ab41fc1063b68f60147b94ff5ec02da3e0ef1f880d387c4b2e"
}
SLOTS = ["all-threads", "bot-tasks", "task-column", "task-conversation", "app-frame", "thread", "task-detail"]
TITLES = {
    "task-groups-expanded": "Dispatcher Overview: waiting, blocked, failed, still-open and completed tasks",
    "empty-dispatcher": "Coordinator Overview has no tasks; the global Inbox still counts one",
    "human-and-delegate": "Human assignee and separate Agent Delegate",
    "delegation-and-history": "Delegation event and successful historical attempt; task remains open",
    "project-error-editable": "Real stale-revision error; unsaved draft remains editable",
}
EXPECTED_SCREENS = [
    (f"{size}-{theme}-{name}.png", name, theme, width, height)
    for size, width, height in [("wide", 1440, 900), ("narrow", 390, 844)]
    for theme in ["light", "dark"] for name in TITLES
]
EXPECTED_MEMBERS = {"index.html", "manifest.json", "source-pair.json"} | {row[0] for row in EXPECTED_SCREENS}
DEADLINE = time.monotonic() + 150
MAX_API = 4 * 1024 * 1024
MAX_MEMBER = 10 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
CHUNK_SIZE = 4096

class Refused(Exception):
    pass

def require(value, code):
    if not value:
        raise Refused(code)

def remaining():
    value = DEADLINE - time.monotonic()
    require(value > 0, "deadline")
    return min(15.0, value)

def sha256(value):
    return hashlib.sha256(value).hexdigest()

def exact_keys(value, required, optional=()):
    require(type(value) is dict, "json_shape")
    require(set(required) <= value.keys() <= set(required) | set(optional), "json_keys")

def text_value(value, maximum=200):
    require(type(value) is str and 0 < len(value) <= maximum, "text_shape")
    require(all(32 <= ord(char) <= 126 for char in value), "text_shape")
    return value

def hash_value(value):
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value), "digest_shape")

def number(value):
    require(type(value) in (int, float) and math.isfinite(value), "number_shape")

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "json_duplicate_key")
        result[key] = value
    return result

def invalid_constant(_):
    raise Refused("json_constant")

def parse_json(raw, limit=MAX_API):
    require(type(raw) is bytes and len(raw) <= limit, "json_size")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=invalid_constant)
    except Refused:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise Refused("json_invalid") from None

def git(*args):
    remaining()
    result = subprocess.run(["git", *args], check=False, capture_output=True, timeout=min(5, remaining()))
    require(result.returncode == 0 and len(result.stdout) <= 65536, "checkout")
    return result.stdout.decode("utf-8").strip()

def local_context():
    env = os.environ
    require(env.get("GITHUB_REPOSITORY") == REPO and env.get("GITHUB_REPOSITORY_ID") == str(REPO_ID), "reader_identity")
    require(env.get("GITHUB_REPOSITORY_OWNER_ID") == str(OWNER_ID), "reader_identity")
    require(env.get("GITHUB_ACTOR") == "alexj11324" and env.get("GITHUB_TRIGGERING_ACTOR") == "alexj11324", "reader_actor")
    require(env.get("GITHUB_ACTOR_ID") == str(OWNER_ID), "reader_actor")
    require(env.get("GITHUB_EVENT_NAME") == "push" and env.get("GITHUB_RUN_ATTEMPT") == "1", "reader_event")
    require(env.get("GITHUB_REF") == f"refs/heads/{READER_BRANCH}", "reader_ref")
    head = env.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[0-9a-f]{40}", head), "reader_sha")
    require(env.get("GITHUB_WORKFLOW_SHA") == head, "reader_workflow")
    require(env.get("GITHUB_WORKFLOW_REF") == f"{REPO}/{READER_PATHS[0]}@refs/heads/{READER_BRANCH}", "reader_workflow")
    with open(env["GITHUB_EVENT_PATH"], "rb") as handle:
        event = parse_json(handle.read(262145), 262144)
    require(event.get("after") == head and event.get("ref") == env["GITHUB_REF"], "reader_event")
    require(event.get("deleted") is False and event.get("forced") is False and event.get("created") is False, "reader_event")
    require(event.get("before") == READER_BASE, "reader_parent")
    require(event.get("repository", {}).get("id") == REPO_ID and event.get("repository", {}).get("full_name") == REPO, "reader_event")
    require(event.get("repository", {}).get("owner", {}).get("id") == OWNER_ID, "reader_event")
    require(git("rev-parse", "HEAD") == head, "reader_checkout")
    require(git("show", "-s", "--format=%P", "HEAD").split() == [READER_BASE], "reader_parent")
    require(git("status", "--porcelain", "--untracked-files=no") == "", "reader_dirty")
    require(git("diff", "--name-status", "HEAD^", "HEAD").splitlines()
            == [f"A\t{path}" for path in READER_PATHS], "reader_changed_paths")
    files = {}
    for path in READER_PATHS:
        with open(path, "rb") as handle:
            raw = handle.read(131073)
        require(len(raw) <= 131072, "reader_source_size")
        files[path] = sha256(raw)
    tree = git("rev-parse", "HEAD^{tree}")
    require(re.fullmatch(r"[0-9a-f]{40}", tree), "reader_tree")
    return {"head": head, "tree": tree, "parent": READER_BASE, "files": files}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def parsed_url(value, api=False):
    require(type(value) is str and len(value) <= 16384 and all(ord(c) > 32 for c in value), "url_shape")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError:
        raise Refused("url_shape") from None
    require(parsed.scheme == "https" and parsed.username is None and parsed.password is None
            and port is None and not parsed.fragment, "url_shape")
    if api:
        require(parsed.netloc == "api.github.com" and parsed.hostname == "api.github.com" and not parsed.query, "api_origin")
    else:
        host = parsed.hostname or ""
        require(re.fullmatch(r"[a-z0-9.-]+", host) and parsed.netloc == host, "download_origin")
        require(host.endswith(".blob.core.windows.net") or host.endswith(".actions.githubusercontent.com"), "download_origin")
        require(bool(parsed.query), "download_unsigned")
    return parsed

def read_bounded(response, maximum):
    require(response.headers.get("Content-Encoding", "identity").lower() == "identity", "content_encoding")
    data = bytearray()
    while True:
        remaining()
        chunk = response.read(min(65536, maximum + 1 - len(data)))
        remaining()
        if not chunk:
            return bytes(data)
        data.extend(chunk)
        require(len(data) <= maximum, "body_size")

class GitHub:
    def __init__(self, token):
        require(type(token) is str and len(token) >= 16 and "\n" not in token and "\r" not in token, "token_unavailable")
        self.token = token
        self.api = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        # This separate opener has no auth, cookie jar, proxy or automatic redirect.
        self.download = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.allowed = {
            f"/repos/{REPO}/actions/runs/{UI_RUN}",
            f"/repos/{REPO}/actions/jobs/{UI_JOB}",
            f"/repos/{REPO}/actions/artifacts/{ARTIFACT_ID}",
            f"/repos/{REPO}/actions/artifacts/{ARTIFACT_ID}/zip",
            f"/repos/{REPO}/git/commits/{CONTROL}",
            f"/repos/{REPO}/git/commits/{PRODUCT}",
        }

    def request(self, path):
        require(path in self.allowed, "api_path")
        url = f"https://api.github.com{path}"
        parsed_url(url, api=True)
        return urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "Accept-Encoding": "identity",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "mikka-1782-fixed-ui-evidence-reader",
        }, method="GET")

    def json(self, path):
        try:
            with self.api.open(self.request(path), timeout=remaining()) as response:
                require(response.status == 200, "api_status")
                return parse_json(read_bounded(response, MAX_API))
        except urllib.error.HTTPError as error:
            error.close()
            raise Refused("api_status") from None
        except urllib.error.URLError:
            raise Refused("api_transport") from None

    def artifact(self):
        # Exactly one archive request and one unauthenticated byte download.
        try:
            with self.api.open(self.request(f"/repos/{REPO}/actions/artifacts/{ARTIFACT_ID}/zip"), timeout=remaining()):
                raise Refused("archive_redirect_required")
        except urllib.error.HTTPError as error:
            try:
                require(error.code == 302, "archive_status")
                locations = error.headers.get_all("Location", [])
                require(len(locations) == 1, "archive_location")
                location = locations[0]
                parsed_url(location)
            finally:
                error.close()
        except urllib.error.URLError:
            raise Refused("archive_transport") from None
        # Never reuse the authenticated request, headers or opener for Location.
        request = urllib.request.Request(location, headers={
            "Accept": "application/zip", "Accept-Encoding": "identity",
            "User-Agent": "mikka-1782-fixed-ui-evidence-reader",
        }, method="GET")
        require(not any(key.lower() == "authorization" for key in request.headers), "download_auth")
        try:
            with self.download.open(request, timeout=remaining()) as response:
                require(response.status == 200, "download_status")
                length = response.headers.get("Content-Length")
                if length is not None:
                    require(length.isdecimal() and int(length) == ZIP_SIZE, "download_length")
                raw = read_bounded(response, ZIP_SIZE)
        except urllib.error.HTTPError as error:
            error.close()
            raise Refused("download_status") from None
        except urllib.error.URLError:
            raise Refused("download_transport") from None
        require(len(raw) == ZIP_SIZE and sha256(raw) == ZIP_SHA256, "archive_digest")
        return raw

def validate_run(value):
    require(value.get("id") == UI_RUN and value.get("run_attempt") == UI_ATTEMPT, "run_identity")
    require(value.get("head_sha") == CONTROL and value.get("head_branch") == UI_BRANCH, "run_source")
    require(value.get("event") == "push" and value.get("path") == UI_WORKFLOW_PATH and value.get("workflow_id") == UI_WORKFLOW, "run_workflow")
    require(value.get("status") == "completed" and value.get("conclusion") == "success", "run_outcome")
    require(value.get("repository", {}).get("id") == REPO_ID and value.get("repository", {}).get("full_name") == REPO, "run_repository")
    require(value.get("head_repository", {}).get("id") == REPO_ID, "run_repository")
    require(value.get("actor", {}).get("login") == "alexj11324" and value.get("triggering_actor", {}).get("login") == "alexj11324", "run_actor")

def validate_metadata(client):
    run = client.json(f"/repos/{REPO}/actions/runs/{UI_RUN}")
    validate_run(run)
    job = client.json(f"/repos/{REPO}/actions/jobs/{UI_JOB}")
    require(job.get("id") == UI_JOB and job.get("run_id") == UI_RUN and job.get("head_sha") == CONTROL, "job_identity")
    require(job.get("name") == "proof" and job.get("status") == "completed" and job.get("conclusion") == "success", "job_outcome")
    steps = job.get("steps")
    require(type(steps) is list and 1 <= len(steps) <= 50, "job_steps")
    require(all(row.get("status") == "completed" and row.get("conclusion") == "success" for row in steps), "job_steps")
    for name in [
        "Check fixed source, actor, push and isolated database before credentials",
        "Reproduce the public-menu mismatch and verify the official menu in real Chromium",
        "Build the actual production application with the fixed official UI",
        "Capture real local production UI and close owned runtimes",
        "Audit only the closed gallery and public manifest", "Upload the single audited gallery",
    ]:
        require(sum(row.get("name") == name for row in steps) == 1, "job_step_missing")
    artifact = client.json(f"/repos/{REPO}/actions/artifacts/{ARTIFACT_ID}")
    require(artifact.get("id") == ARTIFACT_ID and artifact.get("name") == ARTIFACT_NAME, "artifact_identity")
    require(artifact.get("size_in_bytes") == ZIP_SIZE and artifact.get("digest") == f"sha256:{ZIP_SHA256}" and artifact.get("expired") is False, "artifact_metadata")
    linked = artifact.get("workflow_run", {})
    require(linked.get("id") == UI_RUN and linked.get("head_sha") == CONTROL and linked.get("head_branch") == UI_BRANCH, "artifact_run")
    require(linked.get("repository_id") == REPO_ID and linked.get("head_repository_id") == REPO_ID, "artifact_repository")
    require(artifact.get("archive_download_url") == f"https://api.github.com/repos/{REPO}/actions/artifacts/{ARTIFACT_ID}/zip", "artifact_url")
    for commit, tree, parents in [(CONTROL, CONTROL_TREE, [CONTROL_PARENT]), (PRODUCT, PRODUCT_TREE, PRODUCT_PARENTS)]:
        value = client.json(f"/repos/{REPO}/git/commits/{commit}")
        require(value.get("sha") == commit and value.get("tree", {}).get("sha") == tree, "commit_identity")
        require([row.get("sha") for row in value.get("parents", [])] == parents, "commit_parents")
    return run

def zip_members(raw):
    entries = {}
    digests = []
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            require(len(infos) == 23 and {row.filename for row in infos} == EXPECTED_MEMBERS, "zip_members")
            require(len({row.filename for row in infos}) == 23, "zip_duplicate")
            require(sum(row.file_size for row in infos) <= MAX_TOTAL, "zip_total")
            for info in infos:
                remaining()
                require(info.orig_filename == info.filename and info.filename in EXPECTED_MEMBERS, "zip_path")
                require(not info.is_dir() and stat.S_IFMT(info.external_attr >> 16) in (0, stat.S_IFREG), "zip_type")
                require(not (info.flag_bits & 1) and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "zip_encoding")
                require(0 < info.file_size <= MAX_MEMBER and 0 <= info.compress_size <= ZIP_SIZE, "zip_size")
                require(0 <= info.header_offset < ZIP_SIZE, "zip_offset")
                with archive.open(info, "r") as handle:
                    data = handle.read(info.file_size + 1)
                require(len(data) == info.file_size and (binascii.crc32(data) & 0xffffffff) == info.CRC, "zip_crc")
                entries[info.filename] = data
                digests.append({"name": info.filename, "size": len(data), "sha256": sha256(data), "crc32": f"{info.CRC:08x}"})
    except Refused:
        raise
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, ValueError, OSError):
        raise Refused("zip_invalid") from None
    return entries, sorted(digests, key=lambda row: row["name"])

def png(data, width, height):
    require(data[:8] == b"\x89PNG\r\n\x1a\n", "png_signature")
    offset = 8
    count = 0
    idats = 0
    ended = False
    while offset < len(data):
        remaining()
        require(offset + 12 <= len(data), "png_chunk")
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        require(length <= MAX_MEMBER and offset + 12 + length <= len(data), "png_chunk")
        payload = data[offset + 8:offset + 8 + length]
        crc = struct.unpack(">I", data[offset + 8 + length:offset + 12 + length])[0]
        require((binascii.crc32(kind + payload) & 0xffffffff) == crc, "png_crc")
        if count == 0:
            require(kind == b"IHDR" and length == 13, "png_ihdr")
            require(struct.unpack(">II", payload[:8]) == (width, height), "png_dimensions")
        else:
            require(kind != b"IHDR", "png_ihdr")
        idats += kind == b"IDAT"
        offset += length + 12
        count += 1
        require(count <= 10000, "png_chunk_count")
        if kind == b"IEND":
            require(length == 0 and offset == len(data) and idats > 0, "png_end")
            ended = True
            break
    require(ended, "png_end")

def validate_checks(rows):
    require(type(rows) is list and len(rows) == 12, "semantic_count")
    expected = [(width, theme, case) for width in [1440, 390] for theme in ["light", "dark"]
                for case in ["task_groups", "human_delegate_history", "project_stale_form"]]
    for row, identity in zip(rows, expected):
        require((row.get("width"), row.get("theme"), row.get("case")) == identity, "semantic_identity")
        if row["case"] == "task_groups":
            exact_keys(row, ["case", "theme", "width", "taskCount", "surface", "pendingIndicator", "globalWaitingCount", "renderedSlots",
                             "groups", "completedInitiallyFolded", "openTaskWithSuccessfulAttempt", "emptyDispatcher", "icons"])
            require(row["surface"] == "dispatcher_overview" and row["pendingIndicator"] == "inbox", "semantic_surface")
            require(type(row["globalWaitingCount"]) is int and row["globalWaitingCount"] == 1, "semantic_count")
            require(type(row["taskCount"]) is int and row["taskCount"] == 5, "semantic_count")
            require(row["renderedSlots"] == ["app-frame", "thread", "bot-tasks"], "semantic_slots")
            require(row["groups"] == {"pending": 3, "running": 0, "todo": 1, "done": 1}
                    and all(type(value) is int for value in row["groups"].values()), "semantic_groups")
            require(row["completedInitiallyFolded"] is True and row["emptyDispatcher"] is True
                    and row["openTaskWithSuccessfulAttempt"] == "todo", "semantic_tasks")
            icons = row["icons"]
            require(type(icons) is list and [item.get("key") for item in icons] == ["waiting", "blocked", "failed", "open", "done"], "semantic_icons")
            for item in icons:
                exact_keys(item, ["key", "shapeSha256", "color"])
                hash_value(item["shapeSha256"])
                text_value(item["color"], 100)
            require(len({item["shapeSha256"] for item in icons[:3]}) == 3
                    and len({item["color"] for item in icons[:3]}) == 3, "semantic_icons")
        elif row["case"] == "human_delegate_history":
            exact_keys(row, ["case", "theme", "width", "humanAssignee", "separateDelegate", "delegationActivity",
                             "surface", "renderedSlots", "historicalAttemptResult", "taskStatus"])
            require(row["surface"] == "hosted_task_detail_frame" and row["renderedSlots"] == ["task-detail"], "semantic_surface")
            require(all(row[key] is True for key in ["humanAssignee", "separateDelegate", "delegationActivity"]), "semantic_people")
            require(row["historicalAttemptResult"] == "done" and row["taskStatus"] == "doing", "semantic_history")
        else:
            flags = ["normalRpcBusinessError", "serverProjectUnchanged", "draftPreserved", "editableAfterError", "saveEnabledAfterError"]
            exact_keys(row, ["case", "theme", "width", *flags])
            require(all(row[key] is True for key in flags), "semantic_draft")

def validate_source(value):
    exact_keys(value, ["version", "product", "productTree", "overlay", "productionEntry", "inventorySemantics", "build", "targets", "slots"])
    require(type(value["version"]) is int and value["version"] == 1, "source_version")
    require((value["product"], value["productTree"], value["overlay"]) == (PRODUCT, PRODUCT_TREE, OVERLAY), "source_identity")
    require(value["productionEntry"] == "apps/frontend/src/index.tsx"
            and value["inventorySemantics"] == "transformed_source_modules_not_render_coverage", "source_inventory")
    build = value["build"]
    exact_keys(build, ["rendererBuild", "transformedModuleCount", "inventorySha256"])
    hash_value(build["rendererBuild"]); hash_value(build["inventorySha256"])
    require(type(build["transformedModuleCount"]) is int and 16 <= build["transformedModuleCount"] <= 10000, "source_inventory")
    require(type(value["targets"]) is list and [row.get("path") for row in value["targets"]] == list(PUBLIC_SOURCES), "source_targets")
    for row in value["targets"]:
        exact_keys(row, ["path", "sha256", "includedInProductionBuild"])
        require(row["sha256"] == PUBLIC_SOURCES[row["path"]] and row["includedInProductionBuild"] is True, "source_target_digest")
    require(type(value["slots"]) is list and [row.get("name") for row in value["slots"]] == SLOTS, "source_slots")
    for row in value["slots"]:
        exact_keys(row, ["name", "privateOverlaySelected", "includedInProductionBuild"])
        require(row["privateOverlaySelected"] is True and row["includedInProductionBuild"] is True, "source_slots")

def validate_manifest(value, source, entries):
    exact_keys(value, ["version", "product", "productTree", "overlay", "scope", "synthetic", "productionAcceptance",
                      "responseMocks", "edition", "externalCloudServiceConfigured", "startedAt", "fixtureCases", "screens",
                      "checks", "cleanup", "result", "compiled", "workspaceNameCleanup", "fixtureIdentity", "pageErrors",
                      "finishedAt", "runtimeShutdown"])
    require(type(value["version"]) is int and value["version"] == 1, "manifest_version")
    require((value["product"], value["productTree"], value["overlay"]) == (PRODUCT, PRODUCT_TREE, OVERLAY), "manifest_identity")
    require(value["scope"] == "official_ui_isolated_production_build" and value["synthetic"] is True
            and value["productionAcceptance"] is False and value["externalCloudServiceConfigured"] is False
            and value["edition"] == "cloud", "manifest_scope")
    require(type(value["responseMocks"]) is int and value["responseMocks"] == 0, "manifest_mocks")
    require(value["result"] == "passed" and value["runtimeShutdown"] == "passed" and value["pageErrors"] == [], "manifest_outcome")
    stamps = []
    for key in ["startedAt", "finishedAt"]:
        require(type(value[key]) is str and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", value[key]), "manifest_time")
        stamps.append(dt.datetime.fromisoformat(value[key].replace("Z", "+00:00")))
    require(stamps[0] <= stamps[1], "manifest_time")
    expected_cases = [
        {"key": key, "taskStatus": task, "runStatus": run, "outcome": outcome, "group": group, "state": state}
        for key, task, run, outcome, group, state in [
            ("waiting", "doing", "succeeded", "needs_input", "pending", "waiting"),
            ("blocked", "doing", "succeeded", "blocked", "pending", "blocked"),
            ("failed", "doing", "failed", "failed", "pending", "failed"),
            ("open", "doing", "succeeded", "done", "todo", "todo"),
            ("done", "done", "succeeded", "done", "done", "done"),
        ]
    ]
    require(value["fixtureCases"] == expected_cases, "manifest_cases")
    exact_keys(value["fixtureIdentity"], ["taskCount", "uniqueOwnerNumbers", "uniqueIssuedIdentifiers", "originalTaskNumberPreserved", "normalRpcConfirmed"])
    require(all(type(value["fixtureIdentity"][key]) is int and value["fixtureIdentity"][key] == 5
                for key in ["taskCount", "uniqueOwnerNumbers", "uniqueIssuedIdentifiers"]), "fixture_identity")
    require(value["fixtureIdentity"]["originalTaskNumberPreserved"] is True
            and value["fixtureIdentity"]["normalRpcConfirmed"] is True, "fixture_identity")
    exact_keys(value["cleanup"], ["browser", "extension", "base", "workspaceName", "lease"])
    require(all(item is True for item in value["cleanup"].values()), "cleanup")
    cleanup = value["workspaceNameCleanup"]
    exact_keys(cleanup, ["captured", "phase", "restored", "initialName", "initialOwnerMatchesSealedBaseline", "beforeName",
                        "peerMatchesSealedBaseline", "afterName", "ownerMatchesSealedBaseline"], ["onlyGeneratedNameDifference"])
    require(cleanup["captured"] is True and cleanup["phase"] in ["unchanged", "restored"], "workspace_cleanup")
    require(cleanup["restored"] is (cleanup["phase"] == "restored")
            and cleanup["peerMatchesSealedBaseline"] is True and cleanup["ownerMatchesSealedBaseline"] is True, "workspace_cleanup")
    require(type(cleanup["initialOwnerMatchesSealedBaseline"]) is bool, "workspace_cleanup")
    for key in ["initialName", "beforeName", "afterName"]:
        exact_keys(cleanup[key], ["en", "zhCN"])
        require(all(type(item) is bool for item in cleanup[key].values()), "workspace_cleanup")
    if cleanup["restored"] or "onlyGeneratedNameDifference" in cleanup:
        require(cleanup.get("onlyGeneratedNameDifference") is True, "workspace_cleanup")
    compiled = value["compiled"]
    exact_keys(compiled, ["revision", "appBuild", "rendererBuild", "lockSha256", "routesSha256", "tracingSha256", "servedBuildMatches", "servedOverlayMatches"])
    require(compiled["revision"] == PRODUCT and compiled["rendererBuild"] == source["build"]["rendererBuild"], "compiled_identity")
    text_value(compiled["appBuild"])
    for key in ["rendererBuild", "lockSha256", "routesSha256", "tracingSha256"]:
        hash_value(compiled[key])
    require(compiled["servedBuildMatches"] is True and compiled["servedOverlayMatches"] is True, "compiled_served")
    validate_checks(value["checks"])
    require(type(value["screens"]) is list and len(value["screens"]) == 20, "screen_count")
    screens = []
    for index, (screen, expected) in enumerate(zip(value["screens"], EXPECTED_SCREENS)):
        exact_keys(screen, ["name", "title", "theme", "viewport", "filename", "sha256", "masks"])
        filename, name, theme, width, height = expected
        require((screen["filename"], screen["name"], screen["theme"], screen["title"]) == (filename, name, theme, TITLES[name]), "screen_identity")
        exact_keys(screen["viewport"], ["width", "height"])
        require(type(screen["viewport"]["width"]) is int and type(screen["viewport"]["height"]) is int
                and screen["viewport"] == {"width": width, "height": height}, "screen_viewport")
        require(screen["sha256"] == sha256(entries[filename]), "screen_digest")
        masks = screen["masks"]
        require(type(masks) is list and len(masks) <= 2000, "mask_count")
        for mask in masks:
            exact_keys(mask, ["kind", "x", "y", "width", "height"])
            require(mask["kind"] in ["avatar", "time", "identity"], "mask_kind")
            for key in ["x", "y", "width", "height"]:
                number(mask[key])
                require(abs(mask[key]) <= 1000000, "mask_bounds")
            require(mask["width"] > 0 and mask["height"] > 0, "mask_bounds")
        png(entries[filename], width, height)
        screens.append({"index": index, "filename": filename, "sha256": screen["sha256"],
                        "size": len(entries[filename]), "width": width, "height": height, "maskCount": len(masks)})
    return screens

def emit(kind, value):
    print(kind + " " + json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True), flush=True)

def main():
    require(len(sys.argv) == 1, "arguments")
    token = os.environ.pop("GITHUB_TOKEN", None)
    reader = local_context()
    client = GitHub(token)
    validate_metadata(client)
    raw = client.artifact()
    entries, member_digests = zip_members(raw)
    manifest = parse_json(entries["manifest.json"], 1048576)
    source = parse_json(entries["source-pair.json"], 1048576)
    validate_source(source)
    screens = validate_manifest(manifest, source, entries)
    # A later attempt cannot silently replace the selected attempt during read.
    validate_run(client.json(f"/repos/{REPO}/actions/runs/{UI_RUN}"))
    client.token = ""
    token = None
    receipt = {
        "version": 1, "status": "verified", "scope": "read_existing_owned_ui_artifact",
        "reader": reader,
        "source": {"repository": REPO, "run": UI_RUN, "attempt": UI_ATTEMPT, "job": UI_JOB, "workflow": UI_WORKFLOW,
                   "control": CONTROL, "controlTree": CONTROL_TREE, "product": PRODUCT, "productTree": PRODUCT_TREE, "overlay": OVERLAY},
        "artifact": {"id": ARTIFACT_ID, "name": ARTIFACT_NAME, "size": len(raw), "sha256": sha256(raw)},
        "zip": {"exactMembers": 23, "crcVerified": True, "members": member_digests},
        "jsonDigests": {name: sha256(entries[name]) for name in ["manifest.json", "source-pair.json"]},
        "proof": {"result": manifest["result"], "screenshots": len(screens), "semanticChecks": len(manifest["checks"]),
                  "fixtureIdentity": manifest["fixtureIdentity"], "cleanup": manifest["cleanup"],
                  "workspaceNameCleanup": manifest["workspaceNameCleanup"], "runtimeShutdown": manifest["runtimeShutdown"],
                  "pageErrors": len(manifest["pageErrors"]), "productionAcceptance": False,
                  "surfaceChecks": [{"case": row["case"], "theme": row["theme"], "width": row["width"]} for row in manifest["checks"]],
                  "compiledRevision": manifest["compiled"]["revision"], "rendererBuild": source["build"]["rendererBuild"],
                  "sourceInventorySha256": source["build"]["inventorySha256"], "humanVisualReviewPerformed": False},
        "screens": screens,
    }
    emit("UI1782_RECEIPT", receipt)
    for name in ["manifest.json", "source-pair.json"]:
        emit("UI1782_JSON", {"name": name, "size": len(entries[name]), "sha256": sha256(entries[name]),
                             "encoding": "base64", "data": base64.b64encode(entries[name]).decode("ascii")})
    for screen in screens:
        remaining()
        encoded = base64.b64encode(entries[screen["filename"]]).decode("ascii")
        chunks = [encoded[offset:offset + CHUNK_SIZE] for offset in range(0, len(encoded), CHUNK_SIZE)]
        emit("UI1782_PNG_BEGIN", {**screen, "chunks": len(chunks), "encoding": "base64"})
        for index, chunk in enumerate(chunks):
            emit("UI1782_PNG_CHUNK", {"index": screen["index"], "chunk": index, "data": chunk})
        emit("UI1782_PNG_END", {"index": screen["index"], "chunks": len(chunks), "sha256": screen["sha256"]})
    emit("UI1782_READER_COMPLETE", {"screenshots": len(screens), "artifactSha256": ZIP_SHA256,
                                  "receiptSha256": sha256(json.dumps(receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8"))})

def on_alarm(_signal, _frame):
    raise Refused("deadline")

if __name__ == "__main__":
    signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, DEADLINE - time.monotonic()))
    try:
        main()
    except Refused as error:
        emit("UI1782_READER_FAILED", {"code": str(error)})
        sys.exit(1)
    except Exception:
        emit("UI1782_READER_FAILED", {"code": "unexpected_error"})
        sys.exit(1)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
