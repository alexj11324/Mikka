import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, activitySources, decodeActivityCursor, encodeActivityCursor, parseActivityInput } from './activity-cursor'

test('a cursor round-trips the exact microsecond position', () => {
  const position = { micros: '1793301859238417', id: 'action:6f1d4c1e-6a43-4a43-9d39-0f3c2a1b4c5d' }
  assert.deepEqual(decodeActivityCursor(encodeActivityCursor(position)), position)
})

test('a cursor the server did not issue is rejected', () => {
  const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  assert.equal(decodeActivityCursor('not base64!'), null)
  assert.equal(decodeActivityCursor(forged({ micros: '1', id: 'other:1' })), null)
  assert.equal(decodeActivityCursor(forged({ micros: '1.5', id: 'credential:1' })), null)
  assert.equal(decodeActivityCursor(forged({ micros: '1', id: "credential:1' OR 1=1" })), null)
  assert.equal(decodeActivityCursor(forged({ micros: '1', id: 'credential:1', extra: true })), null)
  assert.equal(decodeActivityCursor('A'.repeat(300)), null)
  // Past the year 2286 the SQL timestamp math overflows; such a cursor is refused, not a 500.
  assert.equal(decodeActivityCursor(forged({ micros: '9'.repeat(17), id: 'credential:1' })), null)
  assert.deepEqual(decodeActivityCursor(forged({ micros: '9'.repeat(16), id: 'credential:1' })), { micros: '9'.repeat(16), id: 'credential:1' })
})

test('input defaults to all, the default page and no cursor', () => {
  assert.deepEqual(parseActivityInput(undefined), { filter: 'all', after: null, limit: ACTIVITY_PAGE_DEFAULT })
  assert.deepEqual(parseActivityInput({ filter: 'reminders', cursor: null }), { filter: 'reminders', after: null, limit: ACTIVITY_PAGE_DEFAULT })
})

test('input rejects unknown filters, bad limits, bad cursors and extra fields', () => {
  assert.equal(parseActivityInput({ filter: 'everything' }), null)
  assert.equal(parseActivityInput({ limit: 0 }), null)
  assert.equal(parseActivityInput({ limit: ACTIVITY_PAGE_MAX + 1 }), null)
  assert.equal(parseActivityInput({ cursor: 'garbage' }), null)
  assert.equal(parseActivityInput({ userId: 'someone-else' }), null)
})

test('filters select their sources', () => {
  assert.deepEqual(activitySources('all'), { credentials: true, actions: true, reminders: true })
  assert.deepEqual(activitySources('accounts'), { credentials: true, actions: true, reminders: false })
  assert.deepEqual(activitySources('reminders'), { credentials: false, actions: false, reminders: true })
})
