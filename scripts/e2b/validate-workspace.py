"""Reject repository Git settings that can execute programs in the worker.

Run before the repository becomes a reusable thread-machine snapshot. Git
includes and global/system configuration are deliberately disabled while
inspecting an untrusted repository; never print its potentially secret config.
"""
import os
import subprocess
import sys
from pathlib import Path

repo = Path('/workspace')
gitdir = repo / '.git'
if gitdir.is_symlink() or not gitdir.is_dir():
    sys.exit('Unsupported repository metadata')
env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
           GIT_CONFIG_SYSTEM='/dev/null', GIT_TERMINAL_PROMPT='0')
try:
    result = subprocess.run(
        ['git', '-C', str(repo), 'config', '--local', '--no-includes', '--null', '--list'],
        env=env, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    names = [entry.split(b'\n', 1)[0].decode('utf-8').lower()
             for entry in result.stdout.split(b'\0') if entry]
except (subprocess.SubprocessError, UnicodeError):
    sys.exit('Unsupported repository configuration')

blocked_exact = {
    'core.hookspath', 'core.fsmonitor', 'core.sshcommand', 'core.gitproxy',
    'core.attributesfile', 'core.worktree', 'diff.external',
    'extensions.worktreeconfig', 'credential.helper',
}
if any(name in blocked_exact or name.startswith(('filter.', 'include.', 'includeif.'))
       or (name.startswith('diff.') and name.endswith('.textconv'))
       or (name.startswith('merge.') and name.endswith('.driver'))
       or (name.startswith('credential.') and name.endswith('.helper'))
       for name in names):
    sys.exit('Repository contains unsupported executable Git configuration')
