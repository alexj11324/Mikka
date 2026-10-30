import assert from 'node:assert/strict'
import test from 'node:test'
import { auditPageInput, csvField, decodeAuditCursor, encodeAuditCursor } from './cursor'

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
