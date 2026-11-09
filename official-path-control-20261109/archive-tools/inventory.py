"""Offline, explicit-allowlist evidence inventory. Never executes archived code.

Default: hash the three local source groups and write an inventory.
--stage: additionally require the root-supplied completed-receipts descriptor,
then copy exact bytes into payload/. This program has no Git or network calls.
"""
import argparse
import hashlib
import json
import stat
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
BASE = HERE.parent
GROUPS = {
    "preparation": BASE / "official-path-control-preparation-1505",
    "bound-v1": BASE / "official-path-control-bound-1505",
    "bound-v2": BASE / "official-path-control-bound-v2-1505",
}
EXCLUDED_PREFIXES = ("upstream/", "source/")
BOUND_PATHS = (
    ".github/workflows/issue1505-official-path-control.yml",
    "scripts/ops/issue1505-official-path-control.py",
    "scripts/ops/issue1505-official-path-control.test.py",
)


def relative(value):
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(x in (".", "..") for x in path.parts):
        raise ValueError("Invalid archive-relative path")
    return path.as_posix()


def read_regular(path):
    path = Path(path)
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("Expected regular source file: " + str(path))
    return path.read_bytes()


def identity(raw):
    return {
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "gitBlob": hashlib.sha1(("blob " + str(len(raw)) + "\0").encode() + raw).hexdigest(),
    }


def record(group, root, path, expected=None):
    path = relative(path)
    source = root / path
    raw = read_regular(source)
    found = identity(raw)
    if expected is not None:
        for key in ("bytes", "sha256"):
            if expected.get(key) != found[key]:
                raise ValueError("Source changed from declared binding: " + str(source))
        declared_oid = expected.get("gitBlob", expected.get("sha"))
        if declared_oid != found["gitBlob"]:
            raise ValueError("Git blob differs from declared binding: " + str(source))
        if "content" in expected and expected["content"].encode("utf-8") != raw:
            raise ValueError("Binding content differs from source: " + str(source))
    return {
        "group": group,
        "source": str(source),
        "archivePath": group + "/" + path,
        "mode": "100755" if source.stat().st_mode & 0o111 else "100644",
        **found,
    }


def local_inventory():
    rows, exclusions = [], []
    root = GROUPS["preparation"]
    manifest = json.loads(read_regular(root / "manifest.json"))
    bindings = json.loads(read_regular(root / "source-bindings.json"))
    rows.append(record("preparation", root, "manifest.json"))
    for item in manifest["files"]:
        row = record("preparation", root, item["path"], item)
        if item["path"].startswith(EXCLUDED_PREFIXES):
            old_path = item["path"]
            source_commit = (
                bindings["upstream"]["control"] if old_path.startswith("upstream/08d822da/")
                else bindings["upstream"]["aptMetadata"] if old_path.startswith("upstream/1e351dcf/")
                else bindings["source"]
            )
            exclusions.append({
                **row,
                "reason": "Duplicate Git-backed upstream/product source; recover by exact Git blob.",
                "sourceCommit": source_commit,
                "repositoryPath": "scripts/e2b/build-template.py" if old_path == "source/scripts/e2b/build-template.py" else None,
            })
        else:
            rows.append(row)
    for group in ("bound-v1", "bound-v2"):
        root = GROUPS[group]
        bindings = json.loads(read_regular(root / "root-bindings.json"))
        declared = {x["path"]: x for x in bindings["files"]}
        if set(declared) != set(BOUND_PATHS):
            raise ValueError("Bound source must contain exactly the actual three paths")
        rows.append(record(group, root, "root-bindings.json"))
        rows.extend(record(group, root, path, declared[path]) for path in BOUND_PATHS)
        if group == "bound-v2":
            rows.extend(record(group, root, "validation/" + name) for name in (
                "execution-result.json", "stdout.txt", "stderr.txt"))
            result = json.loads(read_regular(root / "validation/execution-result.json"))
            for stream in ("stdout", "stderr"):
                actual = identity(read_regular(root / ("validation/" + stream + ".txt")))
                if any(actual[k] != result[stream][k] for k in ("bytes", "sha256")):
                    raise ValueError("Validation stream differs from execution receipt")
    return rows, exclusions


def receipts(path, require_complete):
    data = json.loads(read_regular(path))
    if data.get("ready") is not True:
        if require_complete:
            raise ValueError("Root's complete receipts have not been supplied; staging refused")
        return [], data
    if data.get("rootCompleteReceiptReceived") is not True or not data.get("rootInstructionReference"):
        raise ValueError("Missing root-completed receipt handoff")
    rows = []
    for item in data.get("files", []):
        source = Path(item["source"])
        if not source.is_absolute() or not source.resolve().is_relative_to(BASE):
            raise ValueError("Receipt source is outside the explicit local workspace")
        raw = read_regular(source)
        actual = identity(raw)
        if any(item.get(k) != actual[k] for k in ("bytes", "sha256")):
            raise ValueError("Receipt source differs from supplied hash")
        archive_path = relative(item["archivePath"])
        if not archive_path.startswith(("run-42668993157-attempt-1/", "root-receipts/", "bound-v2-run/")):
            raise ValueError("Receipt archive path is outside the permitted evidence groups")
        rows.append({"group": "root-supplied-receipts", "source": str(source),
                     "archivePath": archive_path, "mode": "100644", **actual})
    if not rows:
        raise ValueError("Completed-receipts descriptor is empty")
    return rows, data


def write_new(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipts", type=Path, default=HERE / "receipts.pending.json")
    parser.add_argument("--output", type=Path, default=HERE / "inventory-current.json")
    parser.add_argument("--stage", action="store_true")
    args = parser.parse_args()
    rows, excluded = local_inventory()
    extra, descriptor = receipts(args.receipts, args.stage)
    rows += extra
    archive_paths = [x["archivePath"] for x in rows]
    if len(archive_paths) != len(set(archive_paths)):
        raise ValueError("Duplicate archive path")
    if args.stage:
        for row in rows:
            raw = read_regular(row["source"])
            if identity(raw) != {key: row[key] for key in ("bytes", "sha256", "gitBlob")}:
                raise ValueError("Source changed after inventory")
            destination = HERE / "payload" / row["archivePath"]
            write_new(destination, raw)
            if read_regular(destination) != raw:
                raise ValueError("Staged byte mismatch")
        for row in rows + excluded:
            if identity(read_regular(row["source"])) != {key: row[key] for key in ("bytes", "sha256", "gitBlob")}:
                raise ValueError("Source changed during staging")
    result = {
        "version": 1,
        "status": "staged-for-root-review" if args.stage else "inventory-only-awaiting-root-receipts",
        "gitObjectsCreated": False,
        "refsUpdated": False,
        "sourceFilesModified": False,
        "testsExecuted": False,
        "expectedEvidenceHeadAtPreparation": "dd873c0515f01d40298dd04806365b265fc7da3c",
        "finalParentMustBeProvidedByRoot": True,
        "rootReceiptsReady": descriptor.get("ready") is True,
        "files": rows,
        "fileCount": len(rows),
        "totalBytes": sum(x["bytes"] for x in rows),
        "excluded": excluded,
        "excludedCount": len(excluded),
        "excludedBytes": sum(x["bytes"] for x in excluded),
        "note": "Original manifests are preserved verbatim; excluded Git source remains reconstructible by the listed blob OIDs. Local GREEN is not a provider-control PASS.",
    }
    write_new(args.output, (json.dumps(result, indent=2, ensure_ascii=False) + "\n").encode())
    print(json.dumps({key: result[key] for key in (
        "status", "fileCount", "totalBytes", "excludedCount", "excludedBytes", "rootReceiptsReady")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
