"""Trusted runner wrapper. One exclusive display lease surrounds each driver
call; the model never receives this entry point."""
import json
import fcntl
import os
import re
import sys
import time
from pathlib import Path

def acquire(root, display, bot, owner, version, interval=.25):
    if not re.fullmatch(r'(0|[1-9][0-9]{0,9})', version):
        raise ValueError('invalid policy')
    lock = os.open(root / f'{display[1:]}.lock', os.O_RDWR | os.O_NOFOLLOW)
    try:
        os.set_inheritable(lock, True)
        while True:
            # Only one agent may drive a display. Takeover and policy updates
            # use the same lock and wait for an in-flight call to end.
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = json.loads((root / f'{display[1:]}.json').read_text())
            if state.get('botId') != bot or state.get('ownerId') != owner or state.get('display') != int(display[1:]):
                raise ValueError('desktop changed')
            if state.get('computerAllowed') is not True or state.get('policyVersion') != int(version):
                raise ValueError('computer use denied by workspace')
            if not state.get('controlledBy') or state.get('controlUntil', 0) <= time.time():
                return lock
            # Never wait while holding the lock: handback must update it.
            fcntl.flock(lock, fcntl.LOCK_UN)
            time.sleep(interval)
    except BaseException:
        os.close(lock)
        raise

def main():
    if len(sys.argv) != 5:
        raise ValueError('invalid lease')
    display, bot, owner, version = sys.argv[1:]
    if not re.fullmatch(r':[1-9][0-9]{0,2}', display) or os.environ.get('DISPLAY') != display:
        raise ValueError('invalid display')
    acquire(Path('/run/mikka-viewer'), display, bot, owner, version)
    # The parent rechecks cancellation before sending any operation.
    sys.stderr.write('MIKKA_LEASE_READY\n')
    sys.stderr.flush()
    os.execv('/opt/mikka/computer/cua-driver', ['/opt/mikka/computer/cua-driver', 'mcp', '--direct'])

if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('Desktop control unavailable\n')
        sys.exit(1)
