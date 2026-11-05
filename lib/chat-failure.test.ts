import assert from 'node:assert/strict'
import test from 'node:test'
import { chatFailure, failureMessageKey } from './chat-failure'
import { chatBalanceRefusal } from './chat-balance'
import { failureLine } from '../apps/mobile/lib/chat-failure'

const person = { from: 'person' }, reply = { from: 'coordinator' }, event = { from: 'event' }
const balance = 'Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: Insufficient Balance (request_id: 11111111-1111-4111-8111-111111111111)'

test('the observed model streaming balance refusal has safe copy and a model recovery without retry', () => {
  const failure = chatFailure({ working: false, error: balance })!
  assert.deepEqual(failure, { kind: 'failed', reason: 'balance' })
  assert.deepEqual(failureMessageKey(failure), { namespace: 'Coordinator', key: 'apiBalance' })
  assert.deepEqual(failureLine(failure), { text: 'API 余额不足', retry: false, recovery: 'model' })
  assert.doesNotMatch(JSON.stringify(failure), /request_id|11111111|doStreamStep/)
  assert.equal(chatFailure({ working: true, error: balance }), null)
})

test('balance display recognizes the same provider boundary across SDK versions and a bare refusal', () => {
  assert.equal(chatBalanceRefusal(balance.replace('2.0.80', '2.1.0')), true)
  assert.equal(chatBalanceRefusal(balance.replace('2.0.80', '3.0.0-beta.1')), true)
  assert.equal(chatBalanceRefusal('Insufficient Balance'), true)
  assert.equal(chatBalanceRefusal(null), false)
})

test('generic, quoted and tool errors never become a balance state from credit or quota words', () => {
  for (const error of [
    'model timed out', 'credit unavailable', 'quota exceeded', 'HTTP 402',
    'Tool output: Insufficient Balance',
    'Step "step//tools//doStreamStep" failed after 0 retries: Insufficient Balance',
    'Step "step//@ai-sdk/workflow@2.0.80//runToolStep" failed after 0 retries: Insufficient Balance',
    'Step "step//@ai-sdk/workflow@2.0.80//doStreamStep" failed after 0 retries: unrelated tool body says Insufficient Balance',
    `${balance} extra diagnostic text`,
  ]) {
    assert.equal(chatBalanceRefusal(error), false, error)
    const failure = chatFailure({ working: false, error })!
    assert.deepEqual(failure, { kind: 'failed' }, error)
    assert.equal(failureLine(failure).retry, true, error)
  }
})

test('a failed reply is named by what the person can do, never the raw error', () => {
  assert.deepEqual(chatFailure({ working: false, error: 'Step "step//./workflows/coordinator/agent-kit-steps//botRuntime" failed after 3 retries: binding_required' }), { kind: 'subscription', notice: 'selectionChanged' })
  assert.deepEqual(chatFailure({ working: false, error: 'Error: points_exhausted' }), { kind: 'hosted', code: 'points_exhausted' })
  assert.deepEqual(chatFailure({ working: false, error: 'wake_exhausted' }), { kind: 'wake', code: 'wake_exhausted' })
  assert.deepEqual(chatFailure({ working: false, error: 'model timed out' }), { kind: 'failed' })
})

test('nothing while a turn works; a turn that ended with no reply and nothing recorded is a failure', () => {
  assert.equal(chatFailure({ working: true, error: 'binding_required' }), null)
  assert.equal(chatFailure({ working: false, error: null, items: [person, reply] }), null)
  assert.equal(chatFailure({ working: false, error: null, items: [] }), null)
  assert.deepEqual(chatFailure({ working: false, error: null, items: [reply, person, event] }), { kind: 'failed' })
  assert.equal(chatFailure({ working: false, error: null, items: [reply, { from: 'person', pending: true }] }), null, 'a message still waiting is not unanswered')
})

test('every actionable server subscription error remains readable in the mobile contract', () => {
  for (const code of ['binding_required', 'account_unavailable', 'reconnect_required', 'quota_exhausted', 'backend_unavailable', 'quota_unknown', 'subscription_rate_limited', 'provider_access_denied', 'provider_request_rejected', 'provider_route_unavailable']) {
    const failure = chatFailure({ working: false, error: code })
    assert.equal(failure?.kind, 'subscription', code)
    assert.ok(failure && failureLine(failure).text, code)
  }
})
