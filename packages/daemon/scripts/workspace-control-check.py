#!/usr/bin/env python3
"""Readiness check: the execution user can take the fixed execution fence.

Runs as the daemon's user, with the same checks the daemon's fence holder
(packages/daemon/src/runs/workspace-control.ts) makes before it reports ready:
the root-owned, non-writable directory held by O_PATH, its root-only version
marker, and the two fixed inodes. It takes the lock without blocking and lets
it go at once; it writes nothing. A template that fails this never becomes a
candidate, instead of failing its first run.
"""
import fcntl
import os
import stat
import sys


def check(root='/run/mikka-review-control'):
    directory = os.open(root, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('terminal_control_check_failed directory')
        version = os.open('version', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            info = os.fstat(version)
            if info.st_uid != 0 or info.st_mode & 0o022 or os.read(version, 16) != b'1\n':
                raise SystemExit('terminal_control_check_failed version')
        finally:
            os.close(version)
        lock = os.open('machine.lock', os.O_RDWR | os.O_NOFOLLOW, dir_fd=directory)
        receipt = os.open('machine.json', os.O_RDWR | os.O_NOFOLLOW, dir_fd=directory)
        try:
            for fd in (lock, receipt):
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
                    raise SystemExit('terminal_control_check_failed inode')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock, fcntl.LOCK_UN)
        finally:
            os.close(receipt)
            os.close(lock)
    finally:
        os.close(directory)


if __name__ == '__main__':
    try:
        check(*sys.argv[1:2])
    except SystemExit:
        raise
    except Exception as error:
        raise SystemExit('terminal_control_check_failed ' + type(error).__name__) from None
    print('terminal-control-ready')
