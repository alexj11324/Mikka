import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { mock } from 'node:test'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { challengeFor, sha256Hex } from '../lib/desktop-auth-server'

// Exercise the real route and Drizzle query execution without opening a socket.
// PostgreSQL locking/atomicity are covered by desktop-auth-handoff.db.test.ts.
test('desktop exchange consumes its pending request in one database operation and retains the OTT boundary', async t => {
  const origin = 'https://desktop-auth.example.invalid'
  const verifier = randomBytes(32).toString('base64url')
  const proof = { state: randomBytes(24).toString('base64url'), code: randomBytes(32).toString('base64url'), verifier }
  const token = 'synthetic-parked-one-time-token'
  const bearer = 'synthetic-bearer-not-a-production-credential'
  let rows: unknown[][] = []
  let databaseCalls = 0, verificationCalls = 0, verificationFails = false
  const database = drizzle({ client: { query: async () => { databaseCalls++; return { rows } } } as unknown as Pool })
  const mocks = [
    mock.module(new URL('../lib/db/index.ts', import.meta.url).href, { namedExports: { db: database } }),
    mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { withRequestLog: (_path: string, handler: unknown) => handler } }),
    mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { auth: {
      $context: Promise.resolve({ authCookies: { sessionData: { name: 'better-auth.session_data' } } }),
      api: { verifyOneTimeToken: async (input: { body: { token: string }; headers: Headers; returnHeaders: boolean }) => {
        verificationCalls++
        assert.equal(input.body.token, token)
        assert.equal(input.headers.has('cookie'), false)
        assert.equal(input.headers.has('authorization'), false)
        assert.equal(input.returnHeaders, true)
        if (verificationFails) throw new Error('synthetic-verification-refused')
        return { response: { user: { id: 'synthetic-owner', name: 'Fixture', email: 'fixture@example.invalid', image: null }, session: { id: 'synthetic-session', token: bearer } }, headers: new Headers() }
      } },
    } } }),
  ]
  try {
    const { POST } = await import('../app/api/desktop/exchange/route')
    const exchange = (body: unknown, from = origin) => POST(new Request(`${origin}/api/desktop/exchange`, {
      method: 'POST', headers: { origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    const reset = () => {
      databaseCalls = 0; verificationCalls = 0; verificationFails = false
      rows = [[sha256Hex(proof.code), challengeFor(verifier), token]]
    }

    await t.test('bundled exchange preserves SDK verification and the safe session projection', async () => {
      reset()
      const response = await exchange({ ...proof, client: 'bundled' })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.token, bearer)
      assert.deepEqual(body.session, { id: 'synthetic-session' })
      assert.equal(JSON.stringify(body).includes(token), false, 'the parked OTT never reaches the renderer contract')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(verificationCalls, 1)
      assert.equal(databaseCalls, 1, 'consume and clear must be one atomic statement')
    })
    await t.test('legacy hosted exchange retains its one-time-token response', async () => {
      reset()
      const response = await exchange(proof)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { token })
      assert.equal(verificationCalls, 0)
      assert.equal(databaseCalls, 1)
    })
    await t.test('wrong code or verifier still consumes before refusing, without invoking the SDK', async () => {
      for (const field of ['code', 'verifier']) {
        reset()
        assert.equal((await exchange({ ...proof, [field]: randomBytes(32).toString('base64url'), client: 'bundled' })).status, 400)
        assert.equal(verificationCalls, 0)
        assert.equal(databaseCalls, 1)
      }
    })
    await t.test('missing, expired or previously consumed database proof cannot enter the SDK', async () => {
      reset(); rows = []
      assert.equal((await exchange({ ...proof, client: 'bundled' })).status, 400)
      assert.equal(verificationCalls, 0)
      assert.equal(databaseCalls, 1)
    })
    await t.test('SDK expiry or revocation still rejects after consuming the pending request', async () => {
      reset(); verificationFails = true
      const response = await exchange({ ...proof, client: 'bundled' })
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: 'exchangeRejected' })
      assert.equal(verificationCalls, 1)
      assert.equal(databaseCalls, 1)
    })
    await t.test('foreign origin and malformed proof are refused before database access', async () => {
      reset()
      assert.equal((await exchange(proof, 'https://foreign.example.invalid')).status, 403)
      assert.equal((await exchange({ ...proof, client: 'unknown' })).status, 400)
      assert.equal((await exchange({ ...proof, state: 'short' })).status, 400)
      assert.equal(databaseCalls, 0)
      assert.equal(verificationCalls, 0)
    })
  } finally { for (const handle of mocks.reverse()) handle.restore() }
})
