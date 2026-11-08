"""Default-private task ingress, installed before the first Mikka worker.

The owner and their full-access task share the VM. This is not a boundary
against guest root: it prevents an ordinary dev listener from becoming public
through E2B's automatic port forwarding. Official files and sudo stay intact.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import time

VERSION = 1
SOCKET_MARK = 0x4D4B5056
CHAIN = 'MIKKA_REVIEW_REPLY_V1'
ROOT = Path('/run/mikka-workspace-ingress')
RECEIPT = ROOT / 'receipt.json'
TOOL_PATH = '/opt/mikka/runtime/netfilter/sbin:/opt/mikka/runtime/netfilter/bin:/usr/sbin:/sbin:/usr/bin:/bin'
MACHINE_FILES = (Path('/home/user/.mikka/bootstrap.json'), Path('/home/user/.mikka/worker/device.json'),
                 Path('/home/user/.mikka/preloaded.pid'))
WORKER = '/opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js'
FIELDS = {'version', 'sourceSha256', 'bootId', 'installedTicks', 'providerPorts', 'preparedBeforeWorker'}
FAILURES = frozenset(('listener', 'boot', 'identity', 'state', 'receipt', 'provider', 'command', 'tool',
                      'backend', 'rule_order', 'late_install', 'worker', 'worker_order', 'operation', 'runtime'))


class IngressError(Exception):
    pass


def failure_detail(error):
    value = str(error) if isinstance(error, IngressError) else 'runtime'
    return value if value in FAILURES else 'runtime'


def refuse(condition, reason):
    if not condition:
        raise IngressError(reason)


def marked_listener(port=0, host='0.0.0.0'):
    """Authenticated infrastructure listeners opt in before accepting a SYN."""
    refuse(os.geteuid() == 0 and type(port) is int and 0 <= port <= 65535
           and host in ('0.0.0.0', '127.0.0.1', '::', '::1'), 'listener')
    listener = socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, SOCKET_MARK)
        if listener.family == socket.AF_INET6:
            listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        listener.bind((host, port))
        listener.listen(128)
        listener.setblocking(False)
        return listener
    except BaseException:
        listener.close()
        raise


def boot_id():
    value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    refuse(re.fullmatch(r'[a-f0-9-]{36}', value), 'boot')
    return value


def ticks():
    return int(time.clock_gettime(time.CLOCK_BOOTTIME) * os.sysconf('SC_CLK_TCK'))


def source_hash():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def private_directory(create=False):
    refuse(os.geteuid() == 0, 'identity')
    if create:
        try:
            ROOT.mkdir(mode=0o700)
        except FileExistsError:
            pass
    info = ROOT.lstat()
    refuse(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'state')


def read_receipt():
    private_directory()
    fd = os.open(RECEIPT, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        refuse(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
               and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= 4096, 'receipt')
        value = json.loads(os.read(fd, 4097))
    finally:
        os.close(fd)
    refuse(isinstance(value, dict) and set(value) == FIELDS and type(value['version']) is int and value['version'] == VERSION
           and value['sourceSha256'] == source_hash() and value['bootId'] == boot_id()
           and type(value['installedTicks']) is int and 0 <= value['installedTicks'] <= ticks()
           and value['providerPorts'] in ([49983], [49983, 50005])
           and value['preparedBeforeWorker'] is True, 'receipt')
    return value


def provider_ports():
    owners = {49983: set(), 50005: set()}
    for name in ('tcp', 'tcp6'):
        for row in Path('/proc/net/' + name).read_text().splitlines()[1:]:
            fields = row.split()
            if len(fields) >= 10 and fields[3] == '0A':
                port = int(fields[1].split(':')[1], 16)
                if port in owners:
                    owners[port].add(int(fields[7]))
    # envd is required. An absent optional MCP service never grants a public
    # port exception. A provider using the task UID needs separate evidence.
    refuse(owners[49983] == {0} and owners[50005] in (set(), {0}), 'provider')
    return [port for port, uids in owners.items() if uids == {0}]


def execute(program, arguments, *, check=True):
    result = subprocess.run([program, '--wait', '5', *arguments], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=7, check=False)
    refuse(len(result.stdout) <= 65536 and len(result.stderr) <= 65536, 'command')
    if check:
        refuse(result.returncode == 0, 'command')
    return result


def programs():
    result = []
    for name in ('iptables', 'ip6tables'):
        program = shutil.which(name, path=TOOL_PATH)
        refuse(program is not None, 'tool')
        version = subprocess.run([program, '--version'], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
        refuse(version.returncode == 0 and b'(nf_tables)' in version.stdout, 'backend')
        result.append(program)
    return result


def policy(ports):
    refuse(ports in ([49983], [49983, 50005]), 'provider')
    # The provider exception includes UID 0, so an ordinary task process cannot
    # inherit an exception if the original provider listener goes away.
    provider = ['-p', 'tcp', '-m', 'owner', '--uid-owner', '0', '-m', 'multiport',
                '--sports', ','.join(str(port) for port in ports), '-j', 'RETURN']
    blocked = ['-p', 'tcp', '-m', 'conntrack', '--ctdir', 'REPLY', '-m', 'mark', '!', '--mark', str(SOCKET_MARK),
               '-j', 'REJECT', '--reject-with', 'tcp-reset']
    jump = ['!', '-o', 'lo', '-p', 'tcp', '-j', CHAIN]
    return provider, blocked, jump


def check_rules(program, ports):
    provider, blocked, jump = policy(ports)
    execute(program, ['--check', 'OUTPUT', *jump])
    execute(program, ['--check', CHAIN, *provider])
    execute(program, ['--check', CHAIN, *blocked])
    output = [shlex.split(line) for line in execute(program, ['--list-rules', 'OUTPUT']).stdout.decode('ascii').splitlines()]
    output = [row for row in output if row[:2] == ['-A', 'OUTPUT']]
    refuse(output and output[0] == ['-A', 'OUTPUT', *jump], 'rule_order')
    rules = [shlex.split(line) for line in execute(program, ['--list-rules', CHAIN]).stdout.decode('ascii').splitlines()]
    rules = [row for row in rules if row[:2] == ['-A', CHAIN]]
    # -C above verifies each complete rule. Count/order reject an inserted
    # broad ACCEPT or another rule before the guarded reply decision.
    refuse(len(rules) == 2 and all('-j' in row for row in rules)
           and [row[row.index('-j') + 1] for row in rules] == ['RETURN', 'REJECT'], 'rule_order')


def verify():
    value = read_receipt()
    for program in programs():
        check_rules(program, value['providerPorts'])
    return {**value, 'rulesVerified': {'ipv4': True, 'ipv6': True}}


def prepare():
    private_directory(create=True)
    lock = os.open(ROOT / 'prepare.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        refuse(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
               and stat.S_IMODE(info.st_mode) == 0o600, 'state')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if RECEIPT.exists() or RECEIPT.is_symlink():
            # Idempotence only re-verifies the original proof. Never repair
            # rules after a worker started or manufacture a newer timestamp.
            return verify()
        refuse(not any(path.exists() or path.is_symlink() for path in MACHINE_FILES), 'late_install')
        ports = provider_ports()
        executables = programs()
        provider, blocked, jump = policy(ports)
        for program in executables:
            # Unknown/partial installations fail closed. Do not flush or adopt
            # a pre-existing chain without its original root-owned receipt.
            execute(program, ['--new-chain', CHAIN])
            execute(program, ['--append', CHAIN, *provider])
            execute(program, ['--append', CHAIN, *blocked])
            execute(program, ['--insert', 'OUTPUT', '1', *jump])
            check_rules(program, ports)
        value = {'version': VERSION, 'sourceSha256': source_hash(), 'bootId': boot_id(),
                 'installedTicks': ticks(), 'providerPorts': ports, 'preparedBeforeWorker': True}
        temporary = ROOT / 'receipt.next'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(json.dumps(value, separators=(',', ':')) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.rename(temporary, RECEIPT)
        return verify()
    finally:
        os.close(lock)


def ready(pid):
    refuse(type(pid) is int and 1 < pid < 2 ** 31, 'worker')
    value = verify()
    process = Path('/proc') / str(pid)
    refuse(process.stat().st_uid == pwd.getpwnam('user').pw_uid, 'worker')
    command = (process / 'cmdline').read_bytes().split(b'\0')
    refuse(WORKER.encode() in command and b'--wait-bootstrap' in command, 'worker')
    raw = (process / 'stat').read_text()
    start = int(raw[raw.rfind(')') + 2:].split()[19])
    refuse(start >= value['installedTicks'], 'worker_order')
    return {**value, 'workerPid': pid, 'workerStartTicks': start, 'workerStartedAfterGuard': True}


def main(args):
    if args == ['prepare']:
        value = prepare()
    elif args == ['verify']:
        value = verify()
    elif len(args) == 2 and args[0] == 'ready' and args[1].isdigit():
        value = ready(int(args[1]))
    else:
        raise IngressError('operation')
    print(json.dumps({'ok': True, **value}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        # Kernel/tool errors can include arbitrary rule comments. Expose only
        # a closed diagnosis, never raw stderr, command output or credentials.
        receipt = json.dumps({'ok': False, 'detail': failure_detail(error)})
        print(receipt)
        # Startup suppresses success stdout. Preserve the same closed failure
        # diagnosis in builder logs without raw tool stderr, paths or data.
        print(receipt, file=sys.stderr)
        sys.exit(1)
