import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatItems, eventPrompt } from './context'
import { ATTENTION_THRESHOLD, ruleTier, tierFromDecision, triageState } from './triage'

const run = (payload: Record<string, unknown>) => ({ kind: 'run_finished' as const, payload: { stopReason: 'submitted', ...payload } })

test('clear cases follow the rules', () => {
  assert.equal(ruleTier({ kind: 'user_message', payload: { text: 'hi' } }), 'attention')
  assert.equal(ruleTier({ kind: 'issue_done', payload: { title: 'x' } }), 'background')
  assert.equal(ruleTier(run({ status: 'failed' })), 'attention')
  assert.equal(ruleTier(run({ status: 'cancelled' })), 'background')
  assert.equal(ruleTier(run({ status: 'stopped' })), 'background')
  assert.equal(ruleTier(run({ status: 'succeeded', summary: null })), 'result')
  assert.equal(ruleTier(run({ status: 'succeeded', summary: '  ' })), 'result')
})

test('a success with a summary goes to the decision model', () => {
  assert.equal(ruleTier(run({ status: 'succeeded', summary: 'Fixed it, but could not run the tests' })), null)
  assert.deepEqual(triageState(run({ status: 'succeeded', summary: 'Done' })), { status: 'succeeded', stopReason: 'submitted', agentSummary: 'Done' })
})

test('the model\'s probability picks attention or result', () => {
  assert.equal(tierFromDecision(ATTENTION_THRESHOLD), 'attention')
  assert.equal(tierFromDecision(0.9), 'attention')
  assert.equal(tierFromDecision(0.2), 'result')
})

test('the tier reaches the Coordinator but not the chat', () => {
  const text = eventPrompt({ kind: 'run_finished', issueId: null, runId: 'r1', payload: { status: 'failed', stopReason: 'error' }, tier: 'attention' })
  assert.match(text, /\nTriage: this needs the person/)
  const [item] = chatItems([{ position: 1, createdAt: new Date(), message: { role: 'user', content: text } }])
  assert.equal(item.text, '[Event] Run r1 ended with status failed (error).')
  assert.doesNotMatch(eventPrompt({ kind: 'issue_done', issueId: 'i1', runId: null, payload: { title: 'Login', previousStatus: 'review' }, tier: 'result' }), /Triage/)
})
