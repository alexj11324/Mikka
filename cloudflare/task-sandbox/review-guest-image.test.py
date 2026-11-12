"""Run inside a fresh, offline product image after the real pre-worker boot guards."""
import base64
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

SCRIPTS = Path('/opt/mikka/task-sandbox')
CONTROL = Path('/run/mikka-review-control')
WORKTREE = Path('/workspace/worktrees/review-qualification')

def invoke(script, args, value=None, expect=0):
    proc = subprocess.run([sys.executable, '-I', str(SCRIPTS / script), *args],
                          input=json.dumps(value).encode() if value is not None else b'',
                          capture_output=True, timeout=35)
    if proc.returncode != expect:
        raise AssertionError((script, args[0], proc.returncode, proc.stderr.decode()[:120]))
    return json.loads(proc.stdout) if proc.stdout else None

def main():
    WORKTREE.mkdir(parents=True)
    os.chown(WORKTREE, 1000, 1000)
    run_id, device_id = str(uuid.uuid4()), str(uuid.uuid4())
    scope = {'runId':run_id,'deviceId':device_id,'worktreePath':str(WORKTREE)}
    def checkpoint(action, value=None, expect=0):
        return invoke('review-checkpoint.py', [action, run_id], value, expect)
    def control(action, value, expect=0):
        return invoke('review-control.py', [action], value, expect)
    assert checkpoint('capture') is None
    checkpoint('restore', {**scope, 'worktreePath':'/workspace/worktrees/missing'}, 1)
    checkpoint('restore', scope)
    assert checkpoint('capture') == scope
    checkpoint('restore', scope, 1)
    with (CONTROL / 'machine.lock').open('r+') as active:
        fcntl.flock(active, fcntl.LOCK_EX)
        assert checkpoint('capture') is None
    assert checkpoint('capture') == scope
    key = {'key':base64.b64encode(os.urandom(32)).decode()}
    terminal = control('terminal-prepare', key)
    assert len(terminal['version']) == 64 and uuid.UUID(terminal['boot'])
    assert control('terminal-existing', key) == terminal
    control('terminal-existing', {'key':base64.b64encode(os.urandom(32)).decode()}, 1)
    assert subprocess.run(['setpriv','--reuid=1000','--regid=1000','--clear-groups',
                           'test','-r','/run/mikka-terminal/key']).returncode != 0
    workspace = str(uuid.uuid4())
    closed = control('terminal-revoke', {'leaseIds':[str(uuid.uuid4())], 'runId':run_id,
                                          'workspaceId':workspace,'ownerId':'fixture'})
    assert closed == {'revoked':True}
    binding = {**scope, 'taskId':str(uuid.uuid4()),'workspaceId':workspace,'ownerId':'fixture',
               'repoId':str(uuid.uuid4()),'sandboxId':'a'*64,'epoch':1,'expiresAt':time.time()+45}
    absent = control('preview', {'operation':'prepare','binding':binding})
    assert absent.get('running') is False and absent.get('code') == 'no_loopback_server', absent.get('error')
    print('review guest qualified: retained checkout fence; signed terminal boot and revoke; no resumed development server')

if __name__ == '__main__':
    main()
