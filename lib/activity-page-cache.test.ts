import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeActivityEarlier, mergeActivityPoll } from './activity-page-cache'

const row = (revision: number, value = '') => ({ id: `r${revision}`, revision, value })
test('polling updates overlapping rows while preserving the loaded earlier tail', () => {
  const previous = { version: 'a', items: [row(3), row(2), row(1)], hasMore: false }
  const next = { version: 'b', items: [row(4), row(3, 'renamed')], hasMore: true }
  assert.deepEqual(mergeActivityPoll(previous, next), { version: 'b', items: [row(4), row(3, 'renamed'), row(2), row(1)], hasMore: false, predecessor: null })
})
test('a non-overlapping poll resets the window so the cursor can retrieve the missing gap', () => {
  const previous = { version: 'a', items: [row(2), row(1)], hasMore: false }
  const next = { version: 'b', items: [row(6), row(5)], hasMore: true }
  assert.deepEqual(mergeActivityPoll(previous, next), next)
})

test('a late older-page response cannot add a gap after a poll replaced the window', () => {
  const current = { version: 'new', items: [row(9), row(8)], hasMore: true }
  assert.equal(mergeActivityEarlier(current, 'r3', { items: [row(2), row(1)], hasMore: false }), current)
  assert.deepEqual(mergeActivityEarlier(current, 'r8', { items: [row(7), row(6)], hasMore: false }), { version: 'new', items: [row(9), row(8), row(7), row(6)], hasMore: false, predecessor: null })
})

test('the page predecessor stays private to the visible window and tracks its oldest boundary', () => {
  const previous = { version: 'a', items: [row(5), row(4)], hasMore: true, predecessor: row(3) }
  const next = { version: 'b', items: [row(6), row(5, 'renamed')], hasMore: true, predecessor: row(4) }
  assert.deepEqual(mergeActivityPoll(previous, next), { version: 'b', items: [row(6), row(5, 'renamed'), row(4)], hasMore: true, predecessor: row(3) })
  assert.deepEqual(mergeActivityEarlier(previous, 'r4', { items: [row(3), row(2)], predecessor: row(1), hasMore: false }), { version: 'a', items: [row(5), row(4), row(3), row(2)], predecessor: row(1), hasMore: false })
})
