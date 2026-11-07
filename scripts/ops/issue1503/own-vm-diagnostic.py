"""Read-only, bounded projection. Raw logs and assignments never leave the VM."""
import datetime
import errno
import json
import os
import signal
import stat
import time


def bounded_file(root, relative, maximum, tail=False, expires_at_ms=None):
    """Open fixed path components without following even an ancestor symlink."""
    parent = None
    fd = None
    try:
        if expires_at_ms is not None and time.time() * 1000 >= expires_at_ms:
            return 'expired', None
        parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        parts = relative.split('/')
        for part in parts[:-1]:
            next_parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = next_parent
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return 'not_regular', None
        if info.st_size > maximum and not tail:
            return 'too_large', None
        truncated = info.st_size > maximum
        if truncated:
            os.lseek(fd, -maximum, os.SEEK_END)
        if expires_at_ms is not None and time.time() * 1000 >= expires_at_ms:
            return 'expired', None
        data = os.read(fd, maximum)
        if truncated:
            data = data.partition(b'\n')[2]
        return ('tail' if truncated else 'read'), data
    except OSError as error:
        return ('missing' if error.errno == errno.ENOENT else 'unavailable'), None
    finally:
        if fd is not None:
            os.close(fd)
        if parent is not None:
            os.close(parent)


def timestamp(value):
    try:
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)) and 0 < value < 4102444800000:
            return int(value)
        if isinstance(value, str) and len(value) <= 32:
            return int(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
    except (ValueError, OverflowError, TypeError):
        pass
    return None


def error_projection(value, contract):
    value = value if isinstance(value, dict) else {}
    name = value.get('type', value.get('name'))
    code = value.get('code')
    message = value.get('message')
    classification = 'other'
    if isinstance(message, str):
        if message.endswith(': unexpected response from the server'):
            classification = 'response_schema'
        else:
            classification = contract['messages'].get(message, 'other')
    issues = []
    data = value.get('data')
    if isinstance(data, list):
        for issue in data[:12]:
            if not isinstance(issue, dict):
                continue
            path = []
            raw_path = issue.get('path')
            if isinstance(raw_path, list):
                for segment in raw_path[:8]:
                    if path and path[-1] in contract['recordFields']:
                        path.append('<redacted-key>')
                        break
                    if isinstance(segment, int) and not isinstance(segment, bool):
                        path.append('<index>')
                    elif isinstance(segment, str) and segment in contract['schemaFields']:
                        path.append(segment)
                    else:
                        path.append('<redacted-key>')
                        break
            issues.append({'code': issue.get('code') if issue.get('code') in contract['issueCodes'] else 'other', 'path': path})
    raw_cause = value.get('cause')
    cause = raw_cause if isinstance(raw_cause, dict) else {}
    cause_code = cause.get('code')
    cause_name = cause.get('type', cause.get('name'))
    status = raw_cause if isinstance(raw_cause, int) else cause.get('status', cause.get('statusCode'))
    return {
        'name': name if name in contract['errorNames'] else 'other',
        'code': code if isinstance(code, int) and not isinstance(code, bool) and code in contract['errorCodes'] else 'other',
        'classification': classification,
        'upgradeRequired': value.get('upgradeRequired') is True,
        'schemaIssues': issues,
        'schemaIssuesTruncated': isinstance(data, list) and len(data) > 12,
        'cause': {
            'name': cause_name if cause_name in contract['errorNames'] else 'other',
            'code': cause_code if cause_code in contract['networkCodes'] else 'other',
            'status': status if isinstance(status, int) and not isinstance(status, bool) and (status == 429 or 500 <= status <= 599) else None,
        },
    }


def collect(scope, contract, root='/home/user/.mikka', expires_at_ms=None):
    files = {}
    log_status, log_bytes = bounded_file(root, 'worker/logs/daemon.log', 262144, tail=True, expires_at_ms=expires_at_ms)
    files['daemonLog'] = log_status
    files['bootstrapLog'], unused = bounded_file(root, 'thread-bootstrap.log', 0, expires_at_ms=expires_at_ms)
    # Only presence is useful for the unstructured bootstrap stream.
    files['bootstrapLog'] = 'present' if files['bootstrapLog'] in ('read', 'too_large') else files['bootstrapLog']
    files['journal'], journal_bytes = bounded_file(root, 'worker/runs.json', 1048576, expires_at_ms=expires_at_ms)
    files['pid'], pid_bytes = bounded_file(root, 'worker/daemon.pid', 32, expires_at_ms=expires_at_ms)
    process = {'recordedPidAlive': None}
    if pid_bytes is not None and pid_bytes.strip().isdigit():
        pid = int(pid_bytes.strip())
        if 1 < pid <= 2147483647:
            try:
                os.kill(pid, 0)
                process['recordedPidAlive'] = True
            except ProcessLookupError:
                process['recordedPidAlive'] = False
            except PermissionError:
                pass
    journal = {'valid': False, 'targetPresent': False, 'assignmentMatches': False,
               'state': 'other', 'lastSeq': None, 'sessionPresent': False}
    if journal_bytes is not None:
        try:
            parsed = json.loads(journal_bytes)
            runs = parsed.get('runs') if isinstance(parsed, dict) else None
            if parsed.get('version') == 1 and isinstance(runs, dict):
                journal['valid'] = True
                entry = runs.get(scope['runId'])
                if isinstance(entry, dict):
                    journal['targetPresent'] = True
                    assignment = entry.get('assignment')
                    journal['assignmentMatches'] = isinstance(assignment, dict) and assignment.get('runId') == scope['runId'] and assignment.get('issueId') == scope['issueId']
                    journal['state'] = entry.get('state') if entry.get('state') in contract['runStates'] else 'other'
                    seq = entry.get('lastSeq')
                    journal['lastSeq'] = seq if isinstance(seq, int) and not isinstance(seq, bool) and 0 <= seq <= 2147483647 else None
                    journal['sessionPresent'] = isinstance(entry.get('sessionId'), str) and len(entry['sessionId']) > 0
        except (ValueError, TypeError, AttributeError):
            pass
    events = []
    matching = 0
    malformed = 0
    lines = log_bytes.splitlines() if log_bytes is not None else []
    for raw in lines[-600:]:
        if len(raw) > 32768:
            malformed += 1
            continue
        try:
            item = json.loads(raw)
        except (ValueError, UnicodeError):
            malformed += 1
            continue
        if not isinstance(item, dict):
            continue
        at = timestamp(item.get('time'))
        if at is None or not scope['sinceMs'] <= at <= scope['untilMs']:
            continue
        message = item.get('msg')
        name = contract['logMessages'].get(message) if isinstance(message, str) else None
        exact = item.get('run_id') == scope['runId']
        if name is None or not (exact or name == 'server_sync_failed' and item.get('run_id') is None):
            continue
        matching += 1
        level = item.get('level')
        events.append({'timeMs': at, 'level': level if level in contract['levels'] else 'other',
                       'event': name, 'exactRun': exact, 'error': error_projection(item.get('err'), contract)})
    return {'files': files, 'process': process, 'journal': journal, 'events': events[-12:],
            'eventsTruncated': matching > 12, 'logTruncated': log_status == 'tail' or len(lines) > 600,
            'malformedLines': malformed}


def main(scope, contract, expires_at_ms):
    # Even if the runner disconnects or envd's command stream fails, this command
    # cannot keep reading files in the background. No child process is started.
    signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
    signal.alarm(5)
    try:
        print(json.dumps(collect(scope, contract, expires_at_ms=expires_at_ms), separators=(',', ':')), flush=True)
    except Exception:
        os._exit(70)
