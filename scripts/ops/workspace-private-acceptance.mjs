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
  source: '37b0e55ddfca6646bc3beea7531048e6e63331c1',
  tree: '2167f94b74c1ede4b8d37054fb407a462c0b470d',
  workerSha: '0537b0c49fe197240632ec7c74875c3af0c53260',
  sdks: { nodeMajor: '24', pnpm: '10.34.3', javascriptE2b: '2.61.0', pythonE2b: '2.62.0', next: '16.4.1' },
  files: {
    'package.json': 'c56b9a7aab200373926c23b914111825b5293efb8fae80b85fe4f16682cc020d',
    'pnpm-lock.yaml': '345a6e1d97bb3a0028497f3294a86944bc9f617af892de71990d40d2cdf36054',
    'pnpm-workspace.yaml': '8977ce9916b92a015e0f4dad1d45bcf51c9427637a5988fcdc585a1a21a0301e',
    'scripts/e2b/workspace-candidates.py': '5de2fc0d65e453802455bb1863c6a12fa9643306710b85575d51bdfadd6990ee',
    'scripts/e2b/workspace-candidates.test.py': 'a170f525403a4c934774e27ce8bd1fceee72f0af2165974d69d239452d0245fd',
    'scripts/e2b/build-template.py': 'efe0a20a73749a06b4e2f20fb4b1c8a1bd99a7b7a4fdae961fee9d410b424d85',
    'scripts/e2b/build-template.test.py': '78e367541f0e6441c60944b107b179b78a75ea754bee0d729df0aa9f5bd4749e',
    'scripts/e2b/official-files.py': '6191212b14205c7cb8043efcfb85eaff05670f8cb65c4c801052cf9d3a28babe',
    'scripts/e2b/official-files.test.py': '973c9e7b699032526052f48b4326ef26b0bb7e9db621dd1910a5d00ca0a23c10',
    'scripts/e2b/cleanup-template-candidates.py': '893b0d50f30f4b21f92f155aee97965e12f84fd0e21ea0ada3dfb3a00392533d',
    'scripts/e2b/cleanup-template-candidates.test.py': '826a489c570a788ea018b6a6ce786fd3e71b41dc8d514cfd8a09e516f8bf84f1',
    'scripts/e2b/workspace-ingress-acceptance.mjs': '2d8739516b3ada59925589bb8f2da18f8b80985273d3820f1b3c11d5ba0468ea',
    'scripts/e2b/workspace-ingress-acceptance.test.mjs': '8dd31240764e905e6aa002fe8ca3ab81436f3771a5cb22aad6f75059ed387b1e',
    'scripts/e2b/workspace-ingress-servers.py': '5c0c12ff3f5573f7a6032a359a372b2a4697b17e44501c7d175bd10c809c74b8',
    'scripts/e2b/workspace-terminal-acceptance.mjs': 'd6d9d535c393e179eca800a44e5dfed508b06135d8891a793af05d539fa8252c',
    'scripts/e2b/workspace-terminal-acceptance.test.mjs': '971003d90739338112ae83838abc218811818600dcebe7fdbdd46b5e2214dce3',
    'scripts/e2b/fixtures/preview-frameworks/package.json': 'e0cf3ad9d36941898385fc4e149c65be9a1081d8685b4d0b03e92e547cae964d',
    'scripts/e2b/fixtures/preview-frameworks/package-lock.json': '9c123244b4ea44b3a59b92615e25b9780463135eab9f573b7342ad4df7468ef6',
    'packages/daemon/scripts/workspace-ingress.py': 'e56ef2aa5cc34fdd8ac8572a05614093b29c2c06cfc4eab139959fdc3c42fc49',
  },
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
  'revoke', 'takeover', 'resume', 'terminal', 'cleanup', 'journal', 'internal']
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
const BUILD_STAGES = ['identity', 'credential', 'preflight', 'build', 'complete', 'cleanup', 'probe_cleanup',
  ...KINDS.flatMap(kind => ['build', 'private', 'models', 'conservation'].map(prefix => `${prefix}_${kind}`))]
const RUNTIME_STAGES = ['create', 'identity', 'prelistener_guard', 'initial_ingress', 'gateway_listener_wiring',
  'framework_dependencies', 'next', 'vite', 'terminal', 'pause_resume', 'completed']
const CLEANUP_OUTCOMES = ['creation_not_requested', 'no_creation_journal', 'creation_unconfirmed',
  'provider_already_absent', 'provider_kill_acknowledged_and_absent', 'provider_absence_not_confirmed', 'cleanup_failed']
const FRAMEWORK_FLAGS = ['rawDenied', 'authenticatedHttp', 'assets', 'hotReload', 'crossSiteBootstrap', 'revoked', 'takeoverDenied']
const FRAMEWORK_VERSIONS = { next: '16.4.1', vite: '8.3.6', react: '19.3.1', 'react-dom': '19.3.1' }
const exitCode = number => Number.isInteger(number) && number >= -255 && number <= 255 ? number : null

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
  return { attempted: value.attempted === true, identityMatched: matched,
    status: matched ? one(value.status, ['building', 'waiting', 'ready', 'error'], null) : null,
    step: { phase: matched ? one(value.step?.phase, ['base', 'workdir', 'private_directory', 'copy_runtime', 'official_capture',
      'bootstrap', 'npm_runtime', 'official_verify', 'worker_user', 'finalize', 'unknown']) : null,
    index: matched ? count(value.step?.index) : null },
    exitCode: matched ? exitCode(value.exitCode) : null,
    exitCodeSource: matched && exitCode(value.exitCode) !== null ? one(value.exitCodeSource, ['provider_reason'], null) : null,
    reasonLogEntries: matched ? count(value.reasonLogEntries) : null,
    reasonLogEntriesTruncated: value.reasonLogEntriesTruncated === true,
    failure: value.failure ? diagnosticException(value.failure) : null }
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

function buildDiagnostic(value) {
  if (!value || typeof value !== 'object') return null
  const events = rows => (Array.isArray(rows) ? rows.slice(0, 64) : []).flatMap(row => {
    switch (row?.phase) {
      case 'template_created': return [{ phase: row.phase }]
      case 'bootstrap': return [{ phase: row.phase, detail: one(row.detail, BOOTSTRAP_PHASES), elapsedMs: count(row.elapsedMs) }]
      case 'ingress': {
        const command = row.detail === 'command' ? ingressCommand(row.command) : null
        return [{ phase: row.phase, detail: one(row.detail, INGRESS_DETAILS), ...(command ? { command } : {}) }]
      }
      case 'host_failure': return [{ phase: row.phase, detail: one(row.detail, BUILD_HOST_ERRORS) }]
      case 'official_capture': return [{ phase: row.phase, entries: count(row.entries) }]
      default: return []
    }
  })
  return {
    ...diagnosticException(value),
    statusLookup: buildStatusLookup(value.statusLookup),
    buildLogs: Object.fromEntries(KINDS.filter(kind => value.buildLogs?.[kind]).map(kind => {
      const row = value.buildLogs[kind]
      return [kind, { entries: count(row.entries), ignoredLines: count(row.ignoredLines), oversizedEntries: count(row.oversizedEntries),
        truncated: row.truncated === true, events: events(row.events) }]
    })),
  }
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
function runtimeEvidence(row, kind) {
  return { kind, present: !!row, sourceCommit: SHA.test(row?.sourceCommit ?? '') ? row.sourceCommit : null,
    workerSha: SHA.test(row?.workerSha ?? '') ? row.workerSha : null, templateId: boundedId(row?.templateId), sandboxId: boundedId(row?.sandboxId),
    fixtureId: UUID.test(row?.fixtureId ?? '') ? row.fixtureId : null, stage: one(row?.stage, RUNTIME_STAGES),
    failure: row?.failure === undefined ? null : one(row.failure, RUNTIME_CODES, 'internal'), passed: row?.passed === true,
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
async function save(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

async function main([operation, sourceDirectory, ...extra]) {
  check(extra.length === 0 && ['check', 'dependencies', 'verdict'].includes(operation) && sourceDirectory, 'workspace_ops_arguments')
  const directory = resolve(sourceDirectory), evidence = resolve(process.env.RUNNER_TEMP, 'workspace-private/evidence')
  const source = await verifySources(directory)
  if (operation === 'check') { console.log(JSON.stringify(source)); return }
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
  const base = resolve(process.env.RUNNER_TEMP, 'workspace-private'), builds = resolve(base, 'candidates'), runtime = resolve(base, 'runtime')
  const names = await readdir(builds).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const cleanupNames = names.filter(name => /^cleanup(?:-(?:[2-9]|[1-9][0-9]+))?\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 1) - Number(b.match(/\d+/)?.[0] ?? 1))
  const input = { buildReport: await optionalJson(resolve(builds, 'build-report.json')), candidates: await optionalJson(resolve(builds, 'candidates.json')),
    builderJournal: await optionalJson(resolve(builds, 'creation-journal.json')), vmCleanup: await optionalJson(resolve(runtime, 'cleanup.json')),
    templateCleanups: await Promise.all(cleanupNames.map(name => optionalJson(resolve(builds, name)))),
    runtime: Object.fromEntries(await Promise.all(KINDS.map(async kind => [kind, await optionalJson(resolve(runtime, `${kind}.json`))]))),
    journals: Object.fromEntries(await Promise.all(KINDS.map(async kind => [kind, await optionalJson(resolve(runtime, `${kind}.cleanup.json`))]))),
    outcomes: { build: process.env.BUILD_OUTCOME, acceptance: process.env.ACCEPTANCE_OUTCOME,
      vmCleanup: process.env.VM_CLEANUP_OUTCOME, templateCleanup: process.env.TEMPLATE_CLEANUP_OUTCOME } }
  const verdict = summarizeAcceptance({ opsSource: source.opsSource, workerSha: saved.workerSha, runId: source.runId, runAttempt: source.runAttempt }, input)
  await save(resolve(evidence, 'verdict.json'), verdict)
  // Source reports remain private runner inputs. Only these closed projections
  // and their hashes are uploaded, not stdout, SDK responses or capability files.
  await save(resolve(evidence, 'receipt-digests.json'), { version: 1, sourceCommit: P0.source, opsSource: source.opsSource,
    receipts: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'outcomes').map(([key, value]) => [key, hash(JSON.stringify(value))])) })
  console.log(JSON.stringify({ sourceCommit: P0.source, opsSource: source.opsSource, passed: verdict.passed,
    runtimeCleanupConfirmed: verdict.runtimeCleanupConfirmed, templateCleanupConfirmed: verdict.templateCleanupConfirmed }))
  if (!verdict.passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('workspace_private_ops_refused'); process.exitCode = 1 })
}
