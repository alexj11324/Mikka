import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { decode, encode } from '../../../lib/desktop-rpc/wire'
import { smokeSession, SMOKE_ID } from './http.ts'

const APP = '5ba1f9e2359ce714d83cd16fc040f2567c40a6d0'
const BASE = 'd0e77de53f6e966a41f83cef2ce4f733bc472384'
const FAILED_SOURCE = '7017d5f14871cbf1aeea771824d72e1d2bd90255'
const FIXTURE_SHA = '9e0836aa5e5d290dac5c282e82f56907b99207820ded44396159b935c53f9de7'
const HTTP_HELPER_SHA = 'fe96ea60b8924a8070c0ab6dfe15ef08838856780798a574cb88d69b62b91dec'
const PUBLIC_KEY_SHA = '2a3f2d8917ad66d0e8067196c68e55afd086dc864e40d5cf2d817e32d7289349'
const WORKSPACE = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const TARGET = {
  issueId: 'c38abb4c-2f8a-48ea-b70b-9f2badda85ee',
  originRunId: 'eb28a228-a575-4bc6-8732-ca505a3b2636',
  childRunId: '0450e5aa-7891-47b9-90db-3a1f6b4b9ca3',
}
const ACTION = 'agents.getIssueThread'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_CHUNKS = 4000
const MAX_COMMANDS = 64
const MAX_SEALED_BYTES = 256 * 1024
const PRODUCER_OUTPUT_TAIL_CODE_UNITS = 4000
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const textHash = (value: unknown) => typeof value === 'string' ? hash(value) : null
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const words = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value) ? value : null
const integer = (value: unknown) => Number.isSafeInteger(value) ? value as number : null
const duration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const timestamp = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null
const RUN_STATES = ['queued', 'preparing', 'running', 'succeeded', 'failed', 'stopped', 'cancelled']
const RUN_KINDS = ['implement', 'acceptance', 'fix', 'plan']
const OUTCOMES = ['submitted', 'asked_human', 'blocked', 'turn_ended', 'error', 'device_lost', 'timeout', 'cancelled']
const ERROR_CODES = ['authRequired', 'notFound', 'workspaceAccessDenied', 'validationGeneric', 'originRejected', 'methodNotAllowed', 'rpcActionUnavailable', 'rpcVersionUnsupported']
class DiagnosticFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DiagnosticFailure' }
}
const requireThat = (value: unknown, code: string) => { if (!value) throw new DiagnosticFailure(code) }
const safeFailure = (error: unknown) => error instanceof DiagnosticFailure ? error.code
  : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'request_timeout' : 'operation_failed'
type ReadKey = 'version_before' | 'thread' | 'version_after'
const report: any = {
  issue: 1503, phase: 'private_single_child_tool_diagnosis_42636835234', acceptancePassed: false,
  expectedAppSha: APP, preparationBase: BASE, failedFSource: FAILED_SOURCE, failedFRunId: 42636835234, failedFAttempt: 1,
  historicalFixtureSha256: FIXTURE_SHA, historicalFixtureIdentityOnly: true, credentialsNotReused: true,
  credentialReuseScope: 'historical_fixture_and_github_child', normalSmokeLogin: true,
  workspaceId: WORKSPACE, target: TARGET, recipientPublicKeySha256: PUBLIC_KEY_SHA,
  operatorSha: process.env.GITHUB_SHA ?? null, workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  snapshotTiming: 'one_existing_child_thread_after_failed_window_cleanup',
  startedAt: new Date().toISOString(), stage: 'configuration', status: 'started',
  counts: { version_before: 0, thread: 0, version_after: 0 }, requests: {}, failures: [],
  limits: { responseBytes: MAX_RESPONSE_BYTES, chunks: MAX_CHUNKS, commands: MAX_COMMANDS, sealedBytes: MAX_SEALED_BYTES },
  interpretation: {
    eventAt: 'run_chunks.createdAt_storage_time_not_tool_execution_time',
    commandOutput: 'producer_tail_not_proven_complete',
    producerTailLimitCodeUnits: PRODUCER_OUTPUT_TAIL_CODE_UNITS,
    hostAssignedBranch: 'not_inferred_from_command_output',
    sourceCommit: 'not_inferred_from_local_HEAD',
    executionDeadline: 'not_inferred_from_storage_timestamps_or_lease',
    cause: 'not_inferred',
  },
}
let session: Awaited<ReturnType<typeof smokeSession>> | null = null
let recipient: ReturnType<typeof createPublicKey> | null = null
const save = async () => {
  await mkdir('issue1503-report', { recursive: true, mode: 0o700 })
  await writeFile('issue1503-report/private-thread-0450e5aa.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
async function once(name: ReadKey) {
  requireThat(session && report.counts[name] === 0, 'request_binding_invalid')
  const isThread = name === 'thread'
  const path = isThread ? '/api/desktop/rpc' : '/api/version'
  report.counts[name]++
  const receipt: any = report.requests[name] = {
    method: isThread ? 'POST' : 'GET', path, startedAt: new Date().toISOString(),
    ...(isThread ? { action: ACTION, issueId: TARGET.issueId, requestedRunId: TARGET.childRunId, cursor: null } : {}),
  }
  try {
    const headers = { 'content-type': 'application/json', cookie: 'mikka-workspace=' + WORKSPACE, 'x-mikka-locale': 'en' }
    const init = isThread
      ? { ...session!.post({ version: 1, action: ACTION, args: encode([TARGET.issueId, TARGET.childRunId, null]) }), headers }
      : { method: 'GET', headers }
    const response = await session!.request(path, init)
    const bytes = Buffer.from(await response.arrayBuffer())
    receipt.completedAt = new Date().toISOString()
    receipt.httpStatus = response.status; receipt.httpOk = response.ok
    receipt.responseBytes = bytes.length; receipt.responseSha256 = hash(bytes)
    let value: any
    try {
      requireThat(bytes.length <= MAX_RESPONSE_BYTES, 'response_size_limit')
      try { value = JSON.parse(bytes.toString('utf8')) }
      catch { throw new DiagnosticFailure('response_json_invalid') }
    } finally { bytes.fill(0) }
    const errorCode = typeof value?.error?.code === 'string' ? value.error.code : value?.error
    receipt.errorCode = words(errorCode, ERROR_CODES); receipt.errorCodeSha256 = textHash(errorCode)
    requireThat(response.ok, 'http_failed')
    if (isThread) {
      receipt.rpcVersion = integer(value?.version); receipt.rpcOk = value?.ok === true
      requireThat(value?.version === 1 && value?.ok === true && Object.hasOwn(value, 'result'), 'rpc_envelope_invalid')
      try { return decode(value.result) }
      catch { throw new DiagnosticFailure('rpc_result_invalid') }
    }
    return value
  } catch (error) {
    receipt.completedAt ??= new Date().toISOString(); receipt.failureCode = safeFailure(error)
    throw error
  }
}
function checkScope(detail: any) {
  requireThat(record(detail) && record(detail.thread) && record(detail.chunkCursor) && Array.isArray(detail.chunks), 'thread_dto_invalid')
  const thread = detail.thread, cursor = detail.chunkCursor, attempts = thread.attempts
  report.scopeChecks = {
    ownedByCurrentUser: thread.ownedByCurrentUser === true,
    workspaceMatches: detail.live?.issueWorkspaceId === WORKSPACE,
    requestedRunMatches: thread.id === TARGET.childRunId,
    rootMatches: thread.rootRunId === TARGET.originRunId,
    latestMatches: thread.latestRunId === TARGET.childRunId,
    attemptsMatch: Array.isArray(attempts) && attempts.length === 2
      && attempts[0]?.runId === TARGET.originRunId && attempts[1]?.runId === TARGET.childRunId,
    childOnlyChunkChain: cursor.chain === TARGET.childRunId,
    initialCursorResponse: detail.chunksAppend === false,
  }
  requireThat(Object.values(report.scopeChecks).every(value => value === true), 'thread_scope_mismatch')
  requireThat(detail.chunks.length <= MAX_CHUNKS && Number.isSafeInteger(cursor.seq) && cursor.seq >= 0
    && cursor.count === detail.chunks.length
    && (detail.chunks.length > 0
      ? cursor.runId === TARGET.childRunId && cursor.runs === 1
      : cursor.runId === null && cursor.runs === 0), 'chunk_cursor_invalid')
  report.thread = {
    id: TARGET.childRunId, rootRunId: TARGET.originRunId, latestRunId: TARGET.childRunId,
    ownedByCurrentUser: true, status: words(thread.status, RUN_STATES), outcome: words(thread.outcome, OUTCOMES),
    kind: words(thread.kind, RUN_KINDS), kindUnknownSha256: words(thread.kind, RUN_KINDS) ? null : textHash(thread.kind),
    harness: words(thread.detail?.harness, ['codex']),
    harnessUnknownSha256: thread.detail?.harness === 'codex' ? null : textHash(thread.detail?.harness),
    stopping: typeof thread.stopping === 'boolean' ? thread.stopping : null,
    createdAt: timestamp(thread.createdAt), finishedAt: timestamp(thread.finishedAt),
    attempts: attempts.map((a: any) => ({
      runId: a.runId, attempt: integer(a.attempt), status: words(a.status, RUN_STATES), outcome: words(a.outcome, OUTCOMES),
      stopping: typeof a.stopping === 'boolean' ? a.stopping : null,
      createdAt: timestamp(a.createdAt), finishedAt: timestamp(a.finishedAt),
    })),
    issueBinding: 'fixed_rpc_argument_and_server_issue_scoped_lookup',
  }
  report.chunkCursor = { chain: TARGET.childRunId, runId: cursor.runId, seq: cursor.seq, runs: cursor.runs, count: cursor.count }
}
function checkedToolId(value: unknown): string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value), 'tool_id_invalid')
  return value as string
}
function selectCommandEvidence(detail: any) {
  checkScope(detail)
  const inputs = new Map<string, string>()
  const commands = new Map<string, any>()
  const counts = { chunks: detail.chunks.length, toolInputs: 0, toolOutputs: 0, toolErrors: 0,
    nonBashInputs: 0, unpairedOutputs: 0, duplicateBashInputs: 0, duplicateBashOutputs: 0, otherChunks: 0 }
  const stages: any[] = []
  for (const entry of detail.chunks) {
    requireThat(record(entry) && record(entry.chunk) && timestamp(entry.at) !== null, 'chunk_shape_invalid')
    const c = entry.chunk
    if (c.type === 'tool-input-available') {
      counts.toolInputs++
      const id = checkedToolId(c.toolCallId)
      requireThat(typeof c.toolName === 'string' && c.toolName.length > 0 && c.toolName.length <= 256, 'tool_name_invalid')
      requireThat(!inputs.has(id) || inputs.get(id) === c.toolName, 'tool_id_name_conflict')
      inputs.set(id, c.toolName)
      if (c.toolName !== 'bash') { counts.nonBashInputs++; continue }
      requireThat(record(c.input) && typeof c.input.command === 'string' && Buffer.byteLength(c.input.command) <= 65536, 'bash_input_invalid')
      const prior = commands.get(id)
      if (prior) {
        requireThat(prior.command === c.input.command, 'bash_input_conflict')
        counts.duplicateBashInputs++; continue
      }
      requireThat(commands.size < MAX_COMMANDS, 'command_count_limit')
      commands.set(id, { toolCallId: id, toolName: 'bash', command: c.input.command,
        inputStoredAt: timestamp(entry.at), ...(duration(c.toolDurationMs) !== undefined ? { inputToolDurationMs: duration(c.toolDurationMs) } : {}) })
    } else if (c.type === 'data-run-stage') {
      const data = c.data
      if (record(data) && ['repository', 'worktree', 'agent_start'].includes(data.stage)
        && duration(data.ms) !== undefined && typeof data.ok === 'boolean') {
        stages.push({ stage: data.stage, ms: data.ms, ok: data.ok, storedAt: timestamp(entry.at) })
      }
    } else if (c.type !== 'tool-output-available' && c.type !== 'tool-output-error') counts.otherChunks++
  }
  for (const entry of detail.chunks) {
    const c = entry.chunk
    if (c.type !== 'tool-output-available' && c.type !== 'tool-output-error') continue
    if (c.type === 'tool-output-available') counts.toolOutputs++; else counts.toolErrors++
    const id = checkedToolId(c.toolCallId)
    if (!inputs.has(id)) { counts.unpairedOutputs++; continue }
    if (inputs.get(id) !== 'bash') continue
    const command = commands.get(id)
    let selected: any
    if (c.type === 'tool-output-available') {
      requireThat(record(c.output) && typeof c.output.output === 'string'
        && c.output.output.length <= PRODUCER_OUTPUT_TAIL_CODE_UNITS
        && (c.output.exitCode == null || Number.isSafeInteger(c.output.exitCode)), 'bash_output_invalid')
      selected = { kind: c.type, exitCode: c.output.exitCode ?? null, output: c.output.output }
    } else {
      requireThat(typeof c.errorText === 'string' && Buffer.byteLength(c.errorText) <= 65536, 'bash_error_invalid')
      selected = { kind: c.type, errorText: c.errorText }
    }
    const fingerprint = hash(JSON.stringify(selected))
    if (command.result) {
      requireThat(command.resultSha256 === fingerprint, 'bash_output_conflict')
      counts.duplicateBashOutputs++; continue
    }
    command.result = selected; command.resultSha256 = fingerprint; command.outputStoredAt = timestamp(entry.at)
    if (duration(c.toolDurationMs) !== undefined) command.outputToolDurationMs = duration(c.toolDurationMs)
  }
  const selected = Array.from(commands.values())
  report.toolCounts = { ...counts, selectedBashCommands: selected.length,
    commandsWithoutOutput: selected.filter(c => !c.result).length }
  report.commandEvidence = selected.length ? 'present' : 'none'
  report.stageObservations = stages.slice(0, 16); report.stageObservationsTruncated = stages.length > 16
  report.toolObservations = selected.map(c => ({
    toolCallIdSha256: hash(c.toolCallId), inputSha256: hash(c.command), inputBytes: Buffer.byteLength(c.command),
    inputStoredAt: c.inputStoredAt, inputToolDurationMs: c.inputToolDurationMs ?? null,
    resultKind: c.result?.kind ?? 'missing', resultSha256: c.resultSha256 ?? null,
    outputStoredAt: c.outputStoredAt ?? null, outputToolDurationMs: c.outputToolDurationMs ?? null,
    producerTailLimitCodeUnits: PRODUCER_OUTPUT_TAIL_CODE_UNITS, completeness: 'not_proven',
  }))
  return selected.map(c => ({
    toolCallId: c.toolCallId, toolName: 'bash', input: { command: c.command },
    inputStoredAt: c.inputStoredAt, ...(c.inputToolDurationMs !== undefined ? { inputToolDurationMs: c.inputToolDurationMs } : {}),
    result: c.result ?? null, outputStoredAt: c.outputStoredAt ?? null,
    ...(c.outputToolDurationMs !== undefined ? { outputToolDurationMs: c.outputToolDurationMs } : {}),
  }))
}
function sealCommands(commands: any[]) {
  requireThat(recipient, 'recipient_missing')
  const scope = {
    format: 'mikka.issue1503.private-thread-tools.v1',
    ...TARGET, workspaceId: WORKSPACE, ownerId: SMOKE_ID, selection: 'paired_bash_tools_only',
    chunkChain: TARGET.childRunId, expectedAppSha: APP,
    operatorSha: report.operatorSha, workflowRunId: report.workflowRunId, workflowAttempt: report.workflowAttempt,
    rpcResponseSha256: report.requests.thread.responseSha256, recipientPublicKeySha256: PUBLIC_KEY_SHA,
  }
  const aad = Buffer.from(JSON.stringify(scope), 'utf8')
  const plaintext = Buffer.from(JSON.stringify({ commands }), 'utf8')
  const key = randomBytes(32)
  const nonce = randomBytes(12)
  try {
    requireThat(plaintext.length <= MAX_SEALED_BYTES, 'selected_content_size_limit')
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    const wrappedKey = publicEncrypt({ key: recipient!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)
    requireThat(tag.length === 16 && wrappedKey.length === 384, 'envelope_length_invalid')
    return {
      format: scope.format, scope, keyWrapAlgorithm: 'RSA-OAEP-SHA256', contentAlgorithm: 'AES-256-GCM',
      recipientPublicKeySha256: PUBLIC_KEY_SHA,
      plaintextBytes: plaintext.length, plaintextSha256: hash(plaintext),
      ciphertextBytes: ciphertext.length, ciphertextSha256: hash(ciphertext),
      ciphertextBase64: ciphertext.toString('base64'), nonceBase64: nonce.toString('base64'),
      tagBase64: tag.toString('base64'), wrappedKeyBase64: wrappedKey.toString('base64'),
      aadBase64: aad.toString('base64'), aadSha256: hash(aad),
    }
  } finally { key.fill(0); plaintext.fill(0) }
}

try {
  requireThat(process.env.MIKKA_1503_PRIVATE_THREAD_DIAGNOSTIC_GO === 'read_and_seal_fixed_child_tools_once', 'diagnostic_not_enabled')
  requireThat(process.env.GITHUB_REF === 'refs/heads/ops/issue-1503-production-smoke'
    && process.env.GITHUB_EVENT_NAME === 'push' && /^[a-f0-9]{40}$/.test(report.operatorSha ?? '')
    && /^[0-9]+$/.test(report.workflowRunId ?? '') && report.workflowAttempt === '1', 'operator_source_invalid')
  requireThat(/^[a-f0-9]{40}$/.test(APP) && process.env.MIKKA_EXPECTED_DEPLOYMENT_SHA === APP
    && process.env.MIKKA_1503_START_FIXTURE_SHA256 === FIXTURE_SHA, 'configuration_mismatch')
  report.scriptSha256 = hash(await readFile(new URL(import.meta.url)))
  report.httpHelperSha256 = hash(await readFile(new URL('./http.ts', import.meta.url)))
  requireThat(report.httpHelperSha256 === HTTP_HELPER_SHA, 'http_helper_source_changed')
  const fixtureBytes = await readFile('scripts/ops/issue1503/fixture-state.json')
  requireThat(hash(fixtureBytes) === FIXTURE_SHA, 'historical_fixture_sha_mismatch')
  report.historicalFixtureVerified = true
  const publicPem = await readFile(new URL('./recipient-question-6e8e0149-public.pem', import.meta.url))
  requireThat(hash(publicPem) === PUBLIC_KEY_SHA, 'recipient_public_key_changed')
  recipient = createPublicKey(publicPem)
  requireThat(recipient.asymmetricKeyType === 'rsa' && recipient.asymmetricKeyDetails?.modulusLength === 3072, 'recipient_key_invalid')
  report.recipientPublicKeyVerified = true
  await save()
  report.stage = 'normal_login'
  session = await smokeSession()
  requireThat(session.user.id === SMOKE_ID, 'identity_mismatch')
  report.sessionOpened = true
  report.stage = 'production_before'
  const before = await once('version_before')
  report.productionBefore = typeof before?.build === 'string' && /^[a-f0-9]{40}$/.test(before.build) ? before.build : null
  requireThat(report.productionBefore === APP, 'production_source_changed')
  report.stage = 'read_and_seal_fixed_child_tools_once'
  let detail: any
  let selected: any[] | null = null
  try {
    detail = await once('thread')
    selected = selectCommandEvidence(detail)
    report.sealedThreadTools = sealCommands(selected)
  } finally {
    selected?.splice(0)
    if (record(detail)) {
      delete detail.chunks; delete detail.messages
      if (record(detail.thread)) { delete detail.thread.prompt; delete detail.thread.detail }
    }
    detail = null
  }
  await save()
} catch (error) {
  report.failures.push({ operation: report.stage, code: safeFailure(error) })
} finally {
  if (session) {
    try {
      const after = await once('version_after')
      report.productionAfter = typeof after?.build === 'string' && /^[a-f0-9]{40}$/.test(after.build) ? after.build : null
      requireThat(report.productionAfter === APP && report.productionBefore === APP, 'production_source_changed')
    } catch (error) { report.failures.push({ operation: 'production_after', code: safeFailure(error) }) }
    report.logout = { attempted: true, transportResolved: false, responseStatusAvailable: false }
    try { await session.close(); report.logout.transportResolved = true }
    catch (error) { report.failures.push({ operation: 'normal_logout', code: safeFailure(error) }) }
  }
  report.businessReadsAttempted = report.counts.thread
  report.status = report.failures.length === 0 && report.counts.thread === 1 && report.sealedThreadTools
    && report.counts.version_before === 1 && report.counts.version_after === 1 ? 'completed' : 'failed'
  report.stage = 'finished'; report.completedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ phase: report.phase, status: report.status, counts: report.counts,
    commandEvidence: report.commandEvidence ?? 'unknown', sealedThreadToolsPresent: Boolean(report.sealedThreadTools), failureCount: report.failures.length }))
  if (report.status !== 'completed') process.exitCode = 1
}
