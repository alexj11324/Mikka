import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { runGroupFactoryScenario } from './group-factory-acceptance.mjs'

// Contract fixtures test the acceptance driver's failure boundaries. These do
// not execute a model, create a real Task or count as production acceptance.
function fixture(options = {}) {
  const id = Object.fromEntries(['fixture', 'bot', 'group', 'workspace', 'task', 'issue', 'epoch', 'nextEpoch', 'candidate',
    'artifact', 'producer', 'review', 'verify', 'continuation', 'approval', 'acceptance'].map(key => [key, randomUUID()]))
  const report = { fixtureId: id.fixture, conversationId: id.group, workspaceId: id.workspace, bots: [{ id: id.bot, role: 'Coding', modelId: 'deepseek-flash' }], cases: [] }
  const expected = Buffer.from(`mikka-group-factory:${id.fixture}\nstatus=ready\n`)
  const title = `group-factory-${id.fixture.slice(0, 8)}.txt`
  const attempts = ['execute', 'review', 'verify'].map((stage, i) => ({ id: randomUUID(), stage, status: 'passed',
    runId: [id.producer, id.review, id.verify][i], candidateId: id.candidate,
    output: { requestEpoch: id.epoch, ...(i ? { check: { requestEpoch: id.epoch } } : {}) } }))
  attempts.push({ id: id.approval, stage: 'approval', status: 'pending', runId: null, candidateId: id.candidate, output: { requestEpoch: id.epoch } })
  const state = { task: { id: id.task, issueId: id.issue, sourceEventId: id.epoch, stage: 'approval', status: 'pending',
    attemptId: id.approval, candidateId: id.candidate, revision: 7 }, attempts,
    candidates: [{ id: id.candidate, runId: id.producer, kind: 'deliverable', sha: null }] }
  const calls = [], messages = [], statuses = new Map([[id.producer, 'succeeded'], [id.review, 'succeeded'], [id.verify, 'succeeded']])
  let accepted = false, acceptEvent, time = 0
  const copy = value => structuredClone(value)
  const api = {
    report, timeoutMs: 1000, stopTimeoutMs: 1000,
    now: () => time, wait: async milliseconds => { time += milliseconds }, guard: async () => {},
    async download() { return options.wrongBytes ? Buffer.from('wrong artifact') : expected },
    async json(path, body) {
      calls.push({ path, body: copy(body) })
      if (path.startsWith('/api/settings/model-order?')) return { location: 'cloud', cloudReady: true,
        entries: [{ harness: 'codex', model: 'deepseek-flash', provider: 'deepseek', source: { kind: 'api_key' } },
          ...(options.mixedModels ? [{ harness: 'codex', model: 'deepseek-pro', provider: 'deepseek', source: { kind: 'api_key' } }] : [])] }
      if (path === `/api/conversations/${id.group}/messages` && body) {
        const operation = ['create', 'status', 'continue', 'stop'][messages.length]
        assert.ok(operation, 'driver must not create additional requests as retries')
        assert.deepEqual(body.mentions, [])
        const message = { id: randomUUID(), operation }
        messages.push(message)
        if (operation === 'status' && options.statusDispatches) state.task.revision++
        if (operation === 'continue') {
          const attempt = { id: randomUUID(), stage: 'execute', status: 'running', runId: id.continuation,
            candidateId: null, output: { requestEpoch: id.nextEpoch } }
          state.attempts.push(attempt)
          Object.assign(state.task, { sourceEventId: id.nextEpoch, attemptId: attempt.id, candidateId: null, stage: 'execute', status: 'running', revision: 9 })
          statuses.set(id.continuation, 'running')
        }
        if (operation === 'stop') {
          state.task.status = 'cancelled'; state.task.revision++
          state.attempts.at(-1).status = 'cancelled'
          statuses.set(id.continuation, options.noStopAck ? 'running' : 'stopped')
        }
        return { id: message.id }
      }
      if (path === `/api/factory/tasks/${id.task}/approval` && body) {
        assert.equal(body.operation, 'accept')
        assert.deepEqual(Object.keys(body.input).sort(), ['binding', 'eventId'])
        assert.equal(body.input.binding.taskId, id.task)
        assert.equal(body.input.binding.candidateId, id.candidate)
        assert.equal(body.input.binding.revision, 7)
        if (acceptEvent) assert.equal(body.input.eventId, acceptEvent, 'accept retry uses the same receipt key')
        acceptEvent = body.input.eventId; accepted = true
        state.task.status = 'passed'; state.task.revision = 8; state.attempts[3].status = 'passed'
        state.attempts[3].output.deliverableAcceptanceId = id.acceptance
        return { status: 'accepted', acceptanceId: id.acceptance }
      }
      if (path === `/api/factory/tasks/${id.task}` && !body) return copy(state)
      if (path === `/api/factory/tasks?issueId=${id.issue}` && !body) return [copy(state.task)]
      const run = path.match(/^\/api\/runs\/([^/]+)\/evidence$/)?.[1]
      if (run) {
        assert.ok(statuses.has(run))
        return { run: { id: run, issueId: id.issue, botId: id.bot, status: statuses.get(run), harness: 'codex',
          model: 'deepseek-flash', credentialType: options.subscriptionRun ? 'subscription' : 'api_key', subscriptionRoute: null },
        artifacts: run === id.producer ? [{ id: id.artifact, title, latestVersion: 1, url: `/mikka/api/artifacts/${id.artifact}/versions/1/download` }] : [] }
      }
      assert.fail(`unexpected endpoint/mutation ${path}`)
    },
    async readTurn(groupId, messageId) {
      assert.equal(groupId, id.group)
      const message = messages.find(item => item.id === messageId)
      assert.ok(message)
      const events = []
      if (['create', 'continue'].includes(message.operation)) events.push({ id: `delegate:${messageId}`, type: 'delegate', memberId: id.bot,
        taskId: id.task, runId: message.operation === 'create' ? id.producer : id.continuation, outcome: 'succeeded' })
      events.push({ id: `publish:${messageId}`, type: 'publish', memberId: id.bot })
      if (message.operation === 'create' && accepted) {
        events.push({ id: `result:${messageId}`, type: 'task_result', memberId: id.bot, taskId: id.task, outcome: 'succeeded' })
        events.push({ id: `final:${messageId}`, type: 'publish', memberId: id.bot })
      }
      const page = { messages: messages.map(item => ({ id: `reply:${item.id}`, replyToId: item.id, authorType: 'bot', authorId: id.bot, body: `Task /?issue=${id.issue}` })) }
      if (accepted) page.messages.push({ id: 'final-artifact-report', replyToId: messages[0].id, authorType: 'bot',
        authorId: options.wrongFinalReporter ? randomUUID() : id.bot, body: `Task /?issue=${id.issue}&artifact=${id.artifact}` })
      return { page, turn: { trace: { action: 'delegate', responders: [id.bot], taskFinishedAt: accepted ? '2026-11-03T00:00:00.000Z' : null,
        execution: { executionId: `execution:${messageId}`, providerGenerationId: 'provider-generation', requestDigest: 'a'.repeat(64) }, events } } }
    },
  }
  return { api, id, calls, report, messages }
}

test('real-API driver contract accepts exact artifact once, keeps the Task, and stops its new epoch', async () => {
  const f = fixture()
  const result = await runGroupFactoryScenario(f.api)
  assert.equal(result.status, 'pass')
  assert.equal(result.artifact.retainedAfterStop, true)
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.continuation.taskId, f.id.task)
  assert.equal(result.continuation.previousEpoch, f.id.epoch)
  assert.equal(result.continuation.requestEpoch, f.id.nextEpoch)
  assert.equal(result.continuation.updatedArtifactVerified, false)
  assert.equal(result.stopReplay.repeatReads, 2)
  assert.deepEqual(f.messages.map(item => item.operation), ['create', 'status', 'continue', 'stop'])
  assert.equal(f.calls.filter(call => call.body).length, 6, 'four owner messages and two identical human-accept requests only')
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

test('a second Bot final report fails even if it links the correct Task and artifact', async () => {
  const f = fixture({ wrongFinalReporter: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_multiple_reporters/)
})

test('a status query that mutates the Task fails before continuation', async () => {
  const f = fixture({ statusDispatches: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_status_changed_task/)
  assert.deepEqual(f.messages.map(item => item.operation), ['create', 'status'])
})

test('cancelled Task without an actual run stop acknowledgement times out with resumable evidence', async () => {
  const f = fixture({ noStopAck: true })
  await assert.rejects(runGroupFactoryScenario(f.api), /acceptance_factory_stop_ack_timeout/)
  assert.equal(f.report.cases[0].continuation.runId, f.id.continuation)
  assert.equal(f.report.cases[0].lastTask.status, 'cancelled')
  assert.equal(f.report.cases[0].runs.find(run => run.id === f.id.continuation).status, 'running')
})
