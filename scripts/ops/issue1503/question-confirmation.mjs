import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (value, code) => { if (!value) throw new Error(`issue1503_${code}`) }
const taskBinding = task => ({ taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, candidateId: task.candidateId, revision: task.revision })

/** Keep one bounded diagnostic observation; never retain question text or native IDs. */
export function confirmationPendingObservation(pending, taskRevision, observedAt = new Date().toISOString()) {
  const questions = Array.isArray(pending?.questions) ? pending.questions : null
  const kinds = ['context', 'decision', 'permission', 'external']
  const statuses = ['open', 'waiting_user', 'answered', 'resuming', 'resolved', 'blocked', 'cancelled', 'expired', 'superseded']
  return {
    observedAt,
    taskRevision: Number.isInteger(taskRevision) && taskRevision >= 0 ? taskRevision : null,
    totalCount: questions?.length ?? null,
    questions: (questions ?? []).slice(0, 4).map(question => ({
      questionId: uuid(question?.questionId) ? question.questionId : null,
      type: kinds.includes(question?.type) ? question.type : null,
      status: statuses.includes(question?.status) ? question.status : null,
      runId: uuid(question?.runId) ? question.runId : null,
      taskId: uuid(question?.taskId) ? question.taskId : null,
      textSha256: typeof question?.originalText === 'string' ? hash(question.originalText) : null
    })),
    truncated: (questions?.length ?? 0) > 4
  }
}

/** Classify normal pending DTOs without treating task waiting as a second question.
 * A verified answer can leave its original question pending while resuming.
 * Returning null keeps the existing live/deadline wait; it never proves delivery.
 */
export function confirmationPendingQuestion(pending, progress, expected, confirmation) {
  const questions = pending?.questions
  check(Array.isArray(questions) && typeof progress?.answerAttempted === 'boolean', 'confirmation_unknown_question')
  const matches = question => uuid(question?.questionId) && question.type === 'permission'
    && question.originalText === confirmation.question && question.taskId === expected.taskId
    && question.runId === expected.originRunId
  if (!progress.answerAttempted) {
    check(questions.length === 1 && matches(questions[0]), 'confirmation_unknown_question')
    return questions[0]
  }
  const receipt = progress.receipt
  check(receipt?.source === 'normal_factory_question_api' && uuid(receipt.questionId)
    && receipt.questionId === progress.questionId && receipt.kind === 'permission'
    && uuid(receipt.answerId) && receipt.answerId === progress.answerId && receipt.answerSource === 'human'
    && receipt.originRunId === expected.originRunId && receipt.sourceEventId === expected.sourceEventId
    && receipt.questionSha256 === hash(confirmation.question) && receipt.replayed === false,
  'confirmation_answer_receipt_mismatch')
  if (questions.length === 0) return null
  check(questions.length === 1 && questions[0]?.questionId === receipt.questionId, 'confirmation_repeated_question')
  check(matches(questions[0]) && ['open', 'waiting_user', 'resuming', 'blocked'].includes(questions[0].status),
    'confirmation_unknown_question')
  return null
}

/** An actual, narrowly scoped owner gate before this fresh task may edit files.
 * request_help produces context questions, which the Orchestrator may answer;
 * permission uses the existing ask_human handoff and requires a human session. */
export function codexQuestionConfirmation(marker, specification) {
  const question = `Factory #1503 confirmation ${marker}: May I create only ${specification.path} with the task's exact initial contents, then verify and deliver its PR without merging?`
  const answer = `Confirmed for Factory #1503 ${marker}: you may now create only ${specification.path} with the exact initial contents already specified in this task. Preserve every other file. Continue this same task, original native session, selected Profile and official Codex subscription. Follow the injected Mikka agent delivery instructions: verify, commit, keep the current local worktree branch and push HEAD to the assigned remote task branch (the branch names need not match), open or update the owner's PR, wait for its checks, then submit. Leave the PR open; do not merge. This permission confirmation is complete and must not be asked again during continuation, review or a later requested revision.`
  const instructions = `Initial execution workflow gate, separate from artifact acceptance criteria: before changing any repository file, the implementation worker must call mikka.ask_human exactly once with kind:"permission", question:${JSON.stringify(question)}, and a truthful summary that no repository file has been changed and this explicit owner confirmation is pending. Stop through that tool and wait for the normal human answer. The current task deliberately withholds permission to edit until that answer. Do not use request_help for this permission, do not have the Coordinator answer it, and do not create another task. After the answer, continue the original native session and complete the task. Review and later repair must not repeat this already answered gate.`
  return { marker, filePath: specification.path, question, answer, instructions }
}

/** Public evidence binds the real run to the pinned shared subscription Profile.
 * The binding ID and payer come from frozen executionIdentity, never the prompt. */
export function confirmationRunEvidence(evidence, expected, runId) {
  const run = evidence?.run, identity = run?.executionIdentity, profile = run?.agentProfile
  const subscriptions = identity?.resourceBindings?.filter(item => item.kind === 'subscription') ?? []
  const subscription = subscriptions[0]
  check(run?.id === runId && run.issueId === expected.issueId && run.harness === 'codex' && run.model === 'gpt-6-luna'
    && run.credentialType === 'subscription' && run.subscriptionRoute === 'codex_cli'
    && profile?.profileId === expected.profile.id && profile.version === expected.profile.version
    && profile.digest === expected.profile.digest && profile.source === 'explicit'
    && identity?.requester === expected.ownerId && identity.executionPrincipal === expected.ownerId
    && identity.outputOwner === expected.ownerId && identity.workspaceId === expected.workspaceId
    && identity.botId === run.botId && identity.botOwner === expected.ownerId
    && identity.billingAccount?.runtime?.kind === 'e2b' && identity.billingAccount.runtime.ownerId === expected.ownerId
    && subscriptions.length === 1 && uuid(subscription.id) && subscription.ownerId === expected.credentialOwnerId
    && subscription.ownerId !== expected.ownerId && subscription.access === 'workspace_share'
    && identity.billingAccount?.model?.kind === 'subscription'
    && identity.billingAccount.model.ownerId === subscription.ownerId && identity.billingAccount.model.resourceId === subscription.id,
  'confirmation_run_provenance_mismatch')
  return { runId, status: run.status, harness: run.harness, model: run.model, subscriptionRoute: run.subscriptionRoute,
    profileId: profile.profileId, profileVersion: profile.version, profileDigest: profile.digest, profileSource: profile.source,
    runtimeBotId: run.botId, bindingId: subscription.id, credentialOwnerId: subscription.ownerId,
    executionIdentitySha256: hash(JSON.stringify(identity)) }
}

/** Return the server's reference verbatim. An unknown question is never answered. */
export function confirmationQuestionReference(state, question, evidence, expected, confirmation) {
  const task = state?.task, reference = question?.reference
  const attempts = state?.attempts?.filter(item => item.id === task?.attemptId) ?? []
  check(state?.liveWorkspaceId === expected.workspaceId && task?.id === expected.taskId && task.userId === expected.ownerId
    && task.issueId === expected.issueId && task.botId === expected.botId && task.stage === 'execute' && task.status === 'waiting'
    && task.candidateId === null && attempts.length === 1 && attempts[0].taskId === task.id
    && attempts[0].runId === expected.originRunId && attempts[0].stage === 'execute'
    && attempts[0].status === 'waiting' && attempts[0].candidateId === null,
  'confirmation_task_mismatch')
  check(uuid(question?.id) && question.userId === expected.ownerId && question.taskId === task.id && question.issueId === task.issueId
    && question.attemptId === task.attemptId && question.originRunId === expected.originRunId && question.stage === 'execute'
    && question.kind === 'permission' && ['open', 'waiting_user'].includes(question.status)
    && question.question === confirmation.question && question.candidateId === null
    && question.answerId === null && question.continuationRunId === null
    && reference?.questionId === question.id && reference.questionRevision === question.revision
    && reference.originRunId === expected.originRunId && typeof reference.originSessionId === 'string' && reference.originSessionId.length > 0
    && reference.originSessionId === question.originSessionId && isDeepStrictEqual(reference.binding, taskBinding(task))
    && isDeepStrictEqual(question.waitingBinding, reference.binding), 'confirmation_question_mismatch')
  const run = confirmationRunEvidence(evidence, expected, expected.originRunId)
  check(run.status === 'stopped', 'confirmation_origin_not_stopped')
  return reference
}

export function confirmationAnswerReceipt(result, answered, reference, answerId, expected, confirmation) {
  const task = result?.task
  check(result?.questionId === reference.questionId && uuid(result.continuationRunId) && result.continuationRunId !== reference.originRunId
    && result.replayed === false && task?.id === expected.taskId && task.userId === expected.ownerId
    && task.issueId === expected.issueId && task.botId === expected.botId && task.sourceEventId === expected.sourceEventId
    && task.stage === 'execute' && task.status === 'running' && task.candidateId === null
    && uuid(task.attemptId) && task.attemptId !== reference.binding.attemptId && task.revision > reference.binding.revision
    && answered?.id === reference.questionId && answered.userId === expected.ownerId && answered.taskId === expected.taskId
    && answered.issueId === expected.issueId && answered.originRunId === reference.originRunId
    && answered.originSessionId === reference.originSessionId && answered.kind === 'permission' && answered.question === confirmation.question
    && ['resuming', 'resolved'].includes(answered.status) && answered.answerId === answerId && answered.answerSource === 'human'
    && answered.answer?.source === 'human' && answered.answer.userId === expected.ownerId
    && answered.answer.input?.answerId === answerId && answered.answer.input.text === confirmation.answer
    && isDeepStrictEqual(answered.answer.input.reference, reference) && answered.continuationRunId === result.continuationRunId,
  'confirmation_answer_receipt_mismatch')
  return { source: 'normal_factory_question_api', questionId: reference.questionId, kind: 'permission', answerId,
    answerSource: answered.answerSource, questionSha256: hash(confirmation.question), answerSha256: hash(confirmation.answer),
    referenceSha256: hash(JSON.stringify(reference)), originRunId: reference.originRunId,
    originAttemptId: reference.binding.attemptId, originSessionSha256: hash(reference.originSessionId),
    continuationRunId: result.continuationRunId, continuationAttemptId: task.attemptId,
    taskRevision: task.revision, sourceEventId: task.sourceEventId, replayed: result.replayed }
}
