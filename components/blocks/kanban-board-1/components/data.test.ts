import assert from 'node:assert/strict'
import test from 'node:test'
import { agentStateOf } from './data'

const open = { status: 'todo', metadata: { pullRequests: [] } }

test('a card shows its newest run\'s group, not its raw status', () => {
  assert.equal(agentStateOf({ status: 'failed', outcome: 'idle' }, open), null)
  assert.equal(agentStateOf({ status: 'succeeded', outcome: 'needs_input' }, open), 'waiting')
  assert.equal(agentStateOf({ status: 'succeeded', outcome: 'blocked' }, open), 'blocked')
  assert.equal(agentStateOf({ status: 'succeeded', outcome: 'done' }, open), null)
  assert.equal(agentStateOf({ status: 'running', outcome: null }, open), 'running')
  assert.equal(agentStateOf({ status: 'waiting_input', outcome: null }, open), 'waiting')
})

test('a done task settles a failed run; no run shows nothing', () => {
  assert.equal(agentStateOf({ status: 'failed', outcome: 'failed' }, { status: 'done', metadata: { pullRequests: [] } }), null)
  assert.equal(agentStateOf(undefined, open), null)
})
