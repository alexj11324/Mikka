import assert from 'node:assert/strict'
import test from 'node:test'
import { auditPageInput, auditScopeQuery, auditWindow, csvField, decodeAuditCursor, encodeAuditCursor } from './cursor'

test('audit cursors round-trip and reject anything else', () => {
  const position = { micros: '1793362410829123', id: '11111111-1111-4111-8111-111111111111' }
  assert.deepEqual(decodeAuditCursor(encodeAuditCursor(position)), position)
  assert.equal(decodeAuditCursor('x'), null)
  assert.equal(decodeAuditCursor(Buffer.from(JSON.stringify({ micros: '1', id: 'nope' })).toString('base64url')), null)
  assert.equal(decodeAuditCursor(Buffer.from(JSON.stringify({ ...position, extra: 1 })).toString('base64url')), null)
  assert.deepEqual(auditPageInput.parse({}), { filter: 'all', limit: 50 })
  assert.throws(() => auditPageInput.parse({ filter: 'billing' }))
})

test('CSV fields are quoted and never start a formula', () => {
  assert.equal(csvField('plain'), 'plain')
  assert.equal(csvField('a,b'), '"a,b"')
  assert.equal(csvField('say "hi"'), '"say ""hi"""')
  assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
  assert.equal(csvField(null), '')
})

test('a page can narrow to categories and a period inside the 90 days, never past them', () => {
  const now = new Date('2026-11-09T12:00:00.000Z')
  const search = new URLSearchParams({ filter: 'all', category: 'secret,member', from: '2026-11-01T00:00:00.000Z', until: '2026-11-08T00:00:00.000Z' })
  const scope = auditPageInput.parse(auditScopeQuery(search))
  assert.deepEqual(scope.categories, ['secret', 'member'])
  assert.deepEqual(auditWindow(scope, now), { since: new Date('2026-11-01T00:00:00.000Z'), until: new Date('2026-11-08T00:00:00.000Z') })
  // A start before the window and an end after now are clipped to them.
  assert.deepEqual(auditWindow({ from: '2025-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z' }, now), { since: new Date(now.getTime() - 90 * 86_400_000), until: now })
  // Nothing given is the whole window, as before.
  assert.deepEqual(auditPageInput.parse(auditScopeQuery(new URLSearchParams())), { filter: 'all', limit: 50 })
  assert.throws(() => auditPageInput.parse(auditScopeQuery(new URLSearchParams({ category: 'secret,nope' }))))
  assert.throws(() => auditPageInput.parse({ from: '2026-11-08T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z' }))
  assert.throws(() => auditPageInput.parse({ from: 'yesterday' }))
})
