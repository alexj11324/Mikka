import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionStreamEvent } from 'eve/client'
import type { Delivery } from 'eve/sessions'
import type { DeliveryOutcome, TurnOutcome } from 'eve/events'
import { evaluationDeliveryTrace } from './evaluation-client'
import type { EvaluationPlan } from './evaluation-store'
import { CORE_EVAL_CASES } from '../agent-kit/evals'
import { makeSnapshot } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'

const accepted = 'delivery'
const ownTurn = 'turn'
const answer = { text: 'Complete reply', outcome: 'answered' }
const scope = { turnId: ownTurn }
const plan: EvaluationPlan = { scope: { ownerId: 'fixture', botId: null, workspaceId: null }, instructions: 'host', tools: [], testCase: CORE_EVAL_CASES[0],
  snapshot: makeSnapshot('revision', 1, DEFAULT_AGENT_DEFINITION, 'host', { harness: 'ai_sdk', model: 'fixture' }),
}

function terminalFacts(format: 'text' | 'result', outcome: DeliveryOutcome = 'handled', turnOutcome: TurnOutcome = 'completed'): SessionStreamEvent[] {
  const facts = [
    { type: 'delivery.admitted', data: { deliveryId: accepted, source: { channel: 'evaluation' } } },
    { type: 'delivery.consumed', data: { deliveryId: accepted, turnId: ownTurn, parts: [] } },
    { type: 'turn.started', data: { turnId: ownTurn, cause: { deliveryId: accepted }, follows: null } },
    { type: 'content.completed', scope, data: { partId: 'reply', kind: format, phase: 'reply', value: format === 'text' ? JSON.stringify(answer) : answer } },
    { type: 'turn.settled', data: { turnId: ownTurn, outcome: turnOutcome, reply: ['reply'] } },
    { type: 'delivery.settled', data: { deliveryId: accepted, turnId: ownTurn, outcome } },
  ]
  return facts.map((event, index) => ({ ...event, meta: { position: { line: index + 30, index: 0 }, at: '2026-01-01T01:00:00Z' } })) as SessionStreamEvent[]
}

function readOnce(events: SessionStreamEvent[]): Delivery {
  return {
    sessionId: 'evaluation', deliveryId: accepted,
    async *stream() { yield* events },
    async result() { throw Error('the second durable read is unavailable') },
  }
}

test('one durable delivery read verifies the turn and returns native structured or text output', async () => {
  for (const format of ['text', 'result'] as const) {
    const trace = await evaluationDeliveryTrace(readOnce(terminalFacts(format)), plan, new AbortController().signal)
    assert.deepEqual(trace, { ...answer, tools: [] })
  }
})

test('a partial, unrelated, failed, or waiting delivery cannot supply a successful evaluation', async () => {
  const settled = terminalFacts('result')
  const cases = [
    settled.slice(0, -1), settled.slice(0, -2), settled.filter(event => event.type !== 'turn.settled'),
    terminalFacts('result', 'failed'), terminalFacts('result', 'awaiting-input'),
    terminalFacts('result', 'handled', 'cancelled'), terminalFacts('result', 'handled', 'failed'),
    settled.map(event => event.type === 'delivery.settled' ? { ...event, data: { ...event.data, deliveryId: 'another' } } : event),
  ]
  for (const events of cases) {
    await assert.rejects(evaluationDeliveryTrace(readOnce(events), plan, new AbortController().signal), /agentEvaluationGenerationFailed/)
  }
})

test('aborting the read refuses an otherwise completed evaluation', async () => {
  await assert.rejects(evaluationDeliveryTrace(readOnce(terminalFacts('result')), plan, AbortSignal.abort()), { name: 'AbortError' })
})
