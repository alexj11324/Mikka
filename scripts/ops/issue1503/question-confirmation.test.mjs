import assert from 'node:assert/strict'
import test from 'node:test'
import { codexQuestionConfirmation, confirmationQuestionReference, confirmationRunEvidence, confirmationAnswerReceipt } from './question-confirmation.mjs'

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function fixture() {
  const expected = { ownerId: 'smoke-owner', credentialOwnerId: 'subscription-owner', workspaceId: id(1), taskId: id(2), issueId: id(3), botId: id(4), originRunId: id(5), sourceEventId: id(6), profile: { id: id(7), version: 1, digest: 'a'.repeat(64) } }
  const confirmation = codexQuestionConfirmation('offline-confirmation', { path: 'docs/issue-1503/offline-confirmation-codex.txt' })
  const task = { id: expected.taskId, userId: expected.ownerId, issueId: expected.issueId, botId: expected.botId,
    sourceEventId: expected.sourceEventId, stage: 'execute', status: 'waiting', candidateId: null, attemptId: id(8), revision: 3 }
  const binding = { taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, candidateId: null, revision: task.revision }
  const reference = { questionId: id(9), questionRevision: 2, binding, originRunId: expected.originRunId, originSessionId: 'native-session-fixture' }
  const question = { id: reference.questionId, userId: expected.ownerId, taskId: task.id, issueId: task.issueId,
    attemptId: task.attemptId, originRunId: expected.originRunId, originSessionId: reference.originSessionId, stage: 'execute',
    kind: 'permission', status: 'waiting_user', question: confirmation.question, candidateId: null, answerId: null,
    continuationRunId: null, revision: 2, waitingBinding: { ...binding }, reference }
  const state = { liveWorkspaceId: expected.workspaceId, task, attempts: [{ id: task.attemptId, taskId: task.id, runId: expected.originRunId,
    stage: 'execute', status: 'waiting', candidateId: null }] }
  const evidence = { run: { id: expected.originRunId, status: 'stopped', issueId: expected.issueId, botId: id(10),
    harness: 'codex', model: 'gpt-6-luna', credentialType: 'subscription', subscriptionRoute: 'codex_cli',
    agentProfile: { profileId: expected.profile.id, version: 1, digest: expected.profile.digest, source: 'explicit' },
    executionIdentity: { requester: expected.ownerId, executionPrincipal: expected.ownerId, outputOwner: expected.ownerId,
      botId: id(10), botOwner: expected.ownerId, workspaceId: expected.workspaceId,
      resourceBindings: [{ kind: 'subscription', id: id(11), ownerId: expected.credentialOwnerId, access: 'workspace_share', revision: '2' }],
      billingAccount: { runtime: { kind: 'e2b', ownerId: expected.ownerId }, model: { kind: 'subscription', ownerId: expected.credentialOwnerId, resourceId: id(11) } } } } }
  const answerId = id(12), continuationRunId = id(13)
  const result = { questionId: question.id, continuationRunId, replayed: false,
    task: { ...task, status: 'running', attemptId: id(14), revision: 5 } }
  const answered = { ...question, status: 'resuming', answerId, answerSource: 'human', continuationRunId,
    answer: { source: 'human', userId: expected.ownerId, input: { reference: structuredClone(reference), answerId, text: confirmation.answer } } }
  return { expected, confirmation, state, question, reference, evidence, answerId, result, answered }
}

test('permission instruction has the exact unique file scope and cannot use auto-answered context', () => {
  const { confirmation } = fixture()
  assert.ok(confirmation.question.includes(confirmation.marker) && confirmation.question.includes(confirmation.filePath))
  assert.match(confirmation.instructions, /before changing any repository file/)
  assert.match(confirmation.instructions, /mikka\.ask_human exactly once with kind:"permission"/)
  assert.match(confirmation.instructions, /separate from artifact acceptance criteria/)
  assert.match(confirmation.instructions, /Review and later repair must not repeat/)
  assert.ok(confirmation.question.length < 4000 && confirmation.answer.length < 4000)
})

test('public permission DTO retains the server reference verbatim and frozen shared lender', () => {
  const f = fixture()
  for (const status of ['open', 'waiting_user']) {
    f.question.status = status
    assert.equal(confirmationQuestionReference(f.state, f.question, f.evidence, f.expected, f.confirmation), f.reference)
  }
  const provenance = confirmationRunEvidence(f.evidence, f.expected, f.expected.originRunId)
  assert.equal(provenance.status, 'stopped')
  assert.equal(provenance.credentialOwnerId, f.expected.credentialOwnerId)
  assert.equal(provenance.bindingId, id(11))
})

test('unknown questions, changed targets and fabricated references cannot receive this fixed answer', () => {
  const mutations = [
    f => { f.question.question = 'May I edit another file?' },
    f => { f.question.kind = 'context' },
    f => { f.question.kind = 'decision' },
    f => { f.question.status = 'resolved' },
    f => { f.question.userId = 'other' },
    f => { f.question.originRunId = id(99) },
    f => { f.question.answerId = id(98) },
    f => { f.reference.binding.revision++ },
    f => { f.reference.originSessionId = 'other-native-session' },
    f => { f.state.liveWorkspaceId = id(97) },
    f => { f.state.task.botId = id(96) },
    f => { f.state.task.id = id(95) },
    f => { f.state.attempts[0].runId = id(94) },
    f => { f.state.task.candidateId = id(93) },
    f => { f.evidence.run.agentProfile.version++ },
    f => { f.evidence.run.model = 'other-model' },
    f => { f.evidence.run.executionIdentity.requester = 'other' },
    f => { f.evidence.run.executionIdentity.resourceBindings[0].access = 'owner' },
    f => { f.evidence.run.executionIdentity.resourceBindings[0].ownerId = 'unrelated-lender' },
  ]
  for (const mutate of mutations) {
    const f = fixture(); mutate(f)
    assert.throws(() => confirmationQuestionReference(f.state, f.question, f.evidence, f.expected, f.confirmation), /^Error: issue1503_confirmation_/)
  }
})

test('normal human answer receipt binds one new attempt and records only a hash of the native SID', () => {
  const f = fixture()
  const receipt = confirmationAnswerReceipt(f.result, f.answered, f.reference, f.answerId, f.expected, f.confirmation)
  assert.equal(receipt.continuationRunId, f.result.continuationRunId)
  assert.equal(receipt.originRunId, f.expected.originRunId)
  assert.equal(receipt.answerSource, 'human')
  assert.match(receipt.originSessionSha256, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(receipt).includes(f.reference.originSessionId))
  for (const mutate of [
    f => { f.result.continuationRunId = f.expected.originRunId },
    f => { f.result.replayed = true },
    f => { f.result.task.sourceEventId = id(99) },
    f => { f.result.task.attemptId = f.reference.binding.attemptId },
    f => { f.answered.answerSource = 'orchestrator' },
    f => { f.answered.answer.userId = 'other' },
    f => { f.answered.answer.input.text = 'Broaden the scope' },
    f => { f.answered.answer.input.reference.binding.revision++ },
  ]) {
    const bad = fixture(); mutate(bad)
    assert.throws(() => confirmationAnswerReceipt(bad.result, bad.answered, bad.reference, bad.answerId, bad.expected, bad.confirmation), /^Error: issue1503_confirmation_answer_receipt_mismatch$/)
  }
})
