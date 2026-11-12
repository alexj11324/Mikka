"""Copy a verified idle checkout receipt across a cold restore of the same workspace."""
import contextlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

GATEWAY = Path('/opt/mikka/terminal/gateway.py')
CONTROL = Path('/run/mikka-review-control')
WORKTREES = Path('/workspace/worktrees')
UUID = re.compile(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}')

def gateway():
    spec = importlib.util.spec_from_file_location('task_terminal_gateway', GATEWAY)
    target = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(target)
    return target

def validate(scope, run_id, root):
    if not isinstance(scope, dict) or scope.get('runId') != run_id or not UUID.fullmatch(run_id):
        raise ValueError('invalid run')
    device_id = scope.get('deviceId')
    if not isinstance(device_id, str) or not UUID.fullmatch(device_id):
        raise ValueError('invalid device')
    raw = scope.get('worktreePath')
    if not isinstance(raw, str) or not 1 <= len(raw) <= 4096 or any(ord(c) < 32 for c in raw):
        raise ValueError('invalid worktree')
    path = Path(raw)
    if not path.is_relative_to(root) or path == root or path.resolve(strict=True) != path or str(path) != raw:
        raise ValueError('invalid worktree')
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 1000:
        raise ValueError('invalid worktree')
    return {'runId': run_id, 'deviceId': device_id, 'worktreePath': raw}

def capture(runtime, run_id, root, control):
    try:
        fd = os.open(control, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
        try:
            data = runtime.fixed_file(fd, 'machine.json', os.O_RDONLY)
            try:
                scope = validate(json.loads(os.read(data, 16384)), run_id, root)
            finally:
                os.close(data)
        finally:
            os.close(fd)
        # An active native writer or a mismatched checkout cannot pass the original lock.
        os.close(runtime.execution_fence(scope, control))
        return scope
    except (OSError, ValueError, TypeError, runtime.Refusal):
        return None

def restore(runtime, run_id, root, control):
    proof = validate(json.loads(sys.stdin.buffer.read(8193)), run_id, root)
    directory = os.open(control, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
    try:
        info = os.fstat(directory)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('invalid control directory')
        with contextlib.ExitStack() as held:
            lock = runtime.fixed_file(directory, 'machine.lock', os.O_RDWR)
            held.callback(os.close, lock)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            data = runtime.fixed_file(directory, 'machine.json', os.O_RDWR)
            held.callback(os.close, data)
            if os.fstat(data).st_size != 0:
                raise ValueError('unexpected control state')
            receipt = {'version': 1, 'phase': 'idle', 'nativeExited': True, **proof}
            os.write(data, json.dumps(receipt, separators=(',', ':')).encode())
            os.fsync(data)
        os.close(runtime.execution_fence(proof, control))
    finally:
        os.close(directory)

if __name__ == '__main__':
    try:
        if os.geteuid() or len(sys.argv) != 3:
            raise ValueError('invalid input')
        action, run_id = sys.argv[1:]
        impl = gateway()
        if action == 'capture':
            print(json.dumps(capture(impl, run_id, WORKTREES, CONTROL), separators=(',', ':')))
        elif action == 'restore':
            restore(impl, run_id, WORKTREES, CONTROL)
        else:
            raise ValueError('invalid operation')
    except Exception:
        raise SystemExit('review_checkpoint_unavailable') from None
