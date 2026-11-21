import assert from 'node:assert/strict'
import test from 'node:test'
import { agentStateOf, cardStateKind } from './data'

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

test('a card\'s mark is what its Agent is doing; a status alone, open or closed, draws none', () => {
  assert.equal(cardStateKind('running'), 'running')
  assert.equal(cardStateKind('queued'), 'running')
  assert.equal(cardStateKind('waiting'), 'waiting')
  assert.equal(cardStateKind('blocked'), 'waiting', 'a run stopped for a login or quota waits for the person')
  assert.equal(cardStateKind('failed'), 'blocked')
  assert.equal(cardStateKind('canceled'), null)
  assert.equal(cardStateKind('done'), null)
  assert.equal(cardStateKind('todo'), null)
  assert.equal(cardStateKind('idle'), null)
})
