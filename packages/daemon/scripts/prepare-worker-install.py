"""Prepare a private worker install without the web application's root importer.

The fetched Git checkout and its lockfile stay intact. pnpm receives the same
workspace settings, package sources and locked package/snapshot records; only
unselected workspace importers and the web root's dependencies are omitted.
"""
import argparse
import hashlib
import json
import os
import posixpath
import re
import shutil
from pathlib import Path

PROJECTS = ("packages/config", "packages/protocol", "packages/daemon")
ROOT_KEYS = ("packageManager", "engines", "pnpm")


def project_lock(raw):
    lines = raw.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if line.rstrip("\r\n") == "importers:"]
    if len(starts) != 1:
        raise ValueError("Expected one lockfile importers section")
    start = starts[0] + 1
    end = next((i for i in range(start, len(lines))
                if lines[i].strip() and not lines[i][0].isspace()
                and not lines[i].startswith("#")), len(lines))
    blocks, name = {}, None
    for line in lines[start:end]:
        match = re.fullmatch(r"  (\S.*?):(?:[ \t]*\{\})?[ \t]*(?:\r?\n)?", line)
        if match:
            name = match.group(1).strip("'\"")
            if name in blocks:
                raise ValueError("Duplicate lockfile importer")
            blocks[name] = []
        if name is not None:
            blocks[name].append(line)
    if any(name not in blocks for name in (".", *PROJECTS)):
        raise ValueError("Missing worker lockfile importer")
    for name in PROJECTS:
        for line in blocks[name]:
            match = re.fullmatch(r"\s+version: ['\"]?link:([^'\"\s]+)['\"]?\s*", line)
            if match and posixpath.normpath(posixpath.join(name, match.group(1))) not in PROJECTS:
                raise ValueError("Worker workspace dependency outside the install closure")
    return "".join(lines[:start]) + "  .: {}\n\n" + "".join(
        "".join(blocks[name]) for name in PROJECTS
    ) + "".join(lines[end:])


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def prepare(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if source == destination or destination.exists():
        raise ValueError("Worker install destination must be new")
    root_raw = (source / "package.json").read_bytes()
    root = json.loads(root_raw)
    lock_raw = (source / "pnpm-lock.yaml").read_bytes()
    projected_lock = project_lock(lock_raw.decode()).encode()
    workspace_raw = (source / "pnpm-workspace.yaml").read_bytes()
    manifest = {"private": True, **{key: root[key] for key in ROOT_KEYS if key in root}}
    destination.mkdir(parents=True)
    (destination / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "pnpm-lock.yaml").write_bytes(projected_lock)
    (destination / "pnpm-workspace.yaml").write_bytes(workspace_raw)
    for name in PROJECTS:
        shutil.copytree(source / name, destination / name, symlinks=True,
                        ignore=shutil.ignore_patterns("node_modules", "__pycache__"))
    if (source / "patches").exists():
        shutil.copytree(source / "patches", destination / "patches", symlinks=True)
    receipt = {
        "version": 1,
        "importers": [".", *PROJECTS],
        "sourcePackageSha256": digest(root_raw),
        "sourceLockSha256": digest(lock_raw),
        "installLockSha256": digest(projected_lock),
        "workspaceSha256": digest(workspace_raw),
    }
    (destination / "worker-install-projection.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def link_modules(source, destination):
    source, destination = source.resolve(), destination.resolve()
    receipt = json.loads((destination / "worker-install-projection.json").read_text())
    if digest((source / "pnpm-lock.yaml").read_bytes()) != receipt["sourceLockSha256"]:
        raise ValueError("Source lockfile changed")
    if digest((destination / "pnpm-lock.yaml").read_bytes()) != receipt["installLockSha256"]:
        raise ValueError("Frozen install lockfile changed")
    paths = [(source / name / "node_modules", destination / name / "node_modules") for name in PROJECTS]
    for target, installed in paths:
        if target.exists() or target.is_symlink() or not installed.is_dir():
            raise ValueError("Worker module link is not a fresh installed directory")
    for target, installed in paths:
        target.symlink_to(os.path.relpath(installed, target.parent), target_is_directory=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--link", action="store_true")
    args = parser.parse_args()
    if args.link:
        link_modules(args.source, args.destination)
    else:
        print(json.dumps(prepare(args.source, args.destination), separators=(",", ":")))


if __name__ == "__main__":
    main()
