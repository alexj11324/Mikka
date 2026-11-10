#!/usr/bin/env python3
"""Read only the one fixed private artifact; emit no provider identifiers or raw reports."""
import base64
import binascii
import hashlib
import io
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

REPO = "alexj11324/Mikka"
REPO_ID = 1427517699
BRANCH = "ops/1782-ui-evidence-reader-20261110"
WORKFLOW = ".github/workflows/issue1782-private-evidence-reader.yml"
SCRIPT = "scripts/ops/issue1782-private-evidence-reader.py"
READER_PARENT = "787455ed555c7bdf26a38d22a39f63fdc29a610a"
READER_PARENT_TREE = "0198dc9477b6d33b28e0925ba4e32ddef97913ff"
PRODUCT = "ce6ad923bbb449023783052d0848db22e4360f1d"
PRODUCT_TREE = "dffda64a4975b22cfc649908a8c5e19749ea8a96"
PRODUCT_PARENTS = ["e3c0b0e050515986a8e42cc15ce0a3de15b8e88c", "ab2d00a43a79d35380b4d2db9014a3792fea63ca"]
OPS = "7a4ecf17efb555c5bac717c5b1ee2e8d1535bbcd"
OPS_TREE = "517341dab24411bc67e63a3fb45bc1c50bfab4c9"
OPS_PARENT = "4a662439602f4ea311a09cedd5d4d2555b803642"
WORKER = "638876d7e373115b084b8e56fe69cb437f342f47"
RUN = 42761964307
ATTEMPT = 1
JOB = 129649516421
ARTIFACT = 13739141511
ARTIFACT_NAME = "private-workspace-candidates-42761964307-1"
ZIP_SIZE = 5795
ZIP_SHA256 = "f02b76f05b8b8a2dda6f46fe512293482450f3efb3e2f03b650a5bfef3601701"
COLLECTOR_PATH = "scripts/ops/workspace-private-acceptance.mjs"
COLLECTOR_SHA256 = "610309919c9ed717854ef63a615fdd950cc7112e115590eeffdef5d1cbe62e46"
COLLECTOR_GIT_BLOB = "97b9425b6042d9de554ee19e106127cad1fb6d55"
PRIVATE_WORKFLOW = ".github/workflows/self-hosted-vault-closeout.yml"
PRIVATE_WORKFLOW_SHA256 = "2717aa01cf4ee4e60bb1912fffeb1c4e29fa3a4c92acb3f85559b49fa3c64807"
POLICY_SHA256 = "7d3abc6a73cfd56ee2bed51572db5b7d0e842db91df838f5dc40563b8c0ceb9c"
SUBAGENT_VERSION = "ad9aa7e8bae0ee7e0f83cd70ad74cc373dd6477adc341a69ccfccfadeb688574"
PINS = {
    "package.json": {"sha256":"907de32e9d30c44712805514fa53341623cb348aafff31aa861b4c9e4da6561f","gitBlob":"3dfd514aec7e768971ea05ab964c65765b4ce056","mode":"100644"},
    "pnpm-lock.yaml": {"sha256":"e1db8f01134e8e3377078e5e798b6a11ec117e0c4ffc69bae66c7c7b921d8dac","gitBlob":"171de02abdaf1b9c414aa19aeb07690ef692bafe","mode":"100644"},
    "pnpm-workspace.yaml": {"sha256":"4ab8b2f25a1899aaa44bd216434063b80e0c29c79229e598a20725a55415d2ee","gitBlob":"a9aff193192f224a7b457af8b82a52cfa86c9a48","mode":"100644"},
    "scripts/e2b/workspace-candidates.py": {"sha256":"00757ff10c91206035a051e0625bd2b6adda4e07ef27806628ec6c916e2df0ef","gitBlob":"7eeb95c1db35ea25735f4d6e753c7bd18b907d3b","mode":"100644"},
    "scripts/e2b/workspace-candidates.test.py": {"sha256":"34f3633b94b05b5c6db49cdcb3e61cdac436ccd52c2312087dbcbc7bacede4c4","gitBlob":"977de20840ff4f8cec4ec13e0e4c8f287bb56d6e","mode":"100644"},
    "scripts/e2b/build-template.py": {"sha256":"33ff017fa85e6e05fbdf7d0e8a5c59db4da98825e2aff73ac3314956e479b42c","gitBlob":"5dd021134e479afc25f8f26e279d8a1ecd869d3e","mode":"100644"},
    "scripts/e2b/build-template.test.py": {"sha256":"0481716b0fd2accfd66d08975ceee67ac5fdf6ae82c3918c20164632c79a3ed2","gitBlob":"8b254b0b004d212e0b7e79bf6af0adc0726fc829","mode":"100644"},
    "scripts/e2b/official-files.py": {"sha256":"66911624af52df59ef715eb105af9a3025bacf12460105fadc7f87e4d2dd63b5","gitBlob":"ea0819bf3e2d4ff83e64482b6336567050376591","mode":"100644"},
    "scripts/e2b/official-files.test.py": {"sha256":"9f5c3b13a0b219fa55570964139214fe89db36c76c3b58ba00313a587dade7d0","gitBlob":"88b8eb3916c829aacf4e71bf73e0335321f67e19","mode":"100644"},
    "scripts/e2b/cleanup-template-candidates.py": {"sha256":"893b0d50f30f4b21f92f155aee97965e12f84fd0e21ea0ada3dfb3a00392533d","gitBlob":"6fb47f15aaae3a0e256c47bb4db8df16380d001b","mode":"100644"},
    "scripts/e2b/cleanup-template-candidates.test.py": {"sha256":"826a489c570a788ea018b6a6ce786fd3e71b41dc8d514cfd8a09e516f8bf84f1","gitBlob":"4b7ebcdb65c8bdb78e913743bbadedf327dd8b25","mode":"100644"},
    "scripts/e2b/workspace-ingress-acceptance.mjs": {"sha256":"72a8d8ca769c46e2a8519efb7fa5060b0b04442fc2711caee27386599020f4a4","gitBlob":"353c68bbbdbe03ee927bf0587620880dacbc89ea","mode":"100644"},
    "scripts/e2b/workspace-ingress-acceptance.test.mjs": {"sha256":"eadc427e523e87383ae9e976b29c3891a7b2fc1e288917a9f4f157965d7c318d","gitBlob":"69b2507c8e8ca1167be96747fe28633baad7c803","mode":"100644"},
    "scripts/e2b/workspace-ingress-servers.py": {"sha256":"5c0c12ff3f5573f7a6032a359a372b2a4697b17e44501c7d175bd10c809c74b8","gitBlob":"37333e2fcafa8d56be5cc4d5c56a40ca9d54d06a","mode":"100644"},
    "scripts/e2b/workspace-terminal-acceptance.mjs": {"sha256":"d6d9d535c393e179eca800a44e5dfed508b06135d8891a793af05d539fa8252c","gitBlob":"66834d343968919a10431fbd14e2a26b8fea12d9","mode":"100644"},
    "scripts/e2b/workspace-terminal-acceptance.test.mjs": {"sha256":"971003d90739338112ae83838abc218811818600dcebe7fdbdd46b5e2214dce3","gitBlob":"631a805f85ced602c57a22f2241f3862451526b7","mode":"100644"},
    "scripts/e2b/fixtures/preview-frameworks/package.json": {"sha256":"e0cf3ad9d36941898385fc4e149c65be9a1081d8685b4d0b03e92e547cae964d","gitBlob":"821bc77099115df110341194964dddf2050ec9ba","mode":"100644"},
    "scripts/e2b/fixtures/preview-frameworks/package-lock.json": {"sha256":"9c123244b4ea44b3a59b92615e25b9780463135eab9f573b7342ad4df7468ef6","gitBlob":"e78c4a5a802c9462f6dfbbd4bee217d2c6edd056","mode":"100644"},
    "packages/daemon/scripts/workspace-ingress.py": {"sha256":"24e02e301c7287e288347e18c90486a09f5b82802158a49efb9672f13c734e7b","gitBlob":"41c0eaeb8ed9597388384e5d60d2199b554e6de3","mode":"100644"}
}
KINDS = ("claude", "codex")
MEMBERS = {"source.json", "verdict.json", "receipt-digests.json"}
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
RESOURCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
FRAMEWORK_FLAGS = "rawDenied authenticatedHttp assets hotReload crossSiteBootstrap revoked takeoverDenied".split()
PTY_CHECKS = "metadata freshControl gatewayReady authenticatedHealth unauthorizedStream unauthorizedInput streamReady stdout resize stdin exit postExitRefused".split()
PTY_CLEANUP = "leaseRevoked ptyStopped gatewayStopped receiptRestored filesRemoved".split()
SCOPE_FLAGS = "productionTaskAuthorityTested subscriptionsTested agentRootIsolationProven".split()
FRAMEWORK_VERSIONS = {"next": "16.4.1", "vite": "8.3.6", "react": "19.3.1", "react-dom": "19.3.1"}
SDKS = {"nodeMajor": "24", "pnpm": "10.34.3", "javascriptE2b": "2.61.0", "pythonE2b": "2.62.0", "next": "16.4.1"}
STAGE = "source"
START = time.monotonic()
MAX_SECONDS = 150

class Refused(Exception):
    pass

def need(value, code):
    if not value:
        raise Refused(code)

def exact_keys(value, names, code):
    need(type(value) is dict and set(value) == set(names), code)

def integer(value, minimum=0, maximum=2**53-1):
    return type(value) is int and minimum <= value <= maximum

def string_match(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None

def boolean_flags(value, names, expected, code):
    exact_keys(value, names, code)
    need(all(value[name] is expected for name in names), code)

def sha256(raw):
    return hashlib.sha256(raw).hexdigest()

def git_blob(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        need(key not in value, "json_duplicate_key")
        value[key] = item
    return value

def decode_json(raw, limit):
    need(type(raw) is bytes and 0 < len(raw) <= limit, "json_size")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                          parse_constant=lambda unused: (_ for _ in ()).throw(Refused("json_nonfinite")))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise Refused("json_invalid") from error

def remaining():
    value = MAX_SECONDS - (time.monotonic() - START)
    need(value > 0, "reader_deadline")
    return min(15.0, value)

def local_git(*args):
    result = subprocess.run(["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=min(10, remaining()), check=False)
    need(result.returncode == 0 and len(result.stdout) <= 16384, "local_source_git")
    return result.stdout.decode("utf-8").strip()

def local_guard():
    need(len(sys.argv) == 1 and string_match(HEX40, READER_PARENT), "reader_unbound")
    need(os.environ.get("GITHUB_REPOSITORY") == REPO
         and os.environ.get("GITHUB_REPOSITORY_ID") == str(REPO_ID)
         and os.environ.get("GITHUB_EVENT_NAME") == "push"
         and os.environ.get("GITHUB_REF") == "refs/heads/" + BRANCH
         and os.environ.get("GITHUB_RUN_ATTEMPT") == "1"
         and os.environ.get("GITHUB_ACTOR") == "alexj11324"
         and os.environ.get("GITHUB_TRIGGERING_ACTOR") == "alexj11324",
         "reader_context")
    head = os.environ.get("GITHUB_SHA", "")
    need(string_match(HEX40, head), "reader_head")
    need(os.environ.get("GITHUB_WORKFLOW_REF") == REPO + "/" + WORKFLOW + "@refs/heads/" + BRANCH,
         "reader_workflow")
    event = decode_json(Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes(), 1024 * 1024)
    need(event.get("before") == READER_PARENT and event.get("after") == head
         and event.get("ref") == "refs/heads/" + BRANCH
         and event.get("repository", {}).get("id") == REPO_ID
         and event.get("repository", {}).get("full_name") == REPO
         and event.get("sender", {}).get("login") == "alexj11324"
         and event.get("deleted") is False and event.get("forced") is False and event.get("created") is False,
         "reader_event")
    need(local_git("rev-parse", "HEAD") == head
         and local_git("rev-list", "--parents", "-n", "1", "HEAD").split() == [head, READER_PARENT]
         and local_git("rev-parse", READER_PARENT + "^{tree}") == READER_PARENT_TREE
         and local_git("status", "--porcelain", "--untracked-files=all") == "",
         "reader_checkout")
    need(set(local_git("diff", "--name-status", READER_PARENT, head).splitlines()) == {"A\t" + SCRIPT, "A\t" + WORKFLOW},
         "reader_changed_paths")
    return head

# Read-only transport is copied from the separately reviewed UI artifact reader below.
MAX_API = 4 * 1024 * 1024
SOURCE_TREE_IDS = [
  "dffda64a4975b22cfc649908a8c5e19749ea8a96",
  "71799ee69259f0be251af53c8c6ec29b7eedcd73",
  "03a018aa50ef39afbe2974703e8896d1511263b4",
  "3014d1a8c2b95dd260d1568aff684a08f82699a9",
  "cbc670249ca48ef7bbfa98aa3e08e37cfa4d4ae0",
  "5c5afab77f91477a5cb3b9d77bede9322ce259a1",
  "9a613b7217565ddbf1d327b7b2c6f08a46088535",
  "c0bf4756405be8fdd4e5b666fb10b9f611fceba6",
  "517341dab24411bc67e63a3fb45bc1c50bfab4c9",
  "12f49298098fb7360b4d6f52c4d1b2c71bee2bba",
  "630ff9a28dfe3a15f46b7bce93967937346df290",
  "594f6990fd292839eb7e9b93556b7673ab363d75",
  "5251bca5633af3e653eaa268c77238180d13aa27"
]
SOURCE_BLOB_IDS = [
  "3dfd514aec7e768971ea05ab964c65765b4ce056",
  "171de02abdaf1b9c414aa19aeb07690ef692bafe",
  "a9aff193192f224a7b457af8b82a52cfa86c9a48",
  "7eeb95c1db35ea25735f4d6e753c7bd18b907d3b",
  "977de20840ff4f8cec4ec13e0e4c8f287bb56d6e",
  "5dd021134e479afc25f8f26e279d8a1ecd869d3e",
  "8b254b0b004d212e0b7e79bf6af0adc0726fc829",
  "ea0819bf3e2d4ff83e64482b6336567050376591",
  "88b8eb3916c829aacf4e71bf73e0335321f67e19",
  "6fb47f15aaae3a0e256c47bb4db8df16380d001b",
  "4b7ebcdb65c8bdb78e913743bbadedf327dd8b25",
  "353c68bbbdbe03ee927bf0587620880dacbc89ea",
  "69b2507c8e8ca1167be96747fe28633baad7c803",
  "37333e2fcafa8d56be5cc4d5c56a40ca9d54d06a",
  "66834d343968919a10431fbd14e2a26b8fea12d9",
  "631a805f85ced602c57a22f2241f3862451526b7",
  "821bc77099115df110341194964dddf2050ec9ba",
  "e78c4a5a802c9462f6dfbbd4bee217d2c6edd056",
  "41c0eaeb8ed9597388384e5d60d2199b554e6de3",
  "e6d19b5ed954d71c53a3ef32eed9c96a30943116",
  "898293bf3873ea9da4a1cecf673e7ee54cafcf7c",
  "814d0e464c63f8c95e4ef66b4e755a2bb285aace",
  "97b9425b6042d9de554ee19e106127cad1fb6d55",
  "b6792c0065942ddf675d32b280aa5a3f9ff0c0dd"
]
require = need
def parse_json(raw, limit=MAX_API):
    return decode_json(raw, limit)

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
    def __init__(self, token, reader_head):
        require(type(token) is str and len(token) >= 16 and "\n" not in token and "\r" not in token, "token_unavailable")
        self.token = token
        self.api = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        # This separate opener has no auth, cookie jar, proxy or automatic redirect.
        self.download = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.allowed = {
            f"/repos/{REPO}/actions/runs/{RUN}",
            f"/repos/{REPO}/actions/jobs/{JOB}",
            f"/repos/{REPO}/actions/artifacts/{ARTIFACT}",
            f"/repos/{REPO}/actions/artifacts/{ARTIFACT}/zip",
            f"/repos/{REPO}/git/commits/{OPS}",
            f"/repos/{REPO}/git/commits/{PRODUCT}",
            f"/repos/{REPO}/git/commits/{reader_head}",
        }
        self.allowed.update(f"/repos/{REPO}/git/trees/{sha}" for sha in SOURCE_TREE_IDS)
        self.allowed.update(f"/repos/{REPO}/git/blobs/{sha}" for sha in SOURCE_BLOB_IDS)

    def request(self, path):
        require(path in self.allowed, "api_path")
        url = f"https://api.github.com{path}"
        parsed_url(url, api=True)
        return urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "Accept-Encoding": "identity",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "mikka-1782-fixed-private-evidence-reader",
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
            with self.api.open(self.request(f"/repos/{REPO}/actions/artifacts/{ARTIFACT}/zip"), timeout=remaining()):
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
            "User-Agent": "mikka-1782-fixed-private-evidence-reader",
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

GITHUB = None
def api_json(path):
    need(GITHUB is not None, "api_uninitialized")
    value = GITHUB.json("/repos/" + REPO + path)
    need(type(value) is dict, "api_json_object")
    return value

def artifact_zip():
    need(GITHUB is not None, "api_uninitialized")
    return GITHUB.artifact()


_TREE_CACHE = {}
def fixed_tree(tree_sha):
    need(string_match(HEX40, tree_sha), "source_tree_id")
    if tree_sha not in _TREE_CACHE:
        value = api_json("/git/trees/" + tree_sha)
        need(value.get("sha") == tree_sha and value.get("truncated") is False
             and type(value.get("tree")) is list and len(value["tree"]) <= 10000, "source_tree")
        rows = value["tree"]
        need(len({row.get("path") for row in rows}) == len(rows), "source_tree_names")
        encoded = bytearray()
        for row in sorted(rows, key=lambda item: (item["path"] + ("/" if item["type"] == "tree" else "")).encode("utf-8")):
            need(type(row.get("path")) is str and "/" not in row["path"] and "\0" not in row["path"]
                 and row.get("mode") in ("040000", "100644", "100755", "120000", "160000")
                 and string_match(HEX40, row.get("sha")), "source_tree_entry")
            mode = "40000" if row["mode"] == "040000" else row["mode"]
            encoded.extend((mode + " " + row["path"]).encode("utf-8") + b"\0" + bytes.fromhex(row["sha"]))
        need(hashlib.sha1(b"tree " + str(len(encoded)).encode("ascii") + b"\0" + encoded).hexdigest() == tree_sha,
             "source_tree_digest")
        _TREE_CACHE[tree_sha] = {row["path"]: row for row in rows}
    return _TREE_CACHE[tree_sha]

def fixed_blob(tree_sha, path):
    parts = path.split("/")
    for part in parts[:-1]:
        row = fixed_tree(tree_sha).get(part)
        need(row is not None and row["type"] == "tree" and row["mode"] == "040000", "source_directory")
        tree_sha = row["sha"]
    row = fixed_tree(tree_sha).get(parts[-1])
    need(row is not None and row["type"] == "blob" and row["mode"] in ("100644", "100755"), "source_regular_file")
    value = api_json("/git/blobs/" + row["sha"])
    need(value.get("sha") == row["sha"] and value.get("encoding") == "base64"
         and integer(value.get("size"), 1, 2 * 1024 * 1024), "source_blob")
    try:
        raw = base64.b64decode(value["content"].replace("\n", ""), validate=True)
    except (ValueError, TypeError) as error:
        raise Refused("source_base64") from error
    need(len(raw) == value["size"] and git_blob(raw) == row["sha"], "source_blob_digest")
    return raw, row

def verify_sources(reader_head):
    current = api_json("/git/commits/" + reader_head)
    need(current.get("sha") == reader_head
         and [row.get("sha") for row in current.get("parents", [])] == [READER_PARENT],
         "reader_api_parent")
    need(current.get("tree", {}).get("sha") == local_git("rev-parse", "HEAD^{tree}"), "reader_api_tree")
    product = api_json("/git/commits/" + PRODUCT)
    need(product.get("sha") == PRODUCT and product.get("tree", {}).get("sha") == PRODUCT_TREE
         and [row.get("sha") for row in product.get("parents", [])] == PRODUCT_PARENTS,
         "product_identity")
    ops = api_json("/git/commits/" + OPS)
    need(ops.get("sha") == OPS and ops.get("tree", {}).get("sha") == OPS_TREE
         and [row.get("sha") for row in ops.get("parents", [])] == [OPS_PARENT], "ops_identity")
    collector, row = fixed_blob(OPS_TREE, COLLECTOR_PATH)
    need(row["sha"] == COLLECTOR_GIT_BLOB and sha256(collector) == COLLECTOR_SHA256, "collector_source")
    workflow, unused = fixed_blob(OPS_TREE, PRIVATE_WORKFLOW)
    need(sha256(workflow) == PRIVATE_WORKFLOW_SHA256, "private_workflow_source")
    for path, pin in PINS.items():
        raw, row = fixed_blob(PRODUCT_TREE, path)
        need(row["sha"] == pin["gitBlob"] and row["mode"] == pin["mode"]
             and sha256(raw) == pin["sha256"], "product_file_pin")
    policy, unused = fixed_blob(PRODUCT_TREE, "scripts/e2b/e2b-finalization-files.json")
    need(sha256(policy) == POLICY_SHA256, "conservation_policy_pin")
    gateway, unused = fixed_blob(PRODUCT_TREE, "scripts/e2b/subagent-gateway.py")
    cdp, unused = fixed_blob(PRODUCT_TREE, "scripts/e2b/subagent-cdp.mjs")
    need(sha256(gateway + cdp) == SUBAGENT_VERSION, "subagent_source_pin")
    return {"readerCommit": reader_head, "readerParent": READER_PARENT,
            "readerScriptSha256": sha256(Path(SCRIPT).read_bytes()),
            "readerWorkflowSha256": sha256(Path(WORKFLOW).read_bytes()),
            "collectorSha256": COLLECTOR_SHA256, "privateWorkflowSha256": PRIVATE_WORKFLOW_SHA256,
            "productFilePinsVerified": len(PINS), "productTreeVerified": True,
            "canonicalWorkerRecomputedByReader": False}

def verify_api_identity():
    run = api_json("/actions/runs/" + str(RUN))
    need(run.get("id") == RUN and run.get("run_attempt") == ATTEMPT
         and run.get("head_sha") == OPS and run.get("head_branch") == "ops/self-hosted-vault-closeout-20261108"
         and run.get("status") == "completed" and run.get("conclusion") == "success"
         and run.get("event") == "push" and run.get("path") == PRIVATE_WORKFLOW
         and run.get("workflow_id") == 410913883
         and run.get("repository", {}).get("id") == REPO_ID
         and run.get("head_repository", {}).get("id") == REPO_ID
         and run.get("actor", {}).get("login") == "alexj11324"
         and run.get("triggering_actor", {}).get("login") == "alexj11324"
         and run.get("actor", {}).get("id") == 183887963
         and run.get("triggering_actor", {}).get("id") == 183887963, "private_run_identity")
    job = api_json("/actions/jobs/" + str(JOB))
    need(job.get("id") == JOB and job.get("run_id") == RUN and job.get("head_sha") == OPS
         and job.get("status") == "completed" and job.get("conclusion") == "success", "private_job_identity")
    steps = job.get("steps", [])
    need(type(steps) is list and all(type(step) is dict for step in steps), "private_job_steps")
    for number in range(6, 18):
        selected = [step for step in steps if step.get("number") == number]
        need(len(selected) == 1 and selected[0].get("status") == "completed"
             and selected[0].get("conclusion") == "success", "private_required_step")
    metadata = api_json("/actions/artifacts/" + str(ARTIFACT))
    wr = metadata.get("workflow_run", {})
    need(metadata.get("id") == ARTIFACT and metadata.get("name") == ARTIFACT_NAME
         and metadata.get("size_in_bytes") == ZIP_SIZE and metadata.get("expired") is False
         and metadata.get("digest") == "sha256:" + ZIP_SHA256
         and wr.get("id") == RUN and wr.get("head_sha") == OPS
         and wr.get("head_branch") == "ops/self-hosted-vault-closeout-20261108"
         and wr.get("repository_id") == REPO_ID and wr.get("head_repository_id") == REPO_ID,
         "private_artifact_identity")
    return {"runId": RUN, "runAttempt": ATTEMPT, "jobId": JOB, "workflowSuccess": True,
            "requiredStepsSuccess": list(range(6, 18)), "artifactId": ARTIFACT, "artifactName": ARTIFACT_NAME,
            "artifactBytes": ZIP_SIZE, "artifactSha256": ZIP_SHA256}

def read_members(blob):
    need(len(blob) == ZIP_SIZE and sha256(blob) == ZIP_SHA256, "archive_digest")
    raw, fingerprints = {}, {}
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            rows = archive.infolist()
            need(len(rows) == 3 and {row.filename for row in rows} == MEMBERS, "archive_members")
            need(len({row.filename for row in rows}) == 3
                 and sum(row.file_size for row in rows) <= 3 * 262144, "archive_total")
            for row in rows:
                remaining()
                need(row.orig_filename == row.filename and row.filename in MEMBERS
                     and not row.is_dir() and not (row.flag_bits & 1)
                     and row.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                     and stat.S_IFMT(row.external_attr >> 16) in (0, stat.S_IFREG)
                     and 0 < row.file_size <= 262144 and 0 <= row.compress_size <= ZIP_SIZE
                     and 0 <= row.header_offset < ZIP_SIZE, "archive_member_shape")
                with archive.open(row, "r") as handle:
                    data = handle.read(row.file_size + 1)
                remaining()
                need(len(data) == row.file_size and (binascii.crc32(data) & 0xffffffff) == row.CRC, "archive_crc")
                raw[row.filename] = data
                fingerprints[row.filename] = {"bytes": len(data), "sha256": sha256(data), "crc32": f"{row.CRC:08x}"}
    except Refused:
        raise
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, ValueError, OSError) as error:
        raise Refused("archive_invalid") from error
    values = {name: decode_json(value, 262144) for name, value in raw.items()}
    return values, fingerprints

def bind(value, tree=False, worker=False):
    need(value["sourceCommit"] == PRODUCT and value["opsSource"] == OPS, "receipt_source")
    if tree:
        need(value["sourceTree"] == PRODUCT_TREE, "receipt_tree")
    if worker:
        need(value["workerSha"] == WORKER, "receipt_worker")
    if "runId" in value or "runAttempt" in value:
        need(value.get("runId") == str(RUN) and value.get("runAttempt") == str(ATTEMPT), "receipt_attempt")

def verify_source(value):
    exact_keys(value, "version opsSource sourceCommit sourceTree runId runAttempt files sourceVerified workerSha versions".split(), "source_keys")
    need(value["version"] == 1 and type(value["version"]) is int and value["sourceVerified"] is True, "source_verified")
    bind(value, tree=True, worker=True)
    need(value["files"] == {path: pin["sha256"] for path, pin in PINS.items()}, "source_pins")
    exact_keys(value["versions"], [*SDKS, "node", "python"], "sdk_keys")
    need(all(value["versions"][key] == expected for key, expected in SDKS.items())
         and string_match(SEMVER, value["versions"]["node"]) and value["versions"]["node"].split(".")[0] == "24"
         and string_match(SEMVER, value["versions"]["python"]), "sdk_versions")
    return dict(value["versions"])

def digest_pair(value, code):
    exact_keys(value, ["entries", "sha256"], code)
    need(integer(value["entries"], 1) and string_match(HEX64, value["sha256"]), code)

def finalization(value, kind, original):
    exact_keys(value, "kind policySha256 before after originalBefore originalAfter providerChangesCount".split(), "conservation_final_keys")
    need(value["kind"] == kind and value["policySha256"] == POLICY_SHA256, "conservation_policy")
    for key in ("before", "after", "originalBefore", "originalAfter"):
        digest_pair(value[key], "conservation_digest")
    need(value["before"] == value["after"] and value["originalBefore"] == original
         and value["before"]["entries"] == original["entries"]
         and value["originalAfter"]["entries"] == original["entries"]
         and integer(value["providerChangesCount"], 0, original["entries"]), "conservation_normalized")
    return {"policyMatched": True, "normalizedBeforeAfterEqual": True,
            "originalEntryCount": original["entries"], "providerChangesCount": value["providerChangesCount"]}

def conservation(value, kind):
    exact_keys(value, ["before", "after", "finalization", "preloadFinalization"], "conservation_keys")
    digest_pair(value["before"], "conservation_baseline")
    digest_pair(value["after"], "conservation_installation")
    need(value["before"] == value["after"], "installation_conservation")
    return {"installationBeforeAfterEqual": True,
            "fresh": finalization(value["finalization"], kind, value["before"]),
            "preload": finalization(value["preloadFinalization"], kind, value["before"])}

def guard(value):
    exact_keys(value, "sourceSha256 bootId version installedTicks workerPid workerStartTicks providerPorts ok preparedBeforeWorker workerStartedAfterGuard rulesVerified".split(), "guard_keys")
    need(value["sourceSha256"] == PINS["packages/daemon/scripts/workspace-ingress.py"]["sha256"]
         and string_match(UUID, value["bootId"]) and integer(value["version"], 1)
         and integer(value["installedTicks"], 0) and integer(value["workerPid"], 1)
         and integer(value["workerStartTicks"], 1) and value["workerStartTicks"] >= value["installedTicks"]
         and value["ok"] is True and type(value["preparedBeforeWorker"]) is bool
         and type(value["workerStartedAfterGuard"]) is bool, "guard_values")
    ports = value["providerPorts"]
    need(type(ports) is list and 1 <= len(ports) <= 2 and len(set(ports)) == len(ports)
         and all(type(port) is int and port in (49983, 50005) for port in ports) and 49983 in ports, "guard_provider_ports")
    boolean_flags(value["rulesVerified"], ["ipv4", "ipv6"], True, "guard_rules")

def marker(value, denied=False):
    exact_keys(value, ["status", "markerMatched"], "marker_keys")
    need((value["status"] is None or integer(value["status"], 100, 599)) and type(value["markerMatched"]) is bool, "marker_shape")
    if denied:
        need(value["markerMatched"] is False and (value["status"] is None or value["status"] >= 400), "raw_not_denied")
    else:
        need(value == {"status": 200, "markerMatched": True}, "positive_control")

def ingress(value):
    exact_keys(value, ["local", "external"], "ingress_keys")
    names = ["userLoopback4", "userPublic4", "userLoopback6"]
    boolean_flags(value["local"], names, True, "local_ingress")
    exact_keys(value["external"], [*names, "rootMarked"], "external_ingress")
    for name in names:
        marker(value["external"][name], denied=True)
    marker(value["external"]["rootMarked"])
    return {name: value["external"][name]["status"] for name in [*names, "rootMarked"]}

def framework(value):
    exact_keys(value, ["framework", *FRAMEWORK_FLAGS, "unauthenticatedStatus", "replayStatus", "hmrEvent", "websocket"], "framework_keys")
    need(value["framework"] in ("next", "vite") and all(value[key] is True for key in FRAMEWORK_FLAGS)
         and value["unauthenticatedStatus"] in (401, 403) and type(value["unauthenticatedStatus"]) is int
         and value["replayStatus"] in (401, 403) and type(value["replayStatus"]) is int
         and value["hmrEvent"] in (("built", "serverComponentChanges") if value["framework"] == "next" else ("update", "full-reload")),
         "framework_assertions")
    websocket = value["websocket"]
    exact_keys(websocket, ["closed", "messages", "bytes", "closeCode"], "websocket_keys")
    need(websocket["closed"] is True and integer(websocket["messages"], 1)
         and integer(websocket["bytes"], 1) and integer(websocket["closeCode"], 0, 65535), "websocket_values")
    return {"framework": value["framework"], "checks": {key: True for key in FRAMEWORK_FLAGS},
            "unauthenticatedStatus": value["unauthenticatedStatus"], "replayStatus": value["replayStatus"],
            "hmrEvent": value["hmrEvent"], "websocket": dict(websocket)}

def terminal(value):
    exact_keys(value, ["passed", "exitCode", "checks", "statuses", "cleanup"], "terminal_keys")
    need(value["passed"] is True and value["exitCode"] == 7 and type(value["exitCode"]) is int, "terminal_exit")
    boolean_flags(value["checks"], PTY_CHECKS, True, "terminal_checks")
    boolean_flags(value["cleanup"], PTY_CLEANUP, True, "terminal_cleanup")
    statuses = value["statuses"]
    exact_keys(statuses, ["unauthorizedStream", "unauthorizedInput", "stream", "resize", "postExit"], "terminal_status_keys")
    need(all(type(number) is int for number in statuses.values())
         and statuses["unauthorizedStream"] in (401, 403) and statuses["unauthorizedInput"] in (401, 403)
         and statuses["stream"] == 200 and statuses["resize"] == 204 and statuses["postExit"] == 409, "terminal_statuses")
    return {"checks": dict(value["checks"]), "cleanup": dict(value["cleanup"]), "statuses": dict(statuses), "exitCode": 7}

def validate_build_diagnostic(value):
    exact_keys(value, ["exceptionChain", "exceptionChainTruncated", "statusLookup", "buildLogs"], "build_diagnostic_keys")
    need(value["exceptionChain"] == [] and value["exceptionChainTruncated"] is False and value["statusLookup"] is None,
         "build_success_diagnostic")
    exact_keys(value["buildLogs"], KINDS, "build_log_kinds")
    phase_names = {"template_created", "provider_failure", "bootstrap", "prebuilt_start", "prebuilt_start_failed",
                   "prebuilt_ready_failed", "ingress", "host_failure", "conservation_failed", "official_capture"}
    event_keys = {"phase", "detail", "elapsedMs", "exitCode", "command", "conservation", "stage",
                  "check", "removedPathCode", "entries"}
    result = {}
    for kind in KINDS:
        row = value["buildLogs"][kind]
        exact_keys(row, ["entries", "ignoredLines", "oversizedEntries", "truncated", "events"], "build_log_keys")
        need(all(integer(row[key], 0) for key in ("entries", "ignoredLines", "oversizedEntries"))
             and type(row["truncated"]) is bool and type(row["events"]) is list and len(row["events"]) <= 64, "build_log_bounds")
        for event in row["events"]:
            need(type(event) is dict and event.get("phase") in phase_names
                 and set(event) <= event_keys, "build_event_shape")
        # Diagnostic values are deliberately not copied or interpreted as proof.
        result[kind] = {"entries": row["entries"], "ignoredLines": row["ignoredLines"],
                        "oversizedEntries": row["oversizedEntries"], "truncated": row["truncated"],
                        "eventCount": len(row["events"])}
    return result

def validate_collection(value):
    exact_keys(value, ["stage", "code", "reports"], "collection_keys")
    need(value["stage"] == "complete" and value["code"] == "ok" and type(value["reports"]) is list
         and len(value["reports"]) == 9, "collection_complete")
    expected = [("buildReport", None, None), ("candidates", None, None), ("builderJournal", None, None),
                ("vmCleanup", None, None), ("templateCleanups", None, 1),
                ("runtime", "claude", None), ("journals", "claude", None),
                ("runtime", "codex", None), ("journals", "codex", None)]
    observed = []
    result = []
    for row in value["reports"]:
        keys = ["role", "type", "bytes", "limit", "code"]
        if row.get("role") in ("runtime", "journals"):
            keys.append("kind")
        if row.get("role") == "templateCleanups":
            keys.append("ordinal")
        exact_keys(row, keys, "collection_report_keys")
        limit = 4194304 if row["role"] == "candidates" else 262144
        need(row["type"] == "file" and row["code"] == "ok" and row["limit"] == limit
             and type(row["limit"]) is int and integer(row["bytes"], 1, limit), "collection_report_bounds")
        observed.append((row["role"], row.get("kind"), row.get("ordinal")))
        result.append(dict(row))
    need(observed == expected, "collection_report_inventory")
    return result

def verify_verdict(value):
    exact_keys(value, "version sourceCommit sourceTree opsSource workerSha runId runAttempt scope productionTaskAuthorityTested subscriptionsTested agentRootIsolationProven build candidates cases journals runtimeCleanup templateCleanups stepOutcomes runtimeCleanupConfirmed templateCleanupConfirmed passed collection".split(), "verdict_keys")
    bind(value, tree=True, worker=True)
    need(type(value["version"]) is int and value["version"] == 1
         and value["scope"] == "private_derived_candidates_only"
         and all(value[key] is False for key in SCOPE_FLAGS)
         and value["passed"] is True and value["runtimeCleanupConfirmed"] is True
         and value["templateCleanupConfirmed"] is True, "verdict_scope_or_pass")
    exact_keys(value["stepOutcomes"], ["build", "acceptance", "vmCleanup", "templateCleanup"], "step_outcome_keys")
    need(all(item == "success" for item in value["stepOutcomes"].values()), "step_outcomes")
    build = value["build"]
    exact_keys(build, ["passed", "status", "stage", "code", "diagnostic"], "build_keys")
    need(build["passed"] is True and build["status"] == "passed" and build["stage"] == "complete" and build["code"] is None, "build_complete")
    build_logs = validate_build_diagnostic(build["diagnostic"])
    exact_keys(value["candidates"], KINDS, "candidate_kinds")
    candidate_ids = {}
    conservation_report = {}
    for kind in KINDS:
        row = value["candidates"][kind]
        exact_keys(row, ["baseTemplate", "templateId", "buildId", "preinstalled", "privateVerified", "conservation"], "candidate_keys")
        need(row["baseTemplate"] == kind and row["preinstalled"] is True and row["privateVerified"] is True
             and string_match(RESOURCE_ID, row["templateId"]) and string_match(RESOURCE_ID, row["buildId"]), "candidate_identity")
        candidate_ids[kind] = row["templateId"]
        conservation_report[kind] = conservation(row["conservation"], kind)
    need(len(set(candidate_ids.values())) == 2, "candidate_unique")
    exact_keys(value["journals"], ["builder", "runtime"], "journal_keys")
    builder = value["journals"]["builder"]
    exact_keys(builder, ["version", "identity", "templates", "sandboxes", "pendingSandbox"], "builder_journal_keys")
    need(type(builder["version"]) is int and builder["version"] == 1 and builder["pendingSandbox"] is None, "builder_journal_version")
    exact_keys(builder["identity"], ["sourceCommit", "workerSha", "workflowCommit", "runId", "runAttempt"], "builder_scope_keys")
    need(builder["identity"] == {"sourceCommit": PRODUCT, "workerSha": WORKER, "workflowCommit": OPS,
                                 "runId": str(RUN), "runAttempt": str(ATTEMPT)}, "builder_scope")
    exact_keys(builder["templates"], KINDS, "builder_template_kinds")
    for kind in KINDS:
        row = builder["templates"][kind]
        exact_keys(row, ["kind", "name", "creationStarted", "collision", "templateId", "buildId"], "builder_template_keys")
        need(row["kind"] == kind and row["name"] == "mikka-preview-" + PRODUCT[:12] + "-" + str(RUN) + "-1-" + kind
             and row["creationStarted"] is True and row["collision"] is False
             and row["templateId"] == candidate_ids[kind] and row["buildId"] == value["candidates"][kind]["buildId"],
             "builder_template_binding")
    need(type(builder["sandboxes"]) is list and len(builder["sandboxes"]) == 4, "builder_vm_count")
    builder_ids = []
    for row in builder["sandboxes"]:
        exact_keys(row, ["sandboxId", "templateId", "kind", "deletedConfirmed"], "builder_vm_keys")
        need(row["kind"] in KINDS and string_match(RESOURCE_ID, row["sandboxId"])
             and row["templateId"] == candidate_ids[row["kind"]] and row["deletedConfirmed"] is True, "builder_vm_binding")
        builder_ids.append(row["sandboxId"])
    need(len(set(builder_ids)) == 4 and all(sum(row["kind"] == kind for row in builder["sandboxes"]) == 2 for kind in KINDS), "builder_vm_unique")
    exact_keys(value["journals"]["runtime"], KINDS, "runtime_journal_kinds")
    need(type(value["cases"]) is list and len(value["cases"]) == 2
         and {row.get("kind") for row in value["cases"]} == set(KINDS), "runtime_cases")
    runtime_ids, fixture_ids, report_cases = [], [], []
    case_keys = "kind present sourceCommit workerSha templateId sandboxId fixtureId stage failure passed identityDiagnostic previewDiagnostic productionTaskAuthorityTested subscriptionsTested agentRootIsolationProven previewStopped frameworkVersions frameworkLockSha256 guard resumedGuard initialIngress resumedIngress outbound unassignedProviderPort listenerWiring frameworks terminal identityMatched runtimePassed".split()
    for row in value["cases"]:
        exact_keys(row, case_keys, "runtime_case_keys")
        kind = row["kind"]
        journal = value["journals"]["runtime"][kind]
        exact_keys(journal, "version purpose sourceCommit opsSource workerSha fixtureId templateId kind runId runAttempt creationRequested sandboxId".split(), "runtime_journal_keys")
        bind(journal, worker=True)
        need(type(journal["version"]) is int and journal["version"] == 1
             and journal["purpose"] == "mikka-workspace-ingress-acceptance" and journal["kind"] == kind
             and journal["creationRequested"] is True and journal["templateId"] == candidate_ids[kind]
             and string_match(UUID, journal["fixtureId"]) and string_match(RESOURCE_ID, journal["sandboxId"]), "runtime_journal_binding")
        need(row["sourceCommit"] == PRODUCT and row["workerSha"] == WORKER
             and all(row[key] == journal[key] for key in ("templateId", "sandboxId", "fixtureId"))
             and all(row[key] is True for key in ("present", "passed", "previewStopped", "identityMatched", "runtimePassed"))
             and all(row[key] is False for key in SCOPE_FLAGS) and row["stage"] == "completed"
             and row["failure"] is None and row["identityDiagnostic"] is None and row["previewDiagnostic"] is None,
             "runtime_identity_complete")
        runtime_ids.append(row["sandboxId"])
        fixture_ids.append(row["fixtureId"])
        guard(row["guard"])
        guard(row["resumedGuard"])
        need(row["guard"]["preparedBeforeWorker"] is True and row["guard"]["workerStartedAfterGuard"] is True
             and all(row["guard"][key] == row["resumedGuard"][key] for key in
                     ("bootId", "sourceSha256", "installedTicks", "workerPid", "workerStartTicks"))
             and row["guard"]["providerPorts"] == row["resumedGuard"]["providerPorts"], "full_memory_guard_identity")
        initial, resumed = ingress(row["initialIngress"]), ingress(row["resumedIngress"])
        marker(row["outbound"])
        marker(row["unassignedProviderPort"], denied=True)
        wiring = row["listenerWiring"]
        exact_keys(wiring, ["realEntrypoints", "browserFramesTested", "viewerUnauthenticatedStatus", "subagentVersionStatus", "subagentUnauthenticatedStatus", "subagentVersion"], "listener_keys")
        need(wiring == {"realEntrypoints": True, "browserFramesTested": False, "viewerUnauthenticatedStatus": 401,
                        "subagentVersionStatus": 200, "subagentUnauthenticatedStatus": 401, "subagentVersion": SUBAGENT_VERSION},
             "listener_real_entrypoints")
        need(row["frameworkVersions"] == FRAMEWORK_VERSIONS
             and row["frameworkLockSha256"] == PINS["scripts/e2b/fixtures/preview-frameworks/package-lock.json"]["sha256"],
             "framework_dependencies")
        need(type(row["frameworks"]) is list and len(row["frameworks"]) == 2
             and {entry.get("framework") for entry in row["frameworks"]} == {"next", "vite"}, "framework_count")
        framework_report = [framework(entry) for entry in row["frameworks"]]
        terminal_report = terminal(row["terminal"])
        report_cases.append({"kind": kind, "stage": "completed", "sourceAndJournalBound": True,
                             "frameworks": framework_report, "terminal": terminal_report,
                             "fullMemoryResumeIdentityEqual": True,
                             "fullGuardProjectionEqual": row["guard"] == row["resumedGuard"],
                             "guardRulesIpv4Ipv6Verified": True,
                             "initialIngressStatuses": initial, "resumedIngressStatuses": resumed,
                             "unassignedProviderPortExercised": 50005 not in row["guard"]["providerPorts"],
                             "realListenerEntrypoints": True, "browserFramesTested": False,
                             "previewStopped": True, "outboundPositive": True})
    need(len(set(runtime_ids)) == 2 and len(set(fixture_ids)) == 2
         and len(set(builder_ids + runtime_ids)) == 6, "all_owned_vm_unique")
    need(type(value["runtimeCleanup"]) is list and len(value["runtimeCleanup"]) == 2, "runtime_cleanup_count")
    cleanup_report = []
    for kind in KINDS:
        rows = [row for row in value["runtimeCleanup"] if row.get("kind") == kind]
        need(len(rows) == 1, "runtime_cleanup_kind")
        row = rows[0]
        exact_keys(row, ["kind", "stopped", "absent", "scopeVerified", "killAcknowledged", "outcome"], "runtime_cleanup_keys")
        need(row["stopped"] is True and row["absent"] is True, "runtime_cleanup_absence")
        if row["outcome"] == "provider_kill_acknowledged_and_absent":
            need(row["scopeVerified"] is True and row["killAcknowledged"] is True, "runtime_cleanup_ack")
        else:
            need(row["outcome"] == "provider_already_absent"
                 and (row["scopeVerified"] is None or type(row["scopeVerified"]) is bool)
                 and (row["killAcknowledged"] is None or type(row["killAcknowledged"]) is bool),
                 "runtime_cleanup_outcome")
        cleanup_report.append({"kind": kind, "outcome": row["outcome"], "absent": True,
                               "killAcknowledged": row["killAcknowledged"], "scopeVerified": row["scopeVerified"]})
    need(type(value["templateCleanups"]) is list and len(value["templateCleanups"]) == 1, "template_cleanup_count")
    cleanup = value["templateCleanups"][0]
    exact_keys(cleanup, ["identityMatched", "confirmed", "templates", "sandboxes", "errors"], "template_cleanup_keys")
    need(cleanup["identityMatched"] is True and cleanup["confirmed"] is True and cleanup["errors"] == [], "template_cleanup_confirmed")
    need(type(cleanup["templates"]) is list and len(cleanup["templates"]) == 2
         and type(cleanup["sandboxes"]) is list and len(cleanup["sandboxes"]) == 4, "template_cleanup_inventory")
    for kind in KINDS:
        rows = [row for row in cleanup["templates"] if row.get("kind") == kind]
        need(len(rows) == 1, "template_cleanup_kind")
        row = rows[0]
        exact_keys(row, ["kind", "name", "templateId", "status", "code"], "template_cleanup_entry_keys")
        need(row["name"] == builder["templates"][kind]["name"] and row["templateId"] == candidate_ids[kind]
             and row["status"] in ("absent", "deleted") and row["code"] is None, "template_cleanup_entry")
    for vm in builder_ids:
        rows = [row for row in cleanup["sandboxes"] if row.get("sandboxId") == vm]
        need(len(rows) == 1, "builder_cleanup_exact_id")
        row = rows[0]
        exact_keys(row, ["sandboxId", "status", "code"], "builder_cleanup_keys")
        need(row["status"] in ("absent", "deleted") and row["code"] is None, "builder_cleanup_status")
    collection = validate_collection(value["collection"])
    return {"passed": True, "scope": value["scope"], **{key: False for key in SCOPE_FLAGS},
            "build": {"twoKindsPassed": True, "logs": build_logs, "conservation": conservation_report},
            "cases": report_cases, "runtimeCleanup": cleanup_report,
            "resources": {"templates": 2, "builderVms": 4, "runtimeVms": 2, "distinctVms": 6,
                          "everyJournalIdMatchedOnce": True, "pendingSandbox": False,
                          "templateCleanupConfirmed": True, "runtimeCleanupConfirmed": True,
                          "resourceIdSetSha256": sha256(json.dumps(sorted([*candidate_ids.values(), *builder_ids, *runtime_ids]),
                                                                  separators=(",", ":")).encode("ascii"))},
            "stepOutcomes": dict(value["stepOutcomes"]), "collection": collection}

def verify_receipt_digests(value):
    exact_keys(value, ["version", "sourceCommit", "opsSource", "receipts", "unavailableReceipts"], "receipt_digest_keys")
    need(type(value["version"]) is int and value["version"] == 1 and value["unavailableReceipts"] == [], "receipt_digest_version")
    bind(value)
    exact_keys(value["receipts"], ["buildReport", "candidates", "builderJournal", "vmCleanup", "templateCleanups", "runtime", "journals"], "receipt_digest_roles")
    need(all(string_match(HEX64, item) for item in value["receipts"].values()), "receipt_digest_values")
    return {"digests": dict(value["receipts"]), "rawRunnerReceiptsDownloaded": False,
            "rawRunnerDigestContentsRecomputed": False}

def emit(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    need(len(encoded.encode("utf-8")) <= 24576, "result_size")
    print("MIKKA_PRIVATE_READONLY_RESULT " + encoded, flush=True)
    print("MIKKA_PRIVATE_READONLY_RESULT_SHA256 " + sha256(encoded.encode("utf-8")), flush=True)

def main():
    global STAGE, GITHUB
    reader_head = local_guard()
    GITHUB = GitHub(os.environ.get("GITHUB_TOKEN"), reader_head)
    STAGE = "api_identity"
    identity = verify_api_identity()
    STAGE = "immutable_sources"
    sources = verify_sources(reader_head)
    STAGE = "archive"
    blob = artifact_zip()
    values, members = read_members(blob)
    STAGE = "source_receipt"
    versions = verify_source(values["source.json"])
    STAGE = "verdict"
    acceptance = verify_verdict(values["verdict.json"])
    STAGE = "receipt_digests"
    receipts = verify_receipt_digests(values["receipt-digests.json"])
    remaining()
    emit({"version": 1, "passed": True, "sourceCommit": PRODUCT, "sourceTree": PRODUCT_TREE,
          "workerSha": WORKER, "opsSource": OPS, "identity": identity, "sources": sources,
          "archive": {"sha256": ZIP_SHA256, "bytes": ZIP_SIZE, "crcAllMembersVerified": True, "members": members},
          "versions": versions, "acceptance": acceptance, "receiptDigests": receipts,
          "readOnly": True, "productionAccountsAccessed": False, "providerResourcesCreated": False})

def on_alarm(_signal, _frame):
    raise Refused("reader_deadline")

if __name__ == "__main__":
    signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, MAX_SECONDS - (time.monotonic() - START)))
    try:
        main()
    except Refused as error:
        emit({"version": 1, "passed": False, "stage": STAGE, "code": error.args[0],
              "readOnly": True, "productionAccountsAccessed": False, "providerResourcesCreated": False})
        sys.exit(1)
    except Exception:
        emit({"version": 1, "passed": False, "stage": STAGE, "code": "reader_internal",
              "readOnly": True, "productionAccountsAccessed": False, "providerResourcesCreated": False})
        sys.exit(1)

    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        GITHUB = None
