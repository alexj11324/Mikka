"""Serialize an agent browser action against human takeover and policy changes."""
import fcntl
import json
import os
import re
import sys
import time
from pathlib import Path

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)

def main():
    if len(sys.argv) != 7:
        raise ValueError('invalid request')
    subagent, request, bot, owner, workspace, version = sys.argv[1:]
    if not all(UUID.fullmatch(value) for value in (subagent, request, bot, workspace)) or not re.fullmatch(r'(0|[1-9][0-9]{0,9})', version) or not owner or len(owner) > 128:
        raise ValueError('invalid request')
    root = Path('/run/mikka-subagent')
    lock = os.open(root / f'{subagent}.lock', os.O_RDWR | os.O_NOFOLLOW)
    os.set_inheritable(lock, True)
    while True:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads((root / f'{subagent}.json').read_text())
        if state.get('subagentId') != subagent or state.get('botId') != bot or state.get('ownerId') != owner or state.get('workspaceId') != workspace:
            raise ValueError('browser changed')
        if state.get('computerAllowed') is not True or state.get('stopRequested') or state.get('policyVersion') != int(version):
            raise ValueError('browser unavailable')
        if not state.get('controlledBy') or state.get('controlUntil', 0) <= time.time():
            break
        fcntl.flock(lock, fcntl.LOCK_UN)
        time.sleep(.25)
    os.execv('/usr/local/bin/node', ['/usr/local/bin/node', '/opt/mikka/computer/subagent-rpc.mjs', subagent, request])

if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('Browser unavailable\n')
        sys.exit(1)
