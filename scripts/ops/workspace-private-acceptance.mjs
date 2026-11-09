/** Fixed public product source under the existing Ops workload. No identity,
 * publication, model or production-account operation is added here. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertOpsContext } from './self-hosted-ingress-probe.mjs'

export const P0 = Object.freeze({
  source: '06a3ec1e6567dcd5da95757ad11b1b7db46a127b',
  tree: '650b5f348ea8c90da2c4389d4f84e9784c69c7ee',
  workerSha: '300c7be89fb2bbb701e29d4c74ec7962694613e1',
  sdks: { nodeMajor: '24', pnpm: '10.34.3', javascriptE2b: '2.61.0', pythonE2b: '2.62.0', next: '16.4.1' },
  files: {
    'package.json': '42e0321a095d434bb22437cfd2a3685cbbfb0d0d66576e334aeab2d05e50eb47',
    'pnpm-lock.yaml': 'e18697f2dd891b9159e43e40d1f8af4018d087cf2a0e668b9e358a766b020c28',
    'pnpm-workspace.yaml': '5a24e67ade7fae19b2d160b4ca61b58170eb3c04a18f8b06efb9a5a0fae36b9f',
    'scripts/e2b/workspace-candidates.py': '2440d02b368288e4a6e8a618f65e2ecca88f5a0251a0a005f9c71b6c0c977237',
    'scripts/e2b/workspace-candidates.test.py': 'ce408974f1841de2ba164cd108b69c7dfc1d3bcab8c4cc84c9d1cc7db5622b37',
    'scripts/e2b/build-template.py': '33ff017fa85e6e05fbdf7d0e8a5c59db4da98825e2aff73ac3314956e479b42c',
    'scripts/e2b/build-template.test.py': '0481716b0fd2accfd66d08975ceee67ac5fdf6ae82c3918c20164632c79a3ed2',
    'scripts/e2b/official-files.py': '66911624af52df59ef715eb105af9a3025bacf12460105fadc7f87e4d2dd63b5',
    'scripts/e2b/official-files.test.py': '0d31956e8825cedd739563404ae5d31c80b9388310399968b297344c581a3201',
    'scripts/e2b/cleanup-template-candidates.py': '893b0d50f30f4b21f92f155aee97965e12f84fd0e21ea0ada3dfb3a00392533d',
    'scripts/e2b/cleanup-template-candidates.test.py': '826a489c570a788ea018b6a6ce786fd3e71b41dc8d514cfd8a09e516f8bf84f1',
    'scripts/e2b/workspace-ingress-acceptance.mjs': '880497f82bb3135b33315abd8d10d1cebe113289cccfd34abb315197c37e102e',
    'scripts/e2b/workspace-ingress-acceptance.test.mjs': '899641f96cb548158b733f043d509640eb6aaf6366bebe4e8199d2fb5aec9b0d',
    'scripts/e2b/workspace-ingress-servers.py': '5c0c12ff3f5573f7a6032a359a372b2a4697b17e44501c7d175bd10c809c74b8',
    'scripts/e2b/workspace-terminal-acceptance.mjs': 'd6d9d535c393e179eca800a44e5dfed508b06135d8891a793af05d539fa8252c',
    'scripts/e2b/workspace-terminal-acceptance.test.mjs': '971003d90739338112ae83838abc218811818600dcebe7fdbdd46b5e2214dce3',
    'scripts/e2b/fixtures/preview-frameworks/package.json': 'e0cf3ad9d36941898385fc4e149c65be9a1081d8685b4d0b03e92e547cae964d',
    'scripts/e2b/fixtures/preview-frameworks/package-lock.json': '9c123244b4ea44b3a59b92615e25b9780463135eab9f573b7342ad4df7468ef6',
    'packages/daemon/scripts/workspace-ingress.py': '24e02e301c7287e288347e18c90486a09f5b82802158a49efb9672f13c734e7b',
  },
})
// Copied only from the verified, closed creation journal in this exact artifact.
// This target is already deleted; the diagnostic must never create a replacement.
export const FINALIZE_DIAGNOSTIC = Object.freeze({
  runId: '42539385597', runAttempt: '1',
  opsSource: '4b330dff25a74c66a92530e9d12e6e91485e3797',
  sourceCommit: '37b0e55ddfca6646bc3beea7531048e6e63331c1',
  sourceTree: '2167f94b74c1ede4b8d37054fb407a462c0b470d',
  workerSha: '0537b0c49fe197240632ec7c74875c3af0c53260',
  templateId: '9k8a4ls6uimaeyvbipz4', buildId: 'dff39bb4-ce38-412f-8451-7dd75967a4fa',
  artifactId: 13641406353, artifactSha256: '6fc38ac8f6ba22cbdbb3dc39cc510ac4898b83d1256910e0ada27b74966e24b5',
})
const SOURCE_DIRECTORY = 'workspace-acceptance-source'
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/, KINDS = ['claude', 'codex']
const PURPOSE = 'mikka-workspace-ingress-acceptance'
const check = (value, code) => { if (!value) throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 16_384 }).trim()
const one = (value, allowed, fallback = 'invalid') => allowed.includes(value) ? value : fallback
const boundedId = value => typeof value === 'string' && ID.test(value) ? value : null
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
const flags = (value, names) => Object.fromEntries(names.map(key => [key, typeof value?.[key] === 'boolean' ? value[key] : null]))
const RUNTIME_CODES = ['configuration', 'source', 'candidate', 'scope', 'guard', 'process', 'ready', 'ports',
  'positive_control', 'raw_exposed', 'outbound', 'dependencies', 'preview', 'authentication', 'http', 'hmr',
  'revoke', 'takeover', 'takeover_bind', 'takeover_not_denied', 'resume', 'terminal', 'cleanup', 'journal', 'internal']
const BUILDER_CODES = ['api_key_missing', 'candidate_attempt_already_recorded', 'candidate_build_failed', 'candidate_build_not_ready',
  'candidate_build_identity_missing', 'candidate_build_status_invalid', 'candidate_identity_mismatch', 'candidate_name_mismatch', 'candidate_not_exact_private_template', 'candidate_preflight_failed',
  'creation_journal_invalid', 'creation_journal_missing', 'operation_failed', 'operation_interrupted', 'output_directory_invalid',
  'output_file_invalid', 'probe_cleanup_incomplete', 'probe_deletion_unconfirmed', 'probe_identity_reused', 'probe_scope_mismatch',
  'provider_http_error', 'resource_identity_invalid', 'sandbox_creation_unconfirmed', 'sandbox_deletion_unconfirmed',
  'sandbox_listing_limit', 'sandbox_scope_mismatch', 'source_checkout_modified', 'source_ref_invalid',
  'source_ref_not_checkout_head', 'template_cleanup_failed', 'worker_identity_invalid', 'workflow_identity_required',
  'template_build_failed', 'template_upload_failed', 'provider_authentication_failed', 'provider_rate_limited',
  'provider_busy', 'provider_disk_space', 'operation_timeout']
const BUILDER_ERROR_TYPES = ['CandidateError', 'Exception', 'RuntimeError', 'ValueError', 'TypeError', 'AssertionError',
  'OSError', 'FileNotFoundError', 'PermissionError', 'FileExistsError', 'JSONDecodeError', 'TimeoutError', 'KeyboardInterrupt',
  'SystemExit', 'CalledProcessError', 'TimeoutExpired', 'HTTPError', 'URLError', 'BuildException', 'FileUploadException',
  'SandboxException', 'TemplateException', 'AuthenticationException', 'InvalidArgumentException', 'NotEnoughSpaceException',
  'NotFoundException', 'TimeoutException', 'RateLimitException', 'ServiceBusyException', 'HTTPStatusError', 'RequestError',
  'ConnectError', 'ReadError', 'WriteError', 'RemoteProtocolError', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout',
  'PoolTimeout', 'UnexpectedStatus']
const BOOTSTRAP_PHASES = ['validation', 'source', 'node', 'gh', 'dependencies', 'build', 'cli', 'journal', 'desktop', 'finalize']
const PREBUILT_START_PHASES = ['entry', 'preconditions_verified', 'guard_prepare', 'guard_prepared',
  'control_install', 'control_installed', 'worker_exec']
const PREBUILT_READY_PHASES = ['pid_file', 'pid_read', 'pid_alive', 'worker_waiting', 'ingress_ready',
  'bootstrap_absent', 'device_absent', 'viewer_key_absent', 'viewer_unauthorized', 'official_files']
const INGRESS_DETAILS = ['listener', 'boot', 'identity', 'state', 'receipt', 'provider', 'command', 'tool', 'backend',
  'rule_order', 'late_install', 'worker', 'worker_order', 'operation', 'runtime']
const INGRESS_COMMAND_OPERATIONS = ['new_chain', 'provider_rule', 'reply_rule', 'output_jump', 'check_output',
  'check_provider', 'check_reply', 'list_output', 'list_chain',
  'create_table', 'base_chain', 'install_policy', 'list_ruleset', 'list_table']
const INGRESS_COMMAND_FLAGS = ['unsupportedRevision', 'missingKernelModule', 'missingExtension',
  'operationNotSupported', 'permissionDenied', 'invalidArgument']
const BUILD_HOST_ERRORS = ['official_cli_kind_invalid', 'official_cli_path_invalid', 'official_cli_baseline_mismatch',
  'official_cli_missing', 'official_cli_manifest_invalid', 'runtime_cli_missing', 'cli_relocation_invalid',
  'added_cli_paths_invalid', 'official_cli_changed', 'added_cli_path_invalid', 'official_cli_manifest_untrusted',
  'runtime_cli_changed', 'runtime_cli_unavailable', 'official_cli_manifest_changed', 'e2b_finalization_policy_invalid',
  'e2b_certificate_policy_invalid', 'official_conservation_invalid', 'official_manifest_invalid', 'official_files_removed',
  'official_files_changed', 'e2b_certificate_target_invalid', 'terminal_control_install_refused']
const CONSERVATION_FAILURE_CODES = ['official_manifest_invalid', 'official_conservation_invalid', 'official_conservation_missing',
  'official_files_removed', 'official_files_changed', 'e2b_certificate_target_invalid', 'conservation_failed',
  'conservation_diagnostic_too_large', 'conservation_metadata_invalid', 'conservation_diagnostic_invalid']
const CONSERVATION_FAILURE_STAGES = ['preload_receipts', 'preload_validation', 'fresh_scan', 'fresh_receipt', 'fresh_validation', 'unknown']
const CONSERVATION_FAILURE_CHECKS = ['pid_file', 'pid_read', 'pid_alive', 'worker_waiting', 'official_files']
const CONSERVATION_REMOVED_PATH_CODES = ['provider_shared_directory', 'provider_root_certificate',
  'provider_certificate_reference', 'provider_hashed_certificate_reference', 'redacted']
const BUILD_STAGES = ['identity', 'credential', 'preflight', 'build', 'complete', 'cleanup', 'probe_cleanup',
  ...KINDS.flatMap(kind => ['build', 'private', 'models', 'conservation'].map(prefix => `${prefix}_${kind}`))]
const RUNTIME_STAGES = ['create', 'identity', 'prelistener_guard', 'initial_ingress', 'gateway_listener_wiring',
  'framework_dependencies', 'next', 'vite', 'terminal', 'pause_resume', 'completed']
const IDENTITY_OPERATIONS = ['get_info', 'source_command', 'source_compare']
const IDENTITY_ERROR_TYPES = ['Error', 'TypeError', 'SyntaxError', 'CommandExitError', 'ConnectError',
  'SandboxError', 'SandboxNotFoundError', 'SandboxNotRunningError', 'SandboxUnreachableError', 'FileNotFoundError',
  'NotFoundError', 'ServiceBusyError', 'RateLimitError', 'AuthenticationError', 'InvalidArgumentError',
  'NotEnoughSpaceError', 'TimeoutError', 'AbortError']
const CLEANUP_OUTCOMES = ['creation_not_requested', 'no_creation_journal', 'creation_unconfirmed',
  'provider_already_absent', 'provider_kill_acknowledged_and_absent', 'provider_absence_not_confirmed', 'cleanup_failed']
const FRAMEWORK_FLAGS = ['rawDenied', 'authenticatedHttp', 'assets', 'hotReload', 'crossSiteBootstrap', 'revoked', 'takeoverDenied']
const FRAMEWORK_VERSIONS = { next: '16.4.1', vite: '8.3.6', react: '19.3.1', 'react-dom': '19.3.1' }
const exitCode = number => Number.isInteger(number) && number >= -255 && number <= 255 ? number : null
const DEBUG_FAILURE_CODES = ['journal_refused', 'request_failed', 'request_timeout', 'worker_failed', 'body_limit',
  'response_refused', 'http_error', 'unauthorized', 'forbidden', 'not_found', 'not_terminal', 'status_changed', 'time_limit', 'page_limit']
const DEBUG_REASON_CATEGORIES = ['configuration_failed', 'ready_failed', 'ready_timeout', 'start_confirmation_failed',
  'start_failed', 'process_start_failed', 'sync_failed', 'deadline_exceeded']
const debugCategories = value => [...new Set((Array.isArray(value) ? value.slice(0, 8) : [])
  .filter(code => DEBUG_REASON_CATEGORIES.includes(code)))].sort()
const debugCount = (value, maximum) => count(value) !== null && value <= maximum ? value : null

function diagnosticException(value) {
  return {
    exceptionChain: (Array.isArray(value?.exceptionChain) ? value.exceptionChain.slice(0, 8) : []).map(row => ({
      type: one(row?.type, BUILDER_ERROR_TYPES, 'other'), code: one(row?.code, BUILDER_CODES, 'operation_failed'),
      httpStatus: status(row?.httpStatus), exitCode: exitCode(row?.exitCode),
    })),
    exceptionChainTruncated: value?.exceptionChainTruncated === true,
  }
}

function buildStatusLookup(value) {
  if (!value || typeof value !== 'object') return null
  const matched = value.identityMatched === true
  const requests = debugCount(value.requests, 6), pages = debugCount(value.pages, 6), entries = debugCount(value.entries, 600)
  const limits = { pages: 6, entriesPerPage: 100, totalSeconds: 90, requestSeconds: 15 }
  const bounded = Object.entries(limits).every(([key, expected]) => value.limits?.[key] === expected)
  return { attempted: value.attempted === true, identityMatched: matched,
    outcome: one(value.outcome, ['available', 'partial', 'unavailable'], null),
    complete: matched && bounded && value.complete === true && value.outcome === 'available' && !value.failure
      && ['ready', 'error'].includes(value.status) && requests >= 1 && pages >= 1 && requests >= pages
      && entries !== null && entries >= (pages - 1) * 100 && entries < pages * 100,
    requests, pages, entries, limits: bounded ? limits : null,
    status: matched ? one(value.status, ['building', 'waiting', 'ready', 'error'], null) : null,
    step: { phase: matched ? one(value.step?.phase, ['base', 'workdir', 'private_directory', 'copy_runtime', 'official_capture',
      'bootstrap', 'npm_runtime', 'official_verify', 'worker_user', 'finalize', 'unknown']) : null,
    index: matched ? count(value.step?.index) : null },
    exitCode: matched ? exitCode(value.exitCode) : null,
    exitCodeSource: matched && exitCode(value.exitCode) !== null ? one(value.exitCodeSource, ['provider_reason'], null) : null,
    categories: matched ? debugCategories(value.categories) : [],
    reasonLogEntries: matched ? count(value.reasonLogEntries) : null,
    reasonLogEntriesTruncated: value.reasonLogEntriesTruncated === true,
    debugLogs: matched ? debugBuildLogs(value.debugLogs) : null,
    failure: value.failure ? { code: one(value.failure.code, DEBUG_FAILURE_CODES, null),
      httpStatus: status(value.failure.httpStatus), ...diagnosticException(value.failure) } : null }
}

function ingressCommand(value) {
  if (!value || !['ipv4', 'ipv6', 'inet'].includes(value.family) || !INGRESS_COMMAND_OPERATIONS.includes(value.operation)
    || !['exit', 'timeout', 'output_limit', 'execution'].includes(value.failureKind)
    || !(value.returnCode === null || exitCode(value.returnCode) !== null)
    || INGRESS_COMMAND_FLAGS.some(key => typeof value[key] !== 'boolean')) return null
  const extension = one(value.extension, ['owner', 'multiport', 'conntrack', 'mark', 'tcp'], 'unknown')
  const revision = extension !== 'unknown' && Number.isInteger(value.revision) && value.revision >= 0 && value.revision <= 255 ? value.revision : null
  const unsupported = (Array.isArray(value.unsupportedExtensions) ? value.unsupportedExtensions.slice(0, 6) : [])
    .filter(row => ['owner', 'multiport', 'conntrack', 'mark', 'tcp'].includes(row?.extension))
    .map(row => ({ extension: row.extension, revision: Number.isInteger(row.revision) && row.revision >= 0 && row.revision <= 255 ? row.revision : null }))
  const unsupportedExtensions = [...new Map(unsupported.map(row => [JSON.stringify(row), row])).values()]
    .sort((a, b) => a.extension.localeCompare(b.extension) || (a.revision ?? -1) - (b.revision ?? -1))
  return { ...Object.fromEntries(['family', 'operation', 'failureKind', 'returnCode', ...INGRESS_COMMAND_FLAGS].map(key => [key, value[key]])),
    extension, revision, unsupportedExtensions }
}

function conservationChanges(value) {
  const paths = ['provider_shared_directory', 'provider_root_certificate',
    'provider_certificate_reference', 'provider_hashed_certificate_reference']
  const kinds = ['file', 'link', 'directory', 'special']
  const fields = ['kind', 'sha256', 'mode', 'uid', 'gid', 'target', 'type', 'device']
  if (!value || !Number.isInteger(value.observedChanges) || value.observedChanges < 1 || value.observedChanges > 512
    || !Number.isInteger(value.redactedChanges) || value.redactedChanges < 0 || value.redactedChanges > value.observedChanges
    || typeof value.truncated !== 'boolean' || !Array.isArray(value.changes) || value.changes.length > 16
    || (value.truncated ? value.changes.length !== 16 || value.observedChanges - value.redactedChanges <= 16
      : value.observedChanges - value.redactedChanges !== value.changes.length)) return null
  const changes = []
  for (const row of value.changes) {
    if (!row || !paths.includes(row.pathCode) || !kinds.includes(row.kind) || !Array.isArray(row.fields)
      || !row.fields.length || row.fields.some(key => !fields.includes(key))
      || new Set(row.fields).size !== row.fields.length || typeof row.contentChanged !== 'boolean'
      || typeof row.targetChanged !== 'boolean' || row.contentChanged !== row.fields.includes('sha256')
      || row.targetChanged !== row.fields.includes('target')) return null
    const projected = {}
    for (const side of ['before', 'after']) {
      const state = row[side]
      if (!state || typeof state !== 'object' || Array.isArray(state)
        || Object.keys(state).some(key => !['kind', 'mode', 'uid', 'gid'].includes(key) || !row.fields.includes(key))
        || row.fields.filter(key => ['kind', 'mode', 'uid', 'gid'].includes(key)).some(key => !Object.hasOwn(state, key))
        || Object.entries(state).some(([key, item]) => item !== null && (key === 'kind' ? !kinds.includes(item)
          : !Number.isSafeInteger(item) || item < 0 || (key === 'mode' && item > 4095)))) return null
      projected[side] = Object.fromEntries(Object.entries(state))
    }
    changes.push({ pathCode: row.pathCode, kind: row.kind, fields: [...row.fields].sort(), ...projected,
      contentChanged: row.contentChanged, targetChanged: row.targetChanged })
  }
  return { observedChanges: value.observedChanges, redactedChanges: value.redactedChanges, truncated: value.truncated, changes }
}

function buildEvents(rows, debug = false) {
  const values = (Array.isArray(rows) ? rows.slice(0, 64) : []).flatMap(row => {
    let event
    switch (row?.phase) {
      case 'template_created': event = { phase: row.phase }; break
      case 'bootstrap': event = { phase: row.phase, detail: one(row.detail, BOOTSTRAP_PHASES), elapsedMs: count(row.elapsedMs) }; break
      case 'prebuilt_start':
        if (!PREBUILT_START_PHASES.includes(row.detail)) return []
        event = { phase: row.phase, detail: row.detail }; break
      case 'prebuilt_start_failed':
      case 'prebuilt_ready_failed': {
        const phases = row.phase === 'prebuilt_start_failed' ? PREBUILT_START_PHASES : PREBUILT_READY_PHASES
        if (!phases.includes(row.detail) || !Number.isInteger(row.exitCode) || row.exitCode < 1 || row.exitCode > 255) return []
        event = { phase: row.phase, detail: row.detail, exitCode: row.exitCode }; break
      }
      case 'ingress': {
        const command = row.detail === 'command' ? ingressCommand(row.command) : null
        event = { phase: row.phase, detail: one(row.detail, INGRESS_DETAILS), ...(command ? { command } : {}) }; break
      }
      case 'host_failure': {
        const conservation = row.detail === 'official_files_changed' ? conservationChanges(row.conservation) : null
        event = { phase: row.phase,
          detail: one(row.detail, debug ? [...BUILD_HOST_ERRORS, 'anonymous_worker_unavailable'] : BUILD_HOST_ERRORS),
          ...(conservation ? { conservation } : {}) }; break
      }
      case 'conservation_failed': {
        if (!CONSERVATION_FAILURE_CODES.includes(row.detail) || !CONSERVATION_FAILURE_STAGES.includes(row.stage)) return []
        const conservation = conservationChanges(row.conservation), code = exitCode(row.exitCode)
        event = { phase: row.phase, detail: row.detail, stage: row.stage,
          ...(CONSERVATION_FAILURE_CHECKS.includes(row.check) ? { check: row.check } : {}),
          ...(code !== null ? { exitCode: code } : {}), ...(conservation ? { conservation } : {}),
          ...(CONSERVATION_REMOVED_PATH_CODES.includes(row.removedPathCode) ? { removedPathCode: row.removedPathCode } : {}) }; break
      }
      case 'official_capture': event = { phase: row.phase, entries: count(row.entries) }; break
      case 'ready_rejected':
        if (!debug) return []
        event = { phase: row.phase, categories: debugCategories(row.categories), exitCode: exitCode(row.exitCode) }; break
      default: return []
    }
    return [{ ...event, ...(debug ? { count: count(row.count) } : {}) }]
  })
  return values
}

function debugBuildLogs(value) {
  if (!value || typeof value !== 'object') return null
  return { entries: debugCount(value.entries, 1200), ignoredLines: count(value.ignoredLines),
    oversizedEntries: debugCount(value.oversizedEntries, 1200), truncated: value.truncated === true,
    levels: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, debugCount(value.levels?.[level], 1200)])),
    signals: { ...flags(value.signals, ['startAnnounced', 'readyAnnounced', 'templateReady']),
      readyRejected: count(value.signals?.readyRejected) }, events: buildEvents(value.events, true) }
}

function buildDiagnostic(value) {
  if (!value || typeof value !== 'object') return null
  return {
    ...diagnosticException(value),
    statusLookup: buildStatusLookup(value.statusLookup),
    buildLogs: Object.fromEntries(KINDS.filter(kind => value.buildLogs?.[kind]).map(kind => {
      const row = value.buildLogs[kind]
      return [kind, { entries: count(row.entries), ignoredLines: count(row.ignoredLines), oversizedEntries: count(row.oversizedEntries),
        truncated: row.truncated === true, events: buildEvents(row.events) }]
    })),
  }
}

function providerReason(message, step) {
  const text = typeof message === 'string' && message.length <= 65_536 ? message : ''
  // Fixed error prefixes from runtime@438a79cf finalize/builder.go and ready.go.
  // Their presence is an observation, not proof the deployed provider uses that revision.
  const patterns = {
    configuration_failed: /(?:^|: )configuration script failed:/,
    ready_failed: /(?:^|: )ready command failed:/,
    ready_timeout: /\bready command timed out after [0-9.hmsµ]+(?:\s|$)/,
    start_confirmation_failed: /(?:^|: )waiting for start command failed:/,
    start_failed: /(?:^|: )(?:error running )?start command failed:|(?:^|: )error running start command:/,
    process_start_failed: /(?:^|: )error starting process:/,
    sync_failed: /(?:^|: )error running sync command:/,
    deadline_exceeded: /\bcontext deadline exceeded\b/,
  }
  const codes = [...text.matchAll(/\bexit (?:status|code):?\s+(-?[0-9]{1,3})(?=$|[\s,;)])/gi)]
    .map(match => Number(match[1])).filter(number => exitCode(number) !== null)
  const unique = [...new Set(codes)]
  return { phase: one(step, ['base', 'finalize'], null),
    categories: Object.entries(patterns).filter(([, pattern]) => pattern.test(text)).map(([code]) => code).sort(),
    exitCode: unique.length === 1 ? unique[0] : null }
}

async function diagnosticJson(response) {
  const chunks = []; let bytes = 0
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length
    check(bytes <= 1_048_576, 'workspace_build_diagnostic_body_limit')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch (error) { throw new Error('workspace_build_diagnostic_response_refused', { cause: error }) }
}

/** Finite pages from one completed build, not another build wait or retry loop.
 * The SDK 2.62.0 generated status endpoint supports level/limit/logsOffset;
 * its high-level Template.get_build_status does not expose the level argument. */
export async function diagnoseExistingBuild(apiKey, { fetchImpl = fetch, now = () => performance.now() } = {}) {
  const result = { version: 1, scope: 'existing_deleted_build_read_only', target: FINALIZE_DIAGNOSTIC,
    resourcesCreated: false, mutationsPerformed: false, runtimeAcceptance: false,
    outcome: 'unavailable', complete: false, identityMatched: false, status: null, failure: null,
    limits: { pages: 6, entriesPerPage: 100, totalMs: 90_000, requestMs: 15_000 },
    requests: 0, pages: 0, entries: 0, reasonLogEntries: 0, ignoredLines: 0, oversizedEntries: 0,
    levels: { debug: 0, info: 0, warn: 0, error: 0 },
    reason: { phase: null, categories: [], exitCode: null }, events: [], eventsTruncated: false,
    signals: { startAnnounced: false, readyAnnounced: false, templateReady: false, readyRejected: 0 } }
  const fail = (code, httpStatus = null) => {
    result.failure = { code, httpStatus }; result.outcome = result.pages ? 'partial' : 'unavailable'; return result
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) return fail('credential_missing')
  const deadline = now() + result.limits.totalMs, observed = new Map()
  const event = value => {
    const key = JSON.stringify(value), previous = observed.get(key)
    if (previous) { previous.count++; return }
    if (observed.size === 64) { result.eventsTruncated = true; return }
    const row = { ...value, count: 1 }; observed.set(key, row); result.events.push(row)
  }
  const consume = entry => {
    if (!entry || !Object.hasOwn(result.levels, entry.level)) { result.ignoredLines++; return }
    result.levels[entry.level]++
    if (typeof entry.message !== 'string' || entry.message.length > 65_536) { result.oversizedEntries++; return }
    for (const raw of entry.message.split('\n')) {
      let line = raw.trim()
      if (line.startsWith('Running start command: ')) { result.signals.startAnnounced = true; continue }
      if (line.startsWith('Waiting for template to be ready: ')) { result.signals.readyAnnounced = true; continue }
      if (line === 'Template is ready') { result.signals.templateReady = true; continue }
      if (line.startsWith('Template is not ready: ')) {
        result.signals.readyRejected++; event({ kind: 'ready_rejected', ...providerReason(line.slice(23), 'finalize') }); continue
      }
      const wrapped = /^\[(?:builder ([1-9][0-9]?)\/([1-9][0-9]?)|start|ready)\] \[(?:stdout|stderr)\]: (.*)$/.exec(line)
      if (wrapped && (wrapped[1] === undefined || Number(wrapped[1]) <= Number(wrapped[2]))) line = wrapped[3]
      const phase = /^mikka-bootstrap-phase ([a-z]+) ([0-9]{1,9})$/.exec(line)
      if (phase && BOOTSTRAP_PHASES.includes(phase[1])) {
        event({ kind: 'bootstrap', detail: phase[1], elapsedMs: Number(phase[2]) }); continue
      }
      if (line === 'Cloud worker unavailable') { event({ kind: 'host_failure', detail: 'anonymous_worker_unavailable' }); continue }
      const failure = /^(?:ValueError|RuntimeError): ([a-z_]+)(?: |$)/.exec(line)
      const detail = failure?.[1] ?? line
      if (BUILD_HOST_ERRORS.includes(detail)) { event({ kind: 'host_failure', detail }); continue }
      let value
      try { value = line.startsWith('{') ? JSON.parse(line) : null } catch { value = null }
      if (value && typeof value === 'object' && value.ok === false && INGRESS_DETAILS.includes(value.detail)
        && Object.keys(value).every(key => ['ok', 'detail', 'command'].includes(key))) {
        const command = value.detail === 'command' ? ingressCommand(value.command) : null
        event({ kind: 'ingress', detail: value.detail, ...(command ? { command } : {}) }); continue
      }
      result.ignoredLines++
    }
  }
  for (let page = 0; page < result.limits.pages; page++) {
    const remaining = deadline - now()
    if (remaining <= 0) return fail('time_limit')
    const url = `https://api.e2b.dev/templates/${FINALIZE_DIAGNOSTIC.templateId}/builds/${FINALIZE_DIAGNOSTIC.buildId}/status?level=debug&logsOffset=${result.entries}&limit=100`
    let response, data
    try {
      result.requests++
      response = await fetchImpl(url, { method: 'GET', redirect: 'error',
        headers: { Accept: 'application/json', 'X-API-Key': apiKey },
        signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(result.limits.requestMs, remaining)))) })
      if ([401, 403, 404].includes(response.status)) {
        await response.body?.cancel()
        return fail({ 401: 'unauthorized', 403: 'forbidden', 404: 'not_found' }[response.status], response.status)
      }
      if (response.status !== 200 && response.status !== 400) { await response.body?.cancel(); return fail('http_error', response.status) }
      data = await diagnosticJson(response)
    } catch (error) {
      const code = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'request_timeout'
        : error?.message === 'workspace_build_diagnostic_body_limit' ? 'body_limit'
          : error?.message === 'workspace_build_diagnostic_response_refused' ? 'response_refused' : 'network_error'
      return fail(code)
    }
    if (response.status === 400) return fail(data?.message === `Build '${FINALIZE_DIAGNOSTIC.buildId}' not found` ? 'not_found' : 'http_error', 400)
    if (data?.templateID !== FINALIZE_DIAGNOSTIC.templateId || data?.buildID !== FINALIZE_DIAGNOSTIC.buildId
      || !['waiting', 'building', 'ready', 'error'].includes(data.status)
      || !Array.isArray(data.logEntries) || data.logEntries.length > 100) return fail('response_refused')
    if (result.status !== null && data.status !== result.status) return fail('status_changed')
    result.identityMatched = true; result.status = data.status; result.pages++
    if (data.status === 'waiting' || data.status === 'building') return fail('not_terminal')
    if (page === 0) result.reason = providerReason(data.reason?.message, data.reason?.step)
    result.reasonLogEntries += Array.isArray(data.reason?.logEntries) ? Math.min(data.reason.logEntries.length, 100) : 0
    result.entries += data.logEntries.length
    for (const entry of data.logEntries) consume(entry)
    if (now() >= deadline) return fail('time_limit')
    if (data.logEntries.length < 100) { result.outcome = 'available'; result.complete = true; return result }
  }
  return fail('page_limit')
}

export function assertSourceIdentity({ source, tree, dirty, opsDirty, files }) {
  check(source === P0.source && tree === P0.tree && dirty === false && opsDirty === false
    && Object.entries(P0.files).every(([file, digest]) => files?.[file] === digest), 'workspace_source_refused')
}

async function verifySources(directory, env = process.env) {
  assertOpsContext(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')), git(process.cwd(), 'rev-parse', 'HEAD'))
  check(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') && env.P0_SOURCE === P0.source, 'workspace_context_refused')
  check(directory === resolve(SOURCE_DIRECTORY) && await realpath(directory) === directory
    && git(directory, 'rev-parse', '--show-toplevel') === directory, 'workspace_checkout_refused')
  const files = Object.fromEntries(await Promise.all(Object.keys(P0.files).map(async file => {
    const path = resolve(directory, file), info = await lstat(path)
    check(info.isFile() && !info.isSymbolicLink(), 'workspace_source_file_refused')
    return [file, hash(await readFile(path))]
  })))
  assertSourceIdentity({ source: git(directory, 'rev-parse', 'HEAD'), tree: git(directory, 'rev-parse', 'HEAD^{tree}'), files,
    dirty: git(directory, 'status', '--porcelain', '--untracked-files=all') !== '',
    opsDirty: git(process.cwd(), 'status', '--porcelain', '--untracked-files=all', '--', '.', `:(exclude)${SOURCE_DIRECTORY}`) !== '' })
  return { version: 1, opsSource: env.GITHUB_SHA, sourceCommit: P0.source, sourceTree: P0.tree,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, files, sourceVerified: true }
}

export function assertDependencies(versions) {
  check(Object.entries(P0.sdks).every(([key, value]) => versions?.[key] === value), 'workspace_dependency_refused')
}

export function assertWorkerIdentity(workerSha) {
  check(workerSha === P0.workerSha, 'workspace_worker_refused')
}

function scopeMatches(value, context) {
  return value?.sourceCommit === P0.source && value.workerSha === context.workerSha && value.workflowCommit === context.opsSource
    && value.runId === context.runId && value.runAttempt === context.runAttempt
}
function validCandidate(row, kind) {
  return row?.baseTemplate === kind && row.preinstalled === true && row.privateVerified === true
    && ID.test(row.templateId ?? '') && ID.test(row.buildId ?? '') && count(row.conservation?.before?.entries) > 0
    && DIGEST.test(row.conservation?.before?.sha256 ?? '')
    && row.conservation.before.entries === row.conservation.after?.entries && row.conservation.before.sha256 === row.conservation.after?.sha256
}
function journalMatches(row, kind, candidate, context) {
  return row?.version === 1 && row.purpose === PURPOSE && row.kind === kind && row.sourceCommit === P0.source
    && row.workerSha === context.workerSha && row.opsSource === context.opsSource
    && row.runId === context.runId && row.runAttempt === context.runAttempt && UUID.test(row.fixtureId ?? '')
    && row.templateId === candidate?.templateId && typeof row.creationRequested === 'boolean'
    && (row.sandboxId === null || ID.test(row.sandboxId ?? '')) && (row.creationRequested || row.sandboxId === null)
}
function guardEvidence(value) {
  return { sourceSha256: DIGEST.test(value?.sourceSha256 ?? '') ? value.sourceSha256 : null,
    bootId: UUID.test(value?.bootId ?? '') ? value.bootId : null, version: count(value?.version),
    installedTicks: count(value?.installedTicks), workerPid: count(value?.workerPid), workerStartTicks: count(value?.workerStartTicks),
    providerPorts: Array.isArray(value?.providerPorts) ? value.providerPorts.filter(port => port === 49983 || port === 50005).slice(0, 2) : [],
    ...flags(value, ['ok', 'preparedBeforeWorker', 'workerStartedAfterGuard']), rulesVerified: flags(value?.rulesVerified, ['ipv4', 'ipv6']) }
}
function marker(value) { return { status: status(value?.status), markerMatched: value?.markerMatched === true } }
function ingressEvidence(value) {
  const raw = ['userLoopback4', 'userPublic4', 'userLoopback6']
  return { local: flags(value?.local, raw), external: Object.fromEntries([...raw, 'rootMarked'].map(name => [name, marker(value?.external?.[name])])) }
}
function identityFailureEvidence(value) {
  if (!value || !IDENTITY_OPERATIONS.includes(value.operation)) return null
  const rows = Array.isArray(value.exceptionChain) ? value.exceptionChain : []
  return { operation: value.operation, truncated: value.truncated === true || rows.length > 4,
    exceptionChain: rows.slice(0, 4).map(row => {
      const type = one(row?.type, IDENTITY_ERROR_TYPES, 'other')
      return { type,
        reason: type === 'Error' && row?.reason === 'process_start_event_missing' ? row.reason
          : type === 'SandboxError' && row?.reason === 'process_result_missing' ? row.reason : null,
        exitCode: type === 'CommandExitError' ? exitCode(row?.exitCode) : null,
        httpStatus: status(row?.httpStatus),
        connectCode: type === 'ConnectError' && Number.isInteger(row?.connectCode)
          && row.connectCode >= 1 && row.connectCode <= 16 ? row.connectCode : null }
    }), stderr: flags(value.stderr, ['gitDubiousOwnership', 'gitNotRepository', 'oversized']) }
}
function runtimeEvidence(row, kind) {
  return { kind, present: !!row, sourceCommit: SHA.test(row?.sourceCommit ?? '') ? row.sourceCommit : null,
    workerSha: SHA.test(row?.workerSha ?? '') ? row.workerSha : null, templateId: boundedId(row?.templateId), sandboxId: boundedId(row?.sandboxId),
    fixtureId: UUID.test(row?.fixtureId ?? '') ? row.fixtureId : null, stage: one(row?.stage, RUNTIME_STAGES),
    failure: row?.failure === undefined ? null : one(row.failure, RUNTIME_CODES, 'internal'), passed: row?.passed === true,
    identityDiagnostic: row?.stage === 'identity' ? identityFailureEvidence(row.identityDiagnostic) : null,
    ...flags(row, ['productionTaskAuthorityTested', 'subscriptionsTested', 'agentRootIsolationProven']),
    frameworkVersions: Object.fromEntries(Object.entries(FRAMEWORK_VERSIONS).map(([key, version]) => [key, row?.frameworkVersions?.[key] === version ? version : null])),
    frameworkLockSha256: DIGEST.test(row?.frameworkLockSha256 ?? '') ? row.frameworkLockSha256 : null,
    guard: guardEvidence(row?.guard), resumedGuard: guardEvidence(row?.resumedGuard),
    initialIngress: ingressEvidence(row?.initialIngress), resumedIngress: ingressEvidence(row?.resumedIngress),
    outbound: marker(row?.outbound), unassignedProviderPort: marker(row?.unassignedProviderPort),
    listenerWiring: { ...flags(row?.listenerWiring, ['realEntrypoints', 'browserFramesTested']),
      viewerUnauthenticatedStatus: status(row?.listenerWiring?.viewerUnauthenticatedStatus),
      subagentVersionStatus: status(row?.listenerWiring?.subagentVersionStatus),
      subagentUnauthenticatedStatus: status(row?.listenerWiring?.subagentUnauthenticatedStatus),
      subagentVersion: DIGEST.test(row?.listenerWiring?.subagentVersion ?? '') ? row.listenerWiring.subagentVersion : null },
    frameworks: Array.isArray(row?.frameworks) ? row.frameworks.slice(0, 2).map(value => ({ framework: one(value?.framework, ['next', 'vite']),
      ...flags(value, FRAMEWORK_FLAGS), unauthenticatedStatus: status(value?.unauthenticatedStatus), replayStatus: status(value?.replayStatus),
      hmrEvent: one(value?.hmrEvent, ['built', 'serverComponentChanges', 'update', 'full-reload']),
      websocket: { ...flags(value?.websocket, ['closed']), messages: count(value?.websocket?.messages), bytes: count(value?.websocket?.bytes), closeCode: count(value?.websocket?.closeCode) } })) : [],
    terminal: { passed: row?.terminal?.passed === true, exitCode: Number.isSafeInteger(row?.terminal?.exitCode) ? row.terminal.exitCode : null,
      checks: flags(row?.terminal?.checks, ['metadata', 'freshControl', 'gatewayReady', 'authenticatedHealth', 'unauthorizedStream',
        'unauthorizedInput', 'streamReady', 'stdout', 'resize', 'stdin', 'exit', 'postExitRefused']),
      statuses: Object.fromEntries(['unauthorizedStream', 'unauthorizedInput', 'stream', 'resize', 'postExit'].map(key => [key, status(row?.terminal?.statuses?.[key])])),
      cleanup: flags(row?.terminal?.cleanup, ['leaseRevoked', 'ptyStopped', 'gatewayStopped', 'receiptRestored', 'filesRemoved']) } }
}
const cleanupEvidence = row => ({ kind: one(row?.kind, KINDS), ...flags(row, ['stopped', 'absent', 'scopeVerified', 'killAcknowledged']),
  outcome: one(row?.outcome, CLEANUP_OUTCOMES) })

function conservationEvidence(value) {
  const digest = row => ({ entries: count(row?.entries), sha256: DIGEST.test(row?.sha256 ?? '') ? row.sha256 : null })
  const final = row => ({ kind: one(row?.kind, KINDS), policySha256: DIGEST.test(row?.policySha256 ?? '') ? row.policySha256 : null,
    ...Object.fromEntries(['before', 'after', 'originalBefore', 'originalAfter'].map(key => [key, digest(row?.[key])])),
    providerChangesCount: Array.isArray(row?.providerChanges) ? row.providerChanges.length : null })
  return { before: digest(value?.before), after: digest(value?.after), finalization: final(value?.finalization),
    preloadFinalization: value?.preloadFinalization ? final(value.preloadFinalization) : null }
}

function journalEvidence(context, builder, journals, candidates) {
  const builderMatched = builder?.version === 1 && scopeMatches(builder.identity, context)
  return { builder: builderMatched ? { version: 1,
    identity: { sourceCommit: P0.source, workerSha: context.workerSha, workflowCommit: context.opsSource,
      runId: context.runId, runAttempt: context.runAttempt },
    templates: Object.fromEntries(KINDS.map(kind => {
      const row = builder.templates?.[kind], name = `mikka-preview-${P0.source.slice(0, 12)}-${context.runId}-${context.runAttempt}-${kind}`
      return [kind, { kind, name: row?.name === name ? name : null, ...flags(row, ['creationStarted', 'collision']),
        templateId: boundedId(row?.templateId), buildId: boundedId(row?.buildId) }]
    })),
    sandboxes: Array.isArray(builder.sandboxes) ? builder.sandboxes.slice(0, 16).map(row => ({ sandboxId: boundedId(row?.sandboxId),
      templateId: boundedId(row?.templateId), kind: one(row?.kind, KINDS), ...flags(row, ['deletedConfirmed']) })) : [],
    pendingSandbox: builder.pendingSandbox === null ? null : { kind: one(builder.pendingSandbox?.kind, KINDS), templateId: boundedId(builder.pendingSandbox?.templateId) },
  } : null, runtime: Object.fromEntries(KINDS.map(kind => {
    const row = journals[kind]
    return [kind, journalMatches(row, kind, candidates?.templates?.[kind], context)
      ? Object.fromEntries(['version', 'purpose', 'sourceCommit', 'opsSource', 'workerSha', 'fixtureId', 'templateId', 'kind',
        'runId', 'runAttempt', 'creationRequested', 'sandboxId'].map(key => [key, row[key]])) : null]
  })) }
}

/** Summarization consumes only fixed-source receipts and emits a closed schema;
 * arbitrary SDK text, report fields, cookie/header values and URLs never copy. */
export function summarizeAcceptance(context, input) {
  check(SHA.test(context.opsSource) && context.workerSha === P0.workerSha
    && /^[1-9][0-9]*$/.test(context.runId) && /^[1-9][0-9]*$/.test(context.runAttempt), 'workspace_receipt_context')
  const { buildReport, candidates, builderJournal, templateCleanups = [], vmCleanup, runtime = {}, journals = {}, outcomes = {} } = input
  const buildPassed = scopeMatches(buildReport?.identity, context) && buildReport.status === 'passed' && buildReport.stage === 'complete'
    && candidates?.sourceCommit === P0.source && candidates.workerSha === context.workerSha
    && Object.keys(candidates.templates ?? {}).length === 2 && KINDS.every(kind => validCandidate(candidates.templates[kind], kind))
    && candidates.templates.claude.templateId !== candidates.templates.codex.templateId
  const cases = KINDS.map(kind => {
    const row = runtime[kind], journal = journals[kind], candidate = candidates?.templates?.[kind]
    const identityMatched = journalMatches(journal, kind, candidate, context) && row?.version === 1
      && row.sourceCommit === P0.source && row.workerSha === context.workerSha && row.templateId === journal.templateId
      && row.fixtureId === journal.fixtureId && row.sandboxId === journal.sandboxId && ID.test(row.sandboxId ?? '') && row.kind === kind
    const proof = runtimeEvidence(row, kind)
    const runtimePassed = identityMatched && row.passed === true && row.stage === 'completed'
      && proof.productionTaskAuthorityTested === false && proof.subscriptionsTested === false && proof.agentRootIsolationProven === false
      && proof.guard.ok && proof.guard.sourceSha256 === P0.files['packages/daemon/scripts/workspace-ingress.py']
      && proof.guard.preparedBeforeWorker && proof.guard.workerStartedAfterGuard && proof.guard.rulesVerified.ipv4 && proof.guard.rulesVerified.ipv6
      && ['bootId', 'sourceSha256', 'installedTicks', 'workerPid', 'workerStartTicks'].every(key => proof.guard[key] === proof.resumedGuard[key])
      && proof.resumedGuard.ok && proof.resumedGuard.rulesVerified.ipv4 && proof.resumedGuard.rulesVerified.ipv6
      && Object.values(proof.frameworkVersions).every(Boolean)
      && proof.frameworkLockSha256 === P0.files['scripts/e2b/fixtures/preview-frameworks/package-lock.json']
      && proof.frameworks.length === 2 && ['next', 'vite'].every(name => proof.frameworks.some(value => value.framework === name
        && FRAMEWORK_FLAGS.every(key => value[key] === true) && value.websocket.closed)) && proof.terminal.passed
    return { ...proof, identityMatched: !!identityMatched, runtimePassed: !!runtimePassed }
  })
  const runtimeCleanup = Array.isArray(vmCleanup?.cleanup) ? vmCleanup.cleanup.map(cleanupEvidence) : []
  const runtimeCleanupConfirmed = vmCleanup?.version === 1 && vmCleanup.sourceCommit === P0.source && vmCleanup.opsSource === context.opsSource
    && runtimeCleanup.length === 2 && KINDS.every(kind => {
      const rows = runtimeCleanup.filter(row => row.kind === kind), journal = journals[kind]
      if (rows.length !== 1 || !rows[0].stopped || !rows[0].absent) return false
      if (!journal) return rows[0].outcome === 'no_creation_journal' && !runtime[kind]
      if (!journalMatches(journal, kind, candidates?.templates?.[kind], context)) return false
      return ['creation_not_requested', 'provider_already_absent', 'provider_kill_acknowledged_and_absent'].includes(rows[0].outcome)
    })
  const templates = templateCleanups.map(value => ({ identityMatched: scopeMatches(value?.identity, context), confirmed: value?.confirmed === true,
    templates: Array.isArray(value?.templates) ? value.templates.slice(0, 2).map(row => ({ kind: one(row?.kind, KINDS), name: boundedId(row?.name),
      templateId: boundedId(row?.templateId), status: one(row?.status, ['absent', 'deleted', 'retained_public', 'failed']), code: one(row?.code, BUILDER_CODES, null) })) : [],
    sandboxes: Array.isArray(value?.sandboxes) ? value.sandboxes.slice(0, 16).map(row => ({ sandboxId: boundedId(row?.sandboxId),
      status: one(row?.status, ['absent', 'deleted', 'failed']), code: one(row?.code, BUILDER_CODES, null) })) : [],
    errors: Array.isArray(value?.errors) ? value.errors.slice(0, 32).map(row => ({ stage: one(row?.stage, ['sandbox_list', 'sandbox_create']), code: one(row?.code, BUILDER_CODES, 'operation_failed') })) : [{ stage: 'invalid', code: 'operation_failed' }] }))
  const latest = templates.at(-1)
  const ownedKinds = builderJournal?.version === 1 && scopeMatches(builderJournal.identity, context) && Array.isArray(builderJournal.sandboxes)
    ? KINDS.filter(kind => builderJournal.templates?.[kind]?.creationStarted === true && builderJournal.templates[kind].collision === false) : null
  const preflightRefused = !builderJournal && scopeMatches(buildReport?.identity, context) && buildReport.status === 'failed' && buildReport.stage === 'preflight'
  const templateCleanupConfirmed = !!(latest?.identityMatched && latest.confirmed && latest.errors.length === 0
    && [...latest.templates, ...latest.sandboxes].every(row => ['absent', 'deleted'].includes(row.status))
    && (preflightRefused ? latest.templates.length === 0 && latest.sandboxes.length === 0 : ownedKinds
      && builderJournal.pendingSandbox === null && latest.templates.length === ownedKinds.length
      && ownedKinds.every(kind => latest.templates.filter(row => row.kind === kind && row.name === builderJournal.templates[kind].name).length === 1)
      && latest.sandboxes.length === builderJournal.sandboxes?.length
      && builderJournal.sandboxes.every(row => latest.sandboxes.filter(value => value.sandboxId === row.sandboxId).length === 1)))
  const stepOutcomes = Object.fromEntries(['build', 'acceptance', 'vmCleanup', 'templateCleanup'].map(key =>
    [key, one(outcomes[key], ['success', 'failure', 'cancelled', 'skipped'])]))
  return { version: 1, sourceCommit: P0.source, sourceTree: P0.tree, ...context, scope: 'private_derived_candidates_only',
    productionTaskAuthorityTested: false, subscriptionsTested: false, agentRootIsolationProven: false,
    build: { passed: !!buildPassed, status: one(buildReport?.status, ['passed', 'failed']), stage: one(buildReport?.stage, BUILD_STAGES),
      code: one(buildReport?.code, BUILDER_CODES, null), diagnostic: buildDiagnostic(buildReport?.diagnostic) },
    candidates: Object.fromEntries(KINDS.map(kind => { const row = candidates?.templates?.[kind]
      return [kind, { baseTemplate: one(row?.baseTemplate, KINDS), templateId: boundedId(row?.templateId), buildId: boundedId(row?.buildId),
        ...flags(row, ['preinstalled', 'privateVerified']), conservation: conservationEvidence(row?.conservation) }]
    })),
    cases, journals: journalEvidence(context, builderJournal, journals, candidates), runtimeCleanup, templateCleanups: templates,
    stepOutcomes, runtimeCleanupConfirmed: !!runtimeCleanupConfirmed, templateCleanupConfirmed,
    passed: !!buildPassed && cases.every(row => row.runtimePassed) && !!runtimeCleanupConfirmed && templateCleanupConfirmed
      && Object.values(stepOutcomes).every(value => value === 'success') }
}

async function optionalJson(path) {
  try {
    const info = await lstat(path)
    check(info.isFile() && !info.isSymbolicLink() && info.size <= 262_144, 'workspace_report_refused')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

const REPORT_LIMIT = 262_144, CANDIDATES_LIMIT = 4 * 1024 * 1024
const RECEIPT_KEYS = ['buildReport', 'candidates', 'builderJournal', 'vmCleanup', 'templateCleanups', 'runtime', 'journals']

// Fixed report roles only. A refused report must not erase the independent
// runtime/cleanup evidence, and can never contribute a success or a raw digest.
async function closedReport(path, role, detail = {}) {
  const limit = role === 'candidates' ? CANDIDATES_LIMIT : REPORT_LIMIT
  const observation = { role, ...detail, type: 'unknown', bytes: null, limit, code: 'read_failed' }
  try {
    const info = await lstat(path)
    observation.type = info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
    observation.bytes = Number.isSafeInteger(info.size) && info.size >= 0 ? info.size : null
    if (!info.isFile() || info.isSymbolicLink()) observation.code = 'not_regular'
    else if (info.size > limit) observation.code = 'too_large'
    else {
      const raw = await readFile(path, 'utf8')
      observation.bytes = Buffer.byteLength(raw)
      if (observation.bytes > limit) observation.code = 'too_large'
      else {
        try { return { value: JSON.parse(raw), observation: { ...observation, code: 'ok' } } }
        catch { observation.code = 'invalid_json' }
      }
    }
  } catch (error) {
    if (error?.code === 'ENOENT') Object.assign(observation, { type: 'missing', bytes: null, code: 'missing' })
  }
  return { value: null, observation }
}

export async function readAcceptanceInputs(base, outcomes) {
  const builds = resolve(base, 'candidates'), runtime = resolve(base, 'runtime'), reports = []
  const take = async (path, role, detail) => {
    const result = await closedReport(path, role, detail)
    reports.push(result.observation)
    return result.value
  }
  let names = []
  try { names = await readdir(builds) }
  catch (error) {
    if (error?.code !== 'ENOENT') reports.push({ role: 'templateCleanupInventory', type: 'unknown', bytes: null, limit: null, code: 'read_failed' })
  }
  const cleanupNames = names.filter(name => /^cleanup(?:-(?:[2-9]|[1-9][0-9]+))?\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 1) - Number(b.match(/\d+/)?.[0] ?? 1))
  const input = {
    buildReport: await take(resolve(builds, 'build-report.json'), 'buildReport'),
    candidates: await take(resolve(builds, 'candidates.json'), 'candidates'),
    builderJournal: await take(resolve(builds, 'creation-journal.json'), 'builderJournal'),
    vmCleanup: await take(resolve(runtime, 'cleanup.json'), 'vmCleanup'),
    templateCleanups: [], runtime: {}, journals: {}, outcomes,
  }
  for (const [index, name] of cleanupNames.entries())
    input.templateCleanups.push(await take(resolve(builds, name), 'templateCleanups', { ordinal: index + 1 }))
  for (const kind of KINDS) {
    input.runtime[kind] = await take(resolve(runtime, `${kind}.json`), 'runtime', { kind })
    input.journals[kind] = await take(resolve(runtime, `${kind}.cleanup.json`), 'journals', { kind })
  }
  return { input, reports }
}

export function summarizeCollectedAcceptance(context, { input, reports }) {
  // The source gate ran before any report read. Only fixed-source projections
  // are retained here; arbitrary parser/SDK errors and report paths stay local.
  const refused = reports.filter(row => !['ok', 'missing'].includes(row.code))
  let verdict, projectionFailed = false
  try { verdict = summarizeAcceptance(context, input) }
  catch {
    projectionFailed = true
    verdict = summarizeAcceptance(context, { outcomes: input.outcomes })
    verdict.cases = KINDS.map(kind => {
      try { return { ...runtimeEvidence(input.runtime?.[kind], kind), identityMatched: false, runtimePassed: false } }
      catch { return { ...runtimeEvidence(null, kind), identityMatched: false, runtimePassed: false } }
    })
    verdict.runtimeCleanup = Array.isArray(input.vmCleanup?.cleanup)
      ? input.vmCleanup.cleanup.slice(0, 2).map(cleanupEvidence) : []
  }
  const unavailableReceipts = RECEIPT_KEYS.filter(key => refused.some(row => row.role === key
    || (key === 'templateCleanups' && row.role === 'templateCleanupInventory')))
  const receipts = Object.fromEntries(RECEIPT_KEYS.map(key => {
    if (unavailableReceipts.includes(key)) return [key, null]
    try { return [key, hash(JSON.stringify(input[key]))] }
    catch { projectionFailed = true; unavailableReceipts.push(key); return [key, null] }
  }))
  verdict.collection = { stage: projectionFailed ? 'projection' : refused.length ? 'report_read' : 'complete',
    code: projectionFailed ? 'projection_failed' : refused.length ? 'receipt_unavailable' : 'ok', reports }
  if (refused.length || projectionFailed) verdict.passed = false
  return { verdict, receipts, unavailableReceipts }
}
async function save(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

const COLLECTOR_FAILURE_CODES = ['workspace_ops_arguments', 'workspace_context_refused', 'workspace_checkout_refused',
  'workspace_source_file_refused', 'workspace_source_refused', 'workspace_dependency_refused', 'workspace_worker_refused',
  'workspace_python_version_refused', 'workspace_sdk_shape_refused', 'workspace_saved_source_refused',
  'workspace_report_refused', 'workspace_receipt_context', 'workspace_diagnostic_source_refused']
let collectorStage = 'source'
export function collectorFailure(error, stage) {
  const closedStage = one(stage, ['source', 'input', 'projection'], 'source')
  const code = COLLECTOR_FAILURE_CODES.includes(error?.message) ? error.message
    : error?.code === 'ERR_ASSERTION' ? 'ops_identity_refused'
      : ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error?.code) ? 'filesystem_refused'
        : error?.code === 'ENOBUFS' ? 'source_probe_failed'
          : error instanceof SyntaxError ? 'json_invalid' : 'internal'
  return { event: 'workspace_private_ops_refused', stage: closedStage, code, sourceVerified: closedStage !== 'source' }
}

async function main([operation, sourceDirectory, ...extra]) {
  check(extra.length === 0 && ['check', 'dependencies', 'verdict', 'diagnostic-check', 'diagnose'].includes(operation) && sourceDirectory, 'workspace_ops_arguments')
  const diagnostic = operation === 'diagnostic-check' || operation === 'diagnose'
  const directory = resolve(sourceDirectory), evidence = resolve(process.env.RUNNER_TEMP, diagnostic ? 'workspace-private-diagnostic/evidence' : 'workspace-private/evidence')
  const source = await verifySources(directory)
  collectorStage = 'input'
  if (operation === 'check') { console.log(JSON.stringify(source)); return }
  if (diagnostic) {
    check(P0.source === FINALIZE_DIAGNOSTIC.sourceCommit && P0.tree === FINALIZE_DIAGNOSTIC.sourceTree
      && P0.workerSha === FINALIZE_DIAGNOSTIC.workerSha && process.versions.node.split('.')[0] === '24', 'workspace_diagnostic_source_refused')
    if (operation === 'diagnostic-check') {
      const workerSha = execFileSync('python3', ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', P0.source], { cwd: directory, encoding: 'utf8' }).trim()
      assertWorkerIdentity(workerSha)
      await save(resolve(evidence, 'source.json'), { ...source, workerSha, scope: 'existing_deleted_build_read_only', target: FINALIZE_DIAGNOSTIC })
      console.log(JSON.stringify({ sourceVerified: true, workerVerified: true, scope: 'existing_deleted_build_read_only' })); return
    }
    const saved = await optionalJson(resolve(evidence, 'source.json'))
    check(saved?.sourceCommit === P0.source && saved.sourceTree === P0.tree && saved.workerSha === P0.workerSha
      && saved.opsSource === source.opsSource && saved.runId === source.runId && saved.runAttempt === source.runAttempt
      && JSON.stringify(saved.target) === JSON.stringify(FINALIZE_DIAGNOSTIC), 'workspace_saved_source_refused')
    const report = { diagnosticSource: source.opsSource, diagnosticRunId: source.runId, diagnosticRunAttempt: source.runAttempt,
      ...await diagnoseExistingBuild(process.env.E2B_API_KEY) }
    await save(resolve(evidence, 'diagnostic.json'), report)
    console.log(JSON.stringify({ scope: report.scope, outcome: report.outcome, complete: report.complete,
      failure: report.failure, requests: report.requests, pages: report.pages, entries: report.entries }))
    if (report.outcome !== 'available') process.exitCode = 1
    return
  }
  if (operation === 'dependencies') {
    const require = createRequire(resolve(directory, 'package.json'))
    const python = resolve(process.env.RUNNER_TEMP, 'e2b-private/bin/python')
    const pythonVersions = JSON.parse(execFileSync(python, ['-c',
      'import importlib.metadata,json,platform;print(json.dumps({"e2b":importlib.metadata.version("e2b"),"python":platform.python_version()}))'], { encoding: 'utf8' }))
    check(/^\d+\.\d+\.\d+$/.test(pythonVersions.python ?? ''), 'workspace_python_version_refused')
    const versions = { nodeMajor: process.versions.node.split('.')[0], node: process.versions.node, python: pythonVersions.python,
      pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
      javascriptE2b: require('e2b/package.json').version, next: require('next/package.json').version,
      pythonE2b: pythonVersions.e2b }
    assertDependencies(versions)
    const sdk = require('e2b'), Socket = require('next/dist/compiled/ws')
    check(['pause', 'connect'].every(name => typeof sdk.Sandbox.prototype[name] === 'function')
      && ['list', 'getInfo', 'kill', 'create'].every(name => typeof sdk.Sandbox[name] === 'function') && Socket.OPEN === 1, 'workspace_sdk_shape_refused')
    const workerSha = execFileSync(python, ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', P0.source], { cwd: directory, encoding: 'utf8' }).trim()
    assertWorkerIdentity(workerSha)
    await save(resolve(evidence, 'source.json'), { ...source, workerSha, versions })
    console.log(JSON.stringify({ ...source, workerSha, versions })); return
  }
  const saved = await optionalJson(resolve(evidence, 'source.json'))
  check(saved?.sourceCommit === P0.source && saved.sourceTree === P0.tree && saved.opsSource === source.opsSource
    && saved.runId === source.runId && saved.runAttempt === source.runAttempt && saved.workerSha === P0.workerSha, 'workspace_saved_source_refused')
  const loaded = await readAcceptanceInputs(resolve(process.env.RUNNER_TEMP, 'workspace-private'), {
    build: process.env.BUILD_OUTCOME, acceptance: process.env.ACCEPTANCE_OUTCOME,
    vmCleanup: process.env.VM_CLEANUP_OUTCOME, templateCleanup: process.env.TEMPLATE_CLEANUP_OUTCOME })
  collectorStage = 'projection'
  const { verdict, receipts, unavailableReceipts } = summarizeCollectedAcceptance({ opsSource: source.opsSource,
    workerSha: saved.workerSha, runId: source.runId, runAttempt: source.runAttempt }, loaded)
  await save(resolve(evidence, 'verdict.json'), verdict)
  // Source reports remain private runner inputs. Only these closed projections
  // and their hashes are uploaded, not stdout, SDK responses or capability files.
  await save(resolve(evidence, 'receipt-digests.json'), { version: 1, sourceCommit: P0.source, opsSource: source.opsSource,
    receipts, unavailableReceipts })
  console.log(JSON.stringify({ sourceCommit: P0.source, opsSource: source.opsSource, passed: verdict.passed,
    runtimeCleanupConfirmed: verdict.runtimeCleanupConfirmed, templateCleanupConfirmed: verdict.templateCleanupConfirmed }))
  if (!verdict.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify(collectorFailure(error, collectorStage))); process.exitCode = 1 })
}
