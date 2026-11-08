#!/usr/bin/env python3
"""Create the fixed, non-replaceable execution fence on an authorized task VM.

Only the additive root installer calls this. The user daemon may flock/write
the two fixed inodes, but neither the shell nor daemon can replace their names.
The version marker is root-only and never contains task identity or secrets.
"""
import os
import pwd
import stat
from pathlib import Path


def install(root=Path('/run/mikka-review-control'), account=None):
    if os.geteuid() != 0:
        raise RuntimeError('terminal_control_install_refused')
    account = account or pwd.getpwnam('user')
    try:
        root.mkdir(mode=0o710)
    except FileExistsError:
        pass
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('terminal_control_install_refused')
        os.fchown(descriptor, 0, account.pw_gid)
        os.fchmod(descriptor, 0o710)
        for name in ('machine.lock', 'machine.json'):
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o660, dir_fd=descriptor)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
                    raise RuntimeError('terminal_control_install_refused')
                os.fchown(fd, 0, account.pw_gid)
                os.fchmod(fd, 0o660)
            finally:
                os.close(fd)
        fd = os.open('version', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o440, dir_fd=descriptor)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
                raise RuntimeError('terminal_control_install_refused')
            os.fchown(fd, 0, account.pw_gid)
            os.fchmod(fd, 0o440)
            os.ftruncate(fd, 0)
            os.write(fd, b'1\n')
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    try:
        install()
    except Exception:
        raise SystemExit('terminal_control_install_refused') from None
