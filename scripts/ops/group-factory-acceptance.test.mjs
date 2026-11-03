import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { runGroupFactoryScenario } from './group-factory-acceptance.mjs'

// Contract fixtures test the acceptance driver's failure boundaries. These do
// not execute a model, create a real Task or count as production acceptance.
function fixture(options = {}) {
  const id = Object.fromEntries(['owner', 'modelKey', 'fixture', 'bot', 'group', 'workspace', 'task', 'issue', 'epoch', 'nextEpoch', 'stopEpoch', 'candidate', 'nextCandidate',
    'artifact', 'producer', 'review', 'verify', 'continuation', 'nextReview', 'nextVerify', 'stopRun', 'approval', 'nextApproval', 'acceptance', 'nextAcceptance'].map(key => [key, randomUUID()]))
  const report = { requesterId: id.owner, fixtureId: id.fixture, conversationId: id.group, workspaceId: id.workspace, bots: [{ id: id.bot, role: 'Coding', modelId: 'deepseek-flash' }], cases: [] }
  const expected = Buffer.from(`mikka-group-factory:${id.fixture}\nstatus=ready\n`)
  const continuedExpected = Buffer.from(`mikka-group-factory:${id.fixture}\nstatus=continued\n`)
  const title = `group-factory-${id.fixture.slice(0, 8)}.txt`
  const checkedAttempts = (epoch, candidateId, runIds, approvalId) => [
    ...['execute', 'review', 'verify'].map((stage, i) => ({ id: randomUUID(), stage, status: 'passed',
      runId: runIds[i], candidateId, output: { requestEpoch: epoch, ...(i ? { check: { requestEpoch: epoch } } : {}) } })),
    { id: approvalId, stage: 'approval', status: 'pending', runId: null, candidateId, output: { requestEpoch: epoch } },
  ]
  const attempts = checkedAttempts(id.epoch, id.candidate, [id.producer, id.review, id.verify], id.approval)
  const state = { task: { id: id.task, issueId: id.issue, sourceEventId: id.epoch, stage: 'approval', status: 'pending',
    attemptId: id.approval, candidateId: id.candidate, revision: 7 }, attempts,
    candidates: [{ id: id.candidate, runId: id.producer, kind: 'deliverable', sha: null }] }
  const calls = [], messages = [], downloads = [], accepted = new Map()
  const statuses = new Map([[id.producer, 'succeeded'], [id.review, 'succeeded'], [id.verify, 'succeeded']])
  const artifactUrl = version => `/mikka/api/artifacts/${id.artifact}/versions/${version}/download`
  let time = 0
  const copy = value => structuredClone(value)
  const api = {
    report, timeoutMs: 1000, stopTimeoutMs: 1000,
    now: () => time, wait: async milliseconds => { time += milliseconds }, guard: async () => {},
    async download(url) {
      downloads.push(url)
      assert.ok([artifactUrl(1), artifactUrl(2)].includes(url), 'downloads retain the exact accepted version URL')
      if (options.wrongBytes) return Buffer.from('wrong artifact')
      return url === artifactUrl(2) && !options.oldContinuationBytes ? continuedExpected : expected
    },
    async json(path, body) {
      calls.push({ path, body: copy(body) })
      if (path.startsWith('/api/settings/model-order?')) return { location: 'cloud', cloudReady: true,
        entries: [{ harness: 'codex', model: 'deepseek-flash', provider: 'deepseek', source: { kind: 'api_key' } },
          ...(options.mixedModels ? [{ harness: 'codex', model: 'deepseek-pro', provider: 'deepseek', source: { kind: 'api_key' } }] : [])] }
      if (path === `/api/conversations/${id.group}/messages` && body) {
        const index = messages.length
        const operation = ['create', 'status', 'continue', 'continue', 'stop'][index]
        assert.ok(operation, 'driver must not create additional requests as retries')
        assert.deepEqual(body.mentions, [])
        const message = { id: randomUUID(), replyId: randomUUID(), finalReplyId: randomUUID(), operation,
          epoch: index === 0 ? id.epoch : index === 2 ? id.nextEpoch : index === 3 ? id.stopEpoch : null,
          runId: index === 0 ? id.producer : index === 2 ? id.continuation : index === 3 ? id.stopRun : null }
        messages.push(message)
        if (operation === 'status' && options.statusDispatches) state.task.revision++
        if (index === 2) {
          const next = checkedAttempts(id.nextEpoch, id.nextCandidate, [id.continuation, id.nextReview, id.nextVerify], id.nextApproval)
          for (const attempt of next.filter(item => ['review', 'verify'].includes(item.stage))) {
            if (options.oldContinuationAttemptEpoch) attempt.output.requestEpoch = id.epoch
            if (options.oldContinuationCheckEpoch) attempt.output.check.requestEpoch = id.epoch
          }
          if (options.sharedContinuationCheckRun) next[1].runId = id.continuation
          state.attempts.push(...next)
          state.candidates.push({ id: id.nextCandidate, runId: id.continuation, kind: 'deliverable', sha: null })
          Object.assign(state.task, { sourceEventId: id.nextEpoch, attemptId: id.nextApproval, candidateId: id.nextCandidate, stage: 'approval', status: 'pending', revision: 13 })
          for (const run of [id.continuation, id.nextReview, id.nextVerify]) statuses.set(run, 'succeeded')
        }
        if (index === 3) {
          assert.equal(accepted.size, 2, 'the stop scenario starts only after both versions have been accepted')
          const attempt = { id: randomUUID(), stage: 'execute', status: 'running', runId: id.stopRun,
            candidateId: null, output: { requestEpoch: id.stopEpoch } }
          state.attempts.push(attempt)
          Object.assign(state.task, { sourceEventId: id.stopEpoch, attemptId: attempt.id, candidateId: null, stage: 'execute', status: 'running', revision: 15 })
          statuses.set(id.stopRun, 'running')
        }
        if (operation === 'stop') {
          state.task.status = 'cancelled'; state.task.revision++
          state.attempts.at(-1).status = 'cancelled'
          statuses.set(id.stopRun, options.noStopAck ? 'running' : 'stopped')
        }
        return { id: message.id }
      }
      if (path === `/api/factory/tasks/${id.task}/approval` && body) {
        assert.equal(body.operation, 'accept')
        assert.deepEqual(Object.keys(body.input).sort(), ['binding', 'eventId'])
        const first = body.input.binding.candidateId === id.candidate
        const epoch = first ? id.epoch : id.nextEpoch, approvalId = first ? id.approval : id.nextApproval
        const acceptanceId = first ? id.acceptance : id.nextAcceptance, revision = first ? 7 : 13
        assert.deepEqual(body.input.binding, { taskId: id.task, issueId: id.issue, attemptId: approvalId, candidateId: first ? id.candidate : id.nextCandidate, revision })
        if (accepted.has(epoch)) assert.equal(body.input.eventId, accepted.get(epoch).eventId, 'each acceptance replay uses its own original receipt key')
        else {
          assert.equal(state.task.sourceEventId, epoch)
          assert.equal(state.task.status, 'pending')
          assert.ok([...accepted.values()].every(receipt => receipt.eventId !== body.input.eventId), 'the next epoch has a new acceptance key')
          accepted.set(epoch, { eventId: body.input.eventId, acceptanceId })
          state.task.status = 'passed'; state.task.revision = revision + 1
          const approval = state.attempts.find(attempt => attempt.id === approvalId)
          approval.status = 'passed'; approval.output.deliverableAcceptanceId = acceptanceId
        }
        return { status: 'accepted', acceptanceId }
      }
      if (path === `/api/factory/tasks/${id.task}` && !body) return copy(state)
      if (path === `/api/factory/tasks?issueId=${id.issue}` && !body) return [copy(state.task)]
      const run = path.match(/^\/api\/runs\/([^/]+)\/evidence$/)?.[1]
      if (run) {
        assert.ok(statuses.has(run))
        return { run: { id: run, issueId: id.issue, botId: id.bot, status: statuses.get(run), harness: 'codex',
          model: 'deepseek-flash', credentialType: options.subscriptionRun ? 'subscription' : 'api_key', subscriptionRoute: null,
          executionIdentity: { version: 1, requester: id.owner, executionPrincipal: options.wrongPrincipal ? randomUUID() : id.owner,
            outputOwner: id.owner, botId: id.bot, botOwner: id.owner, workspaceId: id.workspace, personalResourcePolicy: 'requester_only',
            resourceBindings: [{ kind: 'api_key', id: id.modelKey, ownerId: id.owner, access: 'owner' }],
            billingAccount: { model: { kind: 'api_key', resourceId: id.modelKey, ownerId: id.owner, amount: 'provider_unknown' },
              runtime: { kind: 'e2b', ownerId: options.wrongRuntimePayer ? randomUUID() : id.owner, amount: 'provider_unknown' } } } },
        artifacts: [id.producer, id.continuation].includes(run) ? [{ id: id.artifact, title, latestVersion: run === id.producer ? 1 : 2, url: artifactUrl(run === id.producer ? 1 : 2) }] : [] }
      }
      assert.fail(`unexpected endpoint/mutation ${path}`)
    },
    async readTurn(groupId, messageId) {
      assert.equal(groupId, id.group)
      const message = messages.find(item => item.id === messageId)
      assert.ok(message)
      const events = []
      if (['create', 'continue'].includes(message.operation)) events.push({ id: `delegate:${messageId}`, type: 'delegate', memberId: id.bot,
        taskId: id.task, runId: message.runId, outcome: 'succeeded' })
      events.push({ id: `publish:${messageId}`, type: 'publish', memberId: id.bot })
      if (accepted.has(message.epoch)) {
        events.push({ id: `result:${messageId}`, type: 'task_result', memberId: id.bot, taskId: id.task, outcome: 'succeeded' })
        events.push({ id: `final:${messageId}`, type: 'publish', memberId: id.bot })
      }
      const page = { messages: messages.map(item => ({ id: item.replyId, replyToId: item.id, authorType: 'bot', authorId: id.bot, body: `Task /?issue=${id.issue}` })) }
      for (const item of messages.filter(item => accepted.has(item.epoch))) page.messages.push({ id: item.finalReplyId, replyToId: item.id, authorType: 'bot',
        authorId: options.wrongFinalReporter ? id.fixture : id.bot, body: `Task /?issue=${id.issue}&artifact=${id.artifact}` })
      return { page, turn: { trace: { action: 'delegate', responders: [id.bot], taskFinishedAt: accepted.has(message.epoch) ? '2026-11-03T00:00:00.000Z' : null,
        execution: { executionId: `execution:${messageId}`, providerGenerationId: 'provider-generation', requestDigest: 'a'.repeat(64) }, events } } }
    },
  }
  return { api, id, calls, report, messages, downloads, accepted, artifactUrl }
}

test('real-API driver contract accepts two exact artifact versions and stops a third epoch on the same Task', async () => {
  const f = fixture()
  const result = await runGroupFactoryScenario(f.api)
  assert.equal(result.status, 'pass')
  assert.equal(result.artifact.retainedAfterStop, true)
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.continuation.taskId, f.id.task)
  assert.equal(result.continuation.previousEpoch, f.id.epoch)
  assert.equal(result.continuation.requestEpoch, f.id.nextEpoch)
  assert.equal(result.continuation.updatedArtifactVerified, true)
  assert.equal(result.continuation.outcome, 'completed_and_accepted')
  assert.deepEqual(result.continuation.checks.map(check => [check.stage, check.runId, check.candidateId, check.requestEpoch]),
    [['review', f.id.nextReview, f.id.nextCandidate, f.id.nextEpoch], ['verify', f.id.nextVerify, f.id.nextCandidate, f.id.nextEpoch]])
  assert.equal(result.artifact.version, 1)
  assert.equal(result.continuation.artifact.version, 2)
  assert.equal(result.continuation.artifact.retainedAfterStop, true)
  assert.notEqual(result.continuation.artifact.sha256, result.artifact.sha256)
  assert.equal(result.continuation.acceptance.acceptanceId, f.id.nextAcceptance)
  assert.equal(result.continuation.acceptance.replayConfirmed, true)
  assert.equal(result.acceptance.acceptanceId, f.id.acceptance)
  assert.notEqual(result.continuation.acceptance.eventId, result.acceptance.eventId)
  assert.equal(result.continuation.finalReport.reporterId, f.id.bot)
  assert.deepEqual(result.continuation.finalReport.messageIds, [f.messages[2].finalReplyId])
  assert.equal(result.continuation.replay.repeatReads, 2)
  assert.deepEqual(result.stopContinuation, { taskId: f.id.task, runId: f.id.stopRun, previousEpoch: f.id.nextEpoch,
    requestEpoch: f.id.stopEpoch, outcome: 'admitted_then_cancelled', updatedArtifactVerified: false })
  assert.equal(result.stopReplay.repeatReads, 2)
  assert.deepEqual(f.messages.map(item => item.operation), ['create', 'status', 'continue', 'continue', 'stop'])
  assert.equal(f.accepted.size, 2)
  assert.equal(f.calls.filter(call => call.body).length, 9, 'five owner messages and two independently keyed acceptance/replay pairs only')
  assert.deepEqual(f.downloads, [f.artifactUrl(1), f.artifactUrl(2), f.artifactUrl(1), f.artifactUrl(2)], 'both exact versions remain downloadable after stopping')
  assert.equal(f.calls.filter(call => call.path === `/api/factory/tasks/${f.id.task}` && call.body).length, 0, 'never fabricates stage transitions')
})

test('a non-Flash fallback fails before any paid group task prompt', async () => {
  const f = fixture({ mixedModels: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_execution_model_forbidden/)
  assert.equal(f.calls.filter(call => call.body).length, 0)
})

test('actual frozen subscription execution cannot masquerade as Flash API-key acceptance', async () => {
  const f = fixture({ subscriptionRun: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_run_credential_forbidden/)
  assert.equal(f.calls.filter(call => call.path.endsWith('/approval')).length, 0)
})

test('wrong downloaded bytes cannot be human-accepted, and fixture IDs survive failure', async () => {
  const f = fixture({ wrongBytes: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_artifact_content_mismatch/)
  assert.equal(f.calls.filter(call => call.path.endsWith('/approval')).length, 0)
  assert.equal(f.report.cases[0].taskId, f.id.task)
  assert.equal(f.report.cases[0].lastTask.issueId, f.id.issue)
})

for (const [option, code] of [['wrongPrincipal', 'run_identity_mismatch'], ['wrongRuntimePayer', 'run_billing_mismatch']])
  test(`actual frozen execution ownership is checked before acceptance: ${option}`, async () => {
    const f = fixture({ [option]: true })
    await assert.rejects(runGroupFactoryScenario(f.api), new RegExp(`acceptance_factory_${code}`))
    assert.equal(f.calls.filter(call => call.path.endsWith('/approval')).length, 0)
  })

test('a second Bot final report fails even if it links the correct Task and artifact', async () => {
  const f = fixture({ wrongFinalReporter: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_multiple_reporters/)
})

test('a status query that mutates the Task fails before continuation', async () => {
  const f = fixture({ statusDispatches: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_status_changed_task/)
  assert.deepEqual(f.messages.map(item => item.operation), ['create', 'status'])
})

test('the old target bytes cannot satisfy the second epoch or reach its human acceptance', async () => {
  const f = fixture({ oldContinuationBytes: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_artifact_content_mismatch/)
  assert.equal(f.calls.filter(call => call.path.endsWith('/approval')).length, 2, 'only the first acceptance and its replay occurred')
  assert.equal(f.accepted.has(f.id.nextEpoch), false)
  assert.deepEqual(f.messages.map(item => item.operation), ['create', 'status', 'continue'])
  assert.equal(f.report.cases[0].continuation.updatedArtifactVerified, false)
})

for (const field of ['oldContinuationAttemptEpoch', 'oldContinuationCheckEpoch']) test(`second-epoch checks cannot reuse old request evidence: ${field}`, async () => {
  const f = fixture({ [field]: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_continuation_checks_missing/)
  assert.equal(f.calls.filter(call => call.path.endsWith('/approval')).length, 2)
  assert.deepEqual(f.downloads, [f.artifactUrl(1)], 'invalid check epochs fail before inspecting or accepting a second artifact')
  assert.equal(f.report.cases[0].continuation.requestEpoch, f.id.nextEpoch)
})

test('the second epoch still requires three independent producer/review/verify runs', async () => {
  const f = fixture({ sharedContinuationCheckRun: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_continuation_checks_not_independent/)
  assert.equal(f.calls.filter(call => call.path.endsWith('/approval')).length, 2)
  assert.equal(f.accepted.has(f.id.nextEpoch), false)
})

test('cancelled Task without an actual run stop acknowledgement times out with resumable evidence', async () => {
  const f = fixture({ noStopAck: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_stop_ack_timeout/)
  assert.equal(f.report.cases[0].continuation.updatedArtifactVerified, true)
  assert.equal(f.report.cases[0].stopContinuation.runId, f.id.stopRun)
  assert.equal(f.report.cases[0].lastTask.status, 'cancelled')
  assert.equal(f.report.cases[0].runs.find(run => run.id === f.id.stopRun).status, 'running')
  assert.equal(f.report.cases[0].runs.find(run => run.id === f.id.continuation).status, 'succeeded')
  assert.equal(f.accepted.size, 2)
})
