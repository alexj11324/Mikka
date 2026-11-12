"""Move only the native CLIs' conversation files at a writer-free checkpoint."""
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path

RUN = re.compile(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}")
PATHS = (("codex-home", "sessions"), ("codex-home", "archived_sessions"),
         ("native-home", ".claude", "projects"))
NATIVE = Path("/home/node/.mikka/worker/adapters/runs")
STORED = Path("/workspace/.mikka-native-history")

def own_directory(path, create=False):
    if path == Path("/"):
        return True
    if not own_directory(path.parent, create):
        return False
    try:
        entry = path.lstat()
    except FileNotFoundError:
        if not create:
            return False
        path.mkdir(mode=0o700)
        entry = path.lstat()
    if not stat.S_ISDIR(entry.st_mode):
        raise ValueError("Unexpected native session directory")
    return True

def copy_transcripts(source, target):
    if not own_directory(source):
        return
    for folder, _, files in os.walk(source, followlinks=False):
        relative = Path(folder).relative_to(source)
        for name in files:
            transcript = (name.startswith("rollout-") or name.startswith("agent-") or RUN.fullmatch(name[:-6]))
            if not name.endswith(".jsonl") or not transcript:
                continue
            src = Path(folder) / name
            entry = src.lstat()
            if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1:
                continue
            dest = target / relative
            own_directory(dest, True)
            # Replace with fresh regular bytes, even if an old checkpoint
            # planted a link. Never open a task-selected output for overwrite.
            fd, tmp = tempfile.mkstemp(dir=dest)
            try:
                with os.fdopen(fd, "wb") as out, os.fdopen(os.open(src, os.O_NOFOLLOW), "rb") as inp:
                    shutil.copyfileobj(inp, out, 256 * 1024)
                os.replace(tmp, dest / name)
            finally:
                if os.path.lexists(tmp):
                    os.unlink(tmp)

def transfer(source, target):
    if own_directory(source):
        for run in source.iterdir():
            if not RUN.fullmatch(run.name):
                continue
            for parts in PATHS:
                copy_transcripts(run.joinpath(*parts), target.joinpath(run.name, *parts))

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("save", "restore") or os.getuid() != 1000:
        raise SystemExit("Invalid native session transfer")
    source, target = (NATIVE, STORED) if sys.argv[1] == "save" else (STORED, NATIVE)
    transfer(source, target)
