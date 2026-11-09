import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { smokeSession, SMOKE_ID } from './http.ts'

const APP = 'e189d7652fd2fce48b77a3697abf5bb177d8ebd1'
const BASE = 'fbf15abda4e891f6d52e695cc531daf2e3c0e339'
const FAILED_SOURCE = '7017d5f14871cbf1aeea771824d72e1d2bd90255'
const FIXTURE_SHA = '9e0836aa5e5d290dac5c282e82f56907b99207820ded44396159b935c53f9de7'
const HTTP_HELPER_SHA = 'fe96ea60b8924a8070c0ab6dfe15ef08838856780798a574cb88d69b62b91dec'
const KNOWN_QUESTION_SHA = 'f312932a71b2aef71009b40e7ee3e30cba9c35447a76d83df0229afce0322456'
const WORKSPACE = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const TARGET = {
  taskId: '4ad3fce3-a6e8-40b3-9248-df1ea6bc9faf',
  issueId: 'c38abb4c-2f8a-48ea-b70b-9f2badda85ee',
  botId: '0f7336dc-3a1e-4cd8-ad1d-8fbb3a9c8386',
  originAttemptId: '8b6e9429-b679-4492-9feb-8b38e6af3895',
  originRunId: 'eb28a228-a575-4bc6-8732-ca505a3b2636',
  continuationAttemptId: '6c188012-f9e6-4c22-92ed-0e6a70233eca',
  continuationRunId: '0450e5aa-7891-47b9-90db-3a1f6b4b9ca3',
  knownQuestionId: '72f14816-82b0-4ddf-81ee-b719cf78eb65',
} as const
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const id = (value: unknown) => uuid(value) ? value : null
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const textHash = (value: unknown) => typeof value === 'string' ? hash(value) : null
const integer = (value: unknown) => Number.isSafeInteger(value) ? value : null
const words = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value) ? value : null
const STATES = ['pending', 'running', 'waiting', 'passed', 'failed', 'blocked', 'cancelled', 'revoked',
  'open', 'waiting_user', 'answered', 'resuming', 'resolved', 'expired', 'superseded']
const STAGES = ['clarify', 'spec', 'execute', 'review', 'verify', 'approval', 'publish', 'monitor']
const KINDS = ['context', 'decision', 'permission', 'external']
const ERROR_CODES = ['authRequired', 'factoryNotFound', 'factoryHumanRequired', 'factoryInvalid',
  'factoryLifecycleUnavailable', 'workspaceAccessDenied', 'botNotFound', 'validationGeneric',
  'originRejected', 'methodNotAllowed', 'factoryConflict', 'factoryStale']
class DiagnosticFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DiagnosticFailure' }
}
const requireThat = (value: unknown, code: string) => { if (!value) throw new DiagnosticFailure(code) }
const safeFailure = (error: unknown) => error instanceof DiagnosticFailure ? error.code
  : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'request_timeout' : 'operation_failed'
type ReadKey = 'version_before' | 'task' | 'question' | 'version_after'
const report: any = {
  issue: 1503, phase: 'second_question_read_only_diagnosis_42636835234', acceptancePassed: false,
  expectedAppSha: APP, preparationBase: BASE, failedFSource: FAILED_SOURCE, failedFRunId: 42636835234, failedFAttempt: 1,
  historicalFixtureSha256: FIXTURE_SHA, historicalFixtureIdentityOnly: true, credentialsNotReused: true,
  credentialReuseScope: 'historical_fixture_and_github_child', normalSmokeLogin: true,
  workspaceId: WORKSPACE, target: TARGET, knownQuestionTextSha256: KNOWN_QUESTION_SHA,
  operatorSha: process.env.GITHUB_SHA ?? null, workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  snapshotTiming: 'after_failed_window_cleanup_not_failure_instant',
  limitation: 'attempt_output_question_id_is_not_a_complete_question_history',
  startedAt: new Date().toISOString(), stage: 'configuration', status: 'started',
  counts: { version_before: 0, task: 0, question: 0, version_after: 0 },
  requests: {}, observations: {}, failures: [],
  questionLookup: { decision: 'not_reached', newQuestionId: null },
}
let session: Awaited<ReturnType<typeof smokeSession>> | null = null
const save = async () => {
  await mkdir('issue1503-report', { recursive: true, mode: 0o700 })
  await writeFile('issue1503-report/second-question-42636835234.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
async function once(name: ReadKey, path: string) {
  const expectedPath = name === 'task' ? '/api/factory/tasks/' + TARGET.taskId
    : name === 'question' ? '/api/factory/questions/' + report.questionLookup.newQuestionId : '/api/version'
  requireThat(session && report.counts[name] === 0 && path === expectedPath, 'request_binding_invalid')
  if (name === 'question') requireThat(uuid(report.questionLookup.newQuestionId)
    && report.questionLookup.newQuestionId !== TARGET.knownQuestionId
    && report.questionLookup.decision === 'new_question_id', 'question_request_not_admitted')
  report.counts[name]++
  const receipt: any = report.requests[name] = { method: 'GET', path, startedAt: new Date().toISOString() }
  try {
    const response = await session!.request(path, { method: 'GET',
      headers: { cookie: 'mikka-workspace=' + WORKSPACE, 'x-mikka-locale': 'en' } })
    const bytes = Buffer.from(await response.arrayBuffer())
    receipt.completedAt = new Date().toISOString()
    receipt.httpStatus = response.status; receipt.httpOk = response.ok
    receipt.responseBytes = bytes.length; receipt.responseSha256 = hash(bytes)
    let value: any
    try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new DiagnosticFailure('response_json_invalid') }
    receipt.errorCode = words(value?.error, ERROR_CODES); receipt.errorCodeSha256 = textHash(value?.error)
    requireThat(response.ok, 'http_failed')
    return value
  } catch (error) {
    receipt.completedAt ??= new Date().toISOString(); receipt.failureCode = safeFailure(error)
    throw error
  }
}
function projectTask(value: any) {
  const task = value?.task
  requireThat(task?.id === TARGET.taskId && task.userId === SMOKE_ID && task.issueId === TARGET.issueId
    && task.botId === TARGET.botId && value.liveWorkspaceId === WORKSPACE, 'task_scope_mismatch')
  requireThat(Array.isArray(value.attempts), 'attempts_invalid')
  const attempts: any[] = value.attempts
  report.observations.task = {
    id: task.id, issueId: task.issueId, botId: task.botId, stage: words(task.stage, STAGES),
    status: words(task.status, STATES), revision: integer(task.revision), sourceEventId: id(task.sourceEventId),
    currentAttemptId: id(task.attemptId), attemptCount: attempts.length, truncated: attempts.length > 8,
    attempts: attempts.slice(0, 8).map(attempt => ({
      id: id(attempt?.id), taskId: id(attempt?.taskId), runId: id(attempt?.runId),
      stage: words(attempt?.stage, STAGES), status: words(attempt?.status, STATES),
      position: integer(attempt?.position), questionId: id(attempt?.output?.questionId),
    })),
  }
  requireThat(attempts.length <= 8, 'attempts_overflow')
  const origin = attempts.filter(attempt => attempt.id === TARGET.originAttemptId && attempt.runId === TARGET.originRunId)
  const continuation = attempts.filter(attempt => attempt.id === TARGET.continuationAttemptId && attempt.runId === TARGET.continuationRunId)
  requireThat(origin.length === 1 && continuation.length === 1
    && origin[0].taskId === TARGET.taskId && continuation[0].taskId === TARGET.taskId
    && origin[0].stage === 'execute' && continuation[0].stage === 'execute', 'attempt_lineage_mismatch')
  const questionId = continuation[0].output?.questionId
  if (questionId === undefined || questionId === null) {
    report.questionLookup.decision = 'no_question_id_in_continuation_output'
  } else if (questionId === TARGET.knownQuestionId) {
    report.questionLookup.decision = 'known_original_question_only'
  } else {
    requireThat(uuid(questionId), 'continuation_question_id_invalid')
    report.questionLookup = { decision: 'new_question_id', newQuestionId: questionId }
  }
  return task
}
function projectQuestion(question: any, task: any) {
  requireThat(question?.id === report.questionLookup.newQuestionId && question.userId === SMOKE_ID
    && question.taskId === TARGET.taskId && question.issueId === TARGET.issueId
    && question.attemptId === TARGET.continuationAttemptId && question.originRunId === TARGET.continuationRunId
    && question.stage === 'execute', 'question_scope_mismatch')
  requireThat(typeof question.question === 'string', 'question_text_invalid')
  const questionTextSha256 = hash(question.question)
  return {
    id: question.id, taskId: question.taskId, issueId: question.issueId, attemptId: question.attemptId,
    stage: words(question.stage, STAGES), type: words(question.kind, KINDS),
    status: words(question.status, STATES), revision: integer(question.revision),
    sourceEventId: id(question.sourceEventId), sourceEventMatchesTask: question.sourceEventId === task.sourceEventId,
    originRunId: question.originRunId, originRevision: integer(question.originRevision),
    continuationRunId: id(question.continuationRunId), answerId: id(question.answerId),
    answerSource: words(question.answerSource, ['human', 'human_event', 'orchestrator']),
    escalationEventId: id(question.escalationEventId), questionTextSha256,
    matchesKnownConfirmationSha256: questionTextSha256 === KNOWN_QUESTION_SHA,
    textComparison: 'utf8_sha256_against_actual_failed_F_known_question',
  }
}
try {
  requireThat(process.env.MIKKA_1503_SECOND_QUESTION_DIAGNOSTIC_GO === 'read_existing_second_question_once', 'diagnostic_not_enabled')
  requireThat(process.env.GITHUB_REF === 'refs/heads/ops/issue-1503-production-smoke'
    && process.env.GITHUB_EVENT_NAME === 'push'
    && /^[a-f0-9]{40}$/.test(report.operatorSha ?? '')
    && /^[1-9][0-9]*$/.test(report.workflowRunId ?? '')
    && report.workflowAttempt === '1', 'operator_binding_invalid')
  requireThat(/^[a-f0-9]{40}$/.test(APP) && process.env.MIKKA_EXPECTED_DEPLOYMENT_SHA === APP
    && process.env.MIKKA_1503_START_FIXTURE_SHA256 === FIXTURE_SHA, 'configuration_mismatch')
  report.scriptSha256 = hash(await readFile(new URL(import.meta.url)))
  report.httpHelperSha256 = hash(await readFile(new URL('./http.ts', import.meta.url)))
  requireThat(report.httpHelperSha256 === HTTP_HELPER_SHA, 'http_helper_source_changed')
  const fixtureBytes = await readFile('scripts/ops/issue1503/fixture-state.json')
  requireThat(hash(fixtureBytes) === FIXTURE_SHA, 'historical_fixture_sha_mismatch')
  report.historicalFixtureVerified = true
  await save()
  report.stage = 'normal_login'
  session = await smokeSession()
  requireThat(session.user.id === SMOKE_ID, 'identity_mismatch')
  report.sessionOpened = true
  report.stage = 'production_before'
  const before = await once('version_before', '/api/version')
  report.productionBefore = typeof before?.build === 'string' && /^[a-f0-9]{40}$/.test(before.build) ? before.build : null
  requireThat(report.productionBefore === APP, 'production_source_changed')
  report.stage = 'read_exact_task_once'
  const task = projectTask(await once('task', '/api/factory/tasks/' + TARGET.taskId))
  await save()
  if (report.questionLookup.decision === 'new_question_id') {
    report.stage = 'read_exact_new_question_once'
    report.observations.question = projectQuestion(
      await once('question', '/api/factory/questions/' + report.questionLookup.newQuestionId), task)
    await save()
  }
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
  report.businessReadsAttempted = report.counts.task + report.counts.question
  report.businessReadsProjected = Number(Boolean(report.observations.task)) + Number(Boolean(report.observations.question))
  const requiresQuestion = report.questionLookup.decision === 'new_question_id'
  const expectedReads = requiresQuestion ? 2 : 1
  report.status = report.failures.length === 0 && report.counts.task === 1
    && report.counts.question === Number(requiresQuestion) && report.businessReadsProjected === expectedReads
    && report.counts.version_before === 1 && report.counts.version_after === 1 ? 'completed' : 'failed'
  report.stage = 'finished'; report.completedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ phase: report.phase, status: report.status, counts: report.counts,
    businessReadsProjected: report.businessReadsProjected, failureCount: report.failures.length }))
  if (report.status !== 'completed') process.exitCode = 1
}
