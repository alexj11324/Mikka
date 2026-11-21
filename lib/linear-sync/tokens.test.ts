import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { LinearApiError } from './graphql'

const userId = 'user-1'
type Row = { userId: string; accessToken: string; refreshToken: string; expiresAt: Date; revokedAt: Date | null }

let row: Row | undefined
let writes = 0
let transactions = 0
let crypto: typeof import('./crypto')
let tokens: typeof import('./tokens')
const unexpected = () => { throw new Error('Unexpected database or provider work') }

before(async () => {
  process.env.LINEAR_CLIENT_ID = 'fixture-client'
  process.env.LINEAR_CLIENT_SECRET = 'fixture-secret'
  process.env.LINEAR_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64)
  mock.module('@/lib/db', { namedExports: {
    db: {
      select: () => ({ from: () => ({ where: () => ({
        // A row lock taken here would be held across the refresh's provider call.
        for: () => { throw new Error('the token row must not be locked') },
        limit: async () => row ? [row] : [],
      }) }) }),
      update: () => ({ set: (values: Partial<Row>) => ({ where: (predicate: SQL) => ({ returning: async () => {
        // Compare-and-set: the row changes only while it still holds the
        // credential the update was written against.
        const query = new PgDialect().sqlToQuery(predicate)
        if (!row || !query.params.includes(row.userId) || !query.params.includes(row.refreshToken)) return []
        row = { ...row, ...values }; writes++
        return [{ userId: row.userId }]
      } }) }) }),
      transaction: () => { transactions++; return unexpected() },
    },
    pool: unexpected,
  } })
  crypto = await import('./crypto')
  tokens = await import('./tokens')
})

function stored(accessToken: string, refreshToken: string, expiresAt: number): Row {
  return { userId, accessToken: crypto.seal(accessToken), refreshToken: crypto.seal(refreshToken), expiresAt: new Date(expiresAt), revokedAt: null }
}

test('a token that has not expired is returned without a lock, a transaction or provider traffic', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => unexpected())
  row = stored('fresh-access', 'fresh-refresh', Date.now() + 600_000); writes = 0; transactions = 0
  assert.equal(await tokens.linearAccessToken(userId), 'fresh-access')
  assert.equal(fetch.mock.callCount(), 0); assert.equal(writes, 0); assert.equal(transactions, 0)
})

test('the provider call runs outside any transaction and the refreshed pair is written only after it settles', async t => {
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>()
  t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return response.promise })
  row = stored('stale-access', 'stale-refresh', Date.now() - 1_000); writes = 0; transactions = 0
  const pending = tokens.linearAccessToken(userId)
  await started.promise
  assert.equal(transactions, 0, 'the refresh must not hold a transaction open across the provider call')
  assert.equal(writes, 0, 'nothing is written while the provider call is in flight')
  response.resolve(Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3_600 }))
  assert.equal(await pending, 'rotated-access')
  assert.equal(writes, 1)
  assert.equal(crypto.unseal(row!.accessToken), 'rotated-access')
  assert.equal(crypto.unseal(row!.refreshToken), 'rotated-refresh')
  assert.ok(row!.expiresAt.getTime() > Date.now() + 3_000_000)
})

test('a lost rotation returns the winner token instead of overwriting it', async t => {
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>()
  t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return response.promise })
  row = stored('stale-access', 'stale-refresh', Date.now() - 1_000); writes = 0
  const pending = tokens.linearAccessToken(userId)
  await started.promise
  const winner = stored('winner-access', 'winner-refresh', Date.now() + 3_600_000)
  row = winner
  response.resolve(Response.json({ access_token: 'loser-access', refresh_token: 'loser-refresh', expires_in: 3_600 }))
  assert.equal(await pending, 'winner-access')
  assert.equal(writes, 0, 'a refresh that lost the rotation must not overwrite the stored pair')
  assert.equal(row!.accessToken, winner.accessToken); assert.equal(row!.refreshToken, winner.refreshToken)
})

test('a provider failure after another request rotated the same token returns that token', async t => {
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>()
  t.mock.method(globalThis, 'fetch', async () => { started.resolve(); return response.promise })
  row = stored('stale-access', 'stale-refresh', Date.now() - 1_000); writes = 0
  const pending = tokens.linearAccessToken(userId)
  await started.promise
  row = stored('winner-access', 'winner-refresh', Date.now() + 3_600_000)
  response.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }))
  assert.equal(await pending, 'winner-access')
  assert.equal(writes, 0)
})

test('a refresh that loses the race before the winner writes is retried, never failed permanently', async t => {
  // One user, one stored refresh token, two consumers that both read the expired
  // row (dispatch starts a worker per request). Linear rotates the token on first
  // use, so the second post is refused even though the credential is healthy.
  const winner = Promise.withResolvers<Response>(), refused = Promise.withResolvers<Response>()
  const bothSpent = Promise.withResolvers<void>()
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => {
    calls++
    if (calls === 2) bothSpent.resolve()
    return calls === 1 ? winner.promise : refused.promise
  })
  row = stored('stale-access', 'stale-refresh', Date.now() - 1_000); writes = 0
  const first = tokens.linearAccessToken(userId), second = tokens.linearAccessToken(userId)
  await bothSpent.promise
  assert.equal(writes, 0, 'both consumers read the expired row before either refresh settles')
  // The refusal lands while the winner is still waiting on the provider, so the
  // loser's re-read sees its own unchanged row and cannot yet tell why it failed.
  refused.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }))
  const refusal = await second.then((): unknown => undefined, (error: unknown) => error)
  assert.ok(refusal instanceof LinearApiError, 'a refresh that rotated nothing must not answer with a token')
  assert.equal(refusal.status, 400)
  assert.equal(refusal.retryable, true, 'losing the rotation must be retried, never recorded as a permanent failure')
  assert.equal(writes, 0)
  // Only now does the winner write: its pair is what the retry has to find.
  winner.resolve(Response.json({ access_token: 'winner-access', refresh_token: 'winner-refresh', expires_in: 3_600 }))
  assert.equal(await first, 'winner-access')
  assert.equal(writes, 1)
  assert.equal(await tokens.linearAccessToken(userId), 'winner-access')
  assert.equal(calls, 2, 'the retry uses the winner pair instead of spending the token again')
  assert.equal(writes, 1)
})

test('a failed refresh keeps the stored pair intact and reports the provider failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(`provider unreachable ${process.env.LINEAR_CLIENT_SECRET}`) })
  const original = stored('stale-access', 'stale-refresh', Date.now() - 1_000)
  row = original; writes = 0
  await assert.rejects(tokens.linearAccessToken(userId), (error: unknown) => {
    assert.ok(error instanceof LinearApiError); assert.equal(error.retryable, true)
    assert.equal(error.message.includes(`${process.env.LINEAR_CLIENT_SECRET}`), false)
    return true
  })
  assert.equal(writes, 0); assert.equal(row, original, 'a failed refresh must leave no half-written token')
})

test('a refresh refused for want of configuration is not read as a lost rotation', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => unexpected())
  row = stored('stale-access', 'stale-refresh', Date.now() - 1_000); writes = 0
  const clientId = process.env.LINEAR_CLIENT_ID
  delete process.env.LINEAR_CLIENT_ID
  try {
    await assert.rejects(tokens.linearAccessToken(userId), (error: unknown) => {
      assert.equal(error instanceof LinearApiError, false, 'only a provider refusal can be a lost rotation')
      return true
    })
  } finally { process.env.LINEAR_CLIENT_ID = clientId }
  assert.equal(fetch.mock.callCount(), 0); assert.equal(writes, 0)
})

test('a missing or revoked connection is refused before any provider traffic', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => unexpected())
  row = undefined
  await assert.rejects(tokens.linearAccessToken(userId), /Linear connection is unavailable/)
  row = { ...stored('stale-access', 'stale-refresh', Date.now() - 1_000), revokedAt: new Date() }
  await assert.rejects(tokens.linearAccessToken(userId), /Linear connection is unavailable/)
  assert.equal(fetch.mock.callCount(), 0); assert.equal(writes, 0)
})
