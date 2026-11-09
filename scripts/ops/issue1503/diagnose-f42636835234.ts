import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { smokeSession, SMOKE_ID } from './http.ts'
import { encode, decode } from '../../../lib/desktop-rpc/wire.ts'
import { fileSpecification, deliveryTaskText } from './delivery.mjs'
import { codexQuestionConfirmation } from './question-confirmation.mjs'

const APP = '76537e4c2996f717cbd19589e1efae328028aa4a'
const FAILED_SOURCE = '7017d5f14871cbf1aeea771824d72e1d2bd90255'
const FIXTURE_SHA = '9e0836aa5e5d290dac5c282e82f56907b99207820ded44396159b935c53f9de7'
const DRIVER_SHA = '553bea3b62dd8d3d7d8caa5c3b801b315af28a4441f3dfbcf2039fe33f9e7a24'
const WORKSPACE = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const MARKER = '42636835234-1'
const REPOSITORY = 'alexj11324/Mikka-handoff'
const QUESTION = '72f14816-82b0-4ddf-81ee-b719cf78eb65'
const CASES = [
  { harness: 'claude_code', botId: 'c84d7015-f492-4606-840f-d19e1c7578c8',
    taskId: 'f695503c-c7fb-40e1-9659-df918f8b1b6e', issueId: 'fa86659d-a5f2-48ab-992a-ee75f716d562',
    profileId: 'f854e9d5-93a8-4ce3-8d6d-861d0b40ba8b' },
  { harness: 'codex', botId: '0f7336dc-3a1e-4cd8-ad1d-8fbb3a9c8386',
    taskId: '4ad3fce3-a6e8-40b3-9248-df1ea6bc9faf', issueId: 'c38abb4c-2f8a-48ea-b70b-9f2badda85ee',
    profileId: '6dbc1bd2-6157-48bb-acb2-1d66b77cf119' },
] as const
type Case = typeof CASES[number]
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v)
const id = (v: unknown) => uuid(v) ? v : null
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const textHash = (v: unknown) => typeof v === 'string' ? hash(v) : null
const objectHash = (v: unknown) => hash(JSON.stringify(v) ?? 'null')
const integer = (v: unknown) => Number.isSafeInteger(v) ? v : null
const flag = (v: unknown) => typeof v === 'boolean' ? v : null
const time = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d/.test(v) && Number.isFinite(Date.parse(v)) ? v : null
const words = (v: unknown, choices: readonly string[]) => typeof v === 'string' && choices.includes(v) ? v : null
const STATES = ['idle', 'pending', 'queued', 'preparing', 'running', 'paused', 'waiting', 'waiting_input',
  'finishing', 'stopped', 'succeeded', 'failed', 'blocked', 'cancelled', 'revoked', 'passed', 'open',
  'waiting_user', 'answered', 'resuming', 'superseded', 'expired', 'obsolete', 'closed', 'resolved']
const STAGES = ['triage', 'spec', 'plan', 'prepare', 'execute', 'review', 'verify', 'approval', 'publish']
const ERROR_CODES = ['authRequired', 'factoryNotFound', 'factoryHumanRequired', 'factoryInvalid',
  'factoryLifecycleUnavailable', 'workspaceAccessDenied', 'botNotFound', 'validationGeneric',
  'originRejected', 'methodNotAllowed', 'factoryConflict', 'factoryStale']
const apiCode = (v: unknown) => words(v, ERROR_CODES)
class DiagnosticFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DiagnosticFailure' }
}
const requireThat = (value: unknown, code: string) => { if (!value) throw new DiagnosticFailure(code) }
const safeFailure = (error: unknown) => error instanceof DiagnosticFailure ? error.code
  : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'request_timeout' : 'operation_failed'
const array = (v: unknown, code: string): any[] => {
  requireThat(Array.isArray(v) && v.length <= 250, code)
  return v as any[]
}
function expectedDispatch(item: Case) {
  const specification = fileSpecification(MARKER, item.harness)
  const confirmation = item.harness === 'codex' ? codexQuestionConfirmation(MARKER, specification) : null
  const taskText = (confirmation ? confirmation.instructions + '\n\n' : '') + deliveryTaskText(specification)
  const title = 'Factory #1503 ' + MARKER + ' ' + item.harness + ' explicit cloud'
  return 'Create a task for me (run it on Mikka Cloud): Create one new task with this exact title: ' + title
    + '. Put the following complete requirements in its body.\n' + taskText
    + '\nCreate the task through normal create_issue in this workspace\'s sole F1503 team, then dispatch that created task with normal dispatch_run, repo '
    + REPOSITORY + ', target cloud, model harness ' + item.harness + ', selected Profile ' + item.profileId
    + ', needsSpec false. Do not create another task or use dispatch_bot_computer. Follow the injected Mikka agent delivery instructions and leave its PR open for my Factory review.'
}
function projectChat(chat: any, item: Case) {
  requireThat(chat?.botId === item.botId && chat.live?.ownerId === SMOKE_ID && uuid(chat.live.workspaceId), 'chat_scope_mismatch')
  const items = array(chat.items, 'chat_items_invalid')
  const expected = expectedDispatch(item)
  const matching = items.filter(message => message.from === 'person' && message.text === expected)
  const person = matching.length === 1 ? matching[0] : null
  const committedPerson = person !== null && !person.pending && uuid(person.id) && Number.isSafeInteger(person.position)
  const replies = person ? items.filter(message => message.from === 'coordinator'
    && Number.isSafeInteger(message.position) && message.position > person.position && !message.pending && uuid(message.id)) : []
  const revisions = chat.live.revisions
  const version = typeof chat.version === 'string' && /^[a-f0-9]{32}$/.test(chat.version) ? chat.version : null
  return {
    botId: chat.botId, live: { ownerId: SMOKE_ID, workspaceId: chat.live.workspaceId,
      matchesFixtureWorkspace: chat.live.workspaceId === WORKSPACE,
      botChatRevision: integer(revisions?.['bot_chat:' + item.botId]),
      deadline: chat.live.deadline ? { at: time(chat.live.deadline.at), afterMs: integer(chat.live.deadline.afterMs) } : null },
    working: flag(chat.working), enabled: flag(chat.enabled), cursor: integer(chat.cursor), version,
    after: integer(chat.after), baseCursor: integer(chat.baseCursor),
    error: words(chat.error, ['wake_exhausted', 'wake_failed', 'wake_start_unconfirmed', 'turn_failed', 'length']),
    errorPresent: typeof chat.error === 'string' && chat.error.length > 0, errorSha256: textHash(chat.error),
    originalBeforeCursor: null, originalBeforeCursorState: 'not_recorded_do_not_assume_zero',
    expectedDispatchSha256: hash(expected), matchingPersonCount: matching.length,
    uniqueMatchingPersonId: person ? id(person.id) : null, uniqueMatchingPersonPosition: person ? integer(person.position) : null,
    uniqueMatchingPersonCommitted: committedPerson,
    committedCoordinatorRepliesAfterMatchingPerson: replies.length,
    currentCompletionComponentsSatisfied: chat.working === false && committedPerson && replies.length > 0,
    originalTimeoutPredicateEvaluated: false,
    snapshotTiming: 'after_driver_finally_not_timeout_instant',
    itemCount: items.length, personCount: items.filter(message => message.from === 'person').length,
    coordinatorCount: items.filter(message => message.from === 'coordinator').length,
    messages: items.filter(message => ['person', 'coordinator'].includes(message.from)).map(message => ({
      id: id(message.id), from: words(message.from, ['person', 'coordinator']), position: integer(message.position),
      pending: flag(message.pending), textSha256: textHash(message.text),
      exactExpectedPersonText: message.from === 'person' && message.text === expected,
      afterUniqueMatchingPerson: person !== null && Number.isSafeInteger(message.position) && message.position > person.position,
    })),
  }
}
function binding(value: any) {
  return value && typeof value === 'object' ? {
    taskId: id(value.taskId), issueId: id(value.issueId), attemptId: id(value.attemptId),
    candidateId: id(value.candidateId), revision: integer(value.revision),
  } : null
}
function projectTask(value: any, item: Case) {
  requireThat(value?.liveWorkspaceId === WORKSPACE && value.task?.id === item.taskId
    && value.task.issueId === item.issueId && value.task.botId === item.botId, 'task_scope_mismatch')
  const attempts = array(value.attempts, 'task_attempts_invalid')
  return { liveWorkspaceId: value.liveWorkspaceId,
    task: { id: item.taskId, issueId: item.issueId, botId: item.botId,
      stage: words(value.task.stage, STAGES), status: words(value.task.status, STATES),
      revision: integer(value.task.revision), attemptId: id(value.task.attemptId), candidateId: id(value.task.candidateId),
      sourceEventId: id(value.task.sourceEventId), createdAt: time(value.task.createdAt), updatedAt: time(value.task.updatedAt) },
    attemptCount: attempts.length, attempts: attempts.map(attempt => ({
      id: id(attempt.id), taskId: id(attempt.taskId), runId: id(attempt.runId),
      stage: words(attempt.stage, STAGES), status: words(attempt.status, STATES), candidateId: id(attempt.candidateId),
      createdAt: time(attempt.createdAt), startedAt: time(attempt.startedAt), finishedAt: time(attempt.finishedAt),
      reasonCode: apiCode(attempt.output?.reasonCode), reasonCodeSha256: textHash(attempt.output?.reasonCode),
    })) }
}
function projectActivity(value: any) {
  requireThat(value?.version === 1 && value.liveWorkspaceId === WORKSPACE, 'activity_scope_mismatch')
  const waits = array(value.timeline?.waits, 'activity_waits_invalid')
  const attempts = array(value.timeline?.attempts, 'activity_attempts_invalid')
  const questions = waits.filter(wait => wait.kind === 'question' && typeof wait.id === 'string'
    && wait.id.startsWith('question:') && uuid(wait.id.slice('question:'.length)))
  return { taskId: CASES[1].taskId, liveWorkspaceId: value.liveWorkspaceId, observedAt: time(value.observedAt),
    taskStatus: words(value.task?.status, STATES), waitCount: waits.length, questionWaitCount: questions.length,
    questionWaits: questions.map(wait => ({ questionId: wait.id.slice('question:'.length),
      attemptId: id(wait.attemptId), runId: id(wait.runId), startedAt: time(wait.startedAt),
      endedAt: time(wait.endedAt), durationMs: integer(wait.durationMs), isKnownQuestion: wait.id === 'question:' + QUESTION })),
    attemptCount: attempts.length, attempts: attempts.map(attempt => ({
      id: id(attempt.id), attemptId: id(attempt.attemptId), runId: id(attempt.runId),
      stage: words(attempt.stage, STAGES), status: words(attempt.status, STATES),
      startedAt: time(attempt.startedAt), endedAt: time(attempt.endedAt) })),
  }
}
function projectQuestion(question: any) {
  requireThat(question?.id === QUESTION && question.userId === SMOKE_ID
    && question.taskId === CASES[1].taskId && question.issueId === CASES[1].issueId, 'question_scope_mismatch')
  const reference = question.reference
  const result = question.result
  return { id: question.id, taskId: question.taskId, issueId: question.issueId,
    attemptId: id(question.attemptId), candidateId: id(question.candidateId),
    stage: words(question.stage, STAGES), kind: words(question.kind, ['permission', 'context', 'decision']),
    status: words(question.status, STATES), revision: integer(question.revision),
    answerId: id(question.answerId), answerSource: words(question.answerSource, ['human', 'orchestrator', 'agent']),
    sourceEventId: id(question.sourceEventId), escalationEventId: id(question.escalationEventId),
    originRunId: id(question.originRunId), originRevision: integer(question.originRevision),
    continuationRunId: id(question.continuationRunId), originSessionSha256: textHash(question.originSessionId),
    createdAt: time(question.createdAt), expiresAt: time(question.expiresAt),
    waitingBinding: binding(question.waitingBinding),
    reference: reference ? { questionId: id(reference.questionId), questionRevision: integer(reference.questionRevision),
      originRunId: id(reference.originRunId), originSessionSha256: textHash(reference.originSessionId),
      binding: binding(reference.binding), sha256: objectHash(reference) } : null,
    result: result ? { questionId: id(result.questionId), continuationRunId: id(result.continuationRunId),
      replayed: flag(result.replayed), taskBinding: binding(result.task), sha256: objectHash(result) } : null,
  }
}

const BUSINESS_KEYS = ['claude_code_chat', 'claude_code_task', 'codex_chat', 'codex_task', 'codex_activity', 'codex_known_question'] as const
const report: any = {
  issue: 1503, phase: 'read_only_diagnosis_42636835234', acceptancePassed: false,
  expectedAppSha: APP, failedFSource: FAILED_SOURCE, failedFRunId: 42636835234, failedFAttempt: 1,
  fixtureSha256: FIXTURE_SHA, workspaceId: WORKSPACE, identities: CASES,
  operatorSha: process.env.GITHUB_SHA ?? null,
  workflowRunId: process.env.GITHUB_RUN_ID ?? null, workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  snapshotTiming: 'after_driver_finally_not_timeout_instant',
  startedAt: new Date().toISOString(), status: 'started', stage: 'configuration',
  counts: Object.fromEntries(['version_before', ...BUSINESS_KEYS, 'version_after'].map(key => [key, 0])),
  requests: {}, observations: {}, failures: [],
}
let session: Awaited<ReturnType<typeof smokeSession>> | null = null
const save = async () => {
  await mkdir('issue1503-report', { recursive: true, mode: 0o700 })
  await writeFile('issue1503-report/diagnostic-42636835234.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
async function once(name: string, path: string, init: RequestInit = {}) {
  requireThat(session && report.counts[name] === 0, 'request_count_invalid')
  report.counts[name]++
  const receipt: any = report.requests[name] = { method: init.method ?? 'GET', path, startedAt: new Date().toISOString() }
  try {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const response = await session!.request(path, { ...init,
      headers: { cookie: 'mikka-workspace=' + WORKSPACE, 'x-mikka-locale': 'en', ...headers } })
    const bytes = Buffer.from(await response.arrayBuffer())
    receipt.completedAt = new Date().toISOString()
    receipt.httpStatus = response.status; receipt.httpOk = response.ok
    receipt.responseBytes = bytes.length; receipt.responseSha256 = hash(bytes)
    let value: any
    try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new DiagnosticFailure('response_json_invalid') }
    receipt.errorCode = apiCode(value?.error); receipt.errorCodeSha256 = textHash(value?.error)
    requireThat(response.ok, 'http_failed')
    return value
  } catch (error) {
    receipt.completedAt ??= new Date().toISOString(); receipt.failureCode = safeFailure(error)
    throw error
  }
}
async function chatOnce(item: Case) {
  const result = await once(item.harness + '_chat', '/api/desktop/rpc',
    session!.post({ version: 1, action: 'coordinator.syncCoordinatorChat', args: encode([item.botId]) }))
  requireThat(result?.ok === true, 'rpc_envelope_failed')
  let value: any
  try { value = decode(result.result) } catch { throw new DiagnosticFailure('rpc_decode_failed') }
  const meta = report.requests[item.harness + '_chat']
  meta.action = 'coordinator.syncCoordinatorChat'
  meta.actionErrorCode = apiCode(value?.error); meta.actionErrorCodeSha256 = textHash(value?.error)
  requireThat(value?.ok !== false && !value?.error, 'rpc_action_failed')
  const data = value?.ok === true && Object.hasOwn(value, 'data') ? value.data : value
  return projectChat(data?.chat, item)
}
async function observe(name: string, read: () => Promise<unknown>) {
  report.stage = name
  try { report.observations[name] = await read() }
  catch (error) { report.failures.push({ operation: name, code: safeFailure(error) }) }
  await save()
}
try {
  requireThat(/^[a-f0-9]{40}$/.test(report.operatorSha ?? '')
    && /^[1-9][0-9]*$/.test(report.workflowRunId ?? '')
    && /^[1-9][0-9]*$/.test(report.workflowAttempt ?? ''), 'operator_binding_invalid')
  requireThat(process.env.MIKKA_EXPECTED_DEPLOYMENT_SHA === APP
    && process.env.MIKKA_1503_START_FIXTURE_SHA256 === FIXTURE_SHA, 'configuration_mismatch')
  report.scriptSha256 = hash(await readFile(new URL(import.meta.url)))
  report.driverSha256 = hash(await readFile(new URL('./delivery.mjs', import.meta.url)))
  requireThat(report.driverSha256 === DRIVER_SHA, 'driver_source_changed')
  const fixtureBytes = await readFile('scripts/ops/issue1503/fixture-state.json')
  requireThat(hash(fixtureBytes) === FIXTURE_SHA, 'fixture_sha_mismatch')
  report.fixtureVerified = true
  await save()
  report.stage = 'normal_login'
  session = await smokeSession()
  requireThat(session.user.id === SMOKE_ID, 'identity_mismatch')
  report.sessionOpened = true
  report.stage = 'production_before'
  const before = await once('version_before', '/api/version')
  report.productionBefore = typeof before?.build === 'string' && /^[a-f0-9]{40}$/.test(before.build) ? before.build : null
  requireThat(report.productionBefore === APP, 'production_source_changed')
  for (const item of CASES) {
    await observe(item.harness + '_chat', () => chatOnce(item))
    await observe(item.harness + '_task', async () =>
      projectTask(await once(item.harness + '_task', '/api/factory/tasks/' + item.taskId), item))
  }
  await observe('codex_activity', async () =>
    projectActivity(await once('codex_activity', '/api/factory/tasks/' + CASES[1].taskId + '/activity')))
  await observe('codex_known_question', async () =>
    projectQuestion(await once('codex_known_question', '/api/factory/questions/' + QUESTION)))
} catch (error) {
  report.failures.push({ operation: report.stage, code: safeFailure(error) })
} finally {
  if (session) {
    try {
      const after = await once('version_after', '/api/version')
      report.productionAfter = typeof after?.build === 'string' && /^[a-f0-9]{40}$/.test(after.build) ? after.build : null
      requireThat(report.productionAfter === APP && report.productionBefore === APP, 'production_source_changed')
    } catch (error) { report.failures.push({ operation: 'production_after', code: safeFailure(error) }) }
    report.logout = { attempted: true, transportResolved: false, responseStatusAvailable: false }
    try { await session.close(); report.logout.transportResolved = true }
    catch (error) { report.failures.push({ operation: 'normal_logout', code: safeFailure(error) }) }
  }
  report.businessReadsAttempted = BUSINESS_KEYS.reduce((sum, key) => sum + report.counts[key], 0)
  report.businessReadsProjected = BUSINESS_KEYS.filter(key => Object.hasOwn(report.observations, key)).length
  report.status = report.failures.length === 0 && report.businessReadsAttempted === 6 && report.businessReadsProjected === 6 ? 'completed' : 'failed'
  report.stage = 'finished'; report.completedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ phase: report.phase, status: report.status, counts: report.counts,
    businessReadsProjected: report.businessReadsProjected, failureCount: report.failures.length }))
  if (report.status !== 'completed') process.exitCode = 1
}
