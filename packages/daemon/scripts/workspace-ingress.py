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
import shutil
import socket
import stat
import subprocess
import sys
import time

VERSION = 1
SOCKET_MARK = 0x4D4B5056
TABLE = 'mikka_review_v1'
CHAIN = 'guard'
LEGACY_CHAIN = 'MIKKA_REVIEW_REPLY_V1'
ROOT = Path('/run/mikka-workspace-ingress')
RECEIPT = ROOT / 'receipt.json'
TOOL_PATH = '/opt/mikka/runtime/netfilter/sbin:/opt/mikka/runtime/netfilter/bin:/usr/sbin:/sbin:/usr/bin:/bin'
MACHINE_FILES = (Path('/home/user/.mikka/bootstrap.json'), Path('/home/user/.mikka/worker/device.json'),
                 Path('/home/user/.mikka/preloaded.pid'))
WORKER = '/opt/mikka/worker/packages/daemon/dist/cloud/cloud-worker.js'
FIELDS = {'version', 'sourceSha256', 'bootId', 'installedTicks', 'providerPorts', 'preparedBeforeWorker'}
FAILURES = frozenset(('listener', 'boot', 'identity', 'state', 'receipt', 'provider', 'command', 'tool',
                      'backend', 'rule_order', 'late_install', 'worker', 'worker_order', 'operation', 'runtime'))
COMMAND_OPERATIONS = frozenset(('new_chain', 'provider_rule', 'reply_rule', 'output_jump', 'check_output',
                                'check_provider', 'check_reply', 'list_output', 'list_chain',
                                'create_table', 'base_chain', 'install_policy', 'list_ruleset', 'list_table'))
INSTALL_OPERATIONS = (('create_table', 'new_chain', 'base_chain') + ('provider_rule',) * 23
                      + ('reply_rule', 'output_jump'))


class IngressError(Exception):
    pass


class IngressCommandError(IngressError):
    """Retain closed observations only, never process arguments or output."""
    def __init__(self, family, operation, failure_kind, returncode=None, stderr=b''):
        if (family not in ('ipv4', 'ipv6', 'inet') or not isinstance(operation, str) or operation not in COMMAND_OPERATIONS
                or failure_kind not in ('exit', 'timeout', 'output_limit', 'execution')):
            raise IngressError('runtime')
        super().__init__('command')
        text = stderr[:16384].lower() if isinstance(stderr, bytes) else b''
        warnings = re.findall(rb'\bextension (owner|multiport|conntrack|mark|tcp) revision ([0-9]{1,3}) not supported\b', text)
        extensions = {name.decode('ascii') for name, _revision in warnings}
        extension = next(iter(extensions)) if len(extensions) == 1 else 'unknown'
        revisions = {int(revision) for _name, revision in warnings}
        revision = next(iter(revisions)) if extension != 'unknown' and len(revisions) == 1 and max(revisions) <= 255 else None
        observed = {(name.decode('ascii'), int(value) if int(value) <= 255 else None) for name, value in warnings}
        unsupported = [{'extension': name, 'revision': value} for name, value in sorted(observed,
                       key=lambda item: (item[0], -1 if item[1] is None else item[1]))[:6]]
        self.diagnostic = {
            'family': family, 'operation': operation, 'failureKind': failure_kind,
            'returnCode': returncode if type(returncode) is int and -255 <= returncode <= 255 else None,
            'extension': extension, 'revision': revision,
            'unsupportedExtensions': unsupported,
            'unsupportedRevision': bool(re.search(rb'revision [0-9]+ not supported', text)),
            'missingKernelModule': b'missing kernel module' in text,
            'missingExtension': b"couldn't load match" in text or b'could not load match' in text,
            'operationNotSupported': b'operation not supported' in text,
            'permissionDenied': b'permission denied' in text or b'operation not permitted' in text,
            'invalidArgument': b'invalid argument' in text,
        }


def failure_detail(error):
    value = str(error) if isinstance(error, IngressError) else 'runtime'
    return value if value in FAILURES else 'runtime'


def failure_receipt(error):
    value = {'ok': False, 'detail': failure_detail(error)}
    if isinstance(error, IngressCommandError):
        value['command'] = error.diagnostic
    return value


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


def execute(program, arguments, *, family, operation, check=True, script=None):
    refuse(family in ('ipv4', 'ipv6', 'inet') and operation in COMMAND_OPERATIONS, 'runtime')
    try:
        source = {'input': script} if script is not None else {'stdin': subprocess.DEVNULL}
        result = subprocess.run([program, *arguments], **source,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=7, check=False)
    except subprocess.TimeoutExpired as error:
        raise IngressCommandError(family, operation, 'timeout', stderr=error.stderr) from error
    except OSError as error:
        raise IngressCommandError(family, operation, 'execution') from error
    if len(result.stdout) > 65536 or len(result.stderr) > 65536:
        raise IngressCommandError(family, operation, 'output_limit', result.returncode, result.stderr)
    if check and result.returncode != 0:
        if family == 'inet' and operation == 'install_policy':
            # Only locations in our fixed 28-line stdin script may refine the
            # operation. No source line, arbitrary path or tool text escapes.
            lines = re.findall(rb'(?m)^(?:/dev/stdin|<stdin>|stdin|-):([1-9][0-9]?):[0-9]{1,6}(?:-[0-9]{1,6})?:[ \t]*Error:',
                               result.stderr[:16384])
            operations = {INSTALL_OPERATIONS[int(line) - 1] for line in lines
                          if 1 <= int(line) <= len(INSTALL_OPERATIONS)}
            if len(operations) == 1:
                operation = next(iter(operations))
        raise IngressCommandError(family, operation, 'exit', result.returncode, result.stderr)
    return result


def program():
    executable = shutil.which('nft', path=TOOL_PATH)
    refuse(executable is not None, 'tool')
    version = subprocess.run([executable, '--version'], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    parsed = re.match(rb'nftables v([0-9]+)\.([0-9]+)\.([0-9]+)(?:[ .(]|$)', version.stdout[:128])
    refuse(version.returncode == 0 and parsed is not None
           and tuple(int(part) for part in parsed.groups()) >= (1, 0, 6), 'backend')
    return executable


def ack_policy(ports, family):
    source_ports = str(ports[0]) if len(ports) == 1 else '{ ' + ', '.join(str(port) for port in ports) + ' }'
    prefix = (f'add rule inet {TABLE} {CHAIN} meta nfproto {family} meta l4proto tcp '
              f'ct direction reply tcp sport {source_ports} tcp flags == ack ')
    for doff in range(5, 16):
        if family == 'ipv4':
            yield (prefix + f'ip frag-off & 0x3fff == 0 ip hdrlength 5 tcp doff {doff} '
                   f'meta length {20 + 4 * doff} ip length {20 + 4 * doff} return')
        else:
            yield (prefix + f'ip6 length {4 * doff} ip6 nexthdr tcp tcp doff {doff} '
                   f'meta length {40 + 4 * doff} return')


def policy(ports):
    refuse(ports in ([49983], [49983, 50005]), 'provider')
    source_ports = str(ports[0]) if len(ports) == 1 else '{ ' + ', '.join(str(port) for port in ports) + ' }'
    # Before accept() attaches a socket file, kernel ACKs have no skuid.
    # Permit only actual provider reply ACKs with zero TCP payload. Each rule
    # proves both skb and IP lengths against one exact TCP header length.
    # IPv4 options/fragments and IPv6 extension headers stay outside this
    # exception. SYN/FIN/RST and data retain the original UID/mark requirements.
    # Separate rules avoid nft's sub-byte concat readback failure.
    # Priority -1 follows conntrack (-200), and still visits later hooks.
    return '\n'.join((
        f'create table inet {TABLE}',
        f'add chain inet {TABLE} {CHAIN}',
        f'add chain inet {TABLE} output {{ type filter hook output priority -1; policy accept; }}',
        f'add rule inet {TABLE} {CHAIN} meta l4proto tcp meta skuid 0 tcp sport {source_ports} return',
        *ack_policy(ports, 'ipv4'),
        *ack_policy(ports, 'ipv6'),
        f'add rule inet {TABLE} {CHAIN} meta l4proto tcp ct direction reply meta mark != {SOCKET_MARK} reject with tcp reset',
        f'add rule inet {TABLE} output oifname != "lo" meta l4proto tcp jump {CHAIN}',
    )) + '\n'


def check_ack_rule(rule, family, ports, doff):
    payload = lambda protocol, field: {'payload': {'protocol': protocol, 'field': field}}
    meta = lambda key: {'meta': {'key': key}}
    match = lambda left, right: {'match': {'op': '==', 'left': left, 'right': right}}
    nfproto = match(meta('nfproto'), 2 if family == 'ipv4' else 10)
    tcp = match(meta('l4proto'), 6)
    expr = [match({'ct': {'key': 'direction'}}, 1),
            match(payload('tcp', 'sport'), ports[0] if len(ports) == 1 else {'set': ports}),
            match(payload('tcp', 'flags'), 16)]
    if family == 'ipv4':
        expr.extend([match({'&': [payload('ip', 'frag-off'), 0x3fff]}, 0),
                     match(payload('ip', 'hdrlength'), 5), match(payload('tcp', 'doff'), doff),
                     match(meta('length'), 20 + 4 * doff), match(payload('ip', 'length'), 20 + 4 * doff)])
    else:
        # nft merges adjacent IPv6 length/nexthdr payload loads and emits them
        # in header order. Emit and require that same exact order.
        expr.extend([match(payload('ip6', 'length'), 4 * doff), match(payload('ip6', 'nexthdr'), 6),
                     match(payload('tcp', 'doff'), doff), match(meta('length'), 40 + 4 * doff)])
    expr.append({'return': None})
    canonical = lambda item: json.dumps(item, sort_keys=True, separators=(',', ':'))
    binding = {'family': 'inet', 'table': TABLE, 'chain': CHAIN}
    # Only protocol dependencies implied by mandatory IP/TCP payload fields may
    # be omitted by nft's delinearizer. No safety predicate is removed or widened.
    variants = [{**binding, 'expr': [*prefix, *expr]}
                for prefix in ([nfproto, tcp], [nfproto], [tcp], [])]
    refuse(canonical(rule) in tuple(map(canonical, variants)), 'rule_order')


def ruleset_rows(raw):
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise IngressError('rule_order') from error
    refuse(isinstance(value, dict) and set(value) == {'nftables'} and isinstance(value['nftables'], list), 'rule_order')
    refuse(all(isinstance(row, dict) and len(row) == 1 and isinstance(next(iter(row.values())), dict)
               for row in value['nftables']), 'rule_order')
    return value['nftables']


def check_absent(executable):
    rows = ruleset_rows(execute(executable, ['-j', '-n', 'list', 'ruleset'],
                               family='inet', operation='list_ruleset').stdout)
    refuse(not any(row.get('table', {}).get('name') == TABLE
                   or row.get('chain', {}).get('name') == LEGACY_CHAIN for row in rows), 'state')


def check_rules(executable, ports):
    refuse(ports in ([49983], [49983, 50005]), 'provider')
    rows = ruleset_rows(execute(executable, ['-j', '-n', 'list', 'table', 'inet', TABLE],
                               family='inet', operation='list_table').stdout)
    objects = {'table': [], 'chain': [], 'rule': [], 'metainfo': []}
    for row in rows:
        kind, value = next(iter(row.items()))
        refuse(kind in objects, 'rule_order')
        value = dict(value)
        if kind != 'metainfo' and 'handle' in value:
            refuse(type(value['handle']) is int and 0 < value['handle'] < 2 ** 64, 'rule_order')
            del value['handle']
        if kind == 'table' and value.get('flags') == []:
            del value['flags']
        objects[kind].append(value)
    refuse(len(objects['metainfo']) == 1, 'rule_order')
    metadata = objects['metainfo'][0]
    refuse(set(metadata) == {'version', 'release_name', 'json_schema_version'}
           and type(metadata['json_schema_version']) is int and metadata['json_schema_version'] == 1
           and isinstance(metadata['version'], str) and isinstance(metadata['release_name'], str), 'rule_order')
    binding = {'family': 'inet', 'table': TABLE}
    chains = [{**binding, 'name': CHAIN},
              {**binding, 'name': 'output', 'type': 'filter', 'hook': 'output', 'prio': -1, 'policy': 'accept'}]
    tcp = {'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 6}}
    provider = [
        {'match': {'op': '==', 'left': {'meta': {'key': 'skuid'}}, 'right': 0}},
        {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'sport'}},
                   'right': ports[0] if len(ports) == 1 else {'set': ports}}},
        {'return': None},
    ]
    reply = [tcp, {'match': {'op': '==', 'left': {'ct': {'key': 'direction'}}, 'right': 1}},
             {'match': {'op': '!=', 'left': {'meta': {'key': 'mark'}}, 'right': SOCKET_MARK}},
             {'reject': {'type': 'tcp reset'}}]
    jump = [{'match': {'op': '!=', 'left': {'meta': {'key': 'oifname'}}, 'right': 'lo'}},
            tcp, {'jump': {'target': CHAIN}}]
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'))
    refuse(canonical(objects['table']) == canonical([{'family': 'inet', 'name': TABLE}])
           and sorted(map(canonical, objects['chain'])) == sorted(map(canonical, chains))
           and len(objects['rule']) == 25, 'rule_order')
    actual = {name: [row for row in objects['rule'] if row.get('chain') == name] for name in (CHAIN, 'output')}
    expected = lambda name, expr: {**binding, 'chain': name, 'expr': expr}
    refuse(len(actual[CHAIN]) == 24, 'rule_order')
    for offset, family in ((1, 'ipv4'), (12, 'ipv6')):
        for index, doff in enumerate(range(5, 16)):
            check_ack_rule(actual[CHAIN][offset + index], family, ports, doff)
    # The root provider exemption and final reply rejection are unchanged.
    reduced = [actual[CHAIN][0], actual[CHAIN][-1]]
    refuse(canonical(reduced) in (canonical([expected(CHAIN, provider), expected(CHAIN, reply)]),
                                 canonical([expected(CHAIN, [tcp, *provider]), expected(CHAIN, reply)]))
           and canonical(actual['output']) == canonical([expected('output', jump)]), 'rule_order')


def verify():
    value = read_receipt()
    check_rules(program(), value['providerPorts'])
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
        executable = program()
        check_absent(executable)
        # One atomic native transaction. Exclusive table creation rejects an
        # unknown/partial installation; never flush, adopt or repair it.
        execute(executable, ['-f', '-'], family='inet', operation='install_policy', script=policy(ports).encode('ascii'))
        check_rules(executable, ports)
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
        receipt = json.dumps(failure_receipt(error))
        print(receipt)
        # Startup suppresses success stdout. Preserve the same closed failure
        # diagnosis in builder logs without raw tool stderr, paths or data.
        print(receipt, file=sys.stderr)
        sys.exit(1)
