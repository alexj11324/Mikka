import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before, mock } from 'node:test'
import { Pool } from 'pg'

// Goes through the real app/api/conversations/[id]/read/route.ts. Only the
// session lookup and the db module (for the pool) are stubbed; the pool is dev-local
// when reachable (the 200 cases need it), so 401/403 run anywhere.
// Run with --experimental-test-module-mocks.

let sessionUser: string | null = null
let pool: Pool | null = null
let skipReason = 'MIKKA_DATABASE_URL not set (run via ~/.mikka/local-run.sh)'
let route: typeof import('../app/api/conversations/[id]/read/route')
const stubPool = { query: async () => { throw new Error('no database in this test run') } }

before(async () => {
  const url = process.env.MIKKA_DATABASE_URL
  if (url) {
    const candidate = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000 })
    try {
      const { rows } = await candidate.query("select to_regclass('conversation_reads') is not null as ok")
      if (rows[0]?.ok) pool = candidate
      else { skipReason = 'conversation_reads missing: run scripts/migrate.mjs'; await candidate.end() }
    } catch (error) {
      skipReason = `database unreachable (${(error as Error).message})`
      await candidate.end().catch(() => {})
    }
  }
  if (!pool && process.env.CONVERSATION_READS_REQUIRE_DB === '1') throw new Error('Required ephemeral read-route database unavailable')
  mock.module(new URL('./auth.ts', import.meta.url).href, {
    namedExports: { auth: { api: { getSession: async () => (sessionUser ? { user: { id: sessionUser } } : null) } } },
  })
  mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { pool: pool ?? stubPool, db: null } })
  route = await import('../app/api/conversations/[id]/read/route')
})

const params = { params: Promise.resolve({ id: 'coordinator' }) }
const call = (method: 'GET' | 'POST', headers: Record<string, string>, body?: string) =>
  route[method](new Request('http://internal:3000/api/conversations/coordinator/read', method === 'POST' ? { method, headers, body } : { method, headers }), params)

after(async () => { await pool?.end() })

test('route: no session → 401', async () => {
  sessionUser = null
  assert.equal((await call('GET', {})).status, 401)
  assert.equal((await call('POST', { 'content-type': 'text/plain' }, '{"messageId":"1"}')).status, 401)
})

test('route: cross-site Origin against x-forwarded-host → 403', async () => {
  sessionUser = `test-route-${randomUUID()}`
  const headers = { host: 'internal:3000', 'x-forwarded-host': 'mikka.app, internal:3000', origin: 'https://evil.example' }
  assert.equal((await call('GET', headers)).status, 403)
  assert.equal((await call('POST', headers, '{"messageId":"1"}')).status, 403)
  // Origin matching only the internal Host, not the forwarded one, is cross-site too.
  assert.equal((await call('GET', { ...headers, origin: 'http://internal:3000' })).status, 403)
})

test('route: same-origin via x-forwarded-host → 200; missing Origin → 200', async t => {
  if (!pool) return t.skip(skipReason)
  sessionUser = `test-route-${randomUUID()}`
  const ok = await call('GET', { host: 'internal:3000', 'x-forwarded-host': 'mikka.app, internal:3000', origin: 'https://mikka.app' })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { lastReadMessageId: null, lastReadPosition: null, unreadCount: 0 })
  assert.equal((await call('GET', { host: 'internal:3000' })).status, 200)
  // text/plain beacon body reaches the JSON parser: unknown position → 422, not 400/415.
  assert.equal((await call('POST', { host: 'internal:3000', 'content-type': 'text/plain' }, '{"messageId":"1"}')).status, 422)
})
