import assert from 'node:assert/strict'
import test from 'node:test'
import { changedListIds, heldListPositions, mergeList, readListPositions } from './list-poll'

test('an unchanged poll preserves current optimistic data; a changed snapshot replaces it', () => {
  const current = [{ id: 'new-local-task' }]
  assert.equal(mergeList(current, { unchanged: true, version: 'v1' }), current)
  const items = [{ id: 'server-task' }]
  assert.equal(mergeList(current, { version: 'v2', items }), items)
  assert.deepEqual(mergeList(current, { version: 'v3', items: [] }), [], 'deletions and lost access clear stale rows')
})

test('a row delta follows the authorized order and drops deleted or revoked rows', () => {
  const current = [{ id: 'a', title: 'Before' }, { id: 'b', title: 'Revoked' }, { id: 'c', title: 'Unchanged' }]
  const next = { version: 'v2', delta: true as const, positions: [{ id: 'c', version: 'c1' }, { id: 'a', version: 'a2' }, { id: 'd', version: 'd1' }], items: [{ id: 'a', title: 'After' }, { id: 'd', title: 'New' }] }
  assert.deepEqual(mergeList(current, next), [current[2], next.items[0], next.items[1]])
  assert.deepEqual(mergeList(current, { version: 'v3', delta: true, positions: [], items: [] }), [])
  assert.deepEqual(changedListIds(next.positions, [{ id: 'a', version: 'a1' }, { id: 'b', version: 'b1' }, { id: 'c', version: 'c1' }]), ['a', 'd'])
})

test('invalid proofs fall back to full reads, and a local cache only claims rows it holds', () => {
  const a = { id: '10000000-0000-4000-8000-000000000001', version: 'a'.repeat(32) }
  const b = { id: '10000000-0000-4000-8000-000000000002', version: 'b'.repeat(32) }
  assert.deepEqual(readListPositions([a], 100), [a])
  for (const value of [null, {}, [a, a], [{ ...a, version: 'not-a-version' }], [{ ...a, id: 'not-an-id' }]]) assert.equal(readListPositions(value, 100), undefined)
  assert.equal(readListPositions([a, b], 1), undefined)
  assert.deepEqual(heldListPositions({ items: [{ id: b.id }], positions: [a, b] }), [b])
  assert.deepEqual(changedListIds([a, b], heldListPositions({ items: [{ id: b.id }], positions: [a, b] })), [a.id])
})
