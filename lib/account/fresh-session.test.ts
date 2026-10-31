import assert from 'node:assert/strict'
import { betterAuth } from 'better-auth'
import { before, beforeEach, mock, test } from 'node:test'

// Real installed Better Auth resolves the configured freshAge; sessions here are
// explicit identity fixtures, not a claim of application sign-in acceptance.
const instance = betterAuth({ baseURL: 'http://127.0.0.1:3000', secret: 'test-only-fresh-session-secret-32-characters' })
let context: Awaited<typeof instance.$context>
let freshAge: number
let current: { user: { id: string }; session: { id: string; createdAt: Date | string | undefined; updatedAt: Date } } | null
const queries: unknown[] = []
let account: typeof import('./fresh-session')
before(async () => {
  context = await instance.$context
  freshAge = context.sessionConfig.freshAge
  mock.module('@/lib/auth', { namedExports: { auth: {
    get $context() { return Promise.resolve({ sessionConfig: { freshAge } }) },
    api: { getSession: async ({ query }: { query: unknown }) => { queries.push(query); return current } },
  } } })
  account = await import('./fresh-session')
})
beforeEach(() => { freshAge = context.sessionConfig.freshAge; current = { user: { id: 'owner' }, session: { id: 'server-session', createdAt: new Date(), updatedAt: new Date() } }; queries.length = 0 })
const headers = new Headers({ cookie: 'synthetic-signed-session' })
test('uses the resolved Better Auth default and bypasses both cookie cache and session refresh', async () => {
  assert.equal(context.sessionConfig.freshAge, 86400)
  assert.equal((await account.requireFreshAccountSession(headers)).user.id, 'owner')
  assert.deepEqual(queries, [{ disableCookieCache: true, disableRefresh: true }])
})
test('createdAt reaching freshAge is stale even when updatedAt is current', async () => {
  current!.session.createdAt = new Date(Date.now() - freshAge * 1000)
  await assert.rejects(account.requireFreshAccountSession(headers), (error: unknown) => error instanceof account.AccountAuthenticationError && error.code === 'SESSION_NOT_FRESH' && error.status === 403)
  current!.session.createdAt = new Date()
  assert.equal((await account.requireFreshAccountSession(headers)).user.id, 'owner')
})
test('honors a server freshAge override and Better Auth explicit zero opt-out without introducing another time limit', async () => {
  const custom = await betterAuth({ baseURL: 'http://127.0.0.1:3000', secret: 'test-only-fresh-session-secret-32-characters', session: { freshAge: 37 } }).$context
  freshAge = custom.sessionConfig.freshAge
  current!.session.createdAt = new Date(Date.now() - 38_000)
  await assert.rejects(account.requireFreshAccountSession(headers), /SESSION_NOT_FRESH/)
  freshAge = 0
  assert.equal((await account.requireFreshAccountSession(headers)).user.id, 'owner')
})
test('missing or malformed server session time cannot authorize deletion, and no session remains unauthorized', async () => {
  for (const createdAt of [undefined, 'invalid']) {
    current!.session.createdAt = createdAt
    await assert.rejects(account.requireFreshAccountSession(headers), /SESSION_NOT_FRESH/)
  }
  current = null
  await assert.rejects(account.requireFreshAccountSession(headers), (error: unknown) => error instanceof account.AccountAuthenticationError && error.code === 'authRequired' && error.status === 401)
})
