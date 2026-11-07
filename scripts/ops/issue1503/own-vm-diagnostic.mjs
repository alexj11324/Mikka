/** One bounded, read-only probe of an already-running VM belonging to a known
 * failed acceptance run. This is diagnostic evidence, never acceptance proof. */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const VM_ID = /^[a-z0-9]{10,64}$/
const MAX_OUTPUT = 32768
const SELF = fileURLToPath(import.meta.url)
const PROBE = new URL('./own-vm-diagnostic.py', import.meta.url)
const API = 'https://api.e2b.app'
const SDK_VERSION = '2.61.0'
const fileStates = ['read', 'tail', 'present', 'missing', 'not_regular', 'too_large', 'unavailable', 'expired']
const reasons = ['collected', 'key_unavailable', 'invalid_scope', 'sdk_unavailable', 'sdk_version_mismatch',
  'provider_unavailable', 'unproven_404', 'no_match', 'ambiguous_match', 'ownership_mismatch',
  'not_running', 'auto_resume_not_disabled', 'runtime_metadata_unavailable', 'probe_failed',
  'output_invalid', 'deadline', 'child_failed', 'cleanup_started']
export const CONTRACT = Object.freeze({
  errorNames: ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'DaemonError',
    'ServerUnreachableError', 'SessionRejectedError', 'RunNotPinnedHereError', 'InvalidRepositoryError',
    'HarnessNotSupportedError', 'InvalidIdError', 'ZodError', 'FetchError', 'ConnectError'],
  errorCodes: [4001, 4002, 4003, 4010, 4011, 4012, 4013, 4014, 4020, 4030, 400, 401, 403, 404, 409, 429, 500, 502, 503, 504],
  networkCodes: ['ENOENT', 'EACCES', 'EINVAL', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'],
  issueCodes: ['invalid_type', 'too_big', 'too_small', 'invalid_format', 'not_multiple_of', 'unrecognized_keys',
    'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom'],
  schemaFields: ['runId', 'issueId', 'deviceId', 'repoId', 'remoteUrl', 'baseBranch', 'expectedRepoRemote',
    'harness', 'prompt', 'model', 'effort', 'subscriptionBinding', 'subscriptionLease', 'modelCredential',
    'bindingId', 'ownerId', 'workspaceId', 'consumerId', 'route', 'provider', 'revision', 'epoch', 'credential',
    'kind', 'key', 'protocol', 'baseUrl', 'accessToken', 'refreshToken', 'expiresAt', 'accountId', 'email',
    'localComputer', 'computer', 'botId', 'policyVersion', 'permission', 'display', 'taskEnv', 'taskSecretNames',
    'fixture', 'pushBranch', 'verifyCommand', 'factoryCheck', 'stage', 'inferCommand', 'reportOnly',
    'factoryExecuteKind', 'leaseExpiresAt', 'mcp', 'url', 'token', 'mailbox', 'apps', 'github', 'repository',
    'endpoint', 'allowed', 'readOnly', 'repos', 'name', 'path', 'setup', 'networkAllow', 'push', 'approved',
    'remote', 'headers', 'envs', 'commands', 'sessionId', 'originRunId', 'questionId', 'resume', 'runIds'],
  recordFields: ['taskEnv', 'headers', 'envs'],
  runStates: ['queued', 'preparing', 'running', 'waiting_input', 'finishing', 'succeeded', 'stopped', 'failed', 'cancelled'],
  levels: [10, 20, 30, 40, 50, 60],
  logMessages: { 'could not start run': 'could_not_start_run', 'server sync failed': 'server_sync_failed', 'run failed': 'run_failed' },
  messages: { 'Device session changed while claiming run': 'session_changed',
    'Initial repository sync unavailable': 'repository_sync',
    'Repository origin does not match the approved repository': 'repo_origin',
    'Cloud computer runtime unavailable': 'computer_runtime', 'Daemon is draining': 'draining' },
})
const own = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const integer = (value, max = 2147483647) => Number.isInteger(value) && value >= 0 && value <= max
const closed = (value, values) => values.includes(value) || value === 'other'
const scopeValid = value => own(value, ['runId', 'issueId', 'workspaceId', 'sinceMs', 'untilMs'])
  && ['runId', 'issueId', 'workspaceId'].every(key => UUID.test(value[key] ?? ''))
  && integer(value.sinceMs, 4102444800000) && integer(value.untilMs, 4102444800000)
  && value.sinceMs > 0 && value.untilMs >= value.sinceMs && value.untilMs - value.sinceMs <= 90 * 60_000
const blocked = reason => ({ status: 'blocked', reason, target: null, diagnostic: null })

/** Validate every key again on the runner. No free text from envd is retained,
 * including arbitrary error names/codes, JSON record keys or SDK stderr. */
export function validateDiagnostic(value, scope) {
  if (!own(value, ['files', 'process', 'journal', 'events', 'eventsTruncated', 'logTruncated', 'malformedLines'])) return false
  if (!own(value.files, ['daemonLog', 'bootstrapLog', 'journal', 'pid']) || !Object.values(value.files).every(item => fileStates.includes(item))) return false
  if (!own(value.process, ['recordedPidAlive']) || ![null, true, false].includes(value.process.recordedPidAlive)) return false
  const journal = value.journal
  if (!own(journal, ['valid', 'targetPresent', 'assignmentMatches', 'state', 'lastSeq', 'sessionPresent'])
    || !['valid', 'targetPresent', 'assignmentMatches', 'sessionPresent'].every(key => typeof journal[key] === 'boolean')
    || !closed(journal.state, CONTRACT.runStates) || !(journal.lastSeq === null || integer(journal.lastSeq))) return false
  if (!Array.isArray(value.events) || value.events.length > 12 || !integer(value.malformedLines, 600)
    || typeof value.eventsTruncated !== 'boolean' || typeof value.logTruncated !== 'boolean') return false
  return value.events.every(event => {
    if (!own(event, ['timeMs', 'level', 'event', 'exactRun', 'error']) || !integer(event.timeMs, 4102444800000)
      || event.timeMs < scope.sinceMs || event.timeMs > scope.untilMs || !closed(event.level, CONTRACT.levels)
      || !Object.values(CONTRACT.logMessages).includes(event.event) || typeof event.exactRun !== 'boolean'
      || (!event.exactRun && event.event !== 'server_sync_failed')) return false
    const error = event.error
    if (!own(error, ['name', 'code', 'classification', 'upgradeRequired', 'schemaIssues', 'schemaIssuesTruncated', 'cause'])
      || !closed(error.name, CONTRACT.errorNames) || !closed(error.code, CONTRACT.errorCodes)
      || !['other', 'response_schema', ...Object.values(CONTRACT.messages)].includes(error.classification)
      || typeof error.upgradeRequired !== 'boolean' || typeof error.schemaIssuesTruncated !== 'boolean'
      || !Array.isArray(error.schemaIssues) || error.schemaIssues.length > 12) return false
    if (!error.schemaIssues.every(issue => own(issue, ['code', 'path']) && closed(issue.code, CONTRACT.issueCodes)
      && Array.isArray(issue.path) && issue.path.length <= 8
      && issue.path.every((part, index) => ['<index>', '<redacted-key>'].includes(part)
        || CONTRACT.schemaFields.includes(part) && !(index > 0 && CONTRACT.recordFields.includes(issue.path[index - 1]))))) return false
    return own(error.cause, ['name', 'code', 'status']) && closed(error.cause.name, CONTRACT.errorNames)
      && closed(error.cause.code, CONTRACT.networkCodes) && (error.cause.status === null
        || Number.isInteger(error.cause.status) && (error.cause.status === 429 || error.cause.status >= 500 && error.cause.status <= 599))
  })
}

function validReceipt(value, scope) {
  if (!own(value, ['status', 'reason', 'target', 'diagnostic']) || !reasons.includes(value.reason)) return false
  if (value.status === 'blocked') return value.reason !== 'collected' && value.target === null && value.diagnostic === null
  return value.status === 'observed' && value.reason === 'collected'
    && own(value.target, ['sandboxId', 'operationId', 'state', 'autoResume']) && VM_ID.test(value.target.sandboxId)
    && UUID.test(value.target.operationId) && value.target.state === 'running' && value.target.autoResume === false
    && validateDiagnostic(value.diagnostic, scope)
}

export async function diagnosticCommand(scope) {
  if (!scopeValid(scope)) throw new Error('invalid_scope')
  const program = await readFile(PROBE, 'utf8')
  // A late provider start must not begin reading files after this attempt's
  // absolute budget. The remote self-limit also covers a lost command stream.
  return `timeout --signal=KILL 6s python3 - <<'MIKKA_1503_DIAGNOSTIC'\n${program}\nmain(json.loads(${JSON.stringify(JSON.stringify(scope))}), json.loads(${JSON.stringify(JSON.stringify(CONTRACT))}), ${Date.now() + 9000})\nMIKKA_1503_DIAGNOSTIC`
}

/** Version-bound SDK adapter. Construction is local in pinned e2b 2.61.0;
 * connect/create are intentionally unavailable here because connect resumes. */
async function sdk() {
  try {
    const require = createRequire(import.meta.url)
    if (JSON.parse(await readFile(require.resolve('e2b/package.json'), 'utf8')).version !== SDK_VERSION) return null
    return (await import('e2b')).Sandbox
  } catch { return undefined }
}

export async function probeOwnVm(scope, { apiKey, Sandbox, fetchInfo = fetch, signal,
  waitForRemoteLimit = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const started = performance.now()
  let remoteLimit = null
  if (!scopeValid(scope)) return blocked('invalid_scope')
  if (!apiKey) return blocked('key_unavailable')
  Sandbox ??= await sdk()
  if (Sandbox === null) return blocked('sdk_version_mismatch')
  if (!Sandbox) return blocked('sdk_unavailable')
  try {
    signal?.throwIfAborted()
    const options = { apiKey, apiUrl: API, domain: 'e2b.app', debug: false, retries: 0, requestTimeoutMs: 3000, signal }
    const metadata = { application: 'mikka-thread', workspaceId: scope.workspaceId, runId: scope.runId }
    const pages = Sandbox.list({ ...options, limit: 2, query: { metadata, state: ['running', 'paused'] } })
    const matches = await pages.nextItems({ signal })
    if (!Array.isArray(matches) || matches.length > 1 || pages.hasNext !== false) return blocked('ambiguous_match')
    if (!matches.length) return blocked('no_match')
    const match = matches[0]
    if (!VM_ID.test(match.sandboxId ?? '') || !UUID.test(match.metadata?.operationId ?? '')
      || Object.entries(metadata).some(([key, value]) => match.metadata?.[key] !== value)) return blocked('ownership_mismatch')
    if (match.state !== 'running') return blocked('not_running')
    signal?.throwIfAborted()
    // getInfo's public projection omits envdAccessToken. Read that same fixed
    // GET once; never call connect to acquire it or resume a paused VM.
    const response = await fetchInfo(`${API}/sandboxes/${match.sandboxId}`, {
      method: 'GET', redirect: 'error', headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) { await response.body?.cancel(); return blocked(response.status === 404 ? 'unproven_404' : 'provider_unavailable') }
    const reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > 65536) { await reader.cancel(); return blocked('runtime_metadata_unavailable') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const info = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (info?.sandboxID !== match.sandboxId || info.metadata?.operationId !== match.metadata.operationId
      || Object.entries(metadata).some(([key, value]) => info.metadata?.[key] !== value)) return blocked('ownership_mismatch')
    if (info.state !== 'running') return blocked('not_running')
    if (info.lifecycle?.autoResume !== false) return blocked('auto_resume_not_disabled')
    if (!['e2b.app', 'e2b.dev'].includes(info.domain) || typeof info.envdAccessToken !== 'string'
      || info.envdAccessToken.length < 1 || info.envdAccessToken.length > 8192
      || typeof info.envdVersion !== 'string' || !/^0\.\d{1,3}\.\d{1,3}$/.test(info.envdVersion)) return blocked('runtime_metadata_unavailable')
    signal?.throwIfAborted()
    const command = await diagnosticCommand(scope)
    // Leave enough time for the entire remote timeout (including Python
    // startup) before the child abort, not merely before its parent SIGKILL.
    if (performance.now() - started > 8000) return blocked('deadline')
    const box = new Sandbox({ ...options, sandboxId: match.sandboxId, sandboxDomain: info.domain,
      envdVersion: info.envdVersion, envdAccessToken: info.envdAccessToken })
    // A transport error does not prove a submitted command exited. Reserve
    // the 3s start-request budget + remote 6s wall limit + 1s allowance before
    // allowing cleanup. This is one local timer, not a provider/data poll.
    remoteLimit = performance.now() + 10000
    const result = await box.commands.run(command, { user: 'user', timeoutMs: 7000, requestTimeoutMs: 3000, signal })
    remoteLimit = null // commands.run returned its actual completed result.
    if (result.exitCode !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_OUTPUT) return blocked('probe_failed')
    let diagnostic
    try { diagnostic = JSON.parse(result.stdout) } catch { return blocked('output_invalid') }
    if (!validateDiagnostic(diagnostic, scope)) return blocked('output_invalid')
    if (Object.values(diagnostic.files).includes('expired')) return blocked('deadline')
    return { status: 'observed', reason: 'collected', target: { sandboxId: match.sandboxId,
      operationId: match.metadata.operationId, state: 'running', autoResume: false }, diagnostic }
  } catch {
    if (remoteLimit !== null) await waitForRemoteLimit(Math.max(0, remoteLimit - performance.now()))
    return blocked(signal?.aborted ? 'deadline' : 'probe_failed')
  }
}

/** Kill and join the diagnostic process, not just its waiting Promise. envd's
 * remote Python independently self-terminates after five seconds. The isolated
 * process also bounds SDK import and its automatic transport health check. */
export function boundedChild(scope, apiKey, { spawnChild = spawn, deadlineMs = 20000 } = {}) {
  return new Promise(resolve => {
    let stdout = '', size = 0, failed = false, timedOut = false, settled = false
    const child = spawnChild(process.execPath, [SELF, '--probe'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', E2B_API_KEY: apiKey },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, deadlineMs)
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size > MAX_OUTPUT) { failed = true; stdout = ''; child.kill('SIGKILL') }
      else if (!failed) stdout += chunk.toString('utf8')
    })
    // Drain without storing or printing stderr, which can contain raw SDK data.
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => { failed = true })
    child.on('error', () => { failed = true })
    child.on('close', code => {
      if (timedOut) return finish(blocked('deadline'))
      if (failed || code !== 0) return finish(blocked('child_failed'))
      let value
      try { value = JSON.parse(stdout) } catch { return finish(blocked('output_invalid')) }
      finish(validReceipt(value, scope) ? value : blocked('output_invalid'))
    })
    child.stdin.end(JSON.stringify(scope))
  })
}

export function createOwnVmDiagnostic({ apiKey, collect = boundedChild } = {}) {
  let pending, closed = false
  return {
    collect(scope) {
      if (closed && !pending) return Promise.resolve({ schema: 1,
        runId: UUID.test(scope?.runId ?? '') ? scope.runId : null,
        startedAt: null, completedAt: new Date().toISOString(), ...blocked('cleanup_started') })
      if (!pending) pending = (async () => {
        const startedAt = new Date().toISOString()
        let result
        try { result = scopeValid(scope) ? apiKey ? await collect(scope, apiKey) : blocked('key_unavailable') : blocked('invalid_scope') }
        catch { result = blocked('child_failed') }
        if (!validReceipt(result, scope)) result = blocked('output_invalid')
        return { schema: 1, runId: UUID.test(scope?.runId ?? '') ? scope.runId : null,
          startedAt, completedAt: new Date().toISOString(), ...result }
      })()
      return pending
    },
    // An outstanding live read may return after its caller timed out. Closing
    // before cleanup prevents that late callback from starting a new probe.
    settled: () => { closed = true; return pending ?? Promise.resolve(null) },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--probe') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 16000)
  try {
    let input = ''
    for await (const chunk of process.stdin) {
      input += chunk.toString('utf8')
      if (input.length > 4096) throw new Error('invalid_scope')
    }
    const result = await probeOwnVm(JSON.parse(input), { apiKey: process.env.E2B_API_KEY, signal: controller.signal })
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0))
  } catch {
    process.stdout.write(`${JSON.stringify(blocked('child_failed'))}\n`, () => process.exit(0))
  } finally { clearTimeout(timer) }
}
