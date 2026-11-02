import assert from 'node:assert/strict'
import test from 'node:test'
import { chatFailure } from './chat-failure'
import { failureLine } from '../apps/mobile/lib/chat-failure'

const person = { from: 'person' }, reply = { from: 'coordinator' }, event = { from: 'event' }

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
