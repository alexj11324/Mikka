#!/usr/bin/env node
/** One owner-authorized answer through the ordinary Factory question API. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { smokeSession, SMOKE_ID, fail } from './http.ts'
import { factoryEventId } from '../../../lib/factory/event-id.ts'

const EXPECTED_SHA = 'c0c98baa3020a085652ee5f773310b6dfa412c5d'
const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const ISSUE_ID = 'e0582e5d-17cd-44e1-b0af-28fc0aace596'
const TASK_ID = '5138410f-0b33-42fb-a55f-60017242a8e2'
const BOT_ID = '388d4bb4-8e1c-4ad0-a1ec-82e387140bd5'
const RUN_ID = 'd1f7e459-4576-4994-846f-8afb1ca6492f'
const ATTEMPT_ID = '5a8078f4-33a8-460a-bd54-acf6c4a4e3ab'
const QUESTION_ID = '74deb881-055d-43af-b89b-786554456e3c'
const QUESTION_CREATED_AT = '2026-11-06T20:36:51.885Z'
const FILE_PATH = 'docs/issue-1503/42289122096-1-codex.txt'
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const check = (value, code) => { if (!value) fail(code) }

// This corrects the earlier operator task text. The product's actual contract
// is agent-owned GitHub delivery; agentPublishedReceipt reads the result back.
const answer = `Owner clarification for F1503-3: the assigned repository is alexj11324/Mikka-handoff, canonical HTTPS URL https://github.com/alexj11324/Mikka-handoff.git. The supplied checkout at original HEAD 0fe3c5d4cd281435b535b81000bc92664500851a is the correct task checkout. Its local origin is a runtime mirror; it does not change the assigned GitHub repository. Keep the current local mikka/run-${RUN_ID} branch.

I explicitly withdraw the earlier task wording that said the host would push/open the PR after submit. Follow the product-injected delivery instructions: you own publication using the person's already supplied GitHub credential. Create only ${FILE_PATH} with the exact original task contents (State: initial), perform the required verification, and commit the tested change. Push HEAD to mikka/f1503-3 using the explicit canonical HTTPS repository URL; never force-push. Open or update that branch's PR with gh for alexj11324/Mikka-handoff. The PR body must end with <!-- mikka-issue:${ISSUE_ID} -->.

Run gh pr checks <PR URL> --watch, address any failing CI within the original file scope, and submit through the normal mikka MCP submit tool only when every required check has finished successfully for the final pushed commit and the worktree is clean. Mikka will read back that publication and continue Factory review. Do not merge the PR, edit any other file, or start another task. No new permission or repository selection is needed.`

const output = resolve(process.env.MIKKA_1503_RESUME_REPORT ?? 'issue1503-report/resume-codex.json')
const report = { version: 1, issue: 1503, phase: 'codex_question_resume', status: 'running',
  startedAt: new Date().toISOString(), expectedProductionSha: EXPECTED_SHA,
  workspaceId: WORKSPACE_ID, smokeUserId: SMOKE_ID, identifier: 'F1503-3',
  issueId: ISSUE_ID, taskId: TASK_ID, botId: BOT_ID, originRunId: RUN_ID, questionId: QUESTION_ID,
  answerId: randomUUID(), answerSha256: digest(answer), answerAttempted: false, queued: false }
const save = async () => {
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
let session
let stage = 'configuration'
try {
  check(process.env.MIKKA_EXPECTED_DEPLOYMENT_SHA === EXPECTED_SHA, 'resume_deployment_pin_required')
  check(answer.length <= 4000, 'resume_answer_too_long')
  stage = 'login'
  session = await smokeSession()
  const json = async (path, init = {}) => {
    const response = await session.request(path, { ...init, headers: { ...init.headers,
      cookie: `mikka-workspace=${WORKSPACE_ID}`, 'x-mikka-locale': 'en' } })
    const value = await response.json().catch(() => null)
    if (!response.ok) {
      report.lastHttpFailure = { status: response.status,
        ...(typeof value?.error === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{1,100}$/.test(value.error) ? { code: value.error } : {}) }
      fail(`resume_http_${response.status}`)
    }
    check(value !== null, 'resume_http_json_invalid')
    return value
  }
  const pin = async () => {
    const version = await json('/api/version')
    check(version.build === EXPECTED_SHA, 'resume_production_changed')
    report.productionBuild = version.build
  }
  await pin()
  stage = 'read_exact_waiting_question'
  const state = await json(`/api/factory/tasks/${TASK_ID}`)
  const task = state.task
  check(state.liveWorkspaceId === WORKSPACE_ID && task?.id === TASK_ID && task.userId === SMOKE_ID
    && task.issueId === ISSUE_ID && task.botId === BOT_ID && task.stage === 'execute' && task.status === 'waiting'
    && task.attemptId === ATTEMPT_ID && task.candidateId === null && task.route?.flowVersion === 2,
  'resume_task_scope_or_state_changed')
  const attempt = state.attempts?.find(item => item.id === ATTEMPT_ID)
  check(attempt?.taskId === TASK_ID && attempt.runId === RUN_ID && attempt.stage === 'execute'
    && attempt.status === 'waiting' && attempt.candidateId === null, 'resume_origin_run_changed')
  const question = await json(`/api/factory/questions/${QUESTION_ID}`)
  const reference = question.reference
  const binding = reference?.binding
  check(question.id === QUESTION_ID && question.userId === SMOKE_ID && question.taskId === TASK_ID
    && question.issueId === ISSUE_ID && question.attemptId === ATTEMPT_ID && question.originRunId === RUN_ID
    && question.stage === 'execute' && question.kind === 'context' && question.status === 'waiting_user'
    && question.answerId === null && question.continuationRunId === null && question.candidateId === null
    && new Date(question.createdAt).toISOString() === QUESTION_CREATED_AT
    && question.sourceEventId === factoryEventId('execution-question', QUESTION_ID)
    && reference?.questionId === QUESTION_ID && reference.questionRevision === question.revision
    && reference.originRunId === RUN_ID && typeof reference.originSessionId === 'string' && reference.originSessionId.length > 0
    && reference.originSessionId === question.originSessionId && binding.taskId === TASK_ID && binding.issueId === ISSUE_ID
    && binding.attemptId === ATTEMPT_ID && binding.candidateId === null && binding.revision === task.revision,
  'resume_question_scope_or_state_changed')
  report.before = { taskStage: task.stage, taskStatus: task.status, taskRevision: task.revision,
    questionKind: question.kind, questionStatus: question.status, questionRevision: question.revision,
    originSessionSha256: digest(reference.originSessionId), questionSha256: digest(question.question) }
  stage = 'answer_exact_question'
  await pin()
  report.answerAttempted = true
  await save()
  // Exactly one POST. The service owns authorization, CAS, queue admission,
  // original-session continuation and wake. No manual state or report writes.
  const result = await json(`/api/factory/questions/${QUESTION_ID}`,
    session.post({ reference, answerId: report.answerId, text: answer }))
  check(result.questionId === QUESTION_ID && uuid(result.continuationRunId) && result.continuationRunId !== RUN_ID
    && result.replayed === false && result.task?.id === TASK_ID && result.task.userId === SMOKE_ID
    && result.task.botId === BOT_ID && result.task.issueId === ISSUE_ID && result.task.stage === 'execute'
    && result.task.status === 'running' && result.task.revision > task.revision
    && uuid(result.task.attemptId) && result.task.attemptId !== ATTEMPT_ID && result.task.candidateId === null,
  'resume_continuation_receipt_mismatch')
  report.queued = true
  report.continuation = { runId: result.continuationRunId, attemptId: result.task.attemptId,
    taskRevision: result.task.revision, taskStage: result.task.stage, taskStatus: result.task.status,
    source: 'normal_factory_question_continuation_receipt', replayed: result.replayed }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.code = /^issue1503_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'issue1503_codex_resume_failed'
  process.exitCode = 1
} finally {
  await session?.close().catch(() => undefined)
  report.stage = stage
  report.completedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify(report))
}
