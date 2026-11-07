import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import type { ComputerEventPage } from './event-page'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('computer events authorize real sessions and read bounded owner/workspace pages from PostgreSQL', { skip: !url, timeout: 120_000 }, async t => {
  const database = new Pool({ connectionString: url, max: 4 })
  const workspaceId = randomUUID(), otherWorkspaceId = randomUUID(), restrictedWorkspaceId = randomUUID()
  const workspaceIds = [workspaceId, otherWorkspaceId, restrictedWorkspaceId]
  const userIds: string[] = []
  const mocks: { restore(): void }[] = []
  const origin = 'http://127.0.0.1:3030'
  try {
    const [{ betterAuth }, fresh] = await Promise.all([import('better-auth'), import('../fresh-session')])
    const auth = betterAuth({
      baseURL: origin, basePath: '/mikka/api/auth', database, secret: randomBytes(32).toString('hex'),
      emailAndPassword: { enabled: true }, trustedOrigins: [origin], logger: { disabled: true }, session: fresh.SESSION_OPTIONS,
    })
    fresh.readFreshSessionsInScope(auth.api)
    // Only inject the isolated dependencies. Session verification, signed cache
    // cookies, membership SQL and event reads all use their real implementations.
    mocks.push(mock.module(new URL('../api-auth.ts', import.meta.url).href, { namedExports: { auth } }))
    mocks.push(mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: database } }))
    mocks.push(mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: { workspacePool: database } }))
    mocks.push(mock.module(new URL('../request-log.ts', import.meta.url).href, {
      namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_name: string, route: (request: Request) => Promise<Response>) => route },
    }))
    const { GET } = await import('../../app/api/computer/events/route')

    const register = async (name: string) => {
      const email = `computer-events-${randomUUID()}@example.invalid`
      const password = `fixture-${randomBytes(24).toString('hex')}`
      const post = (path: string, body: object) => auth.handler(new Request(`${origin}/mikka/api/auth/${path}`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }))
      const signup = await post('sign-up/email', { name, email, password })
      assert.equal(signup.status, 200)
      const id = (await signup.json()).user.id as string
      userIds.push(id)
      const signin = await post('sign-in/email', { email, password })
      assert.equal(signin.status, 200)
      const cookies = signin.headers.getSetCookie()
      assert.ok(cookies.some(cookie => cookie.split('=')[0].endsWith('session_data')), 'real signed session cache cookie issued')
      return { id, email, headers: { cookie: cookies.map(cookie => cookie.split(';')[0]).join('; ') } }
    }
    const alice = await register('Computer Events Alice'), bob = await register('Computer Events Bob')
    await database.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES
      ($1,$4,'Computer events fixture'),($2,$4,'Other workspace fixture'),($3,$5,'Restricted fixture')`,
    [workspaceId, otherWorkspaceId, restrictedWorkspaceId, alice.id, bob.id])
    const addMember = (space: string, person: typeof alice) => database.query(
      `INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,'Event fixture',$3,'admin','active')`,
      [space, person.id, person.email],
    )
    await addMember(workspaceId, alice); await addMember(workspaceId, bob)
    await addMember(otherWorkspaceId, alice); await addMember(restrictedWorkspaceId, bob)

    const stream = async (space: string, ownerId: string) => {
      const botId = randomUUID(), subagentId = randomUUID()
      await database.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,\'Event fixture\')', [botId, space, ownerId])
      await database.query(`INSERT INTO bot_subagents(id,"workspaceId","ownerId","botId",task,status)
        VALUES($1,$2,$3,$4,'Read fixture source','needs_you')`, [subagentId, space, ownerId, botId])
      return async (label: string) => {
        const data = { botId, subagentId, task: label, state: 'needs_you', step: 'Review fixture', needs: null }
        const result = await database.query(`INSERT INTO subagent_events("ownerId","workspaceId","botId","subagentId",event)
          VALUES($1,$2,$3,$4,$5) RETURNING seq`, [ownerId, space, botId, subagentId, { type: 'data-subagent', data }])
        return { id: String(result.rows[0].seq), data }
      }
    }
    const own = await stream(workspaceId, alice.id), peer = await stream(workspaceId, bob.id), elsewhere = await stream(otherWorkspaceId, alice.id)
    const expected: ComputerEventPage['events'] = []
    for (let index = 0; index < 50; index++) expected.push(await own(`Alice event ${index}`))
    const peerEvent = await peer('Bob private event'), elsewhereEvent = await elsewhere('Other workspace event')
    for (let index = 50; index < 103; index++) expected.push(await own(`Alice event ${index}`))

    const request = (person: typeof alice | undefined, space: string = workspaceId, after = '0', extraHeaders = {}) => GET(new Request(
      `${origin}/mikka/api/computer/events?${new URLSearchParams({ workspace: space, after })}`,
      { headers: { ...person?.headers, ...extraHeaders } },
    ))
    const denied = async (response: Response, status: number) => {
      assert.equal(response.status, status)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(await response.text(), '', 'a rejected read discloses no event body')
    }
    const page = async (response: Response) => {
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.match(response.headers.get('content-type') ?? '', /application\/json/)
      return await response.json() as ComputerEventPage
    }

    await t.test('missing session is rejected', async () => {
      await denied(await request(undefined), 401)
    })
    await t.test('Bearer plus a valid cookie is rejected instead of changing authority', async () => {
      await denied(await request(alice, workspaceId, '0', { authorization: 'Bearer fixture-invalid' }), 401)
      await denied(await request(alice, workspaceId, '0', { authorization: '' }), 401)
    })
    await t.test('invalid cursor and workspace fail before any event page is exposed', async () => {
      for (const cursor of ['', '-1', '01', '1.5', '1e3', ' 1', '9223372036854775808']) {
        await denied(await request(alice, workspaceId, cursor), 400)
      }
      await denied(await request(alice, ''), 400)
      await denied(await request(alice, 'not-a-workspace'), 400)
      const upper = await page(await request(alice, workspaceId, '9223372036854775807'))
      assert.deepEqual(upper, { events: [], cursor: '9223372036854775807', hasMore: false })
    })
    await t.test('a valid session cannot read a workspace without membership', async () => {
      await denied(await request(alice, restrictedWorkspaceId), 403)
    })
    await t.test('deleting a membership immediately revokes the same cached session read', async () => {
      await database.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, alice.id])
      try { await denied(await request(alice), 403) } finally { await addMember(workspaceId, alice) }
    })
    await t.test('same-workspace owners and the same owner in another workspace remain isolated', async () => {
      assert.deepEqual((await page(await request(bob))).events, [peerEvent])
      assert.deepEqual((await page(await request(alice, otherWorkspaceId))).events, [elsewhereEvent])
      assert.deepEqual((await page(await request(alice))).events, expected.slice(0, 100))
    })
    await t.test('100-row pages resume exclusively after the last visible event without losing global-sequence gaps', async () => {
      const first = await page(await request(alice))
      assert.deepEqual(first, { events: expected.slice(0, 100), cursor: expected[99].id, hasMore: true })
      const second = await page(await request(alice, workspaceId, first.cursor))
      assert.deepEqual(second, { events: expected.slice(100), cursor: expected[102].id, hasMore: false })
      assert.deepEqual(await page(await request(alice, workspaceId, second.cursor)), { events: [], cursor: second.cursor, hasMore: false })
    })
    await t.test('revoked database sessions cannot read through a still-valid signed cache cookie', async () => {
      await database.query('DELETE FROM session WHERE "userId"=$1', [alice.id])
      const cached = await auth.handler(new Request(`${origin}/mikka/api/auth/get-session`, { headers: alice.headers }))
      assert.equal(cached.status, 200)
      assert.equal((await cached.json()).user.id, alice.id, 'ordinary cached reads still accept the real signed cookie')
      await denied(await request(alice), 401)
      assert.deepEqual((await page(await request(bob))).events, [peerEvent], 'revoking Alice does not revoke another owner')
    })
  } finally {
    for (const item of mocks) item.restore()
    await database.query('DELETE FROM bots WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
    await database.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
    await database.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
    if (userIds.length) await database.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [userIds])
    await database.end()
  }
})
