"""Trusted runner wrapper. flock holds the shared display lock around this
process and its exec'd driver; the model never receives this entry point."""
import json
import os
import re
import sys
import time
from pathlib import Path

def main():
    if len(sys.argv) != 5:
        raise ValueError('invalid lease')
    display, bot, owner, version = sys.argv[1:]
    if not re.fullmatch(r':[1-9][0-9]{0,2}', display) or os.environ.get('DISPLAY') != display:
        raise ValueError('invalid display')
    state = json.loads((Path('/run/mikka-viewer') / f'{display[1:]}.json').read_text())
    if state.get('botId') != bot or state.get('ownerId') != owner or state.get('display') != int(display[1:]):
        raise ValueError('desktop changed')
    if state.get('computerAllowed') is not True:
        raise ValueError('computer use denied by workspace')
    if not re.fullmatch(r'(0|[1-9][0-9]{0,9})', version) or state.get('policyVersion') != int(version):
        raise ValueError('workspace policy changed')
    if state.get('controlledBy') and state.get('controlUntil', 0) > time.time():
        raise ValueError('desktop is controlled by a person')
    os.execv('/opt/mikka/computer/cua-driver', ['/opt/mikka/computer/cua-driver', 'mcp', '--direct'])

try:
    main()
except Exception:
    sys.stderr.write('Desktop control unavailable\n')
    sys.exit(1)
