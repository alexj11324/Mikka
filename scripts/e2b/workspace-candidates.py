"""Build/clean two private review candidates; never publish a template.

The checkout source and GitHub/OIDC carrier identity are distinct. Reuse the
release builder without changing either context or its eventual release gate.
The trusted runner's 0600 journal precedes creation; no Secret or SDK error
text is retained. Successful templates remain for the subsequent acceptance
driver, whose always step invokes cleanup with the same source/output.
"""
import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from types import SimpleNamespace
from urllib.error import HTTPError
from uuid import uuid4

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('workspace_candidate_builder', HERE / 'build-template.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
KINDS = ('claude', 'codex')
JOURNAL = 'creation-journal.json'
MAX_JOURNAL_BYTES = 65_536
ID = re.compile(r'[A-Za-z0-9_-]{1,128}')
BUILD_CREATED = re.compile(r'Template created with ID: ([A-Za-z0-9_-]{1,128}), Build ID: ([A-Za-z0-9_-]{1,128})')
PROVIDER_OUTPUT = re.compile(r'\[(?:builder ([1-9][0-9]?)/([1-9][0-9]?)|start|ready)\] \[(?:stdout|stderr)\]: (.*)')
BOOTSTRAP_PHASES = frozenset(('validation', 'source', 'node', 'gh', 'dependencies', 'build', 'cli',
                             'journal', 'desktop', 'finalize'))
INGRESS_DETAILS = frozenset(('listener', 'boot', 'identity', 'state', 'receipt', 'provider', 'command', 'tool',
                             'backend', 'rule_order', 'late_install', 'worker', 'worker_order', 'operation', 'runtime'))
INGRESS_COMMAND_OPERATIONS = frozenset(('new_chain', 'provider_rule', 'reply_rule', 'output_jump', 'check_output',
                                      'check_provider', 'check_reply', 'list_output', 'list_chain',
                                      'create_table', 'base_chain', 'install_policy', 'list_ruleset', 'list_table'))
INGRESS_COMMAND_FLAGS = ('unsupportedRevision', 'missingKernelModule', 'missingExtension',
                         'operationNotSupported', 'permissionDenied', 'invalidArgument')
HOST_ERRORS = frozenset(('official_cli_kind_invalid', 'official_cli_path_invalid', 'official_cli_baseline_mismatch',
    'official_cli_missing', 'official_cli_manifest_invalid', 'runtime_cli_missing', 'cli_relocation_invalid',
    'added_cli_paths_invalid', 'official_cli_changed', 'added_cli_path_invalid', 'official_cli_manifest_untrusted',
    'runtime_cli_changed', 'runtime_cli_unavailable', 'official_cli_manifest_changed', 'e2b_finalization_policy_invalid',
    'e2b_certificate_policy_invalid', 'official_conservation_invalid', 'official_manifest_invalid',
    'official_files_removed', 'official_files_changed', 'e2b_certificate_target_invalid', 'terminal_control_install_refused'))
ERROR_TYPES = frozenset(('CandidateError', 'Exception', 'RuntimeError', 'ValueError', 'TypeError', 'AssertionError',
    'OSError', 'FileNotFoundError', 'PermissionError', 'FileExistsError', 'JSONDecodeError', 'TimeoutError',
    'KeyboardInterrupt', 'SystemExit', 'CalledProcessError', 'TimeoutExpired', 'HTTPError', 'URLError',
    'BuildException', 'FileUploadException', 'SandboxException', 'TemplateException', 'AuthenticationException',
    'InvalidArgumentException', 'NotEnoughSpaceException', 'NotFoundException', 'TimeoutException',
    'RateLimitException', 'ServiceBusyException', 'HTTPStatusError', 'RequestError', 'ConnectError', 'ReadError',
    'WriteError', 'RemoteProtocolError', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout', 'PoolTimeout', 'UnexpectedStatus'))
SDK_CODES = {'BuildException': 'template_build_failed', 'FileUploadException': 'template_upload_failed',
             'AuthenticationException': 'provider_authentication_failed', 'RateLimitException': 'provider_rate_limited',
             'ServiceBusyException': 'provider_busy', 'NotEnoughSpaceException': 'provider_disk_space',
             'HTTPStatusError': 'provider_http_error', 'UnexpectedStatus': 'provider_http_error',
             **dict.fromkeys(('TimeoutException', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout', 'PoolTimeout'), 'operation_timeout')}
CANDIDATE_CODES = frozenset(('resource_identity_invalid', 'source_ref_invalid', 'source_ref_not_checkout_head',
    'source_checkout_modified', 'workflow_identity_required', 'worker_identity_invalid', 'output_directory_invalid',
    'output_file_invalid', 'creation_journal_invalid', 'creation_journal_missing', 'candidate_not_exact_private_template',
    'candidate_name_mismatch', 'candidate_build_not_ready', 'probe_scope_mismatch', 'probe_identity_reused',
    'probe_deletion_unconfirmed', 'sandbox_listing_limit', 'sandbox_scope_mismatch', 'sandbox_deletion_unconfirmed',
    'candidate_attempt_already_recorded', 'candidate_preflight_failed', 'candidate_identity_mismatch',
    'candidate_build_identity_missing', 'candidate_build_status_invalid', 'probe_cleanup_incomplete', 'candidate_build_failed', 'api_key_missing'))
MAX_LOG_MESSAGE = 65_536
MAX_LOG_EVENTS = 64
DEBUG_PAGES = 6
DEBUG_PAGE_ENTRIES = 100
DEBUG_REQUEST_SECONDS = 15
DEBUG_TOTAL_SECONDS = 90
DEBUG_RESULT_BYTES = 131_072
DEBUG_REQUEST_MARKER = b'{"requestStarted":true}\n'
CONSERVATION_PATH_CODES = {
    '/usr/local/share/e2b': 'provider_shared_directory',
    '/usr/local/share/ca-certificates/e2b-ca.crt': 'provider_root_certificate',
    '/etc/ssl/certs/e2b-ca.pem': 'provider_certificate_reference',
    '/etc/ssl/certs/1560546e.0': 'provider_hashed_certificate_reference',
}


class CandidateError(Exception):
    """Only these host-authored codes cross the SDK boundary."""


class Discard:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


@contextmanager
def quiet_sdk():
    with redirect_stdout(Discard()), redirect_stderr(Discard()):
        yield


def error_code(error):
    if isinstance(error, CandidateError):
        return error.args[0] if len(error.args) == 1 and isinstance(error.args[0], str) and error.args[0] in CANDIDATE_CODES else 'operation_failed'
    if isinstance(error, HTTPError):
        return 'provider_http_error'
    if isinstance(error, (TimeoutError, KeyboardInterrupt)):
        return 'operation_interrupted'
    return SDK_CODES.get(type(error).__name__, 'operation_failed')


def exception_diagnostic(error):
    """Only fixed type names, codes and numeric statuses leave an exception."""
    rows, seen = [], set()
    while error is not None and id(error) not in seen and len(rows) < 8:
        seen.add(id(error))
        name = type(error).__name__
        row = {'type': name if name in ERROR_TYPES else 'other', 'code': error_code(error)}
        status = error.code if isinstance(error, HTTPError) else getattr(error, 'status_code', None)
        if status is None:
            status = getattr(getattr(error, 'response', None), 'status_code', None)
        if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
            row['httpStatus'] = int(status)
        exit_code = getattr(error, 'exit_code', getattr(error, 'returncode', None))
        if type(exit_code) is int and -255 <= exit_code <= 255:
            row['exitCode'] = exit_code
        rows.append(row)
        error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
    return {'exceptionChain': rows, 'exceptionChainTruncated': error is not None}


def ingress_command(value):
    if (not isinstance(value, dict) or value.get('family') not in ('ipv4', 'ipv6', 'inet')
            or not isinstance(value.get('operation'), str) or value['operation'] not in INGRESS_COMMAND_OPERATIONS
            or value.get('failureKind') not in ('exit', 'timeout', 'output_limit', 'execution')
            or 'returnCode' not in value
            or not (value['returnCode'] is None or type(value['returnCode']) is int and -255 <= value['returnCode'] <= 255)
            or any(type(value.get(flag)) is not bool for flag in INGRESS_COMMAND_FLAGS)):
        return None
    result = {key: value[key] for key in ('family', 'operation', 'failureKind', 'returnCode', *INGRESS_COMMAND_FLAGS)}
    extension, revision = value.get('extension'), value.get('revision')
    result['extension'] = extension if extension in ('owner', 'multiport', 'conntrack', 'mark', 'tcp') else 'unknown'
    result['revision'] = revision if result['extension'] != 'unknown' and type(revision) is int and 0 <= revision <= 255 else None
    warnings = value.get('unsupportedExtensions')
    observed = {(row['extension'], row.get('revision') if type(row.get('revision')) is int and 0 <= row['revision'] <= 255 else None)
                for row in (warnings[:6] if isinstance(warnings, list) else []) if isinstance(row, dict)
                and row.get('extension') in ('owner', 'multiport', 'conntrack', 'mark', 'tcp')}
    result['unsupportedExtensions'] = [{'extension': name, 'revision': number} for name, number in sorted(observed,
                                      key=lambda item: (item[0], -1 if item[1] is None else item[1]))]
    return result


def official_change_diagnostic(message):
    """Project guard differences without retaining arbitrary paths or bytes.

    A failed ready command is not a successful conservation receipt. Preserve
    its rejection, plus numeric/type differences at four known provider paths,
    so a later fix need not guess which existing strict predicate refused it.
    """
    prefix = 'RuntimeError: official_files_changed '
    if not message.startswith(prefix):
        return None
    kinds = {'file', 'link', 'directory', 'special'}
    fields = {'kind', 'sha256', 'mode', 'uid', 'gid', 'target', 'type', 'device'}
    try:
        rows = json.loads(message[len(prefix):])
        if not isinstance(rows, list) or not 0 < len(rows) <= 512:
            return None
        changes, redacted = [], 0
        for row in rows:
            if (not isinstance(row, dict) or set(row) - {'path', 'kind', 'before', 'after', 'resolvedSha256'}
                    or not {'path', 'kind', 'before', 'after'}.issubset(row)
                    or not isinstance(row['path'], str) or row['kind'] not in kinds
                    or not isinstance(row['before'], dict) or not row['before'] or not isinstance(row['after'], dict)
                    or row['before'].keys() != row['after'].keys() or set(row['before']) - fields):
                return None
            for side in ('before', 'after'):
                for key, value in row[side].items():
                    valid = (value is None or
                             (key == 'kind' and isinstance(value, str) and value in kinds) or
                             (key == 'sha256' and isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value)) or
                             (key == 'target' and isinstance(value, str) and len(value) <= 2048) or
                             (key not in ('kind', 'sha256', 'target') and type(value) is int
                              and 0 <= value <= (4095 if key == 'mode' else 2**53 - 1)))
                    if not valid:
                        return None
            code = CONSERVATION_PATH_CODES.get(row['path'])
            if not code:
                redacted += 1
                continue
            if len(changes) < 16:
                changes.append({'pathCode': code, 'kind': row['kind'], 'fields': sorted(row['before']),
                    'before': {key: value for key, value in row['before'].items() if key in ('kind', 'mode', 'uid', 'gid')},
                    'after': {key: value for key, value in row['after'].items() if key in ('kind', 'mode', 'uid', 'gid')},
                    'contentChanged': 'sha256' in row['before'], 'targetChanged': 'target' in row['before']})
        return {'observedChanges': len(rows), 'redactedChanges': redacted,
                'truncated': len(rows) - redacted > len(changes), 'changes': changes}
    except (ValueError, TypeError, KeyError, RecursionError):
        return None


class BuildDiagnostics:
    """Consume the pinned SDK's public callback; retain no raw log messages.

    Python E2B 2.62.0 emits its creation event before uploading/triggering the
    build. Its background API returns later, and it has no public wait API.
    Keeping Template.build therefore records IDs earlier without replacing
    the SDK's existing wait/log-drain behavior or adding a polling loop.
    """
    def __init__(self, journal, output, kind):
        self.journal, self.output, self.kind = journal, output, kind
        self.value = {'entries': 0, 'ignoredLines': 0, 'oversizedEntries': 0, 'events': [], 'truncated': False}

    def event(self, value):
        if len(self.value['events']) < MAX_LOG_EVENTS:
            self.value['events'].append(value)
        else:
            self.value['truncated'] = True

    def __call__(self, entry):
        self.value['entries'] += 1
        message = getattr(entry, 'message', None)
        if not isinstance(message, str) or len(message) > MAX_LOG_MESSAGE:
            self.value['oversizedEntries'] += 1
            return
        created = BUILD_CREATED.fullmatch(message)
        if created and getattr(entry, 'level', None) == 'info':
            row = self.journal['templates'][self.kind]
            identifiers = {'templateId': resource_id(created[1]), 'buildId': resource_id(created[2])}
            if any(row.get(key, value) != value for key, value in identifiers.items()):
                raise CandidateError('candidate_identity_mismatch')
            # A single atomic 0600 write precedes the SDK's next upload or wait.
            row.update(identifiers)
            write_private(self.output / JOURNAL, self.journal)
            self.event({'phase': 'template_created'})
            return
        for line in message.splitlines():
            line = line.strip()
            # runtime@438a79cf sandboxtools/command.go wraps process output in
            # this fixed envelope. Strip it only after the SDK control-event
            # check: guest stdout can never supply creation identities.
            wrapped = PROVIDER_OUTPUT.fullmatch(line)
            if wrapped and (wrapped[1] is None or int(wrapped[1]) <= int(wrapped[2])):
                line = wrapped[3]
            phase = re.fullmatch(r'mikka-bootstrap-phase ([a-z]+) ([0-9]{1,9})', line)
            if phase and phase[1] in BOOTSTRAP_PHASES:
                self.event({'phase': 'bootstrap', 'detail': phase[1], 'elapsedMs': int(phase[2])})
                continue
            startup = re.fullmatch(r'mikka-prebuilt-start ([a-z_]+)', line)
            if startup and startup[1] in builder.PREBUILT_START_PHASES:
                self.event({'phase': 'prebuilt_start', 'detail': startup[1]})
                continue
            stopped = re.fullmatch(r'mikka-prebuilt-(start|ready)-failed ([a-z_]+) ([0-9]{1,3})', line)
            if (stopped and 1 <= int(stopped[3]) <= 255
                    and stopped[2] in (builder.PREBUILT_START_PHASES if stopped[1] == 'start' else builder.PREBUILT_READY_PHASES)):
                self.event({'phase': 'prebuilt_' + stopped[1] + '_failed', 'detail': stopped[2], 'exitCode': int(stopped[3])})
                continue
            failure = re.match(r'(?:ValueError|RuntimeError): ([a-z_]+)(?: |$)', line)
            host_error = failure[1] if failure else line
            if host_error in HOST_ERRORS:
                detail = official_change_diagnostic(line) if host_error == 'official_files_changed' else None
                self.event({'phase': 'host_failure', 'detail': host_error,
                            **({'conservation': detail} if detail is not None else {})})
                continue
            # These receipts are emitted by the pinned ingress/conservation
            # scripts. Extra fields, arbitrary paths and hashes are discarded.
            try:
                value = json.loads(line) if line.startswith('{') else None
            except (ValueError, RecursionError):
                value = None
            if (isinstance(value, dict) and set(value) in ({'ok', 'detail'}, {'ok', 'detail', 'command'}) and value['ok'] is False
                    and isinstance(value['detail'], str) and value['detail'] in INGRESS_DETAILS):
                event = {'phase': 'ingress', 'detail': value['detail']}
                command = ingress_command(value.get('command')) if value['detail'] == 'command' else None
                if command is not None:
                    event['command'] = command
                self.event(event)
            elif (isinstance(value, dict) and set(value) == {'entries', 'sha256'}
                  and type(value['entries']) is int and 0 <= value['entries'] <= 10_000_000
                  and isinstance(value['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', value['sha256'])):
                self.event({'phase': 'official_capture', 'entries': value['entries']})
            else:
                self.value['ignoredLines'] += 1


def build_diagnostic(error, logs):
    return {**exception_diagnostic(error), 'buildLogs': {kind: log.value for kind, log in logs.items()}}


def read_build_status(row, api_key, logs_offset, request_timeout):
    """Pinned SDK generated GET; its high-level wrapper cannot select debug.

    There is no RetryableTransport and no connect retry. A parent process also
    kills/reaps this entire request, including imports/body parsing, at its
    absolute deadline; correctness does not depend on HTTPX idle timeouts.
    """
    from e2b.api import ApiClient
    from e2b.api.client_sync import get_transport
    from e2b.api.client.api.templates import get_templates_template_id_builds_build_id_status as endpoint
    from e2b.api.client.models.log_level import LogLevel
    from e2b.connection_config import ConnectionConfig
    config = ConnectionConfig(api_key=api_key, api_url='https://api.e2b.dev', debug=False,
                              request_timeout=request_timeout, retries=0, logger=None)
    with ApiClient(config, transport=get_transport(config, retry_connect=False), follow_redirects=False,
                   raise_on_unexpected_status=False) as client:
        return endpoint.sync_detailed(row['templateId'], row['buildId'], client=client,
                                      logs_offset=logs_offset, limit=DEBUG_PAGE_ENTRIES, level=LogLevel.DEBUG)


def source_step(step):
    # runtime@438a79cf phases/steps/factory.go numbers Config.Steps with i+1;
    # phases/utils.go serializes that number. SDK 2.62.0 uses it unchanged.
    # Base/finalize have named steps, outside the numeric instruction range.
    phases = ('base', 'workdir', 'private_directory', *(['copy_runtime'] * (len(builder.BOOTSTRAP_FILES) + 1)),
              'official_capture', 'bootstrap', 'npm_runtime', 'official_verify', 'worker_user', 'finalize')
    if step in ('base', 'finalize'):
        return {'phase': step, 'index': None}
    if isinstance(step, str) and re.fullmatch(r'[1-9][0-9]?', step) and int(step) < len(phases) - 1:
        return {'phase': phases[int(step)], 'index': int(step)}
    return {'phase': 'unknown', 'index': None}


def reason_exit_code(message):
    """Retain a single unambiguous numeric exit, never the reason/command."""
    if not isinstance(message, str) or len(message) > MAX_LOG_MESSAGE:
        return None
    values = {int(value) for value in re.findall(r'\bexit (?:status|code):?\s+(-?[0-9]{1,3})(?=$|[\s,;)])', message, re.IGNORECASE)}
    return next(iter(values)) if len(values) == 1 and all(-255 <= value <= 255 for value in values) else None


def provider_reason(message):
    # Fixed error prefixes from runtime@438a79cf finalize/builder.go/ready.go.
    # Classify observed text, without asserting the deployed provider revision.
    message = message if isinstance(message, str) and len(message) <= MAX_LOG_MESSAGE else ''
    patterns = {
        'configuration_failed': r'(?:^|: )configuration script failed:',
        'ready_failed': r'(?:^|: )ready command failed:',
        'ready_timeout': r'\bready command timed out after [0-9.hmsµ]+(?:\s|$)',
        'start_confirmation_failed': r'(?:^|: )waiting for start command failed:',
        'start_failed': r'(?:^|: )(?:error running )?start command failed:|(?:^|: )error running start command:',
        'process_start_failed': r'(?:^|: )error starting process:',
        'sync_failed': r'(?:^|: )error running sync command:',
        'deadline_exceeded': r'\bcontext deadline exceeded\b',
    }
    return {'categories': sorted(code for code, pattern in patterns.items() if re.search(pattern, message)),
            'exitCode': reason_exit_code(message)}


class DebugDiagnostics(BuildDiagnostics):
    """A separate read-only projection; never mutate the creation callback/journal."""
    def __init__(self):
        super().__init__(None, None, None)
        self.observed = {}
        self.value.update(levels=dict.fromkeys(('debug', 'info', 'warn', 'error'), 0),
                          signals={'startAnnounced': False, 'readyAnnounced': False,
                                   'templateReady': False, 'readyRejected': 0})

    def event(self, value):
        key = json.dumps(value, sort_keys=True)
        if key in self.observed:
            self.observed[key]['count'] += 1
        elif len(self.observed) < MAX_LOG_EVENTS:
            row = {**value, 'count': 1}
            self.observed[key] = row
            self.value['events'].append(row)
        else:
            self.value['truncated'] = True

    def __call__(self, entry):
        entries = self.value['entries'] + 1
        self.value['entries'] = entries
        level, message = getattr(entry, 'level', None), getattr(entry, 'message', None)
        level = getattr(level, 'value', level)
        if level not in self.value['levels']:
            self.value['ignoredLines'] += 1
            return
        self.value['levels'][level] += 1
        if not isinstance(message, str) or len(message) > MAX_LOG_MESSAGE:
            self.value['oversizedEntries'] += 1
            return
        for line in message.splitlines():
            line = line.strip()
            # Historical provider logs cannot be mistaken for SDK creation
            # control events. In particular, no debug read can rewrite IDs.
            if BUILD_CREATED.fullmatch(line):
                self.value['ignoredLines'] += 1
                continue
            signals = self.value['signals']
            if line.startswith('Running start command: '):
                signals['startAnnounced'] = True
            elif line.startswith('Waiting for template to be ready: '):
                signals['readyAnnounced'] = True
            elif line == 'Template is ready':
                signals['templateReady'] = True
            elif line.startswith('Template is not ready: '):
                signals['readyRejected'] += 1
                self.event({'phase': 'ready_rejected', **provider_reason(line[23:])})
            else:
                wrapped = PROVIDER_OUTPUT.fullmatch(line)
                host = wrapped[3] if wrapped and (wrapped[1] is None or int(wrapped[1]) <= int(wrapped[2])) else line
                if host == 'Cloud worker unavailable':
                    self.event({'phase': 'host_failure', 'detail': 'anonymous_worker_unavailable'})
                else:
                    super().__call__(SimpleNamespace(level=level, message=line))
        self.value['entries'] = entries


def debug_failure(code, error=None, http_status=None, request_started=False):
    return {'requestStarted': request_started, 'failure': {'code': code, 'httpStatus': http_status,
            **(exception_diagnostic(error) if error is not None else {})}}


def debug_target(scope, output, kind, expected):
    if kind not in KINDS or stat.S_IMODE((output / JOURNAL).stat().st_mode) != 0o600:
        raise CandidateError('creation_journal_invalid')
    row = read_journal(output, scope)['templates'][kind]
    if (row != expected or set(row) != {'kind', 'name', 'creationStarted', 'collision', 'templateId', 'buildId'}
            or row['creationStarted'] is not True or row['collision'] is not False):
        raise CandidateError('candidate_identity_mismatch')
    return row


def project_debug_page(response, row):
    code, value = getattr(response, 'status_code', None), getattr(response, 'parsed', None)
    if not isinstance(code, int) or isinstance(code, bool) or not 100 <= code <= 599:
        return debug_failure('response_refused', request_started=True)
    if code != 200:
        failure = {401: 'unauthorized', 403: 'forbidden', 404: 'not_found'}.get(code, 'http_error')
        if code == 400 and getattr(value, 'message', None) == f"Build '{row['buildId']}' not found":
            failure = 'not_found'
        return debug_failure(failure, http_status=int(code), request_started=True)
    state = getattr(value, 'status', None)
    state = getattr(state, 'value', state)
    entries = getattr(value, 'log_entries', None)
    if ((getattr(value, 'template_id', None), getattr(value, 'build_id', None)) != (row['templateId'], row['buildId'])
            or state not in ('waiting', 'building', 'ready', 'error')
            or not isinstance(entries, list) or len(entries) > DEBUG_PAGE_ENTRIES):
        return debug_failure('response_refused', request_started=True)
    result = {'requestStarted': True, 'identityMatched': True, 'status': state, 'entries': len(entries)}
    if state in ('waiting', 'building'):
        return {**result, 'failure': {'code': 'not_terminal', 'httpStatus': None}}
    reason, logs = getattr(value, 'reason', None), DebugDiagnostics()
    reason_entries = getattr(reason, 'log_entries', None)
    reason_entries = reason_entries if isinstance(reason_entries, list) else []
    for entry in entries:
        logs(entry)
    seen = {(getattr(entry, 'level', None), getattr(entry, 'message', None)) for entry in entries
            if isinstance(getattr(entry, 'message', None), str)}
    for entry in reason_entries[:DEBUG_PAGE_ENTRIES]:
        if (getattr(entry, 'level', None), getattr(entry, 'message', None)) not in seen:
            logs(entry)
    return {**result, 'failure': None, 'step': source_step(getattr(reason, 'step', None)),
            **provider_reason(getattr(reason, 'message', None)), 'debugLogs': logs.value,
            'reasonLogEntries': min(len(reason_entries), DEBUG_PAGE_ENTRIES),
            'reasonLogEntriesTruncated': len(reason_entries) > DEBUG_PAGE_ENTRIES}


def debug_page_main():
    """Internal child entry point: one fixed GET, key only on anonymous stdin."""
    started = False
    try:
        with quiet_sdk():
            raw = sys.stdin.buffer.read(MAX_JOURNAL_BYTES + 1)
            if len(raw) > MAX_JOURNAL_BYTES:
                raise CandidateError('creation_journal_invalid')
            value = json.loads(raw)
            if (not isinstance(value, dict) or set(value) != {'scope', 'output', 'kind', 'row', 'key', 'offset', 'timeout'}
                    or type(value['offset']) is not int or value['offset'] not in range(0, DEBUG_PAGES * DEBUG_PAGE_ENTRIES, DEBUG_PAGE_ENTRIES)
                    or type(value['timeout']) not in (int, float) or not 0 < value['timeout'] <= DEBUG_REQUEST_SECONDS
                    or not isinstance(value['key'], str) or not value['key']):
                raise CandidateError('creation_journal_invalid')
            scope = identity(value['scope']['sourceCommit'], os.environ)
            if scope != value['scope']:
                raise CandidateError('candidate_identity_mismatch')
            row = debug_target(scope, Path(value['output']), value['kind'], value['row'])
        # This closed marker lets a killed request report that it was attempted,
        # without persisting any partial SDK output or claiming it was delivered.
        sys.stdout.buffer.write(DEBUG_REQUEST_MARKER)
        sys.stdout.buffer.flush()
        started = True
        with quiet_sdk():
            response = read_build_status(row, value['key'], value['offset'], value['timeout'])
            result = project_debug_page(response, row)
    except BaseException as error:
        result = debug_failure('request_failed' if started else 'journal_refused', error, request_started=started)
    print(json.dumps(result))
    return 0


def request_debug_page(payload, timeout):
    """subprocess.run kills AND reaps on timeout, including a stalled body/parser.

    The caller shrinks this deadline to its remaining 90-second total. No
    shell, credential argument, retry or background worker is involved.
    """
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '_debug-page'],
            input=json.dumps({**payload, 'timeout': timeout}).encode(), stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, cwd=builder.ROOT, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        return debug_failure('request_timeout', request_started=(error.stdout or b'').startswith(DEBUG_REQUEST_MARKER))
    except BaseException as error:
        return debug_failure('request_failed', error)
    started = result.stdout.startswith(DEBUG_REQUEST_MARKER)
    raw = result.stdout[len(DEBUG_REQUEST_MARKER):] if started else result.stdout
    if result.returncode or len(raw) > DEBUG_RESULT_BYTES:
        return debug_failure('worker_failed' if result.returncode else 'body_limit', request_started=started)
    try:
        value = json.loads(raw)
        if not isinstance(value, dict) or value.get('requestStarted') is not started:
            raise CandidateError('candidate_build_status_invalid')
        return value
    except BaseException as error:
        return debug_failure('response_refused', error, request_started=started)


def failed_build_status(scope, output, kind, expected, api_key):
    """Finite pages of this failed build, before cleanup; never another build wait."""
    deadline = time.monotonic() + DEBUG_TOTAL_SECONDS
    logs, exit_codes = DebugDiagnostics(), set()
    result = {'attempted': True, 'identityMatched': False, 'outcome': 'unavailable', 'complete': False,
              'status': None, 'step': {'phase': 'unknown', 'index': None}, 'exitCode': None, 'exitCodeSource': None,
              'categories': [], 'requests': 0, 'pages': 0, 'entries': 0, 'reasonLogEntries': 0,
              'reasonLogEntriesTruncated': False, 'failure': None, 'debugLogs': logs.value,
              'limits': {'pages': DEBUG_PAGES, 'entriesPerPage': DEBUG_PAGE_ENTRIES,
                         'totalSeconds': DEBUG_TOTAL_SECONDS, 'requestSeconds': DEBUG_REQUEST_SECONDS}}

    def fail(code, error=None):
        result['failure'] = debug_failure(code, error)['failure']
        result['outcome'] = 'partial' if result['pages'] else 'unavailable'
        return result

    try:
        row = debug_target(scope, output, kind, expected)
    except BaseException as error:
        return fail('journal_refused', error)
    try:
        for _ in range(DEBUG_PAGES):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return fail('time_limit')
            page = request_debug_page({'scope': scope, 'output': str(output), 'kind': kind, 'row': row,
                                       'key': api_key, 'offset': result['entries']}, min(DEBUG_REQUEST_SECONDS, remaining))
            result['requests'] += int(page.get('requestStarted') is True)
            if page.get('identityMatched') is True:
                if result['status'] is not None and result['status'] != page['status']:
                    return fail('status_changed')
                result.update(identityMatched=True, status=page['status'])
                result['pages'] += 1
            if page.get('failure'):
                result['failure'] = page['failure']
                result['outcome'] = 'partial' if result['pages'] else 'unavailable'
                return result
            result['entries'] += page['entries']
            if result['pages'] == 1:
                result['step'] = page['step']
            result['categories'] = sorted(set(result['categories']) | set(page['categories']))
            if page['exitCode'] is not None:
                exit_codes.add(page['exitCode'])
            result['exitCode'] = next(iter(exit_codes)) if len(exit_codes) == 1 else None
            result['exitCodeSource'] = 'provider_reason' if result['exitCode'] is not None else None
            result['reasonLogEntries'] += page['reasonLogEntries']
            result['reasonLogEntriesTruncated'] |= page['reasonLogEntriesTruncated']
            value = page['debugLogs']
            for name in ('entries', 'ignoredLines', 'oversizedEntries'):
                logs.value[name] += value[name]
            for level in logs.value['levels']:
                logs.value['levels'][level] += value['levels'][level]
            for name in ('startAnnounced', 'readyAnnounced', 'templateReady'):
                logs.value['signals'][name] |= value['signals'][name]
            logs.value['signals']['readyRejected'] += value['signals']['readyRejected']
            logs.value['truncated'] |= value['truncated']
            for event in value['events']:
                count = event.pop('count')
                logs.event(event)
                key = json.dumps(event, sort_keys=True)
                if key in logs.observed:
                    logs.observed[key]['count'] += count - 1
            if time.monotonic() >= deadline:
                return fail('time_limit')
            if page['entries'] < DEBUG_PAGE_ENTRIES:
                result.update(complete=True, outcome='available')
                return result
        return fail('page_limit')
    except BaseException as error:
        # Diagnostic transport/projection must never replace the build failure.
        return fail('request_failed', error)


def resource_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise CandidateError('resource_identity_invalid')
    return value


def identity(source_ref, environ):
    if not re.fullmatch(r'[a-f0-9]{40}', source_ref or ''):
        raise CandidateError('source_ref_invalid')
    if builder.commit(source_ref) != source_ref or builder.commit('HEAD') != source_ref:
        raise CandidateError('source_ref_not_checkout_head')
    if subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=builder.ROOT, check=False).returncode:
        raise CandidateError('source_checkout_modified')
    metadata = builder.release_metadata(environ)
    if len(metadata) != 4 or any(len(metadata[key]) > 20 for key in ('runId', 'runAttempt')):
        raise CandidateError('workflow_identity_required')
    worker = builder.worker_hash(source_ref)
    if not re.fullmatch(r'[a-f0-9]{40}', worker):
        raise CandidateError('worker_identity_invalid')
    return {'sourceCommit': source_ref, 'workerSha': worker,
            'workflowCommit': metadata['sourceCommit'], 'runId': metadata['runId'], 'runAttempt': metadata['runAttempt']}


def metadata_for(scope):
    return {'application': 'mikka-template-release', 'sourceCommit': scope['workflowCommit'],
            'runId': scope['runId'], 'runAttempt': scope['runAttempt']}


def candidate_name(scope, kind):
    return f"mikka-preview-{scope['sourceCommit'][:12]}-{scope['runId']}-{scope['runAttempt']}-{kind}"


def output_directory(path):
    path = Path(path)
    if path.is_symlink():
        raise CandidateError('output_directory_invalid')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_dir() or path.stat().st_uid != os.geteuid():
        raise CandidateError('output_directory_invalid')
    path.chmod(0o700)
    return path


def write_private(path, value, *, exclusive=False):
    """Atomic, owner-only writes; exclusive reports preserve original failures."""
    raw = (json.dumps(value, indent=2) + '\n').encode()
    if path.is_symlink():
        raise CandidateError('output_file_invalid')
    target = path if exclusive else path.with_name('.' + path.name + '-' + uuid4().hex)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if not exclusive:
            os.replace(target, path)
    finally:
        if not exclusive:
            target.unlink(missing_ok=True)


def read_private(path):
    if path.is_symlink():
        raise CandidateError('creation_journal_invalid')
    details = path.stat()
    if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_mode & 0o077 or details.st_size > MAX_JOURNAL_BYTES:
        raise CandidateError('creation_journal_invalid')
    return json.loads(path.read_bytes())


def read_journal(output, scope):
    value = read_private(output / JOURNAL)
    if (not isinstance(value, dict) or set(value) != {'version', 'identity', 'templates', 'sandboxes', 'pendingSandbox'}
            or type(value['version']) is not int or value['version'] != 1 or value['identity'] != scope
            or not isinstance(value['templates'], dict) or set(value['templates']) != set(KINDS)
            or not isinstance(value['sandboxes'], list) or len(value['sandboxes']) > 16):
        raise CandidateError('creation_journal_invalid')
    for kind, row in value['templates'].items():
        if (not isinstance(row, dict) or set(row) - {'kind', 'name', 'creationStarted', 'collision', 'templateId', 'buildId'}
                or row.get('kind') != kind or row.get('name') != candidate_name(scope, kind)
                or type(row.get('creationStarted')) is not bool or type(row.get('collision')) is not bool
                or ('templateId' in row and (not row['creationStarted'] or row['collision']))
                or ('buildId' in row and 'templateId' not in row)):
            raise CandidateError('creation_journal_invalid')
        for field in ('templateId', 'buildId'):
            if field in row:
                resource_id(row[field])
    seen = set()
    for row in value['sandboxes']:
        if (not isinstance(row, dict) or set(row) != {'sandboxId', 'templateId', 'kind', 'deletedConfirmed'}
                or row['kind'] not in KINDS or row['templateId'] != value['templates'][row['kind']].get('templateId')
                or type(row['deletedConfirmed']) is not bool or row['sandboxId'] in seen):
            raise CandidateError('creation_journal_invalid')
        seen.add(resource_id(row['sandboxId']))
    pending = value['pendingSandbox']
    if pending is not None and (not isinstance(pending, dict) or set(pending) != {'kind', 'templateId'}
            or pending['kind'] not in KINDS or pending['templateId'] != value['templates'][pending['kind']].get('templateId')):
        raise CandidateError('creation_journal_invalid')
    return value


def private_ready(row, api_key, request):
    info = request('GET', '/templates/' + row['templateId'], api_key)
    alias = request('GET', '/templates/aliases/' + row['name'], api_key)
    if (not isinstance(info, dict) or not isinstance(alias, dict) or info.get('templateID') != row['templateId']
            or alias.get('templateID') != row['templateId'] or info.get('isDefault') is True
            or info.get('public') is not False or alias.get('public') is not False):
        raise CandidateError('candidate_not_exact_private_template')
    names = (info.get('names') or []) + (info.get('aliases') or [])
    if not any(isinstance(name, str) and re.fullmatch(r'(?:[^/]+/)?' + re.escape(row['name']), name) for name in names):
        raise CandidateError('candidate_name_mismatch')
    matches = [build for build in info.get('builds', []) if isinstance(build, dict) and build.get('buildID') == row['buildId']]
    if len(matches) != 1 or matches[0].get('status') != 'ready':
        raise CandidateError('candidate_build_not_ready')


def absent_sandbox(sandbox_id, api_key, request):
    try:
        request('GET', '/sandboxes/' + sandbox_id, api_key)
    except HTTPError as error:
        if error.code == 404:
            return True
        raise
    return False


def tracked_factory(journal, output, kind, api_key, sdk, request):
    expected = journal['templates'][kind]['templateId']

    def create(template_id, **kwargs):
        if template_id != expected or kwargs.get('metadata') != metadata_for(journal['identity']) or kwargs.get('api_key') != api_key:
            raise CandidateError('probe_scope_mismatch')
        journal['pendingSandbox'] = {'kind': kind, 'templateId': expected}
        write_private(output / JOURNAL, journal)
        sandbox = sdk[0].create(template_id, **kwargs)
        row = {'sandboxId': resource_id(sandbox.sandbox_id), 'templateId': expected, 'kind': kind, 'deletedConfirmed': False}
        if any(item['sandboxId'] == row['sandboxId'] for item in journal['sandboxes']):
            raise CandidateError('probe_identity_reused')
        journal['sandboxes'].append(row)
        journal['pendingSandbox'] = None
        write_private(output / JOURNAL, journal)

        class TrackedSandbox:
            def __getattr__(self, name):
                return getattr(sandbox, name)

            def kill(self):
                sandbox.kill()
                if not absent_sandbox(row['sandboxId'], api_key, request):
                    raise CandidateError('probe_deletion_unconfirmed')
                row['deletedConfirmed'] = True
                write_private(output / JOURNAL, journal)

        return TrackedSandbox()
    return create


def sandbox_cleanup(journal, output, api_key, sdk, request):
    Sandbox, SandboxQuery, SandboxState = sdk
    metadata = metadata_for(journal['identity'])
    by_id = {row['sandboxId']: row for row in journal['sandboxes']}
    templates = {row.get('templateId'): kind for kind, row in journal['templates'].items() if row.get('templateId')}
    errors, receipts = [], []
    pending = journal['pendingSandbox']
    pending_found = False
    try:
        pages = Sandbox.list(query=SandboxQuery(metadata=metadata, state=[SandboxState.RUNNING, SandboxState.PAUSED]), api_key=api_key)
        count = 0
        while pages.has_next:
            count += 1
            if count > 20:
                raise CandidateError('sandbox_listing_limit')
            for row in pages.next_items():
                sandbox_id = resource_id(row.sandbox_id)
                if row.metadata != metadata or row.template_id not in templates:
                    errors.append({'stage': 'sandbox_list', 'code': 'sandbox_scope_mismatch'})
                    continue
                if sandbox_id not in by_id:
                    if pending and row.template_id == pending['templateId']:
                        pending_found = True
                    by_id[sandbox_id] = {'sandboxId': sandbox_id, 'templateId': row.template_id,
                                        'kind': templates[row.template_id], 'deletedConfirmed': False}
                if len(by_id) > 16:
                    raise CandidateError('sandbox_listing_limit')
    except BaseException as error:
        errors.append({'stage': 'sandbox_list', 'code': error_code(error)})
    if pending_found:
        journal['pendingSandbox'] = None
    elif pending:
        # A create timeout may finish after this list response. An empty list
        # cannot attest the outcome of an acknowledged-but-unidentified create.
        errors.append({'stage': 'sandbox_create', 'code': 'sandbox_creation_unconfirmed'})
    journal['sandboxes'] = list(by_id.values())
    write_private(output / JOURNAL, journal)
    for sandbox_id, row in by_id.items():
        result = {'sandboxId': sandbox_id, 'status': 'failed'}
        try:
            try:
                info = request('GET', '/sandboxes/' + sandbox_id, api_key)
            except HTTPError as error:
                if error.code != 404:
                    raise
                info = None
            if info is None:
                result['status'] = 'absent'
            else:
                if (not isinstance(info, dict) or info.get('sandboxID') != sandbox_id
                        or info.get('templateID') != row['templateId'] or info.get('metadata') != metadata):
                    raise CandidateError('sandbox_scope_mismatch')
                Sandbox.kill(sandbox_id, api_key=api_key)
                if not absent_sandbox(sandbox_id, api_key, request):
                    raise CandidateError('sandbox_deletion_unconfirmed')
                result['status'] = 'deleted'
            row['deletedConfirmed'] = True
        except BaseException as error:
            result['code'] = error_code(error)
        receipts.append(result)
    write_private(output / JOURNAL, journal)
    return receipts, errors


def cleanup(scope, output, api_key, sdk, request=None):
    request = request or builder._request
    if not (output / JOURNAL).exists():
        # A durable preflight refusal happens before journal creation or any
        # mutating SDK call. A missing journal in every other case stays red.
        refused = read_private(output / 'build-report.json')
        if (not isinstance(refused, dict) or not {'identity', 'status', 'stage', 'code'}.issubset(refused)
                or set(refused) - {'identity', 'status', 'stage', 'code', 'diagnostic'}
                or refused['identity'] != scope or refused['status'] != 'failed' or refused['stage'] != 'preflight'):
            raise CandidateError('creation_journal_missing')
        sandboxes, templates, errors = [], [], []
    else:
        journal = read_journal(output, scope)
        with quiet_sdk():
            sandboxes, errors = sandbox_cleanup(journal, output, api_key, sdk, request)
            owned = [row for row in journal['templates'].values() if row['creationStarted'] and not row['collision']]
            raw = builder.cleanup_templates(owned, api_key, request)
        templates = []
        for candidate, receipt in zip(owned, raw, strict=True):
            row = {'name': candidate['name'], 'kind': candidate['kind'], 'status': receipt['status']}
            if row['status'] not in ('absent', 'deleted', 'retained_public', 'failed'):
                row.update(status='failed', code='template_cleanup_failed')
            if 'templateId' in receipt:
                row['templateId'] = resource_id(receipt['templateId'])
            if row['status'] == 'failed':
                row['code'] = 'template_cleanup_failed'
            templates.append(row)
    # A public/ambiguous resource is retained, and this attempt remains red.
    confirmed = not errors and all(row['status'] in ('absent', 'deleted') for row in sandboxes + templates)
    result = {'identity': scope, 'confirmed': confirmed, 'templates': templates, 'sandboxes': sandboxes, 'errors': errors}
    number = 1
    while True:
        path = output / ('cleanup.json' if number == 1 else f'cleanup-{number}.json')
        try:
            write_private(path, result, exclusive=True)
            return result, path.name
        except FileExistsError:
            number += 1


def build_candidates(scope, output, api_key, sdk, request=None):
    request = request or builder._request
    if any((output / name).exists() for name in (JOURNAL, 'build-report.json', 'candidates.json')):
        raise CandidateError('candidate_attempt_already_recorded')
    journal = {'version': 1, 'identity': scope, 'templates': {
        kind: {'kind': kind, 'name': candidate_name(scope, kind), 'creationStarted': False, 'collision': False} for kind in KINDS},
        'sandboxes': [], 'pendingSandbox': None}
    # Never claim an existing alias as this attempt's cleanup responsibility.
    try:
        for row in journal['templates'].values():
            with quiet_sdk():
                builder.assert_new_template(row['name'], api_key)
    except BaseException as error:
        write_private(output / 'build-report.json', {'identity': scope, 'status': 'failed',
            'stage': 'preflight', 'code': error_code(error), 'diagnostic': build_diagnostic(error, {})}, exclusive=True)
        raise CandidateError('candidate_preflight_failed') from error
    write_private(output / JOURNAL, journal, exclusive=True)
    templates, logs, stage = {}, {}, 'build'
    try:
        for kind in KINDS:
            row = journal['templates'][kind]
            row['creationStarted'] = True
            write_private(output / JOURNAL, journal)
            stage = 'build_' + kind
            logs[kind] = BuildDiagnostics(journal, output, kind)
            try:
                with quiet_sdk():
                    source, result = builder.build(row['name'], scope['sourceCommit'], api_key=api_key,
                        on_build_logs=logs[kind], kind=kind, cpu_count=2, memory_mb=4096)
            except ValueError as error:
                if error.args == ('template_name_already_exists',):
                    row['collision'] = True
                    write_private(output / JOURNAL, journal)
                raise
            if not row.get('templateId') or not row.get('buildId'):
                raise CandidateError('candidate_build_identity_missing')
            if (row['templateId'], row['buildId']) != (resource_id(result.template_id), resource_id(result.build_id)):
                raise CandidateError('candidate_identity_mismatch')
            if source != scope['sourceCommit'] or any(item['templateId'] == row['templateId'] for item in templates.values()):
                raise CandidateError('candidate_identity_mismatch')
            stage = 'private_' + kind
            private_ready(row, api_key, request)
            entry = {key: row[key] for key in ('name', 'templateId', 'buildId')}
            entry.update(baseTemplate=kind, preinstalled=True)
            factory = tracked_factory(journal, output, kind, api_key, sdk, request)
            stage = 'models_' + kind
            with quiet_sdk():
                entry['models'] = builder.probe_models(row['templateId'], kind, api_key, scope['sourceCommit'], scope['workerSha'], factory)
            stage = 'conservation_' + kind
            with quiet_sdk():
                entry['conservation'] = builder.probe_conservation(row['templateId'], api_key, kind, factory)
            private_ready(row, api_key, request)
            entry['privateVerified'] = True
            templates[kind] = entry
        stage = 'probe_cleanup'
        with quiet_sdk():
            sandboxes, errors = sandbox_cleanup(journal, output, api_key, sdk, request)
        if errors or any(row['status'] not in ('absent', 'deleted') for row in sandboxes):
            raise CandidateError('probe_cleanup_incomplete')
        result = {'sourceCommit': scope['sourceCommit'], 'workerSha': scope['workerSha'], 'templates': templates}
        write_private(output / 'candidates.json', result, exclusive=True)
        write_private(output / 'build-report.json', {'identity': scope, 'status': 'passed', 'stage': 'complete',
            'diagnostic': build_diagnostic(None, logs)}, exclusive=True)
        return result
    except BaseException as error:
        diagnostic = build_diagnostic(error, logs)
        if stage in ('build_claude', 'build_codex'):
            kind = stage.removeprefix('build_')
            row = journal['templates'][kind]
            if row.get('templateId') and row.get('buildId'):
                try:
                    diagnostic['statusLookup'] = failed_build_status(scope, output, kind, row, api_key)
                except BaseException as lookup_error:
                    # Even an unexpected diagnostic bug cannot skip cleanup or
                    # replace the original SDK BuildException/cause chain.
                    diagnostic['statusLookup'] = {'attempted': True, 'identityMatched': False,
                        'complete': False, 'outcome': 'unavailable',
                        'failure': debug_failure('request_failed', lookup_error)['failure']}
        write_private(output / 'build-report.json', {'identity': scope, 'status': 'failed', 'stage': stage,
            'code': error_code(error), 'diagnostic': diagnostic}, exclusive=True)
        try:
            cleanup(scope, output, api_key, sdk, request)
        except BaseException as cleanup_error:
            # Keep the original build failure; always-cleanup can retry using
            # the durable journal. No SDK text or key enters this report.
            write_private(output / 'cleanup-error.json', {'identity': scope, 'confirmed': False,
                'stage': 'cleanup', 'code': error_code(cleanup_error), 'diagnostic': exception_diagnostic(cleanup_error)}, exclusive=True)
        raise CandidateError('candidate_build_failed') from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('build', 'cleanup'))
    parser.add_argument('--source-ref', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    stage = 'identity'
    try:
        scope = identity(args.source_ref, os.environ)
        output = output_directory(args.output)
        stage = 'credential'
        api_key = os.environ.get('E2B_API_KEY')
        if not api_key:
            raise CandidateError('api_key_missing')
        from e2b import Sandbox, SandboxQuery, SandboxState
        sdk = (Sandbox, SandboxQuery, SandboxState)
        stage = args.operation
        if args.operation == 'build':
            build_candidates(scope, output, api_key, sdk)
            report, passed = 'candidates.json', True
        else:
            result, report = cleanup(scope, output, api_key, sdk)
            passed = result['confirmed']
        print(json.dumps({'operation': args.operation, 'status': 'passed' if passed else 'failed', 'report': report}))
        return 0 if passed else 1
    except BaseException as error:
        print(json.dumps({'operation': args.operation, 'status': 'failed', 'stage': stage, 'code': error_code(error),
                          'diagnostic': exception_diagnostic(error)}))
        return 1


if __name__ == '__main__':
    sys.exit(debug_page_main() if sys.argv[1:] == ['_debug-page'] else main())
