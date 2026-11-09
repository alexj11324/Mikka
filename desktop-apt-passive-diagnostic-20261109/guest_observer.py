"""Unactivated, bounded notification-only observer; no host workflow is supplied.

UAPI: Linux v6.6 ffc253263a1375a65fa6c9f62a893e9767fbebfa.
Runtime functions are intentionally not exercised by the offline parser tests.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

BOUND_CONTEXT = None  # Review-only: no time, instance or operator binding exists.
SOURCE = '5ba1f9e2359ce714d83cd16fc040f2567c40a6d0'
OUTPUT_ROOT = Path('/opt/mikka/issue1505-apt-observer')
WATCH = '/var/backups'
TARGET = b'apt.extended_states.0'
STAGING = b'apt.extended_states'
NODES = ('/var/lib/apt/extended_states', '/var/backups/apt.extended_states.0')
SOURCES = ('/usr/lib/apt/apt.systemd.daily', '/etc/cron.daily/apt-compat')
UNITS = ('apt-daily.service', 'apt-daily-upgrade.service', 'apt-daily.timer', 'apt-daily-upgrade.timer')
SERVICE_FIELDS = ('ActiveState', 'SubState', 'MainPID', 'ExecMainStartTimestamp',
                  'ExecMainExitTimestamp', 'InvocationID', 'Result')
PHASES = ('before_capture', 'after_capture', 'after_bootstrap', 'after_npm',
          'before_strict', 'after_strict', 'ready', 'fresh', 'terminal')
MODIFY, CLOSE_WRITE, MOVED_TO, OVERFLOW = 0x2, 0x8, 0x80, 0x4000
ON_CHILD, RENAME, ON_DIR = 0x08000000, 0x10000000, 0x40000000
MASK = MODIFY | CLOSE_WRITE | MOVED_TO | RENAME | ON_CHILD
INIT_FLAGS = 0x1 | 0x2 | 0x80 | 0x200 | 0x400 | 0x800 | 0x1000
MARK_FLAGS = 0x1 | 0x8  # ADD | ONLYDIR; never mount/filesystem/permission marks.
META, INFO = struct.Struct('=IBBHQii'), struct.Struct('=BBH')
MAX_BUFFER, MAX_EVENTS, MAX_INFOS = 65536, 512, 16
MAX_HANDLE, MAX_NAME, MAX_FILE = 128, 255, 2 * 1024 * 1024
MAX_RECORD, MAX_OUTPUT, TERMINAL_RESERVE = 32768, 1024 * 1024, 32768
MAX_RECORDED_EVENTS, MAX_SECONDS = 256, 600
KNOWN_EXES = {f'{prefix}/{name}' for prefix in ('/bin', '/usr/bin', '/sbin', '/usr/sbin')
              for name in ('cp', 'mv', 'dash', 'bash', 'apt', 'apt-get', 'dpkg', 'cron', 'anacron')}
KNOWN_EXES.add('/usr/lib/systemd/systemd')


class ParseError(ValueError):
    def __init__(self, code, fds=()):
        super().__init__(code)
        self.code, self.fds = code, tuple(sorted(set(fd for fd in fds if fd >= 0)))


def parse_events(raw):
    """Parse one kernel read without using any embedded FD or path.

    FD ownership is returned to the caller, including on malformed input. The
    runtime terminates its segment on a parse error; it never resynchronizes by
    guessing offsets or treats unknown records as positive evidence.
    """
    fds, events, offset = set(), [], 0
    def bad(code):
        raise ParseError(code, fds)
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_BUFFER:
        bad('buffer_size_invalid')
    while offset < len(raw):
        if len(events) >= MAX_EVENTS or len(raw) - offset < META.size:
            bad('event_count_or_header_invalid')
        length, version, reserved, metadata_len, mask, fd, pid = META.unpack_from(raw, offset)
        if fd >= 0:
            fds.add(fd)
        if version != 3 or reserved or metadata_len != META.size:
            bad('metadata_version_or_length_invalid')
        if length < metadata_len or length > MAX_BUFFER or offset + length > len(raw) or fd < -1:
            bad('event_length_or_fd_invalid')
        end, pos, records, seen, pidfd = offset + length, offset + metadata_len, [], set(), None
        while pos < end:
            if len(seen) >= MAX_INFOS or end - pos < INFO.size:
                bad('info_header_invalid')
            kind, pad, size = INFO.unpack_from(raw, pos)
            if pad or size < INFO.size or pos + size > end:
                bad('info_length_invalid')
            payload = raw[pos + INFO.size:pos + size]
            if kind == 4 and len(payload) >= 4:
                value = struct.unpack_from('=i', payload)[0]
                if value >= 0:
                    fds.add(value)
            if kind in seen:
                bad('duplicate_info_record')
            seen.add(kind)
            if kind == 4:
                if len(payload) != 4 or value < -2:
                    bad('pidfd_record_invalid')
                pidfd = value
            elif kind in (1, 2, 3, 10, 12):
                if len(payload) < 16:
                    bad('fid_record_short')
                count, handle_type = struct.unpack_from('=Ii', payload, 8)
                if not 1 <= count <= MAX_HANDLE or 16 + count > len(payload):
                    bad('file_handle_length_invalid')
                handle, tail = payload[16:16 + count], payload[16 + count:]
                name = None
                if kind in (2, 10, 12):
                    nul = tail.find(b'\0')
                    if not 0 < nul <= MAX_NAME or any(tail[nul + 1:]) or len(tail) - nul - 1 > 3:
                        bad('name_termination_invalid')
                    name = tail[:nul]
                    if b'/' in name:
                        bad('name_not_basename')
                elif any(tail) or len(tail) > 3:
                    bad('fid_padding_invalid')
                records.append({'type': kind, 'key': (payload[:8], handle_type, handle), 'name': name})
            else:
                bad('unknown_info_record')
            pos += size
        events.append({'mask': mask, 'pid': pid, 'fd': fd, 'pidfd': pidfd, 'records': records})
        offset = end
    return events, tuple(sorted(fds))


def release_fds(fds, close=os.close):
    for fd in sorted(set(fd for fd in fds if type(fd) is int and fd >= 0)):
        try:
            close(fd)
        except OSError:
            pass


def object_id(key):
    fsid, kind, handle = key
    return hashlib.sha256(fsid + struct.pack('=i', kind) + handle).hexdigest()


def project_event(event, watched_key):
    # An overflow has no filename. Never filter it out as an unrelated event.
    mask = event['mask']
    if mask & OVERFLOW:
        return {'type': 'gap', 'reason': 'queue_overflow'}
    if mask & ~(MASK | OVERFLOW | ON_DIR):
        return {'type': 'gap', 'reason': 'unsupported_event_mask'}
    named = [r for r in event['records'] if r['type'] in (2, 10, 12)]
    if not any(r['key'] == watched_key and r['name'] == TARGET for r in named):
        return None
    labels = [name for bit, name in ((MODIFY, 'modify'), (CLOSE_WRITE, 'close_write'),
                                     (MOVED_TO, 'moved_to'), (RENAME, 'rename')) if mask & bit]
    if not labels:
        return {'type': 'gap', 'reason': 'target_event_without_supported_operation'}
    entries = [{'role': {2: 'entry', 10: 'old', 12: 'new'}[r['type']],
                'watchedDirectory': r['key'] == watched_key,
                'nameClass': 'target' if r['name'] == TARGET else 'staging' if r['name'] == STAGING else 'other'}
               for r in named]
    target = next((r for r in event['records'] if r['type'] == 1), None)
    return {'type': 'event', 'operations': labels, 'entries': entries,
            'targetObjectId': object_id(target['key']) if target else None,
            'directoryObjectId': object_id(watched_key),
            'actorRole': 'directory_entry_actor_at_read' if mask & (RENAME | MOVED_TO) else 'content_event_actor_at_read',
            'initialDataWriter': 'unknown', 'pathSnapshotRelation': 'later_path_read_not_bound_to_event_object',
            'reportedPid': event['pid']}


def read_bounded(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        out = bytearray()
        while len(out) <= limit:
            part = os.read(fd, min(4096, limit + 1 - len(out)))
            if not part:
                return bytes(out)
            out.extend(part)
        raise ValueError('read_limit')
    finally:
        os.close(fd)


def boot_id():
    value = read_bounded('/proc/sys/kernel/random/boot_id', 64).decode('ascii').strip()
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value):
        raise ValueError('boot_id_invalid')
    return value


class ProcAccess:
    def alive(self, fd):
        poll = select.poll()
        poll.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
        return not poll.poll(0)

    def pid(self, fd):
        raw = read_bounded(f'/proc/self/fdinfo/{fd}', 4096).decode('ascii')
        values = [line.split(':', 1)[1].strip() for line in raw.splitlines() if line.startswith('Pid:')]
        if len(values) != 1 or not re.fullmatch(r'-?[0-9]+', values[0]):
            raise ValueError('pidfd_identity_invalid')
        return int(values[0])

    def start(self, pid):
        raw = read_bounded(f'/proc/{pid}/stat', 8192)
        split = raw.rfind(b') ')
        if split < 0 or int(raw.split(b' ', 1)[0]) != pid:
            raise ValueError('proc_stat_invalid')
        fields = raw[split + 2:].split()
        if len(fields) < 20 or not fields[19].isdigit() or int(fields[19]) <= 0:
            raise ValueError('proc_start_invalid')
        return int(fields[19])

    def exe(self, pid):
        # O_PATH obtains an object reference; no executable bytes are exported or read.
        fd = os.open(f'/proc/{pid}/exe', os.O_PATH | os.O_CLOEXEC)
        try:
            info = os.fstat(fd)
            value = os.readlink(f'/proc/self/fd/{fd}')
            raw = value.encode('utf-8', 'strict')
            if not stat.S_ISREG(info.st_mode) or not value.startswith('/') or len(raw) > 1024 or any(ord(c) < 32 for c in value):
                raise ValueError('exe_metadata_invalid')
            return {'knownPath': value if value in KNOWN_EXES else None,
                    'pathSha256': hashlib.sha256(raw).hexdigest(), 'pathBytes': len(raw),
                    'device': info.st_dev, 'inode': info.st_ino, 'size': info.st_size}
        finally:
            os.close(fd)


def identify_actor(event, access=None):
    access = access or ProcAccess()
    pid, fd = event['pid'], event['pidfd']
    def unknown(reason):
        return {'status': 'unknown', 'reason': reason, 'exeAtRead': None}
    if pid <= 0 or fd is None or fd < 0:
        return unknown('pid_or_pidfd_unavailable')
    try:
        if not access.alive(fd):
            return unknown('process_exited_before_read')
        if access.pid(fd) != pid:
            return unknown('pidfd_pid_mismatch')
        before = access.start(pid)
        exe = access.exe(pid)
        after = access.start(pid)
        if before != after or not access.alive(fd) or access.pid(fd) != pid:
            return unknown('process_changed_or_exited_during_read')
        return {'status': 'stable_process_at_read', 'pid': pid, 'startTicks': before,
                'exeAtRead': exe, 'exeAtEvent': 'unknown'}
    except (OSError, ValueError, UnicodeError):
        return unknown('process_metadata_unavailable')


def identity(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def node(path, deadline):
    result = {'path': path}
    fd = None
    try:
        before = os.lstat(path)
        result.update(kind='file' if stat.S_ISREG(before.st_mode) else 'link' if stat.S_ISLNK(before.st_mode)
                      else 'directory' if stat.S_ISDIR(before.st_mode) else 'special',
                      mode=stat.S_IMODE(before.st_mode), uid=before.st_uid, gid=before.st_gid,
                      device=before.st_dev, inode=before.st_ino, size=before.st_size,
                      mtimeNs=before.st_mtime_ns, ctimeNs=before.st_ctime_ns)
        if not stat.S_ISREG(before.st_mode):
            return {**result, 'status': 'unexpected_kind'}
        if before.st_size > MAX_FILE:
            return {**result, 'status': 'too_large'}
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        if identity(os.fstat(fd)) != identity(before):
            return {**result, 'status': 'changed_during_read'}
        h, count = hashlib.sha256(), 0
        while True:
            if time.monotonic() >= deadline:
                return {**result, 'status': 'read_deadline'}
            part = os.read(fd, min(32768, MAX_FILE + 1 - count))
            if not part:
                break
            count += len(part)
            if count > MAX_FILE:
                return {**result, 'status': 'too_large'}
            h.update(part)
        if identity(os.fstat(fd)) != identity(before) or identity(os.lstat(path)) != identity(before):
            return {**result, 'status': 'changed_during_read'}
        return {**result, 'status': 'present', 'sha256': h.hexdigest()}
    except FileNotFoundError:
        return {**result, 'status': 'absent'}
    except OSError as error:
        return {**result, 'status': 'unavailable', 'errno': error.errno}
    finally:
        if fd is not None:
            os.close(fd)


def unit_snapshot(unit, deadline):
    fields = SERVICE_FIELDS if unit.endswith('.service') else ('LastTriggerUSec',)
    assert unit in UNITS
    command = ['/usr/bin/systemctl', 'show', unit, '--no-pager', *[f'--property={name}' for name in fields]]
    process, raw = None, bytearray()
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}, close_fds=True)
        until = min(deadline, time.monotonic() + 0.25)
        while time.monotonic() < until:
            if not select.select([process.stdout], [], [], max(0, until - time.monotonic()))[0]:
                break
            part = os.read(process.stdout.fileno(), 1024)
            if not part:
                process.wait(timeout=max(0.001, until - time.monotonic()))
                if process.returncode != 0:
                    break
                values = {}
                for line in raw.decode('ascii').splitlines():
                    key, sep, value = line.partition('=')
                    if not sep or key not in fields or key in values or len(value) > 128 or not re.fullmatch(r'[A-Za-z0-9_ .:+/()-]*', value):
                        raise ValueError('unit_values_invalid')
                    if key == 'MainPID' and not value.isdigit() or key == 'InvocationID' and value and not re.fullmatch(r'[a-f0-9]{32}', value):
                        raise ValueError('unit_values_invalid')
                    values[key] = value
                if set(values) == set(fields):
                    return {'status': 'observed', 'values': values}
                break
            raw.extend(part)
            if len(raw) > 4096:
                break
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        pass
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()  # Only this observer's own bounded read-only systemctl child.
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                pass
            if process.stdout:
                process.stdout.close()
    return {'status': 'unknown'}


def snapshot(deadline, full):
    result = {'nodes': [node(path, deadline) for path in NODES], 'sourceFiles': None,
              'systemdDirectory': None, 'units': None}
    if full:
        result['sourceFiles'] = [node(path, deadline) for path in SOURCES]
        try:
            info = os.lstat('/run/systemd/system')
            result['systemdDirectory'] = {'status': 'present', 'isDirectory': stat.S_ISDIR(info.st_mode)}
        except FileNotFoundError:
            result['systemdDirectory'] = {'status': 'absent'}
        except OSError:
            result['systemdDirectory'] = {'status': 'unknown'}
        result['units'] = {unit: unit_snapshot(unit, deadline) if time.monotonic() < deadline else {'status': 'unknown'} for unit in UNITS}
    return result


class FileHandle(ctypes.Structure):
    _fields_ = [('count', ctypes.c_uint), ('kind', ctypes.c_int), ('data', ctypes.c_ubyte * MAX_HANDLE)]


class StatFS(ctypes.Structure):
    _fields_ = [('type', ctypes.c_long), ('bsize', ctypes.c_long), ('blocks', ctypes.c_ulong),
                ('bfree', ctypes.c_ulong), ('bavail', ctypes.c_ulong), ('files', ctypes.c_ulong),
                ('ffree', ctypes.c_ulong), ('fsid', ctypes.c_int * 2), ('namelen', ctypes.c_long),
                ('frsize', ctypes.c_long), ('flags', ctypes.c_long), ('spare', ctypes.c_long * 4)]


def open_notification_group():
    if sys.byteorder != 'little' or platform.machine() != 'x86_64' or ctypes.sizeof(StatFS) != 120:
        raise OSError(errno.ENOTSUP, 'unsupported_abi')
    libc = ctypes.CDLL(None, use_errno=True)
    init, mark = libc.fanotify_init, libc.fanotify_mark
    init.argtypes, init.restype = [ctypes.c_uint, ctypes.c_uint], ctypes.c_int
    mark.argtypes, mark.restype = [ctypes.c_int, ctypes.c_uint, ctypes.c_ulonglong, ctypes.c_int, ctypes.c_char_p], ctypes.c_int
    handle_fn, fs_fn = libc.name_to_handle_at, libc.fstatfs
    handle_fn.argtypes, handle_fn.restype = [ctypes.c_int, ctypes.c_char_p, ctypes.POINTER(FileHandle), ctypes.POINTER(ctypes.c_int), ctypes.c_int], ctypes.c_int
    fs_fn.argtypes, fs_fn.restype = [ctypes.c_int, ctypes.POINTER(StatFS)], ctypes.c_int
    directory = os.open(WATCH, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    group = -1
    try:
        handle, mount_id, fs = FileHandle(), ctypes.c_int(), StatFS()
        handle.count = MAX_HANDLE
        if handle_fn(directory, b'', ctypes.byref(handle), ctypes.byref(mount_id), 0x1000) != 0 or fs_fn(directory, ctypes.byref(fs)) != 0:
            raise OSError(ctypes.get_errno(), 'directory_handle_unavailable')
        if not 1 <= handle.count <= MAX_HANDLE:
            raise OSError(errno.EOVERFLOW, 'directory_handle_invalid')
        group = init(INIT_FLAGS, os.O_RDONLY | os.O_CLOEXEC)
        if group < 0 or mark(group, MARK_FLAGS, MASK, directory, None) != 0:
            raise OSError(ctypes.get_errno(), 'fanotify_unavailable')
        opened, current = os.fstat(directory), os.lstat(WATCH)
        if not stat.S_ISDIR(current.st_mode) or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise OSError(errno.ESTALE, 'directory_changed_before_ack')
        key = (struct.pack('=ii', *fs.fsid), handle.kind, bytes(handle.data[:handle.count]))
        return group, directory, key, os.fstat(directory)
    except BaseException:
        release_fds([group, directory])
        raise


def validate_context(ctx, now):
    keys = {'activated', 'sourceCommit', 'runId', 'attempt', 'instanceNonce', 'segmentNonce', 'notBeforeUnix', 'deadlineUnix'}
    if (not isinstance(ctx, dict) or set(ctx) != keys or ctx['activated'] is not True or ctx['sourceCommit'] != SOURCE
            or not isinstance(ctx['runId'], str) or not re.fullmatch(r'[1-9][0-9]{0,19}', ctx['runId'])
            or type(ctx['attempt']) is not int or not 1 <= ctx['attempt'] <= 100
            or any(not isinstance(ctx[k], str) or not re.fullmatch(r'[a-f0-9]{32}', ctx[k]) for k in ('instanceNonce', 'segmentNonce'))
            or any(type(ctx[k]) is not int for k in ('notBeforeUnix', 'deadlineUnix'))
            or not ctx['notBeforeUnix'] <= now < ctx['deadlineUnix']
            or not 0 < ctx['deadlineUnix'] - ctx['notBeforeUnix'] <= 900):
        raise ValueError('unbound_or_expired_context')
    return ctx


def request_valid(request, ctx):
    return (isinstance(request, dict) and set(request) == {'action', 'phase', 'instanceNonce', 'segmentNonce', 'challenge'}
            and request['action'] in ('checkpoint', 'stop') and request['phase'] in PHASES
            and request['instanceNonce'] == ctx['instanceNonce'] and request['segmentNonce'] == ctx['segmentNonce']
            and isinstance(request['challenge'], str) and re.fullmatch(r'[a-f0-9]{32}', request['challenge']) is not None)


def ack_valid(ack, ctx, request, expected_boot):
    return (isinstance(ack, dict) and set(ack) == {'version', 'type', 'challenge', 'context', 'bootId', 'observerNonce', 'phase', 'sequence', 'markActive', 'coverage'}
            and type(ack['version']) is int and ack['version'] == 1 and ack['type'] == 'ack' and ack['challenge'] == request['challenge']
            and ack['context'] == ctx and ack['bootId'] == expected_boot and ack['phase'] == request['phase']
            and isinstance(ack['observerNonce'], str) and re.fullmatch(r'[a-f0-9]{32}', ack['observerNonce']) is not None
            and type(ack['sequence']) is int and ack['sequence'] > 0 and ack['markActive'] is True
            and ack['coverage'] in ('bounded_segment_notifications', 'incomplete'))


class Journal:
    def __init__(self, path, common):
        self.fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        self.common, self.count = common, 0

    def write(self, payload, terminal=False):
        record = {**self.common, 'observedUtcNs': time.time_ns(), 'observedMonotonicNs': time.monotonic_ns(), **payload}
        raw = (json.dumps(record, separators=(',', ':'), sort_keys=True) + '\n').encode()
        limit = MAX_OUTPUT if terminal else MAX_OUTPUT - TERMINAL_RESERVE
        if len(raw) > MAX_RECORD or self.count + len(raw) > limit:
            return False
        pos = 0
        while pos < len(raw):
            written = os.write(self.fd, raw[pos:])
            if written <= 0:
                raise OSError(errno.EIO, 'journal_write_failed')
            pos += written
        self.count += len(raw)
        return True


def run_bound(ctx):
    """One bounded live segment; never claims continuous coverage across commands/boots."""
    validate_context(ctx, time.time())
    end = time.monotonic() + min(MAX_SECONDS, ctx['deadlineUnix'] - time.time())
    OUTPUT_ROOT.mkdir(mode=0o700, parents=False, exist_ok=True)
    if OUTPUT_ROOT.is_symlink() or not OUTPUT_ROOT.is_dir() or OUTPUT_ROOT.stat().st_uid != os.geteuid():
        raise ValueError('output_directory_invalid')
    folder = OUTPUT_ROOT / ctx['segmentNonce']
    folder.mkdir(mode=0o700)  # No reuse/overwrite of an old segment or receipt.
    observed_boot, nonce = boot_id(), os.urandom(16).hex()
    common = {'version': 1, 'context': ctx, 'bootId': observed_boot, 'observerNonce': nonce}
    journal = Journal(folder / 'events.jsonl', common)
    group = directory = wake_read = wake_write = -1
    server, reason, issues, sequence, event_count = None, 'unavailable', [], 0, 0
    old_handlers = {}
    def issue(code):
        if code not in issues and len(issues) < 16:
            issues.append(code)
    def emit(payload):
        if not journal.write(payload):
            issue('output_cap'); return False
        return True
    try:
        baseline = snapshot(min(end, time.monotonic() + 2), True)
        group, directory, watched_key, watched_stat = open_notification_group()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
        server.bind(str(folder / 'control.sock'))
        os.chmod(folder / 'control.sock', 0o600)
        server.listen(2)
        wake_read, wake_write = os.pipe2(os.O_NONBLOCK | os.O_CLOEXEC)
        def interrupted(signum, frame):
            try:
                os.write(wake_write, b'x')
            except OSError:
                pass
        for sig in (signal.SIGTERM, signal.SIGINT):
            old_handlers[sig] = signal.signal(sig, interrupted)
        if not emit({'type': 'mark_ack', 'markActive': True, 'watch': WATCH,
                     'directoryObjectId': object_id(watched_key), 'snapshotBeforeMark': baseline,
                     'kernelRelease': platform.release()[:128], 'architecture': platform.machine(),
                     'coverageAcrossCommandsOrBoots': 'unknown', 'coverage': 'bounded_segment_notifications'}):
            reason = 'output_cap'
            raise ValueError('output_cap')
        reason, stop = 'deadline', False
        while not stop and time.monotonic() < end and time.time() < ctx['deadlineUnix']:
            ready = select.select([group, server, wake_read], [], [], max(0, min(end - time.monotonic(), ctx['deadlineUnix'] - time.time())))[0]
            if wake_read in ready:
                issue('interrupted'); reason = 'interrupted'; break
            if group in ready:
                fds = ()
                try:
                    raw = os.read(group, MAX_BUFFER)
                    events, fds = parse_events(raw)
                    for event in events:
                        projected = project_event(event, watched_key)
                        if projected is None:
                            continue
                        if projected['type'] == 'gap':
                            issue(projected['reason']); stop = True; reason = projected['reason']
                        else:
                            event_count += 1
                            if event_count > MAX_RECORDED_EVENTS:
                                issue('event_cap'); stop = True; reason = 'event_cap'; break
                            projected['actor'] = identify_actor(event)
                            if projected['actor']['status'] == 'unknown':
                                issue(projected['actor']['reason'])
                            if projected['targetObjectId'] is None:
                                issue('target_object_id_unavailable')
                            projected['snapshot'] = snapshot(min(end, time.monotonic() + 0.2), False)
                        if not emit(projected):
                            stop = True; reason = 'output_cap'; break
                except ParseError as error:
                    release_fds(error.fds); issue(error.code); reason = error.code; stop = True
                except BlockingIOError:
                    pass
                finally:
                    release_fds(fds)
            if not stop and server in ready:
                connection, _ = server.accept()
                try:
                    connection.settimeout(0.25)
                    request = json.loads(connection.recv(513))
                    if not request_valid(request, ctx):
                        continue
                    if request['action'] == 'stop':
                        # Stop is passive and does not freeze writers. Do not claim
                        # an empty/drained kernel queue at the stop boundary.
                        issue('stop_queue_boundary_unverified')
                    current = os.lstat(WATCH)
                    if (current.st_dev, current.st_ino) != (watched_stat.st_dev, watched_stat.st_ino) or boot_id() != observed_boot:
                        issue('directory_or_boot_changed'); reason = 'directory_or_boot_changed'; stop = True; continue
                    sequence += 1
                    data = snapshot(min(end, time.monotonic() + 2), True)
                    if not emit({'type': 'checkpoint', 'phase': request['phase'], 'sequence': sequence,
                                 'snapshot': data, 'coverageAcrossCommandsOrBoots': 'unknown'}):
                        stop = True; reason = 'output_cap'; continue
                    ack = {'version': 1, 'type': 'ack', 'challenge': request['challenge'], 'context': ctx,
                           'bootId': observed_boot, 'observerNonce': nonce, 'phase': request['phase'],
                           'sequence': sequence, 'markActive': True,
                           'coverage': 'incomplete' if issues else 'bounded_segment_notifications'}
                    connection.send(json.dumps(ack, separators=(',', ':')).encode())
                    if request['action'] == 'stop':
                        stop = True; reason = 'requested_stop'
                except (OSError, ValueError, UnicodeError):
                    issue('control_request_unavailable')
                finally:
                    connection.close()
        if reason == 'deadline':
            issue('deadline_reached')
    except (OSError, ValueError, AttributeError) as error:
        issue('capability_or_runtime_unavailable')
        emit({'type': 'unavailable', 'reason': 'capability_or_runtime_unavailable',
              'errno': error.errno if isinstance(error, OSError) else None})
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        release_fds([group, directory, wake_read, wake_write])
        if server:
            server.close()
        journal.write({'type': 'terminal', 'reason': reason, 'issues': issues,
                       'coverage': 'incomplete' if issues else 'bounded_segment_notifications',
                       'coverageAcrossCommandsOrBoots': 'unknown', 'initialDataWriter': 'unknown',
                       'recordedEvents': event_count, 'zeroEventsProvesNoWrites': False}, terminal=True)
        os.close(journal.fd)
    return {'coverage': 'incomplete' if issues else 'bounded_segment_notifications', 'issues': issues}


def checkpoint(ctx, phase, stop=False):
    """Single bounded challenge/ACK, no retries or delay loop; disk ACK is not liveness."""
    validate_context(ctx, time.time())
    request = {'action': 'stop' if stop else 'checkpoint', 'phase': phase,
               'instanceNonce': ctx['instanceNonce'], 'segmentNonce': ctx['segmentNonce'], 'challenge': os.urandom(16).hex()}
    if not request_valid(request, ctx):
        return {'status': 'unknown', 'reason': 'request_invalid'}
    client = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
    try:
        client.settimeout(2.5)
        expected_boot = boot_id()
        client.connect(str(OUTPUT_ROOT / ctx['segmentNonce'] / 'control.sock'))
        client.send(json.dumps(request, separators=(',', ':')).encode())
        ack = json.loads(client.recv(4097))
        if not ack_valid(ack, ctx, request, expected_boot):
            return {'status': 'unknown', 'reason': 'ack_identity_invalid'}
        return {'status': 'acknowledged', 'ack': ack, 'coverageAcrossCommandsOrBoots': 'unknown'}
    except (OSError, ValueError, UnicodeError):
        return {'status': 'unknown', 'reason': 'observer_unavailable_or_gap'}
    finally:
        client.close()


def main():
    if BOUND_CONTEXT is None or len(sys.argv) != 1:
        print(json.dumps({'status': 'disabled', 'reason': 'unbound_review_only'}))
        return 2
    result = run_bound(BOUND_CONTEXT)
    return 3 if result['coverage'] == 'incomplete' else 0


if __name__ == '__main__':
    raise SystemExit(main())
