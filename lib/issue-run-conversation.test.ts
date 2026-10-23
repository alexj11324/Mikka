import test from 'node:test'
import assert from 'node:assert/strict'
import { runIsActive, runListRefreshInterval, runDiscussionId, isRunDiscussion, runOutput, runDiscussionRunId } from './issue-run-conversation'

test('only active run states offer messages; completed history stays readable', () => {
  for (const state of ['queued', 'preparing', 'running', 'waiting_input', 'finishing']) assert.equal(runIsActive(state), true)
  for (const state of ['succeeded', 'stopped', 'failed', 'cancelled', 'unknown']) assert.equal(runIsActive(state), false)
})
test('run comments use distinct existing collaborative discussion threads', () => {
  assert.equal(runDiscussionId('run-1'), 'discussion-run-run-1')
  assert.notEqual(runDiscussionId('run-1'), runDiscussionId('run-2'))
  assert.equal(isRunDiscussion(runDiscussionId('run-1')), true)
  assert.equal(isRunDiscussion('discussion-other'), false)
})
test('durable chunk replay merges deltas and preserves tools/errors in order', () => {
  assert.deepEqual(runOutput([
    { type: 'start' }, { type: 'reasoning-delta', id: 'r', delta: 'Think' },
    { type: 'text-delta', id: 'a', delta: 'Hello ' }, { type: 'text-delta', id: 'a', delta: '世界' },
    { type: 'tool-input-available', toolCallId: 't', toolName: 'read' },
    { type: 'tool-output-available', toolCallId: 't', output: { ok: true } },
    { type: 'tool-output-error', toolCallId: 'u', errorText: 'No access' },
    { type: 'error', errorText: 'Interrupted' }, { type: 'unknown', data: 'ignored' },
  ]), [
    { id: 'reasoning:r', kind: 'reasoning', text: 'Think' },
    { id: 'text:a', kind: 'text', text: 'Hello 世界' },
    { id: 'tool:t', kind: 'tool', text: 'read\n{"ok":true}' },
    { id: 'tool:u', kind: 'tool', text: 'No access' },
    { id: 'error:7', kind: 'error', text: 'Interrupted' },
  ])
  assert.deepEqual(runOutput([]), [])
})

// Replicate the collaborative comment map's concurrent insertion semantics without a server.
test('concurrent first comments keep independent keys in one run discussion', async () => {
  const Y = await import('yjs')
  const a = new Y.Doc(), b = new Y.Doc()
  for (const [doc, key, body] of [[a, 'a', 'first'], [b, 'b', 'second']] as const) {
    const { addThread } = await import('../components/blocks/rich-text-editor-4/components/rich-text-comments')
    addThread(doc, { id: `${runDiscussionId('run-1')}:${key}`, author: key, createdAt: '2026-10-23T00:00:00Z', messages: [{ author: key, body, at: '2026-10-23T00:00:00Z' }] }, 'issue-discussion')
  }
  const au = Y.encodeStateAsUpdate(a), bu = Y.encodeStateAsUpdate(b)
  Y.applyUpdate(a, bu); Y.applyUpdate(b, au)
  for (const doc of [a, b]) {
    assert.equal(doc.getMap<import('yjs').Map<unknown>>('threads').size, 2)
    const bodies = [...doc.getMap<import('yjs').Map<unknown>>('threads').values()].map(value => (value.get('messages') as import('yjs').Array<{ body: string }>).get(0).body).sort()
    assert.deepEqual(bodies, ['first', 'second'])
    assert.deepEqual([...doc.getMap<import('yjs').Map<unknown>>('threads').keys()].map(runDiscussionRunId), ['run-1', 'run-1'])
    doc.destroy()
  }
})

test('idle and historical lists do not poll; active runs keep supported refresh', () => {
  assert.equal(runListRefreshInterval(undefined), 0)
  assert.equal(runListRefreshInterval([]), 0)
  assert.equal(runListRefreshInterval([{ status: 'succeeded' }]), 0)
  assert.equal(runListRefreshInterval([{ status: 'succeeded' }, { status: 'running' }]), 5000)
})
