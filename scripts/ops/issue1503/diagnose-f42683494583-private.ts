import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { decode, encode } from '../../../lib/desktop-rpc/wire'
import { smokeSession, SMOKE_ID } from './http.ts'

const APP = 'd8e09ac218f5656763a5bc42a75e45fc385caede'
const BASE = '75b69813a4edbab97b668bdb7138eb681d54eb95'
const FAILED_SOURCE = '3fb90418c513d65b52e1e09dc6e46b2d83c4e3e0'
const FIXTURE_SHA = '0da23cbb104014a36e130c82c3ae583f01a16825686da1393fb572bc8b199791'
const CREDIT_SHA = '5a80cc31ab5a4d219fdb77cc90e259dede9ba970ca055d517174d3d2de4786b6'
const HTTP_HELPER_SHA = 'fe96ea60b8924a8070c0ab6dfe15ef08838856780798a574cb88d69b62b91dec'
const PUBLIC_KEY_SHA = '2a3f2d8917ad66d0e8067196c68e55afd086dc864e40d5cf2d817e32d7289349'
const WORKSPACE = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const TARGETS = [
  { key: 'claude', harness: 'claude_code', taskId: '26e80ec8-573a-450b-82cb-19a2cd8cd072', runId: 'd0d86b98-5bd7-43e1-8e2a-6b9323380d8d' },
  { key: 'codex', harness: 'codex', taskId: '6afd92fa-7a27-49c6-bef3-2078372ac7cb', runId: '9c3b5adc-4816-4180-a9a0-0cd30a2d2f3d',
    botId: '1dc0d205-38f4-4925-934e-d5b96d3d6e89', attemptId: 'faf6a1db-8894-46b2-9db5-bb8ab04876ae',
    originRunId: '5f35a381-52bf-4477-8042-3f31f65c4686', knownQuestionId: '11b1f6be-290e-4546-ad80-5b4ea798419e',
    knownQuestionSha256: '8503a0ae2b4c24831b6891b855bd588d35fabe70a0ce5a0b40c4b9f546f5acbe',
    answerId: '1317e261-154a-47e9-b177-cff8a19feb63' },
] as const
const CX = TARGETS[1]
type Target = typeof TARGETS[number]
const BUSINESS_KEYS = ['claude_task', 'claude_evidence', 'codex_task', 'codex_evidence', 'codex_thread', 'codex_question'] as const
type BusinessKey = typeof BUSINESS_KEYS[number]
type ReadKey = BusinessKey | 'version_before' | 'version_after'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_SEALED_BYTES = 4 * 1024 * 1024
const MAX_ATTEMPTS = 16
const MAX_CANDIDATES = 16
const MAX_CHUNKS = 4000
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const ERROR_CODES = ['authRequired', 'factoryNotFound', 'factoryHumanRequired', 'factoryInvalid', 'factoryLifecycleUnavailable',
  'workspaceAccessDenied', 'botNotFound', 'runNotFound', 'validationGeneric', 'originRejected', 'methodNotAllowed', 'factoryConflict', 'factoryStale']
class DiagnosticFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DiagnosticFailure' }
}
const requireThat = (value: unknown, code: string) => { if (!value) throw new DiagnosticFailure(code) }
const safeFailure = (error: unknown) => error instanceof DiagnosticFailure ? error.code
  : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'request_timeout' : 'operation_failed'

function admitTask(value: any, target: Target) {
  const task = value?.task
  requireThat(record(task) && value.liveWorkspaceId === WORKSPACE && task.id === target.taskId
    && task.userId === SMOKE_ID && task.workspaceId === WORKSPACE && uuid(task.issueId) && uuid(task.botId), 'task_scope_mismatch')
  if (target.key === 'codex') requireThat(task.botId === CX.botId, 'task_bot_mismatch')
  requireThat(Array.isArray(value.attempts) && value.attempts.length <= MAX_ATTEMPTS
    && value.attempts.every((a: any) => record(a) && a.taskId === target.taskId && uuid(a.id))
    && new Set(value.attempts.map((a: any) => a.id)).size === value.attempts.length, 'task_attempts_invalid')
  requireThat(Array.isArray(value.candidates) && value.candidates.length <= MAX_CANDIDATES
    && value.candidates.every((c: any) => record(c) && c.taskId === target.taskId && uuid(c.id))
    && new Set(value.candidates.map((c: any) => c.id)).size === value.candidates.length, 'task_candidates_invalid')
  const bound = value.attempts.filter((a: any) => a.runId === target.runId)
  requireThat(bound.length === 1, 'run_task_binding_mismatch')
  if (target.key === 'codex') {
    requireThat(bound[0].id === CX.attemptId && bound[0].stage === 'execute'
      && value.attempts.some((a: any) => a.runId === CX.originRunId && a.stage === 'execute'), 'continuation_lineage_mismatch')
  }
  return { issueId: task.issueId as string, botId: task.botId as string, attempt: bound[0] }
}
function admitEvidence(value: any, target: Target, scope: { issueId: string; botId: string }) {
  requireThat(record(value) && record(value.run) && value.run.id === target.runId
    && value.run.issueId === scope.issueId && value.run.botId === scope.botId
    && value.run.harness === target.harness, 'evidence_scope_mismatch')
}
function questionDecision(scope: { attempt: any }) {
  const id = scope.attempt.output?.questionId
  if (id === undefined || id === null) return { decision: 'no_question_id_in_continuation_output', id: null }
  if (id === CX.knownQuestionId) return { decision: 'known_question_not_reread', id: null }
  requireThat(uuid(id), 'continuation_question_id_invalid')
  return { decision: 'new_question_id', id }
}
function admitQuestion(value: any, questionId: string, scope: { issueId: string }) {
  requireThat(record(value) && value.id === questionId && value.userId === SMOKE_ID
    && value.taskId === CX.taskId && value.issueId === scope.issueId && value.attemptId === CX.attemptId
    && value.originRunId === CX.runId && value.stage === 'execute', 'question_scope_mismatch')
}
function admitThread(value: any) {
  requireThat(record(value) && record(value.thread) && record(value.chunkCursor) && Array.isArray(value.chunks)
    && value.chunks.length <= MAX_CHUNKS, 'thread_dto_invalid')
  const thread = value.thread, cursor = value.chunkCursor
  requireThat(thread.id === CX.runId && thread.rootRunId === CX.originRunId && thread.latestRunId === CX.runId
    && thread.ownedByCurrentUser === true && value.live?.issueWorkspaceId === WORKSPACE
    && Array.isArray(thread.attempts) && thread.attempts.length === 2
    && thread.attempts[0]?.runId === CX.originRunId && thread.attempts[1]?.runId === CX.runId
    && cursor.chain === CX.runId && value.chunksAppend === false, 'thread_scope_mismatch')
  requireThat(Number.isSafeInteger(cursor.seq) && cursor.seq >= 0 && cursor.count === value.chunks.length
    && (value.chunks.length > 0 ? cursor.runId === CX.runId && cursor.runs === 1 : cursor.runId === null && cursor.runs === 0),
  'thread_cursor_invalid')
}

const report: any = {
  issue: 1503, phase: 'private_failure_diagnosis_42683494583', acceptancePassed: false,
  expectedAppSha: APP, preparationBase: BASE, failedFSource: FAILED_SOURCE, failedFRunId: 42683494583, failedFAttempt: 1,
  fixtureSha256: FIXTURE_SHA, creditShareSha256: CREDIT_SHA, credentialReuseScope: 'normal_smoke_login_only',
  workspaceId: WORKSPACE, targets: TARGETS, recipientPublicKeySha256: PUBLIC_KEY_SHA,
  operatorSha: process.env.GITHUB_SHA ?? null, workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  snapshotTiming: 'after_driver_finally_not_failure_instant',
  startedAt: new Date().toISOString(), status: 'started', stage: 'configuration',
  counts: Object.fromEntries(['version_before', ...BUSINESS_KEYS, 'version_after'].map(k => [k, 0])),
  requests: {}, sealed: {}, failures: [],
  limits: { businessReads: 6, eachRead: 1, responseBytes: MAX_RESPONSE_BYTES, sealedBytesPerRead: MAX_SEALED_BYTES,
    attemptsPerTask: MAX_ATTEMPTS, candidatesPerTask: MAX_CANDIDATES, chunks: MAX_CHUNKS },
  interpretation: {
    runEvidence: 'status_and_frozen_provenance_not_report_or_publication_error',
    task: 'attempt_reason_output_candidates_and_current_candidate_delivery',
    thread: 'exact_codex_continuation_normal_thread_response',
    publication: 'no_direct_publication_error_lookup_or_missing_PR_inference',
    cause: 'not_inferred_by_collector',
  },
}
let session: Awaited<ReturnType<typeof smokeSession>> | null = null
let recipient: ReturnType<typeof createPublicKey> | null = null
let codexIssueId: string | null = null
let newQuestionId: string | null = null
const save = async () => {
  await mkdir('issue1503-report', { recursive: true, mode: 0o700 })
  await writeFile('issue1503-report/private-failure-42683494583.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
function requestSpec(name: ReadKey): { path: string; init: RequestInit } {
  const headers = { 'content-type': 'application/json', cookie: 'mikka-workspace=' + WORKSPACE, 'x-mikka-locale': 'en' }
  if (name === 'version_before' || name === 'version_after') return { path: '/api/version', init: { method: 'GET', headers } }
  if (name === 'codex_thread') {
    requireThat(uuid(codexIssueId), 'thread_issue_not_bound')
    return { path: '/api/desktop/rpc', init: { ...session!.post({ version: 1, action: 'agents.getIssueThread',
      args: encode([codexIssueId, CX.runId, null]) }), headers } }
  }
  if (name === 'codex_question') {
    requireThat(uuid(newQuestionId) && newQuestionId !== CX.knownQuestionId, 'question_not_admitted')
    return { path: '/api/factory/questions/' + newQuestionId, init: { method: 'GET', headers } }
  }
  const target = name.startsWith('claude_') ? TARGETS[0] : CX
  return { path: name.endsWith('_task') ? '/api/factory/tasks/' + target.taskId : '/api/runs/' + target.runId + '/evidence',
    init: { method: 'GET', headers } }
}
async function once(name: ReadKey) {
  requireThat(session && Object.hasOwn(report.counts, name) && report.counts[name] === 0, 'request_binding_invalid')
  if ((BUSINESS_KEYS as readonly string[]).includes(name))
    requireThat(BUSINESS_KEYS.reduce((n, k) => n + report.counts[k], 0) < 6, 'business_read_limit')
  const spec = requestSpec(name)
  report.counts[name]++
  const receipt: any = report.requests[name] = { method: spec.init.method, path: spec.path, startedAt: new Date().toISOString() }
  try {
    const response = await session!.request(spec.path, spec.init)
    const bytes = Buffer.from(await response.arrayBuffer())
    receipt.completedAt = new Date().toISOString(); receipt.httpStatus = response.status; receipt.httpOk = response.ok
    receipt.responseBytes = bytes.length; receipt.responseSha256 = hash(bytes)
    let value: any
    try {
      requireThat(bytes.length <= MAX_RESPONSE_BYTES, 'response_size_limit')
      try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new DiagnosticFailure('response_json_invalid') }
    } finally { bytes.fill(0) }
    const code = typeof value?.error?.code === 'string' ? value.error.code : value?.error
    receipt.errorCode = typeof code === 'string' && ERROR_CODES.includes(code) ? code : null
    receipt.errorCodeSha256 = typeof code === 'string' ? hash(code) : null
    requireThat(response.ok, 'http_failed')
    if (name === 'codex_thread') {
      requireThat(value?.version === 1 && value?.ok === true && Object.hasOwn(value, 'result'), 'rpc_envelope_invalid')
      try { return decode(value.result) } catch { throw new DiagnosticFailure('rpc_result_invalid') }
    }
    return value
  } catch (error) {
    receipt.completedAt ??= new Date().toISOString(); receipt.failureCode = safeFailure(error)
    throw error
  }
}
function sealPayload(name: BusinessKey, value: any, binding: Record<string, unknown>) {
  requireThat(recipient && !report.sealed[name], 'seal_binding_invalid')
  const scope = {
    format: 'mikka.issue1503.private-failure.v1', read: name, ...binding, workspaceId: WORKSPACE, ownerId: SMOKE_ID,
    expectedAppSha: APP, failedFSource: FAILED_SOURCE, failedFRunId: 42683494583, failedFAttempt: 1,
    operatorSha: report.operatorSha, workflowRunId: report.workflowRunId, workflowAttempt: report.workflowAttempt,
    rpcResponseSha256: report.requests[name].responseSha256, recipientPublicKeySha256: PUBLIC_KEY_SHA,
  }
  const aad = Buffer.from(JSON.stringify(scope), 'utf8')
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const key = randomBytes(32), nonce = randomBytes(12)
  try {
    requireThat(plaintext.length <= MAX_SEALED_BYTES, 'sealed_content_size_limit')
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    const wrappedKey = publicEncrypt({ key: recipient!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)
    requireThat(tag.length === 16 && wrappedKey.length === 384, 'envelope_length_invalid')
    report.sealed[name] = { format: scope.format, scope, keyWrapAlgorithm: 'RSA-OAEP-SHA256', contentAlgorithm: 'AES-256-GCM',
      recipientPublicKeySha256: PUBLIC_KEY_SHA, plaintextBytes: plaintext.length, plaintextSha256: hash(plaintext),
      ciphertextBytes: ciphertext.length, ciphertextSha256: hash(ciphertext), ciphertextBase64: ciphertext.toString('base64'),
      nonceBase64: nonce.toString('base64'), tagBase64: tag.toString('base64'), wrappedKeyBase64: wrappedKey.toString('base64'),
      aadBase64: aad.toString('base64'), aadSha256: hash(aad) }
  } finally { key.fill(0); plaintext.fill(0) }
}
async function observe(name: string, work: () => Promise<void>) {
  report.stage = name
  try { await work() } catch (error) { report.failures.push({ operation: name, code: safeFailure(error) }) }
  await save()
}
try {
  requireThat(process.env.MIKKA_1503_PRIVATE_FAILURE_DIAGNOSTIC_GO === 'read_and_seal_two_failed_targets_once', 'diagnostic_not_enabled')
  requireThat(process.env.GITHUB_REF === 'refs/heads/ops/issue-1503-production-smoke' && process.env.GITHUB_EVENT_NAME === 'push'
    && /^[a-f0-9]{40}$/.test(report.operatorSha ?? '') && /^[1-9][0-9]*$/.test(report.workflowRunId ?? '')
    && report.workflowAttempt === '1', 'operator_source_invalid')
  requireThat(process.env.MIKKA_EXPECTED_DEPLOYMENT_SHA === APP && process.env.MIKKA_1503_START_FIXTURE_SHA256 === FIXTURE_SHA
    && process.env.MIKKA_1503_CREDIT_SHARE_SHA256 === CREDIT_SHA, 'configuration_mismatch')
  report.scriptSha256 = hash(await readFile(new URL(import.meta.url)))
  report.httpHelperSha256 = hash(await readFile(new URL('./http.ts', import.meta.url)))
  requireThat(report.httpHelperSha256 === HTTP_HELPER_SHA, 'http_helper_source_changed')
  for (const [file, expected] of [['fixture-state.json', FIXTURE_SHA], ['credit-share-state.json', CREDIT_SHA]]) {
    const bytes = await readFile('scripts/ops/issue1503/' + file)
    try { requireThat(hash(bytes) === expected, 'fixture_source_mismatch') } finally { bytes.fill(0) }
  }
  report.fixtureSourcesVerified = true
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
  for (const target of TARGETS) {
    let taskScope: ReturnType<typeof admitTask> | null = null
    await observe(target.key + '_task', async () => {
      const value = await once((target.key + '_task') as BusinessKey)
      taskScope = admitTask(value, target)
      sealPayload((target.key + '_task') as BusinessKey, value, { taskId: target.taskId, issueId: taskScope.issueId, runId: target.runId })
      if (target.key === 'codex') {
        codexIssueId = taskScope.issueId
        const decision = questionDecision(taskScope)
        newQuestionId = decision.id
        report.questionLookup = decision
      }
    })
    if (taskScope) {
      const scope = taskScope as ReturnType<typeof admitTask>
      await observe(target.key + '_evidence', async () => {
        const value = await once((target.key + '_evidence') as BusinessKey)
        admitEvidence(value, target, scope)
        sealPayload((target.key + '_evidence') as BusinessKey, value, { taskId: target.taskId, issueId: scope.issueId, runId: target.runId })
      })
    }
  }
  if (codexIssueId) {
    await observe('codex_thread', async () => {
      const value = await once('codex_thread')
      admitThread(value)
      sealPayload('codex_thread', value, { taskId: CX.taskId, issueId: codexIssueId, runId: CX.runId, originRunId: CX.originRunId })
    })
    if (newQuestionId) {
      await observe('codex_question', async () => {
        const value = await once('codex_question')
        admitQuestion(value, newQuestionId!, { issueId: codexIssueId! })
        sealPayload('codex_question', value, { taskId: CX.taskId, issueId: codexIssueId, runId: CX.runId, questionId: newQuestionId })
      })
    }
  }
} catch (error) {
  report.failures.push({ operation: report.stage, code: safeFailure(error) })
} finally {
  if (session) {
    try {
      const after = await once('version_after')
      report.productionAfter = typeof after?.build === 'string' && /^[a-f0-9]{40}$/.test(after.build) ? after.build : null
      requireThat(report.productionBefore === APP && report.productionAfter === APP, 'production_source_changed')
    } catch (error) { report.failures.push({ operation: 'production_after', code: safeFailure(error) }) }
    report.logout = { attempted: true, transportResolved: false, responseStatusAvailable: false }
    try { await session.close(); report.logout.transportResolved = true }
    catch (error) { report.failures.push({ operation: 'normal_logout', code: safeFailure(error) }) }
  }
  report.businessReadsAttempted = BUSINESS_KEYS.reduce((n, k) => n + report.counts[k], 0)
  const expected = newQuestionId ? 6 : 5
  report.businessReadsSealed = Object.keys(report.sealed).length
  report.status = report.failures.length === 0 && report.businessReadsAttempted === expected
    && report.businessReadsSealed === expected && report.counts.version_before === 1 && report.counts.version_after === 1
    ? 'completed' : 'failed'
  report.stage = 'finished'; report.completedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ phase: report.phase, status: report.status, counts: report.counts,
    businessReadsSealed: report.businessReadsSealed, failureCount: report.failures.length }))
  if (report.status !== 'completed') process.exitCode = 1
}
