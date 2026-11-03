import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeList } from './list-poll'

test('an unchanged poll preserves current optimistic data; a changed snapshot replaces it', () => {
  const current = [{ id: 'new-local-task' }]
  assert.equal(mergeList(current, { unchanged: true, version: 'v1' }), current)
  const items = [{ id: 'server-task' }]
  assert.equal(mergeList(current, { version: 'v2', items }), items)
  assert.deepEqual(mergeList(current, { version: 'v3', items: [] }), [], 'deletions and lost access clear stale rows')
})
