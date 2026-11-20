// Scripted answers at the shared LiteLLM boundary. Runtime contracts stay strict.
import assert from 'node:assert/strict'

export function answerDecision(input, observe = () => {}) {
  assert.equal(input.model, 'mikka-decision')
  assert.equal(input.questions?.length, 1)
  const question = input.questions[0]
  assert.equal(question.type, 'choice')
  if (question.name === 'push') {
    // Push classification
    // Whether a Coordinator reply also goes to the phone (lib/push-reasons.ts):
    // the answered events and the reply, one per line, as plain text.
    assert.deepEqual(question.choices?.map(choice => choice.value), ['decide', 'review', 'finished', 'briefing', 'none'])
    assert.equal(typeof input.input, 'string')
    const answersPerson = /^answeredEvents: .+\nanswersAMessageFromThePerson: (yes|no)\nreply: .+$/s.exec(input.input)?.[1]
    assert.ok(answersPerson, 'Unexpected push evidence')
    observe({ kind: 'push-request', answersPerson })
    // The person is in the chat they just wrote in: no phone notification.
    return ({ cost: 0.001,
      model: input.model,
      answers: [{ type: 'choice', name: 'push', choice: 'none' }],
    })
  }
  if (question.name === 'outcome') {
    // Outcome classification
    // run-outcome-judge passes outcomeText directly. decisionRequestInput
    // preserves plain strings; only DecisionContext callers use messages.
    assert.deepEqual(question.choices?.map(choice => choice.value), ['done', 'blocked', 'needs_input', 'failed', 'idle'])
    assert.equal(typeof input.input, 'string')
    const facts = input.input
    const status = /^status: (succeeded|stopped|failed|cancelled)\nstop reason: .+\nattempts on this task: [1-9][0-9]*\ntask: .+\npull requests: .+\nsummary \(quoted\): .+\nlast reply \(quoted\): .+$/.exec(facts)?.[1]
    assert.ok(status, 'Unexpected run outcome evidence')
    observe({ kind: 'outcome-request', status })
    return ({ cost: 0.001,
      model: input.model,
      answers: [{ type: 'choice', name: 'outcome', choice: status === 'succeeded' ? 'done' : 'idle' }],
    })
  }
  // Event classification
  assert.equal(question.name, 'tier')
  assert.deepEqual(question.choices?.map(choice => choice.value), ['attention', 'result', 'background'])
  assert.equal(input.input?.length, 1)
  assert.equal(input.input[0].role, 'user')
  assert.equal(input.input[0].content?.length, 1)
  assert.equal(input.input[0].content[0].type, 'input_text')
  const state = JSON.parse(input.input[0].content[0].text)
  const host = JSON.parse(state.hostObservation)
  assert.ok(['run_finished', 'action_decided', 'artifact_submitted'].includes(host.eventKind), 'Unexpected MVP runtime event')
  assert.match(host.eventId, /^[a-f0-9-]{36}$/)
  assert.equal(typeof host.ownerId, 'string')
  if (host.eventKind === 'run_finished') {
    assert.equal(host.observedRun?.id, host.runId)
    assert.ok(['succeeded', 'failed', 'cancelled'].includes(host.observedRun?.status))
  }
  if (host.eventKind === 'artifact_submitted') {
    // artifactSubmittedEvent is also emitted by Factory reports. This
    // model tier classifies the notice; it cannot prove PR publication.
    const artifact = JSON.parse(state.untrustedEventPayload)
    assert.match(artifact.artifactId, /^[a-f0-9-]{36}$/)
    assert.ok(Number.isSafeInteger(artifact.version) && artifact.version > 0)
    assert.ok(['markdown', 'html'].includes(artifact.artifactKind))
    assert.equal(typeof artifact.title, 'string')
    assert.equal(typeof artifact.authorName, 'string')
    if (host.runId !== null) assert.match(host.runId, /^[a-f0-9-]{36}$/)
    if (host.issueId !== null) assert.match(host.issueId, /^[a-f0-9-]{36}$/)
    if (host.observedRun !== null) assert.equal(host.observedRun.id, host.runId)
  }
  observe({ kind: 'decision-request', eventId: host.eventId, eventKind: host.eventKind })
  return ({ cost: 0.001,
    model: input.model,
    answers: [{ type: 'choice', name: 'tier', choice: 'result' }],
  })
}
