"""Extract an owner-scoped workspace archive into a fresh staging sandbox.

The archive can contain untrusted repository files. Python's data filter
rejects paths, links and special files that escape the destination. The
extractor runs as the unprivileged runner, not root.
"""
import re
import sys
import tarfile
from pathlib import Path

if len(sys.argv) == 1:
    source = '/tmp/mikka-workspace.tar'
    destination = '/workspace'
elif len(sys.argv) == 2 and re.fullmatch(r'[0-9a-fA-F-]{36}', sys.argv[1]):
    source = '/tmp/mikka-worktree.tar'
    destination = f'/home/mikka-runner/.mikka/worker/worktrees/{sys.argv[1]}'
    Path(destination).mkdir(parents=True, exist_ok=False, mode=0o700)
else:
    raise ValueError('Invalid extraction target')

with tarfile.open(source, 'r') as archive:
    archive.extractall(destination, filter='data')
