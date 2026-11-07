import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { readServerSession } from './server-admin'

let revoked = false
const expected = { user: { id: 'operator' }, session: { id: 'session' } }
const read = mock.fn(async (input: { headers: Headers; query: { disableCookieCache: boolean } }) => {
  assert.equal(input.query.disableCookieCache, true)
  return revoked ? null : expected
})
mock.module(new URL('./auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: read } } } })

test('server configuration reads the actual current session and cannot use a stale cookie after revocation', async () => {
  const headers = new Headers({ cookie: 'same-cookie' })
  assert.equal(await readServerSession(headers), expected)
  assert.equal(read.mock.calls[0].arguments[0].headers, headers)
  revoked = true
  assert.equal(await readServerSession(headers), null)
  assert.equal(read.mock.callCount(), 2)
})
