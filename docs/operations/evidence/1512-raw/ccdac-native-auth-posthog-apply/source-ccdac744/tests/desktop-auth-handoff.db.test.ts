// Signed-out desktop OAuth handoff (/begin -> /return -> /exchange) against a
// real PostgreSQL. The browser session and Better Auth token are stubbed.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, mock, test } from 'node:test'
import { NextResponse } from 'next/server'

const dbUrl = process.env.MIKKA_DATABASE_URL ?? process.env.DATABASE_URL
let sessionUser: string | null = null
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports } as never)
mock.module('next/headers', { namedExports: { headers: async () => new Headers() } } as never)
stub('../lib/request-log.ts', { noteLogRpcAction: () => {}, noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler })
stub('../lib/auth.ts', { auth: { api: {
  getSession: async () => sessionUser ? { user: { id: sessionUser } } : null,
  generateOneTimeToken: async () => ({ token: `ott-${randomBytes(12).toString('hex')}` }),
} } })

type Routes = { begin: (r: Request) => Promise<Response>; ret: (r: Request) => Promise<Response>; exchange: (r: Request) => Promise<Response> }
let routes: Routes
let users: string[] = []
const states: string[] = []
let pool: import('pg').Pool
const origin = 'https://app.example'
const callback = 'http://127.0.0.1:49152/auth/callback'
const b64 = (bytes: Buffer) => bytes.toString('base64url')

before(async () => {
  if (!dbUrl) return
  const { Pool } = await import('pg')
  pool = new Pool({ connectionString: dbUrl, max: 2 })
  for (const name of ['a', 'b']) {
    const id = `desktop-auth-${name}-${randomBytes(4).toString('hex')}`
    await pool.query('insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $1, $2, true, now(), now())', [id, `${id}@example.test`])
    users.push(id)
  }
  routes = {
    begin: (await import('../app/api/desktop/begin/route')).POST as Routes['begin'],
    ret: (await import('../app/api/desktop/return/route')).GET as Routes['ret'],
    exchange: (await import('../app/api/desktop/exchange/route')).POST as Routes['exchange'],
  }
})
after(async () => {
  if (!pool) return
  await pool.query('delete from desktop_auth_requests where "stateHash" = any($1)', [states])
  await pool.query('delete from "user" where id = any($1)', [users])
  await pool.end()
  const { pool: appPool } = await import('../lib/db')
  await appPool.end()
})

function pair() {
  const verifier = b64(randomBytes(32))
  const state = b64(randomBytes(24))
  states.push(createHash('sha256').update(state).digest('hex'))
  return { state, verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
const json = (path: string, body: unknown) => new Request(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
const returnURL = (state: string, cb = callback) => new Request(`${origin}/api/desktop/return?${new URLSearchParams({ state, next: '/', callback: cb })}`)

async function bind(state: string, user: string) {
  sessionUser = user
  const response = await routes.ret(returnURL(state))
  sessionUser = null
  return new URL(response.headers.get('location')!)
}

test('a signed-out desktop finishes sign-in and the code works once', { skip: !dbUrl }, async () => {
  const { state, verifier, challenge } = pair()
  sessionUser = null
  assert.equal((await routes.begin(json('/api/desktop/begin', { state, callback, challenge }))).status, 204)
  assert.equal((await routes.begin(json('/api/desktop/begin', { state, callback, challenge }))).status, 409, 'nonce is single-use')
  const location = await bind(state, users[0])
  assert.equal(location.origin + location.pathname, callback)
  assert.equal(location.searchParams.get('token'), null, 'the loopback never sees a sign-in token')
  const code = location.searchParams.get('code')!
  const first = await routes.exchange(json('/api/desktop/exchange', { state, code, verifier }))
  assert.equal(first.status, 200)
  assert.match((await first.json() as { token: string }).token, /^ott-/)
  assert.equal((await routes.exchange(json('/api/desktop/exchange', { state, code, verifier }))).status, 400, 'replay is rejected')
  const row = await pool.query('select "userId", token from desktop_auth_requests where "stateHash" = $1', [createHash('sha256').update(state).digest('hex')])
  assert.equal(row.rows[0].userId, users[0])
  assert.equal(row.rows[0].token, null, 'the parked token is cleared')
})

test('a wrong verifier burns the request', { skip: !dbUrl }, async () => {
  const { state, verifier, challenge } = pair()
  await routes.begin(json('/api/desktop/begin', { state, callback, challenge }))
  const code = (await bind(state, users[0])).searchParams.get('code')!
  assert.equal((await routes.exchange(json('/api/desktop/exchange', { state, code, verifier: b64(randomBytes(32)) }))).status, 400)
  const row = await pool.query('select "usedAt", token from desktop_auth_requests where "stateHash" = $1', [createHash('sha256').update(state).digest('hex')])
  assert.ok(row.rows[0].usedAt)
  assert.equal(row.rows[0].token, null, 'a failed attempt clears the token in the same consumption')
  assert.equal((await routes.exchange(json('/api/desktop/exchange', { state, code, verifier }))).status, 400)
})

test('two simultaneous exchanges on separate connections consume the row only once', { skip: !dbUrl, timeout: 20_000 }, async () => {
  const { state, verifier, challenge } = pair()
  await routes.begin(json('/api/desktop/begin', { state, callback, challenge }))
  const code = (await bind(state, users[0])).searchParams.get('code')!
  const { withDatabaseClient } = await import('../lib/db')
  const clients: import('pg').PoolClient[] = []
  let exchanges: Promise<Response>[] = []
  try {
    clients.push(await pool.connect())
    clients.push(await pool.connect())
    const pids = await Promise.all(clients.map(client => client.query('select pg_backend_pid() as pid')))
    assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid, 'the race uses two real PostgreSQL connections')
    await Promise.all(clients.map(client => client.query('begin')))
    await Promise.all(clients.map(client => client.query("set local statement_timeout = '10s'")))
    // A winner keeps its row lock until COMMIT. The other statement must then
    // recheck the updated row and reject, even if it began with an older snapshot.
    exchanges = clients.map(client => withDatabaseClient(client, () => routes.exchange(json('/api/desktop/exchange', { state, code, verifier }))))
    const winner = await Promise.race(exchanges.map(async (response, index) => ({ response: await response, index })))
    assert.equal(winner.response.status, 200)
    await clients[winner.index].query('commit')
    const responses = await Promise.all(exchanges)
    await clients[1 - winner.index].query('commit')
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 400])
    assert.match((await winner.response.json() as { token: string }).token, /^ott-/)
    const row = await clients[0].query('select "usedAt", token from desktop_auth_requests where "stateHash" = $1', [createHash('sha256').update(state).digest('hex')])
    assert.ok(row.rows[0].usedAt)
    assert.equal(row.rows[0].token, null)
  } finally {
    await Promise.allSettled(clients.map(client => client.query('rollback')))
    await Promise.allSettled(exchanges)
    for (const client of clients) client.release()
  }
})

test('exchange cannot consume an unbound or expired row', { skip: !dbUrl }, async () => {
  const unbound = pair()
  await routes.begin(json('/api/desktop/begin', { state: unbound.state, callback, challenge: unbound.challenge }))
  assert.equal((await routes.exchange(json('/api/desktop/exchange', { state: unbound.state, verifier: unbound.verifier, code: b64(randomBytes(32)) }))).status, 400)
  const unboundRow = await pool.query('select "usedAt", "boundAt", token from desktop_auth_requests where "stateHash" = $1', [createHash('sha256').update(unbound.state).digest('hex')])
  assert.deepEqual(unboundRow.rows[0], { usedAt: null, boundAt: null, token: null })

  const expired = pair()
  await routes.begin(json('/api/desktop/begin', { state: expired.state, callback, challenge: expired.challenge }))
  const code = (await bind(expired.state, users[0])).searchParams.get('code')!
  await pool.query('update desktop_auth_requests set "expiresAt" = now() - interval \'1 second\' where "stateHash" = $1', [createHash('sha256').update(expired.state).digest('hex')])
  assert.equal((await routes.exchange(json('/api/desktop/exchange', { state: expired.state, verifier: expired.verifier, code }))).status, 400)
  const expiredRow = await pool.query('select "usedAt" from desktop_auth_requests where "stateHash" = $1', [createHash('sha256').update(expired.state).digest('hex')])
  assert.equal(expiredRow.rows[0].usedAt, null)
})

test('used rows and token-less rows cannot redeem a handoff', { skip: !dbUrl }, async () => {
  for (const used of [true, false]) {
    const { state, verifier, challenge } = pair()
    await routes.begin(json('/api/desktop/begin', { state, callback, challenge }))
    const code = (await bind(state, users[0])).searchParams.get('code')!
    const stateHash = createHash('sha256').update(state).digest('hex')
    await pool.query(used
      ? 'update desktop_auth_requests set "usedAt" = now() where "stateHash" = $1'
      : 'update desktop_auth_requests set token = null where "stateHash" = $1', [stateHash])
    assert.equal((await routes.exchange(json('/api/desktop/exchange', { state, code, verifier }))).status, 400)
    const row = await pool.query('select "usedAt", token from desktop_auth_requests where "stateHash" = $1', [stateHash])
    assert.ok(row.rows[0].usedAt, 'a bound token-less request still burns its first attempt')
    if (!used) assert.equal(row.rows[0].token, null)
  }
})

test('a second browser cannot rebind, and a different callback is refused', { skip: !dbUrl }, async () => {
  const { state, challenge } = pair()
  await routes.begin(json('/api/desktop/begin', { state, callback, challenge }))
  sessionUser = users[1]
  const wrongCallback = new URL((await routes.ret(returnURL(state, 'http://127.0.0.1:50000/auth/callback'))).headers.get('location')!)
  assert.equal(wrongCallback.searchParams.get('oauth'), 'failed')
  sessionUser = null
  assert.ok((await bind(state, users[0])).searchParams.get('code'))
  assert.equal((await bind(state, users[1])).searchParams.get('oauth'), 'failed')
})

test('return without a browser session fails, expired requests fail', { skip: !dbUrl }, async () => {
  const { state, challenge } = pair()
  await routes.begin(json('/api/desktop/begin', { state, callback, challenge }))
  sessionUser = null
  assert.equal(new URL((await routes.ret(returnURL(state))).headers.get('location')!).searchParams.get('oauth'), 'failed')
  await pool.query('update desktop_auth_requests set "expiresAt" = now() - interval \'1 second\' where "stateHash" = $1', [createHash('sha256').update(state).digest('hex')])
  assert.equal((await bind(state, users[0])).searchParams.get('oauth'), 'failed')
})

test('begin rejects a missing challenge and a foreign origin', { skip: !dbUrl }, async () => {
  const { state } = pair()
  assert.equal((await routes.begin(json('/api/desktop/begin', { state, callback }))).status, 400)
  const foreign = new Request(`${origin}/api/desktop/begin`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })
  assert.equal((await routes.begin(foreign)).status, 403)
  void NextResponse
})
