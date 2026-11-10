#!/usr/bin/env python3
"""Read six fixed PR #1782 CI artifacts; no product execution or account access."""
import binascii
import hashlib
import io
import json
import math
import os
from pathlib import Path
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
import xml.etree.ElementTree as ET
import zipfile

REPO = "alexj11324/Mikka"
REPO_ID = 1427517699
ACTOR = "alexj11324"
BRANCH = "ops/1782-ui-evidence-reader-20261110"
WORKFLOW = ".github/workflows/issue1782-ci-evidence-reader.yml"
DRIVER = "scripts/ops/ci-evidence-reader-1782.py"
OWN_PATHS = {DRIVER, WORKFLOW}
# Root binds this only after the preceding private reader has an actual commit.
READER_PARENT = "816ff3690a108efaae2c3b47ea24406dd400f46b"
PRODUCT = "ce6ad923bbb449023783052d0848db22e4360f1d"
PRODUCT_TREE = "dffda64a4975b22cfc649908a8c5e19749ea8a96"
PRODUCT_PARENTS = ["e3c0b0e050515986a8e42cc15ce0a3de15b8e88c", "ab2d00a43a79d35380b4d2db9014a3792fea63ca"]
SYNTHETIC = "08aea3e5533412337d531ca0dc1f77fc06565f60"
SYNTHETIC_PARENTS = [PRODUCT_PARENTS[1], PRODUCT]
SOURCE_BRANCH = "batch/2026-11-08-1"
DEADLINE = time.monotonic() + 150
MAX_API = 4 * 1024 * 1024
ACTIVE_KIND = "guard"
REGISTRY = json.loads(r'''[{"kind":"kernel","id":13737543369,"name":"workspace-ingress-kernel-42761565306-1","size":972,"sha256":"e1772d069eb45cb0845479e088c86aff1f3dd1fb2e8caf817120b7bf30e2b4a6","run":42761565306,"job":129648204000},{"kind":"daemon","id":13737374049,"name":"pr13-cli-diagnostics-08aea3e5533412337d531ca0dc1f77fc06565f60","size":72076,"sha256":"ca3da40bcf15e815762ec5a81d48e8857fbb868fe29cb4090dc278dc1822499e","run":42761565545,"job":129648570585},{"kind":"pg","id":13737952989,"name":"pr13-http-cli-approval-08aea3e5533412337d531ca0dc1f77fc06565f60-3","size":2389,"sha256":"f852112401ec7be4bf7cd0f1ed3b9db1d55390edf50b9fd6426cbcef554797af","run":42761565545,"job":129648570641},{"kind":"image","id":13738228717,"name":"self-hosted-services-08aea3e5533412337d531ca0dc1f77fc06565f60","size":71946,"sha256":"c027b0baedab74ecd4d31eddd516f6ffed2b7f52820d1a74ecbb9fae071c189e","run":42761565545,"job":129648930989},{"kind":"native","id":13738976513,"name":"desktop-native-evidence-08aea3e5533412337d531ca0dc1f77fc06565f60","size":15193156,"sha256":"42362910122e8199481f9b75fb39a4d3aea5a72bf2bca8cedb26aaabdf963187","run":42761565545,"job":129650875673},{"kind":"package","id":13738492805,"name":"desktop-package-evidence-08aea3e5533412337d531ca0dc1f77fc06565f60","size":1595,"sha256":"b6666554e5fd21d8bad98586ea3979bb23c9958210c1aa16e6db15cfd5f93f5d","run":42761565545,"job":129650875673}]''')
PARITY_NAMES = json.loads(r'''["all-threads","artifact-html","artifact-library","artifact-markdown","board","bot-computer","bot-details","bot-prs","bot-thread-list","bot-threads","coordinator-computer","coordinator-details","coordinator-prs","coordinator-threads","group","list","new-task","offline","plugins","projects","settings-account","settings-audit","settings-billing","settings-bot-permissions","settings-computers","settings-connections","settings-general","settings-logins","settings-members","settings-memory","settings-models","settings-notifications","settings-permissions","settings-preferences","settings-privacy","settings-secrets","settings-security","settings-teams","settings-usage","shared-html","shared-markdown","shared-missing","sign-in","suggestions","task","task-thread","team-home","team-projects","team-tasks","thread","workspace-link"]''')
NATIVE_CHECKS = json.loads(r'''{"smoke":["packaged local origin and isolated renderer","local document CSP blocks external renderer fetches","server choice: probe states, probed-only selection, the page follows the chosen server and returns","system browser shows the signed-in account, then loopback and single-use PKCE session handoff","opening the app link brings the packaged app to the front","no browser session credential in renderer-accessible state","native badge, payload validation, device and quota bridge","settings deep link and shared devices page","sign-out clears the main-owned session"],"lifecycle":["real sandboxed frame has no IPC/Node or parent access, and its API request never reaches the main bearer transport","one leased account, ordinary native PKCE and hosted cookie profiles select the same real workspace","at least five paired fresh-process launches reach the same usable seeded chat","two leased browser identities remain private in main and the real account/workspace menu switches back to the retained owner","actual main HTTP transport outage preserves the loaded conversation and unsent draft; online notification recovers","native notification click event follows the real preload bridge to the requested task/thread","native dialog result traverses real IPC and main validates the selected Git repository and cancellation","fresh-process offline launch serves installed assets and a meaningful local offline screen, then recovers without a reload"]}''')
PG_TEST_NAMES = json.loads(r'''["real pg connection serializer sends only the 16-byte keyed CancelRequest, no startup/password/SQL","real pg Client.end with an active query only destroys the local stream; it does not emit CancelRequest","TLS reuses the original verified options; cancellation key is not sent before SSL negotiation","SSL failure never falls back to plaintext and unsupported/ambient identities never open a control connection","a blackholed cancel connection has a 1000ms bound, destroys only itself and does not claim backend cancellation","authorization lease callback handoff abort retains WS custody until APP is released, then closes once","authorization lease arriving after aborted APP cleanup is still closed exactly once","APP checkout handoff abort microtask discards acquired reservation without opening WS","workspace checkout handoff abort microtask discards the acquired client exactly once before any query","synchronous workspace checkout rejection removes admission listeners and preserves the cause","admitted workspace query remains owned through cancellation before exactly-once discard","ordinary member UPDATE after prepare waits through app COMMIT; next operation is denied","revocation winning before member lock denies after app preparation with zero effects","cancel or WS connection failure before COMMIT destroys only held clients and commits no effect","actual Next response-close signal reaches request and guarded APP discard before WS release without a server","an aborted APP remains checked out until the keyed cancel control closes, so a late cancel cannot hit a pooled borrower","a COMMIT already sent and never answered is bounded and explicitly unconfirmed, never retried","WS failure racing a COMMIT can leave a durable effect and must remain explicitly unconfirmed","post-acknowledgement lease loss reports known committed state instead of zero writes","deadline ends a never-settling app query without waiting for its socket","aborted pending APP reservation is released if it arrives late, without taking WS","five-connection initialization/head ordering leaves WS capacity for the existing APP-head holder","abort microtask after the final check never dispatches COMMIT and is not mislabeled uncertain","ordinary application SQL failure rolls back before releasing membership and preserves the cause","pending workspace checkout arriving after cancellation is destroyed without SQL or effects","transport preserves known/unknown commit state for explicit stable-key reconciliation","default-off claim, MCP and Coordinator work on the tracked schema with the mailbox flag off","the tracked mailbox schema is present and the flag is off","a current daemon without repository-origin transport cannot claim or receive a run token","a repository-capable legacy CLI without run approval transport cannot claim or receive a run token","actual device-authenticated claim keeps ordinary MCP and omits mailbox capability","actual run-authenticated MCP advertises legacy worker tools without new schema","default-off mailbox endpoint refuses before authentication/store SQL","real Coordinator catalogue and callback do not load mailbox schema when off","actual revoked-run bearer fails authentication without querying new schema","nothing wrote to the mailbox tables while the flag was off"]''')
ENVIRONMENT_SHA256 = "f67185978cc8a0c227ee3397785d191c8ece3c66001d9f2b7e77fdf94acef06c"
HARNESS_SHA256 = "8622733e19908b66bab05c2cce8068628e9f60ca80852bdf8b5af1865f3512cc"
JOB_CONTRACTS = json.loads(r'''{"129648204000":{"run":42761565306,"name":"Real ingress kernel boundaries","steps":["Verify all IPv4 and IPv6 ingress cases on the real kernel","Preserve kernel regression evidence"]},"129648570585":{"run":42761565545,"name":"Daemon checks","steps":["Daemon unit and transport regression tests","Preserve daemon unit evidence"]},"129648570641":{"run":42761565545,"name":"Database checks (4/4)","steps":["Required DB suites (temporary Postgres 17, no skips)","Preserve synthetic CLI approval database evidence"]},"129648930989":{"run":42761565545,"name":"image-checks / image","steps":["Exercise Mailpit, MinIO, two app replicas and 31 synthetic model replies","Exercise the real daemon against the registered community user","Verify packaged desktop email login, chat and built-in live against the actual image","Retain secret-free application acceptance evidence","Upload isolated acceptance receipt","Verify the same persistent installation restarts","Verify the older built-in UI remains opt-in with the same data","Stop disposable services"]},"129650875673":{"run":42761565545,"name":"desktop-checks / Apple Silicon packaged acceptance and ad-hoc Mikka Dev","steps":["Real Keychain encryption across three independent packaged processes","Real packaged Apple Silicon native acceptance","Keep final package integrity evidence","Audit closed package and crypto reports","Audit native evidence"]}}''')
RUN_CONTRACTS = {
    42761565545: (391052823, ".github/workflows/ui-policy.yml"),
    42761565306: (411390806, ".github/workflows/coding-workspace-review.yml"),
}
FIXED_MEMBERS = {
    "kernel": {"workspace-ingress-kernel.json"},
    "daemon": {"pr13-daemon-unit-results.json"},
    "pg": {"home/runner/work/_temp/pr13-personal-mailbox-results.xml"},
    "image": {"evidence.json", "daemon.json", "desktop/report.json", "desktop/self-hosted-chat.png"},
    "package": {"mac-acceptance-package.json", "native-crypto.json"},
    "native": {
        "parity/parity.json", "smoke.json", "lifecycle.json",
        "bundled-sign-in.png", "bundled-sign-in-self-hosted.png", "bundled-devices.png",
        "lifecycle-offline-retained.png", "lifecycle-offline-cold-launch.png",
    } | {
        f"parity/{theme}-{name}-{variant}.png"
        for theme in ("light", "dark") for name in PARITY_NAMES
        for variant in ("hosted", "bundled", "diff")
    },
}
FILE_HASHES = {
    "kernel": {"workspace-ingress-kernel.json": (7379, "6e6fcbb099fda3c574e9b3ba6a667cb624d6c9a545dfbff3a09785a5966e3025")},
    "image": {
        "evidence.json": (1739, "0f0a9eed0faa0a73c274cd859c6381f3b716977e8f8843655e38d03fd975c572"),
        "daemon.json": (824, "de838cbdc0e70fbf7a79eedc97f3878776a08a531b48c08eb5be802b2fe30698"),
    },
    "package": {
        "mac-acceptance-package.json": (957, "cb9eb91d94eccac08cba28663ca67809961ea477c197a3f155ff0d046b681130"),
        "native-crypto.json": (2868, "212d47f84d8fbf6b372ad729d744d390143774bf7796eae40dc740364f5dd296"),
    },
}

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

def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")

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

def count(value):
    return type(value) is int and value >= 0

def finite(value):
    return type(value) in (int, float) and math.isfinite(value)

def no_failure(value, code):
    require(type(value) is dict and not any(key in value for key in (
        "failure", "cleanupError", "cleanupErrors", "cleanupFailures"
    )), code)

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
    def __init__(self, token, control, own_run):
        require(type(token) is str and len(token) >= 16 and "\n" not in token and "\r" not in token, "token_unavailable")
        self.token = token
        self.api = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.download = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.allowed = {
            f"/repos/{REPO}/git/commits/{control}",
            f"/repos/{REPO}/git/commits/{PRODUCT}",
            f"/repos/{REPO}/git/commits/{SYNTHETIC}",
            f"/repos/{REPO}/actions/runs/{own_run}",
        }
        self.allowed.update(f"/repos/{REPO}/actions/runs/{run}" for run in RUN_CONTRACTS)
        self.allowed.update(f"/repos/{REPO}/actions/jobs/{job}" for job in JOB_CONTRACTS)
        for item in REGISTRY:
            self.allowed.add(f"/repos/{REPO}/actions/artifacts/{item['id']}")
            self.allowed.add(f"/repos/{REPO}/actions/artifacts/{item['id']}/zip")

    def request(self, path):
        require(path in self.allowed, "api_path")
        url = f"https://api.github.com{path}"
        parsed_url(url, api=True)
        return urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "Accept-Encoding": "identity",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "mikka-1782-fixed-ci-evidence-reader",
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

    def artifact(self, item):
        require(item in REGISTRY, "artifact_registry")
        # One authenticated archive request, then one unauthenticated byte GET.
        try:
            with self.api.open(self.request(f"/repos/{REPO}/actions/artifacts/{item['id']}/zip"), timeout=remaining()):
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
        request = urllib.request.Request(location, headers={
            "Accept": "application/zip", "Accept-Encoding": "identity",
            "User-Agent": "mikka-1782-fixed-ci-evidence-reader",
        }, method="GET")
        require(not any(key.lower() == "authorization" for key in request.headers), "download_auth")
        try:
            with self.download.open(request, timeout=remaining()) as response:
                require(response.status == 200, "download_status")
                length = response.headers.get("Content-Length")
                if length is not None:
                    require(length.isdecimal() and int(length) == item["size"], "download_length")
                raw = read_bounded(response, item["size"])
        except urllib.error.HTTPError as error:
            error.close()
            raise Refused("download_status") from None
        except urllib.error.URLError:
            raise Refused("download_transport") from None
        require(len(raw) == item["size"] and sha256(raw) == item["sha256"], "archive_digest")
        return raw

def git(*args):
    remaining()
    result = subprocess.run(["git", *args], check=False, capture_output=True, timeout=min(5.0, remaining()))
    require(result.returncode == 0, "checkout_git")
    try:
        return result.stdout.decode("utf-8").strip()
    except UnicodeError:
        raise Refused("checkout_git") from None

def local_guard():
    require(len(sys.argv) == 1, "arguments")
    require(type(READER_PARENT) is str and re.fullmatch(r"[0-9a-f]{40}", READER_PARENT), "reader_unbound")
    require(os.environ.get("GITHUB_REPOSITORY") == REPO
            and os.environ.get("GITHUB_REPOSITORY_ID") == str(REPO_ID)
            and os.environ.get("GITHUB_ACTOR") == ACTOR
            and os.environ.get("GITHUB_TRIGGERING_ACTOR") == ACTOR
            and os.environ.get("GITHUB_EVENT_NAME") == "push"
            and os.environ.get("GITHUB_REF") == f"refs/heads/{BRANCH}"
            and os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "execution_identity")
    control = os.environ.get("GITHUB_SHA", "")
    run_text = os.environ.get("GITHUB_RUN_ID", "")
    require(re.fullmatch(r"[0-9a-f]{40}", control) and re.fullmatch(r"[1-9][0-9]{0,14}", run_text), "execution_identity")
    require(os.environ.get("GITHUB_WORKFLOW_REF") == f"{REPO}/{WORKFLOW}@refs/heads/{BRANCH}", "workflow_identity")
    event_file = Path(os.environ.get("GITHUB_EVENT_PATH", ""))
    require(event_file.is_file() and not event_file.is_symlink() and event_file.stat().st_size <= MAX_API, "event_file")
    event = parse_json(event_file.read_bytes())
    require(event.get("before") == READER_PARENT and event.get("after") == control
            and event.get("ref") == f"refs/heads/{BRANCH}"
            and event.get("created") is False and event.get("deleted") is False
            and event.get("forced") is False
            and event.get("repository", {}).get("id") == REPO_ID
            and event.get("repository", {}).get("full_name") == REPO
            and event.get("sender", {}).get("login") == ACTOR, "push_identity")
    require(len(event.get("commits", [])) == 1 and event["commits"][0].get("id") == control
            and event.get("head_commit", {}).get("id") == control, "push_commit")
    require(git("rev-parse", "HEAD") == control and git("status", "--porcelain", "--untracked-files=all") == "", "checkout_identity")
    require(git("rev-list", "--parents", "-n", "1", "HEAD").split() == [control, READER_PARENT], "checkout_parent")
    lines = git("diff", "--name-status", READER_PARENT, control, "--").splitlines()
    require(sorted(lines) == sorted("M\t" + path for path in OWN_PATHS), "whole_commit_paths")
    source = []
    for path in sorted(OWN_PATHS):
        file = Path(path)
        require(file.is_file() and not file.is_symlink() and 0 < file.stat().st_size <= 256 * 1024, "source_file")
        raw = file.read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()
        entry = git("ls-tree", control, "--", path)
        require(entry == f"100644 blob {blob}\t{path}", "source_blob")
        source.append({"path": path, "bytes": len(raw), "sha256": sha256(raw), "blob": blob})
    return control, int(run_text), source

def verify_metadata(api, control, own_run):
    own = api.json(f"/repos/{REPO}/actions/runs/{own_run}")
    require(own.get("id") == own_run and own.get("head_sha") == control
            and own.get("head_branch") == BRANCH and own.get("event") == "push"
            and own.get("run_attempt") == 1 and own.get("path") == WORKFLOW
            and own.get("actor", {}).get("login") == ACTOR
            and own.get("triggering_actor", {}).get("login") == ACTOR
            and own.get("repository", {}).get("id") == REPO_ID, "own_run")
    commit = api.json(f"/repos/{REPO}/git/commits/{control}")
    require(commit.get("sha") == control
            and [row.get("sha") for row in commit.get("parents", [])] == [READER_PARENT]
            and commit.get("tree", {}).get("sha") == git("rev-parse", "HEAD^{tree}"), "control_commit")
    for commit_sha, parents in ((PRODUCT, PRODUCT_PARENTS), (SYNTHETIC, SYNTHETIC_PARENTS)):
        value = api.json(f"/repos/{REPO}/git/commits/{commit_sha}")
        require(value.get("sha") == commit_sha and value.get("tree", {}).get("sha") == PRODUCT_TREE
                and [row.get("sha") for row in value.get("parents", [])] == parents, "source_commit")
    for run_id, (workflow_id, path) in RUN_CONTRACTS.items():
        run = api.json(f"/repos/{REPO}/actions/runs/{run_id}")
        require(run.get("id") == run_id and run.get("workflow_id") == workflow_id
                and run.get("path") == path and run.get("event") == "pull_request"
                and run.get("head_sha") == PRODUCT and run.get("head_branch") == SOURCE_BRANCH
                and run.get("run_attempt") == 1 and run.get("status") == "completed"
                and run.get("conclusion") == "success"
                and run.get("repository", {}).get("id") == REPO_ID
                and run.get("head_repository", {}).get("id") == REPO_ID, "producer_run")
    for job_text, contract in JOB_CONTRACTS.items():
        job_id = int(job_text)
        job = api.json(f"/repos/{REPO}/actions/jobs/{job_id}")
        require(job.get("id") == job_id and job.get("run_id") == contract["run"]
                and job.get("run_attempt") == 1 and job.get("head_sha") == PRODUCT
                and job.get("name") == contract["name"]
                and job.get("status") == "completed" and job.get("conclusion") == "success", "producer_job")
        for name in contract["steps"]:
            found = [step for step in job.get("steps", []) if step.get("name") == name]
            require(len(found) == 1 and found[0].get("status") == "completed"
                    and found[0].get("conclusion") == "success", "producer_step")
    for item in REGISTRY:
        value = api.json(f"/repos/{REPO}/actions/artifacts/{item['id']}")
        binding = value.get("workflow_run", {})
        require(value.get("id") == item["id"] and value.get("name") == item["name"]
                and value.get("size_in_bytes") == item["size"]
                and value.get("digest") == "sha256:" + item["sha256"]
                and value.get("expired") is False
                and binding.get("id") == item["run"] and binding.get("repository_id") == REPO_ID
                and binding.get("head_repository_id") == REPO_ID
                and binding.get("head_sha") == PRODUCT and binding.get("head_branch") == SOURCE_BRANCH, "artifact_metadata")

def zip_members(raw, item):
    expected = FIXED_MEMBERS[item["kind"]]
    maximum_member = 16 * 1024 * 1024 if item["kind"] == "native" else 4 * 1024 * 1024
    maximum_total = 128 * 1024 * 1024 if item["kind"] == "native" else 16 * 1024 * 1024
    entries, digests = {}, []
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            require(len(infos) == len(expected) and {row.filename for row in infos} == expected, "zip_members")
            require(len({row.filename for row in infos}) == len(expected), "zip_duplicate")
            require(sum(row.file_size for row in infos) <= maximum_total, "zip_total")
            for info in infos:
                remaining()
                require(info.orig_filename == info.filename and info.filename in expected, "zip_path")
                require(not info.is_dir() and stat.S_IFMT(info.external_attr >> 16) in (0, stat.S_IFREG), "zip_type")
                require(not (info.flag_bits & 1) and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "zip_encoding")
                require(0 < info.file_size <= maximum_member and 0 <= info.compress_size <= item["size"], "zip_size")
                require(0 <= info.header_offset < item["size"], "zip_offset")
                with archive.open(info, "r") as handle:
                    data = handle.read(info.file_size + 1)
                require(len(data) == info.file_size and (binascii.crc32(data) & 0xffffffff) == info.CRC, "zip_crc")
                entries[info.filename] = data
                digest = sha256(data)
                if info.filename in FILE_HASHES.get(item["kind"], {}):
                    require((len(data), digest) == FILE_HASHES[item["kind"]][info.filename], "logged_file_digest")
                digests.append({"name": info.filename, "size": len(data), "sha256": digest, "crc32": f"{info.CRC:08x}"})
    except Refused:
        raise
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, ValueError, OSError):
        raise Refused("zip_invalid") from None
    return entries, sorted(digests, key=lambda row: row["name"])

def png_size(raw):
    require(raw[:8] == b"\x89PNG\r\n\x1a\n", "png_signature")
    pos, dimensions, ended, idat = 8, None, False, False
    while pos < len(raw):
        require(pos + 12 <= len(raw), "png_chunk")
        length = struct.unpack(">I", raw[pos:pos + 4])[0]
        kind = raw[pos + 4:pos + 8]
        end = pos + 12 + length
        require(end <= len(raw), "png_chunk")
        data = raw[pos + 8:pos + 8 + length]
        crc = struct.unpack(">I", raw[pos + 8 + length:end])[0]
        require((binascii.crc32(kind + data) & 0xffffffff) == crc, "png_crc")
        if pos == 8:
            require(kind == b"IHDR" and length == 13, "png_ihdr")
            dimensions = struct.unpack(">II", data[:8])
            require(all(0 < n <= 4096 for n in dimensions), "png_dimensions")
        elif kind == b"IHDR":
            raise Refused("png_ihdr")
        if kind == b"IDAT":
            idat = True
        if kind == b"IEND":
            require(length == 0 and end == len(raw), "png_end")
            ended = True
        pos = end
    require(ended and idat and dimensions is not None, "png_end")
    return dimensions

def verify_kernel(entries):
    value = parse_json(entries["workspace-ingress-kernel.json"])
    require(value.get("ok") is True and value.get("listener_mark_mechanism_control") is False, "kernel_status")
    cases = value.get("cases")
    names = {
        "root_provider_preaccept_ack", "nonroot_rebound_provider_denied",
        "nonroot_dev_listener_denied", "root_dev_listener_denied",
        "established_nonroot_data_denied", "established_nonroot_ACK_payload_denied",
    }
    expected = {(family, name) for family in ("ipv4", "ipv6") for name in names}
    require(type(cases) is list and len(cases) == 12
            and {(row.get("family"), row.get("case")) for row in cases} == expected
            and all(row.get("passed") is True for row in cases), "kernel_cases")
    projection = []
    for row in cases:
        name, evidence = row["case"], row["evidence"]
        if name == "root_provider_preaccept_ack":
            tcp, counters = evidence["client_tcp_info"], evidence["observed"]
            require(evidence.get("accept_called_before_ack") is False
                    and evidence.get("application_roundtrip") is True
                    and evidence.get("syn_ack_received") is True
                    and tcp.get("ok") is True and tcp.get("bytes_acked") == 8193
                    and tcp.get("state") == 1 and tcp.get("unacked") == 0
                    and counters.get("before_without_uid") == 2
                    and counters.get("after_without_uid") == 2, "kernel_ownerless_ack")
            detail = {"bytesAcked": 8193, "ownerlessBefore": 2, "ownerlessAfter": 2, "preaccept": True}
        elif name.startswith("established_"):
            counters, tracking = evidence["observed"], evidence["tracking_before_policy"]
            require(evidence.get("application_data_denied") is True
                    and evidence.get("pre_policy_application_data_received") is True
                    and evidence.get("receive_result", {}).get("ok") is True
                    and evidence.get("receive_result", {}).get("received") == 0
                    and tracking.get("client_syn_original") == 1
                    and tracking.get("server_synack_reply") == 1
                    and counters.get("before_nonroot_long_original") == 0
                    and count(counters.get("before_nonroot_long_reply"))
                    and counters["before_nonroot_long_reply"] > 0
                    and counters.get("after_all") == 0, "kernel_data_denial")
            if name == "established_nonroot_ACK_payload_denied":
                require(counters.get("before_nonroot_ack_long_original") == 0
                        and counters.get("before_nonroot_ack_long_reply", 0) > 0, "kernel_ack_payload_direction")
            detail = {"dataReplyDirection": True, "afterPackets": 0, "receivedBytes": 0}
        else:
            require(evidence.get("application_connection_denied") is True
                    and evidence.get("connect_result", {}).get("ok") is False, "kernel_connection_denial")
            detail = {"connectionDenied": True}
        projection.append({"family": row["family"], "case": name, "passed": True, **detail})
    return {"passed": True, "cases": projection, "markedListenerControl": False}

def verify_daemon(entries):
    value = parse_json(entries["pr13-daemon-unit-results.json"])
    require(value.get("success") is True and value.get("numFailedTests") == 0
            and value.get("numFailedTestSuites") == 0
            and value.get("numPassedTests") == 1595 and value.get("numPendingTests") == 5
            and value.get("numTotalTests") == 1600, "daemon_totals")
    results = value.get("testResults")
    require(type(results) is list and len(results) == 143, "daemon_files")
    # Fixed Vitest 5.0.5 maps skip to "skipped"; numPendingTests still counts skips.
    # Source: vitest-dev/vitest v5.0.5 packages/vitest/src/node/reporters/json.ts.
    assertions = []
    for file in results:
        require(type(file.get("name")) is str and type(file.get("assertionResults")) is list, "daemon_shape")
        for result in file["assertionResults"]:
            require(result.get("status") in ("passed", "skipped"), "daemon_assertion")
            assertions.append((file["name"], result))
    require(sum(result["status"] == "passed" for _, result in assertions) == 1595
            and sum(result["status"] == "skipped" for _, result in assertions) == 5, "daemon_assertion_totals")
    pending = [(path, result) for path, result in assertions if result["status"] == "skipped"]
    allowances = {"packages/daemon/test/adapters.test.ts": 2, "packages/daemon/src/runs/workspace-control.test.ts": 3}
    require(all(any(path.endswith("/" + allowed) for allowed in allowances) for path, _ in pending), "daemon_pending_scope")
    for path, number in allowances.items():
        require(sum(name.endswith("/" + path) for name, _ in pending) == number, "daemon_pending_scope")
    critical = {
        "packages/daemon/test/codex-startup-config.test.ts": 28,
        "packages/daemon/test/anonymous-codex-spare.test.ts": 22,
        "packages/daemon/test/anonymous-codex-hosted.test.ts": 10,
    }
    verified = []
    for path, total in critical.items():
        files = [file for file in results if file["name"].endswith("/" + path)]
        require(len(files) == 1 and len(files[0]["assertionResults"]) == total
                and all(row.get("status") == "passed" for row in files[0]["assertionResults"]), "daemon_required60")
        verified.append({"path": path, "passed": total, "skipped": 0})
    return {"passed": 1595, "failed": 0, "originalSkipped": 5, "files": 143,
            "criticalTests": verified, "criticalPassed": 60}

def verify_pg(entries):
    raw = entries["home/runner/work/_temp/pr13-personal-mailbox-results.xml"]
    require(len(raw) <= 1024 * 1024 and b"<!DOCTYPE" not in raw.upper()
            and b"<!ENTITY" not in raw.upper(), "pg_xml_declaration")
    try:
        root = ET.fromstring(raw)
    except (ET.ParseError, ValueError):
        raise Refused("pg_xml") from None
    require(root.tag in ("testsuites", "testsuite"), "pg_xml_root")
    elements = list(root.iter())
    require(len(elements) <= 2048
            and not any(row.tag in ("failure", "error", "skipped") for row in elements), "pg_failure")
    suites = [row for row in elements if row.tag in ("testsuite", "testsuites")]
    cases = [row for row in elements if row.tag == "testcase"]
    require(len(cases) > 0, "pg_empty")
    for suite in suites:
        for key in ("failures", "errors", "skipped"):
            if key in suite.attrib:
                require(re.fullmatch(r"[0-9]+", suite.attrib[key])
                        and int(suite.attrib[key]) == 0, "pg_failure_count")
        if "tests" in suite.attrib:
            require(re.fullmatch(r"[0-9]+", suite.attrib["tests"])
                    and int(suite.attrib["tests"]) > 0, "pg_test_count")
    found = {row.get("name") for row in elements if row.tag in ("testcase", "testsuite")}
    require(set(PG_TEST_NAMES) <= found, "pg_required_cases")
    return {"scope": "selected_personal_mailbox_xml", "producerShard": "4/4",
            "testCases": len(cases), "requiredNamedCases": len(PG_TEST_NAMES),
            "failures": 0, "errors": 0, "skipped": 0}

def true_fields(value, names, code):
    require(type(value) is dict and set(value) == set(names)
            and all(value[name] is True for name in names), code)

def verify_image(entries):
    service = parse_json(entries["evidence.json"])
    daemon = parse_json(entries["daemon.json"])
    desktop = parse_json(entries["desktop/report.json"])
    for value in (service, daemon, desktop):
        no_failure(value, "image_failure")
        require(value.get("revision") == SYNTHETIC and value.get("origin") == "http://localhost:3000"
                and value.get("status") == "passed", "image_source")
    require(service.get("kind") == "isolated-self-hosted-services" and service.get("stage") == "complete"
            and service.get("synthetic") is True and service.get("productionAcceptance") is False
            and service.get("provider") == "synthetic-openai-compatible", "image_service")
    checks = service["checks"]
    true_fields(checks["mailpit"], ("verificationReceived", "passwordResetReceived", "configuredSender", "verifiedSignIn"), "image_mail")
    web = checks["officialWeb"]
    web_flags = (
        "discovery", "corsPreflight", "bearerOnly", "explicitSameOriginReturn", "independentSession",
        "fragmentCodeOnly", "replayRejected", "sessionRpc", "maliciousOriginRejected", "workspaceRead",
        "attachmentUploadAndDownload", "messageSubmitted", "messageReplyRead", "revokeImmediate",
        "sourceCookieSurvives", "bearerBoundLive", "liveClosedOnRevoke",
    )
    require(all(web.get(name) is True for name in web_flags)
            and web.get("transport") == "actual-http" and web.get("protocol") == "v1"
            and web.get("replyProvider") == "synthetic-openai-compatible"
            and web.get("visualAcceptance") is False, "image_web")
    require(checks["live"] == {"applications": 2, "sharedPostgres": True, "cloudflare": False,
                               "businessMutationReceivedAcrossReplicas": True}, "image_live")
    true_fields(checks["minio"], ("applicationUpload", "privateObject", "presignedDownload", "bytesVerified"), "image_objects")
    require(checks["chat"] == {"messages": 31, "replies": 31, "provider": "synthetic-openai-compatible",
                               "synthetic": True, "hostedUsageRows": 0, "subscriptionAcceptance": False}
            and service.get("chatProgress") == {"confirmedReplies": 31}, "image_chat")
    require(daemon.get("kind") == "isolated-source-daemon" and daemon.get("taskCompletion") is False
            and daemon.get("subscriptionAcceptance") is False and daemon.get("modelRequests") is False, "image_daemon_scope")
    true_fields(daemon["checks"], ("target", "enrollment", "realProcess", "heartbeat", "builtinGatewayPong",
                                  "ownerDeviceOnline", "builtinPresenceReady", "builtinPresenceAck"), "image_daemon")
    true_fields(daemon["cleanup"], ("credentialRevoked", "revokedCredentialRefused", "daemonUnregistered",
                                   "revocationCheckedOnNextSync", "deviceRemoved", "sessionClosed", "privateFilesRemoved"), "image_daemon_cleanup")
    expected_desktop = [
        "real_community_discovery_and_explicit_server_selection",
        "normal_email_login_and_authenticated_remote_rpc",
        "actual_builtin_live_ticket_and_socket",
        "real_chat_submission_and_fixture_reply_over_live_invalidations",
        "normal_first_run_dismissed_and_reply_visible",
        "sign_out_and_return_to_bundled_default_server",
    ]
    require(desktop.get("schemaVersion") == 1 and desktop.get("provider") == "synthetic-openai-compatible"
            and desktop.get("realGoogleOAuth") is False and desktop.get("subscriptionAcceptance") is False
            and desktop.get("checks") == expected_desktop, "image_desktop")
    true_fields(desktop["cleanup"], ("session", "electron", "daemon", "privateFile"), "image_desktop_cleanup")
    width, height = png_size(entries["desktop/self-hosted-chat.png"])
    return {"passed": True, "synthetic": True, "productionAcceptance": False,
            "serviceChecks": checks, "daemonChecks": daemon["checks"], "daemonCleanup": daemon["cleanup"],
            "desktopChecks": expected_desktop, "desktopCleanup": desktop["cleanup"],
            "screenshot": {"width": width, "height": height}}

def package_report(value):
    no_failure(value, "package_failure")
    require(value.get("version") == 1 and value.get("variant") == "acceptance"
            and value.get("passed") is True and value.get("signatureVerifiedStrictDeep") is True
            and value.get("bundleIdentifier") == "com.aspectlylabs.mikka.dev"
            and value.get("urlScheme") == "mikka-dev-auth" and value.get("architecture") == "arm64", "package_identity")
    identity, entitlements, fuses = value["identity"], value["entitlements"], value["fuses"]
    require(identity.get("adHoc") is True and identity.get("teamIdentifier") == "none"
            and identity.get("hardenedRuntime") is True
            and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", identity.get("cdHash", "")), "package_signature")
    require(entitlements.get("hardenedRuntime") is True
            and entitlements.get("devOnlyLibraryValidationException") is True
            and entitlements.get("unexpected") is False
            and count(entitlements.get("executables")) and entitlements["executables"] >= 1
            and count(entitlements.get("libraries")) and entitlements["libraries"] >= 1
            and count(entitlements.get("librariesWithoutEntitlements"))
            and entitlements["librariesWithoutEntitlements"] <= entitlements["libraries"]
            and value.get("signedBundleCount") == entitlements["executables"] + entitlements["libraries"], "package_entitlements")
    require(fuses.get("RunAsNode") is False and fuses.get("EnableNodeOptionsEnvironmentVariable") is False
            and fuses.get("EnableNodeCliInspectArguments") is True
            and fuses.get("OnlyLoadAppFromAsar") is True, "package_fuses")

def verify_package(entries):
    package = parse_json(entries["mac-acceptance-package.json"])
    crypto = parse_json(entries["native-crypto.json"])
    package_report(package)
    no_failure(crypto, "crypto_failure")
    require(crypto.get("version") == 1 and crypto.get("passed") is True
            and crypto.get("platform") == "darwin" and crypto.get("architecture") == "arm64"
            and crypto.get("revision") == SYNTHETIC and crypto.get("cleanup") == "passed"
            and crypto.get("sameImmutablePackage") is True and crypto.get("distinctProcesses") == 3
            and crypto.get("package") == package, "crypto_identity")
    launches = crypto.get("launches")
    require(type(launches) is list and len(launches) == 3, "crypto_launches")
    for index, item in enumerate(launches):
        no_failure(item, "crypto_launch_failure")
        result = item["crypto"]
        no_failure(result, "crypto_result_failure")
        require(item.get("passed") is True and item.get("processExited") is True
                and item.get("mode") == ("bundled", "hosted", "bundled")[index]
                and item.get("profile") == ("a", "b", "b")[index]
                and item.get("phase") == ("create", "continue", "verify")[index]
                and result.get("phase") == item["phase"] and result.get("verifiedCanaries") == index
                and all(result.get(key) is True for key in ("passed", "available", "encrypted", "decrypted", "identityMatches")), "crypto_launch")
    return {"passed": True, "strictDeepSignature": True, "signedBundleCount": package["signedBundleCount"],
            "fuses": package["fuses"], "cryptoLaunches": 3, "sameImmutablePackage": True,
            "processesExited": True, "cleanup": "passed"}

def native_environment(value, parity=False):
    revision = value.get("appRevision") if parity else value.get("revision")
    binding = {"environmentId": value.get("environmentId"), "origin": value.get("origin"), "revision": revision}
    require(sha256(canonical(binding)) == ENVIRONMENT_SHA256
            and type(value.get("database")) is str and bool(value["database"]), "native_environment")
    return value["database"]

def verify_native_cleanup(value, label):
    no_failure(value, "native_failure")
    require(value.get("result") == "passed" and value.get("nativeCleanup", {}).get("cleaned") is True, "native_cleanup")
    generated = value.get("workspaceNameCleanup", {})
    require(generated.get("captured") is True
            and generated.get("ownerMatchesSealedBaseline") is True
            and generated.get("peerMatchesSealedBaseline") is True
            and generated.get("phase") in ("unchanged", "restored")
            and (generated["phase"] == "unchanged" or generated.get("restored") is True), "native_generated_name")
    if label == "parity":
        require(value.get("cleanup") == "passed" and value.get("pageErrors") == [], "native_parity_cleanup")
    else:
        checks = value.get("checks")
        require(type(checks) is list
                and [row.get("name") for row in checks] == NATIVE_CHECKS[label]
                and all(row.get("result") == "passed" for row in checks), "native_checks")
        stages = value.get("cleanupStages")
        require(type(stages) is list and len(stages) > 0
                and all(row.get("result") == "passed" for row in stages), "native_cleanup_stages")
        required = {"browser-close", "electron-close", "daemon-drain", "native-resources", "workspace-generated-name", "lease-release"}
        if label == "lifecycle":
            required.add("fixtures")
        require(required <= {row.get("stage") for row in stages}, "native_cleanup_stage_set")
        observation = value.get("accountObservation", {})
        require(observation.get("observed") is True and observation.get("state") == "released"
                and observation.get("blockedReason") is None
                and observation.get("owner", {}).get("matchesSealedBaselineAfter") is True
                and observation.get("peer", {}).get("matchesSealedBaselineAfter") is True, "native_account_release")

def verify_native(entries):
    parity = parse_json(entries["parity/parity.json"])
    smoke = parse_json(entries["smoke.json"])
    lifecycle = parse_json(entries["lifecycle.json"])
    database = native_environment(parity, parity=True)
    require(native_environment(smoke) == database and native_environment(lifecycle) == database, "native_same_environment")
    for label, value in (("parity", parity), ("smoke", smoke), ("lifecycle", lifecycle)):
        verify_native_cleanup(value, label)
    require(parity.get("version") == 1 and parity.get("mode") == "desktop"
            and parity.get("appRevision") == SYNTHETIC and parity.get("harnessRevision") == SYNTHETIC
            and parity.get("harnessSha256") == HARNESS_SHA256
            and parity.get("viewport") == {"width": 1440, "height": 900}
            and parity.get("colorThreshold") == 0 and parity.get("maximumChangedRatio") == 0.001
            and parity.get("timeZone") == "UTC" and parity.get("themes") == ["light", "dark"]
            and parity.get("nativeModeOrder") == ["hosted-anonymous", "bundled-anonymous", "bundled-authenticated", "hosted-authenticated"]
            and parity.get("nativeProfiles") == 1
            and sorted(parity.get("requiredScreens", [])) == PARITY_NAMES, "native_parity_source")
    screens = parity.get("screens")
    expected = {(name, theme) for name in PARITY_NAMES for theme in ("light", "dark")}
    require(type(screens) is list and len(screens) == 102
            and {(row.get("name"), row.get("theme")) for row in screens} == expected, "native_screens")
    comparisons = []
    for row in screens:
        require(row.get("width") == 1440 and row.get("height") == 900
                and row.get("totalPixels") == 1296000
                and count(row.get("changedPixels")) and count(row.get("comparedPixels"))
                and count(row.get("excludedIdentityPixels")) and row["comparedPixels"] > 0
                and row["comparedPixels"] + row["excludedIdentityPixels"] == row["totalPixels"]
                and row["changedPixels"] <= row["comparedPixels"]
                and finite(row.get("changedRatio")) and 0 <= row["changedRatio"] <= 0.001
                and abs(row["changedRatio"] - row["changedPixels"] / row["comparedPixels"]) <= 1e-12
                and row.get("maximumRatio") == 0.001 and row.get("maskGeometryMatches") is True
                and row.get("passed") is True, "native_pixel_contract")
        comparisons.append({"name": row["name"], "theme": row["theme"], "changedPixels": row["changedPixels"],
                            "comparedPixels": row["comparedPixels"], "changedRatio": row["changedRatio"], "passed": True})
    pngs = []
    for name, raw in sorted(entries.items()):
        if not name.endswith(".png"):
            continue
        width, height = png_size(raw)
        if name.startswith("parity/") or name.startswith("lifecycle-"):
            require((width, height) == (1440, 900), "native_png_viewport")
        pngs.append({"name": name, "width": width, "height": height})
    require(len(pngs) == 311, "native_png_count")
    require(lifecycle.get("viewport") == {"width": 1440, "height": 900}
            and lifecycle.get("coldStart", {}).get("pairs") == 5, "native_cold_pairs")
    samples = lifecycle.get("samples")
    require(type(samples) is list and len(samples) == 10, "native_cold_samples")
    pairs = {}
    for row in samples:
        require(count(row.get("pair")) and row.get("mode") in ("bundled", "hosted")
                and row.get("order") in (1, 2) and finite(row.get("milliseconds"))
                and row["milliseconds"] > 0, "native_cold_sample")
        pairs.setdefault(row["pair"], []).append(row)
    require(len(pairs) == 5 and all(len(rows) == 2
            and {row["mode"] for row in rows} == {"bundled", "hosted"}
            and {row["order"] for row in rows} == {1, 2} for rows in pairs.values()), "native_cold_pairing")
    # Original source records cold speed; it deliberately has no speed pass gate.
    return {
        "passed": True, "environmentBindingSha256": ENVIRONMENT_SHA256, "harnessSha256": HARNESS_SHA256,
        "comparisons": sorted(comparisons, key=lambda row: (row["theme"], row["name"])),
        "requiredScreens": 51, "themes": 2, "passedComparisons": 102,
        "smokeChecks": [{"name": name, "passed": True} for name in NATIVE_CHECKS["smoke"]],
        "lifecycleChecks": [{"name": name, "passed": True} for name in NATIVE_CHECKS["lifecycle"]],
        "coldPairs": 5, "coldSamples": 10, "coldSpeedIsPassGate": False,
        "pageErrors": 0, "nativeCleanup": True, "leasedAccountsReleased": True,
        "generatedWorkspaceNamesSealed": True, "pngDimensions": pngs,
    }

def self_check():
    # Reader-only negative checks; these do not execute or replace product tests.
    checks = 0
    def refuses(fn):
        nonlocal checks
        try:
            fn()
        except Refused:
            checks += 1
            return
        raise Refused("self_check")
    refuses(lambda: parse_json(b'{"a":1,"a":2}'))
    refuses(lambda: parse_json(b'{"a":NaN}'))
    refuses(lambda: parsed_url("http://api.github.com/repos/a/b", api=True))
    refuses(lambda: parsed_url("https://api.github.com@evil.example/zip?x=y"))
    refuses(lambda: parsed_url("https://evil.example/zip?x=y"))
    refuses(lambda: parsed_url("https://valid.blob.core.windows.net/zip"))
    refuses(lambda: png_size(b"not-a-png"))
    refuses(lambda: verify_pg({"home/runner/work/_temp/pr13-personal-mailbox-results.xml": b'<!DOCTYPE x [<!ENTITY x "x">]><testsuites/>'}))
    require(len(REGISTRY) == 6 and len({item["id"] for item in REGISTRY}) == 6
            and [len(FIXED_MEMBERS[item["kind"]]) for item in REGISTRY] == [1, 1, 1, 4, 314, 2]
            and len(PARITY_NAMES) == len(set(PARITY_NAMES)) == 51
            and PARITY_NAMES == sorted(PARITY_NAMES) and len(PG_TEST_NAMES) == 36, "self_check_registry")
    return checks

def main():
    global ACTIVE_KIND
    control, own_run, source = local_guard()
    self_tests = self_check()
    api = GitHub(os.environ.get("GH_TOKEN"), control, own_run)
    verify_metadata(api, control, own_run)
    output = []
    verifiers = {"kernel": verify_kernel, "daemon": verify_daemon, "pg": verify_pg,
                 "image": verify_image, "native": verify_native, "package": verify_package}
    for item in REGISTRY:
        ACTIVE_KIND = item["kind"]
        raw = api.artifact(item)
        entries, digests = zip_members(raw, item)
        result = verifiers[item["kind"]](entries)
        output.append({
            "kind": item["kind"], "artifactId": item["id"], "artifactName": item["name"],
            "runId": item["run"], "runAttempt": 1, "producerJobId": item["job"],
            "archiveBytes": len(raw), "archiveSha256": sha256(raw),
            "crcVerified": True, "exactMembers": True, "members": digests, "result": result,
        })
        del entries, raw
    report = {
        "schema": "mikka-pr1782-fixed-ci-artifacts-v1", "status": "passed",
        "product": PRODUCT, "productTree": PRODUCT_TREE, "synthetic": SYNTHETIC,
        "productParents": PRODUCT_PARENTS, "syntheticParents": SYNTHETIC_PARENTS,
        "reader": {"head": control, "parent": READER_PARENT, "run": own_run, "attempt": 1,
                   "sourceFiles": source, "negativeSelfChecks": self_tests},
        "artifacts": output,
        "scope": "six_existing_ci_artifacts_only_no_product_rerun_or_production_access",
    }
    raw = canonical(report)
    print("CI_EVIDENCE_REPORT " + raw.decode("utf-8"), flush=True)
    print("CI_EVIDENCE_REPORT_SHA256 " + sha256(raw), flush=True)

def on_alarm(_signum, _frame):
    raise Refused("deadline")

if __name__ == "__main__":
    signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, DEADLINE - time.monotonic()))
    try:
        main()
    except Refused as error:
        code = str(error)
        if re.fullmatch(r"[a-z_]{1,64}", code) is None:
            code = "unexpected_error"
        print(json.dumps({"status": "failed", "artifact": ACTIVE_KIND, "code": code}, separators=(",", ":")), flush=True)
        sys.exit(1)
    except Exception:
        print(json.dumps({"status": "failed", "artifact": ACTIVE_KIND, "code": "unexpected_error"}, separators=(",", ":")), flush=True)
        sys.exit(1)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
