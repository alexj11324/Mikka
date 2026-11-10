#!/usr/bin/env python3
"""One admitted retrieval of two immutable Native artifacts; no product execution."""
import base64
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = "alexj11324/Mikka"
API = "https://api.github.com/repos/" + REPO
CONTROL = Path(".github/ops/issue1512-native-evidence-extract")
MANIFEST_BYTES = (CONTROL / "manifest.json").read_bytes()
MANIFEST = json.loads(MANIFEST_BYTES)
TOKEN = os.environ["GITHUB_TOKEN"]
PHASE = "admission"
RECEIPT = {"schema": "issue1512-native-original-extraction-v1", "status": "started",
           "artifacts": [], "cleanup": {"privateDirectoryRemoved": False},
           "limits": {"artifactDownloadsRetried": False, "productExecuted": False,
                      "dependencyInstalls": 0, "persistentResourcesCreated": 0,
                      "originalJsonParsed": False}}

class GuardFailure(Exception):
    pass

def require(condition, code):
    if not condition:
        raise GuardFailure(code)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None

OPENER = urllib.request.build_opener(NoRedirect)

def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def git_blob_id(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()

def git(*args):
    return subprocess.check_output(["git", *args], text=True, timeout=30).strip()

def api_bytes(path, method="GET", payload=None):
    require(path.startswith("/") and not path.startswith("//"), "API_PATH")
    require(method == "GET" or (method == "POST" and path == "/git/blobs"), "API_METHOD")
    data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(API + path, data=data, method=method, headers={
        "Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Mikka-issue1512-original-evidence",
        "Content-Type": "application/json",
    })
    with OPENER.open(request, timeout=180) as response:
        require(response.status in (200, 201), "API_STATUS")
        return response.read()

def api(path):
    return json.loads(api_bytes(path))

def freeze(data):
    expected = git_blob_id(data)
    value = json.loads(api_bytes("/git/blobs", "POST", {
        "content": base64.b64encode(data).decode("ascii"), "encoding": "base64",
    }))
    require(value.get("sha") == expected, "GIT_BLOB_ID")
    return expected

def emit(kind, value):
    print("ISSUE1512_NATIVE_EXTRACT_" + kind + " " +
          json.dumps(value, separators=(",", ":"), sort_keys=True), flush=True)

def admission():
    require(MANIFEST["enabled"] is True, "ADMISSION_CLOSED")
    require(os.environ.get("GITHUB_REPOSITORY") == REPO, "REPOSITORY")
    require(os.environ.get("GITHUB_EVENT_NAME") == "push", "EVENT")
    require(os.environ.get("GITHUB_REF") == "refs/heads/" + MANIFEST["opsBranch"], "REF")
    require(os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "ATTEMPT")
    require(os.environ.get("GITHUB_ACTIONS") == "true", "ACTIONS")
    require(os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "RUNNER")
    require(platform.system() == "Linux", "PLATFORM")
    require(dt.datetime.now(dt.timezone.utc) <= dt.datetime.fromisoformat(MANIFEST["expiresAt"]), "EXPIRED")
    require(digest(Path(__file__).read_bytes()) == MANIFEST["controllerSha256"], "CONTROLLER")
    for key in MANIFEST["forbiddenCredentials"]:
        require(not os.environ.get(key), "EXTERNAL_CREDENTIAL")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes())
    sha = os.environ["GITHUB_SHA"]
    require(re.fullmatch(r"[0-9a-f]{40}", sha) is not None, "SHA")
    require(event.get("after") == sha and event.get("before") == MANIFEST["previousOps"], "PUSH_TRANSITION")
    require(event.get("head_commit", {}).get("id") == sha, "PUSH_HEAD")
    require(event.get("head_commit", {}).get("message") == MANIFEST["admissionMessage"], "MESSAGE")
    require(event.get("repository", {}).get("id") == MANIFEST["repositoryId"], "REPOSITORY_ID")
    require(git("rev-parse", "HEAD") == sha, "CHECKOUT")
    parents = [line[7:] for line in git("cat-file", "-p", "HEAD").splitlines() if line.startswith("parent ")]
    require(parents == [MANIFEST["previousOps"], MANIFEST["source"]["head"]], "PARENTS")
    require(git("status", "--porcelain", "--untracked-files=no") == "", "TRACKED_SOURCE_DIRTY")
    anchor = api("/git/ref/heads/" + MANIFEST["admissionBranch"])
    require(anchor.get("object", {}).get("sha") == sha, "EXACT_ADMISSION_SHA")
    current = api("/actions/runs/" + os.environ["GITHUB_RUN_ID"])
    require(current.get("head_sha") == sha and current.get("run_attempt") == 1 and current.get("event") == "push", "CURRENT_RUN")
    require(current.get("path") == MANIFEST["workflowPath"], "CURRENT_WORKFLOW")
    for path, blob in MANIFEST["sourceAuditBlobs"].items():
        require(git("rev-parse", "HEAD:" + path) == blob, "AUDIT_SOURCE")
    RECEIPT["binding"] = {
        "repository": REPO, "opsSha": sha, "opsTree": git("rev-parse", "HEAD^{tree}"),
        "opsRun": int(os.environ["GITHUB_RUN_ID"]), "attempt": 1,
        "admissionRef": MANIFEST["admissionBranch"], "admissionSha": anchor["object"]["sha"],
        "manifestBlob": git("rev-parse", "HEAD:" + str(CONTROL / "manifest.json")),
        "controllerBlob": git("rev-parse", "HEAD:" + str(CONTROL / "controller.py")),
        "workflowBlob": git("rev-parse", "HEAD:" + MANIFEST["workflowPath"]),
        "source": MANIFEST["source"], "python": platform.python_version(), "startedAt": utc(),
    }

def source_guard():
    source = MANIFEST["source"]
    original = api_bytes("/actions/jobs/" + str(source["job"]))
    job = json.loads(original)
    require(job.get("id") == source["job"] and job.get("run_id") == source["run"], "SOURCE_JOB")
    require(job.get("head_sha") == source["head"] and job.get("run_attempt") == 1, "SOURCE_JOB_REVISION")
    require(job.get("status") == "completed" and job.get("conclusion") == "success", "SOURCE_JOB_RESULT")
    for name in MANIFEST["requiredSourceSteps"]:
        matches = [step for step in job["steps"] if step["name"] == name]
        require(len(matches) == 1 and matches[0]["conclusion"] == "success", "SOURCE_AUDIT_STEP")
    uploads = [step for step in job["steps"] if step["name"] == MANIFEST["artifactUploadStep"]]
    require(len(uploads) == 2 and all(step["conclusion"] == "success" for step in uploads), "SOURCE_UPLOADS")
    run = api("/actions/runs/" + str(source["run"]))
    require(run.get("head_sha") == source["head"] and run.get("run_attempt") == 1, "SOURCE_RUN")
    require(run.get("repository", {}).get("id") == MANIFEST["repositoryId"], "SOURCE_RUN_REPOSITORY")
    head = api("/git/commits/" + source["head"])
    checkout = api("/git/commits/" + source["checkout"])
    require(head["tree"]["sha"] == source["tree"] == checkout["tree"]["sha"], "SOURCE_TREES")
    require([p["sha"] for p in checkout["parents"]] == [source["base"], source["head"]], "SOURCE_CHECKOUT_PARENTS")
    RECEIPT["sourceJobMetadataBlob"] = freeze(original)
    RECEIPT["sourcePrivacy"] = {
        "nativeAudit": "passed: known credentials/cookies scanned; traces and recordings forbidden",
        "packageAudit": "passed: closed credential-free canonical reports",
        "fixture": "MIKKA_LOCAL_TEST_ACCOUNTS=1; localhost disposable PostgreSQL and API",
        "frozenOriginalNativeLog": MANIFEST["source"]["originalJobLogBlob"],
        "productionAccess": False,
    }

def capture(spec, directory):
    global PHASE
    PHASE = "artifact_metadata_" + str(spec["id"])
    metadata_bytes = api_bytes("/actions/artifacts/" + str(spec["id"]))
    metadata = json.loads(metadata_bytes)
    for key in ("id", "name", "size_in_bytes", "digest", "expires_at"):
        require(metadata.get(key) == spec[key], "ARTIFACT_METADATA")
    require(metadata.get("expired") is False, "ARTIFACT_EXPIRED")
    require(metadata.get("workflow_run", {}).get("id") == MANIFEST["source"]["run"], "ARTIFACT_RUN")
    require(metadata.get("workflow_run", {}).get("head_sha") == MANIFEST["source"]["head"], "ARTIFACT_HEAD")
    row = {"id": spec["id"], "name": spec["name"], "metadataBlob": freeze(metadata_bytes),
           "sourceApiGetCount": 0, "deliveryGetCount": 0, "selected": []}
    RECEIPT["artifacts"].append(row)
    PHASE = "download_" + str(spec["id"])
    request = urllib.request.Request(API + "/actions/artifacts/" + str(spec["id"]) + "/zip", headers={
        "Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Mikka-issue1512-original-evidence",
    })
    row["sourceApiGetCount"] += 1
    try:
        response = OPENER.open(request, timeout=60)
    except urllib.error.HTTPError as error:
        require(error.code == 302, "ARTIFACT_REDIRECT_STATUS")
        location = error.headers.get("Location", "")
        error.close()
    else:
        response.close()
        raise GuardFailure("ARTIFACT_EXPECTED_REDIRECT")
    target = urllib.parse.urlsplit(location)
    require(target.scheme == "https" and not target.username and not target.password and not target.fragment, "ARTIFACT_DELIVERY_URL")
    require(any(target.hostname and target.hostname.endswith(suffix) for suffix in MANIFEST["deliveryHostSuffixes"]), "ARTIFACT_DELIVERY_HOST")
    # Never forward the repository token to the signed object-storage URL.
    delivery = urllib.request.Request(location, headers={"User-Agent": "Mikka-issue1512-original-evidence"})
    row["deliveryGetCount"] += 1
    path = directory / (str(spec["id"]) + ".zip")
    sha256 = hashlib.sha256()
    length = 0
    with OPENER.open(delivery, timeout=180) as response, path.open("xb") as out:
        require(response.status == 200, "ARTIFACT_DELIVERY_STATUS")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            length += len(chunk)
            require(length <= spec["size_in_bytes"], "ARTIFACT_TOO_LARGE")
            sha256.update(chunk)
            out.write(chunk)
    require(length == spec["size_in_bytes"], "ARTIFACT_LENGTH")
    require("sha256:" + sha256.hexdigest() == spec["digest"], "ARTIFACT_DIGEST")
    original = path.read_bytes()
    row.update({"bytes": length, "sha256": sha256.hexdigest(), "expectedZipBlob": git_blob_id(original)})
    PHASE = "freeze_zip_" + str(spec["id"])
    row["zipBlob"] = freeze(original)
    row["zipFrozenBeforeOpeningArchive"] = True
    emit("ZIP_FROZEN", {"id": row["id"], "blob": row["zipBlob"], "bytes": length, "sha256": row["sha256"]})
    return path, row

def extract(spec, path, row):
    global PHASE
    PHASE = "extract_frozen_" + str(spec["id"])
    # The exact original archive is now an independently addressable Git object.
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        require(len(names) == len(set(names)), "DUPLICATE_MEMBER")
        files = [info for info in infos if not info.is_dir()]
        require(len(files) == spec["fileCount"], "ARCHIVE_FILE_COUNT")
        require(sum(info.file_size for info in infos) <= 128 * 1024 * 1024, "EXPANDED_LIMIT")
        for info in infos:
            name = PurePosixPath(info.filename)
            require(not name.is_absolute() and ".." not in name.parts and "\\" not in info.filename, "MEMBER_PATH")
            require(not (info.flag_bits & 1), "ENCRYPTED_MEMBER")
            mode = stat.S_IFMT(info.external_attr >> 16)
            require(mode in (0, stat.S_IFREG, stat.S_IFDIR), "MEMBER_TYPE")
            if not info.is_dir():
                require(info.filename in spec["jsonMembers"] or
                        (spec["allowPng"] and info.filename.endswith(".png")), "UNEXPECTED_MEMBER")
        require(all(name in names for name in spec["jsonMembers"]), "MISSING_JSON")
        require(archive.testzip() is None, "ARCHIVE_CRC")
        row["allMemberCrcPassed"] = True
        row["members"] = [{"name": info.filename, "bytes": info.file_size,
                           "compressedBytes": info.compress_size, "crc32": format(info.CRC, "08x")}
                          for info in infos]
        for name in spec["jsonMembers"]:
            info = archive.getinfo(name)
            require(0 < info.file_size <= 2 * 1024 * 1024, "JSON_SIZE")
            original = archive.read(info)
            # Preserve the exact member bytes before any JSON decoding or parsing.
            blob = freeze(original)
            selected = {"name": name, "bytes": len(original), "sha256": digest(original),
                        "crc32": format(info.CRC, "08x"), "blob": blob}
            row["selected"].append(selected)
            emit("JSON_FROZEN", {"artifact": row["id"], **selected})

directory = None
exit_code = 0
try:
    admission()
    PHASE = "source_guard"
    source_guard()
    directory = Path(tempfile.mkdtemp(prefix="issue1512-native-originals-", dir=os.environ["RUNNER_TEMP"]))
    os.chmod(directory, 0o700)
    captured = []
    for spec in MANIFEST["artifacts"]:
        path, row = capture(spec, directory)
        captured.append((spec, path, row))
    for spec, path, row in captured:
        extract(spec, path, row)
    require(sum(len(row["selected"]) for row in RECEIPT["artifacts"]) == 5, "EXACT_FIVE_JSON")
    RECEIPT["status"] = "passed"
except BaseException as error:
    exit_code = 1
    RECEIPT["status"] = "failed"
    RECEIPT["failure"] = {"phase": PHASE, "type": type(error).__name__,
                          "code": str(error) if isinstance(error, GuardFailure) else "EXTRACTION_FAILED"}
finally:
    try:
        if directory is not None:
            shutil.rmtree(directory)
        RECEIPT["cleanup"]["privateDirectoryRemoved"] = directory is None or not directory.exists()
    except BaseException:
        exit_code = 1
        RECEIPT["status"] = "failed"
        RECEIPT["cleanup"]["privateDirectoryRemoved"] = False
    RECEIPT["finishedAt"] = utc()
    try:
        receipt_bytes = (json.dumps(RECEIPT, indent=2, sort_keys=True) + "\n").encode("utf-8")
        receipt_blob = freeze(receipt_bytes)
        emit("RESULT", {"status": RECEIPT["status"], "receiptBlob": receipt_blob,
                        "jsonCount": sum(len(row["selected"]) for row in RECEIPT["artifacts"]),
                        "cleanup": RECEIPT["cleanup"], "failure": RECEIPT.get("failure")})
    except BaseException as error:
        exit_code = 1
        emit("RESULT", {"status": "failed", "phase": "freeze_receipt", "type": type(error).__name__,
                        "cleanup": RECEIPT["cleanup"]})
raise SystemExit(exit_code)
