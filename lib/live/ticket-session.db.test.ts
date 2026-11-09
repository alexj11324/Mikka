import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { readHomeScopeProof } from './home-scope-proof'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) {
  assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')
  assert.equal(process.env.MIKKA_DATABASE_URL, url)
  assert.equal(process.env.DATABASE_URL, url)
  if (process.env.ORVILO_DATABASE_URL) assert.equal(process.env.ORVILO_DATABASE_URL, url)
}

test('real tickets project only the active owned personal home and recheck a revoked Better Auth session', { skip: !url, timeout: 120_000 }, async () => {
  const database = new Pool({ connectionString: url, max: 4 })
  let handle!: (request: Request) => Promise<Response>
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value)
      const result = await handle(new Request(`http://${request.headers.host}${request.url}`, { method: request.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }))
      response.writeHead(result.status, { ...Object.fromEntries([...result.headers].filter(([name]) => name !== 'set-cookie')), 'set-cookie': result.headers.getSetCookie() })
      response.end(Buffer.from(await result.arrayBuffer()))
    } catch { response.writeHead(500); response.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const workspaceId = randomUUID(), homeWorkspaceId = randomUUID(), foreignWorkspaceId = randomUUID()
  const foreignOwner = `live-ticket-foreign-${randomUUID()}`
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  let userId: string | undefined
  const mocks: { restore(): void }[] = []
  try {
    const [{ betterAuth }, fresh] = await Promise.all([import('better-auth'), import('../fresh-session')])
    const auth = betterAuth({ baseURL: origin, basePath: '/mikka/api/auth', database, secret: randomBytes(32).toString('hex'),
      advanced: { database: { validateSchema: false } },
      emailAndPassword: { enabled: true }, trustedOrigins: [origin], logger: { disabled: true }, session: fresh.SESSION_OPTIONS })
    assert.equal((await auth.$context).checkSchema, undefined, 'the auth fixture uses the production schema validation policy')
    fresh.readFreshSessionsInScope(auth.api)
    mocks.push(mock.module(new URL('../api-auth.ts', import.meta.url).href, { namedExports: { auth } }))
    mocks.push(mock.module(new URL('../request-log.ts', import.meta.url).href, { namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_name: string, route: (request: Request) => Promise<Response>) => route } }))
    const { GET } = await import('../../app/api/live/ticket/route')
    handle = request => new URL(request.url).pathname.includes('/api/auth/') ? auth.handler(request) : GET(request)
    process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
    process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-real-session-ticket-secret'
    const email = `live-ticket-${randomUUID()}@example.invalid`, password = `fixture-${randomBytes(24).toString('hex')}`
    const signup = await fetch(`${origin}/mikka/api/auth/sign-up/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Live Ticket Fixture', email, password }) })
    assert.equal(signup.status, 200)
    userId = (await signup.json()).user.id
    const signin = await fetch(`${origin}/mikka/api/auth/sign-in/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    assert.equal(signin.status, 200)
    const cookies = signin.headers.getSetCookie()
    assert.ok(cookies.some(cookie => cookie.split('=')[0].endsWith('session_data')), 'the real signed session cache cookie was issued')
    const headers = { cookie: cookies.map(cookie => cookie.split(';')[0]).join('; ') }
    await database.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES ($1,$2,'Live ticket fixture')`, [workspaceId, userId])
    await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Fixture',$3,'admin')`, [workspaceId, userId, email])
    const ticket = (selectedWorkspaceId = workspaceId) => fetch(`${origin}/mikka/api/live/ticket?workspace=${selectedWorkspaceId}`, { headers })
    const issued = await ticket()
    assert.equal(issued.status, 200)
    const team = await issued.json()
    assert.equal(typeof team.protocol, 'string')
    assert.equal(team.homeScope, undefined, 'team membership alone cannot attest the personal home')
    await database.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Foreign fixture',$2,true,now(),now())`, [foreignOwner, `${foreignOwner}@example.invalid`])
    await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,$2,'Foreign personal fixture','personal'),($3,$4,'Owned personal fixture','personal')`, [foreignWorkspaceId, foreignOwner, homeWorkspaceId, userId])
    await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES ($1,$2,'Foreign fixture',$3,'admin'),($4,$5,'Fixture',$6,'admin')`, [foreignWorkspaceId, foreignOwner, `${foreignOwner}@example.invalid`, homeWorkspaceId, userId, email])
    await assert.rejects(database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES ($1,$2,'Forged peer',$3,'member')`, [foreignWorkspaceId, userId, email]), { code: '23514' }, 'Personal cannot admit another user even through direct SQL')
    const foreign = await ticket(foreignWorkspaceId)
    assert.equal(foreign.status, 403, 'another owner\'s Personal Workspace cannot issue a ticket')
    assert.equal((await foreign.json()).error, 'workspaceAccessDenied')
    const home = await (await ticket(homeWorkspaceId)).json()
    assert.equal(home.homeScope.expiresAt, home.expiresAt)
    assert.deepEqual(readHomeScopeProof(home.homeScope.token, userId!, process.env.DEVICE_GATEWAY_PUSH_SECRET), {
      ownerId: userId, workspaceId: homeWorkspaceId, expiresAt: home.expiresAt,
    }, 'the real membership statement projects the actual owned personal workspace')
    await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspaceId, userId])
    assert.equal((await ticket()).status, 403, 'the existing active-member gate remains fresh')
    await database.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspaceId, userId])
    await database.query('DELETE FROM session WHERE "userId"=$1', [userId])
    const cached = await fetch(`${origin}/mikka/api/auth/get-session`, { headers })
    assert.equal((await cached.json()).user.id, userId, 'the ordinary 5-minute cache still sees the revoked session')
    const refused = await ticket(homeWorkspaceId)
    assert.equal(refused.status, 401, 'minting another capability must read the revoked session from PostgreSQL')
    const body = await refused.json()
    assert.equal(body.error, 'authRequired')
    assert.equal(body.protocol, undefined)
    assert.equal(body.url, undefined)
    assert.equal(body.homeScope, undefined)
  } finally {
    for (const item of mocks) item.restore()
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    await database.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[workspaceId, homeWorkspaceId, foreignWorkspaceId]])
    await database.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[workspaceId, homeWorkspaceId, foreignWorkspaceId]])
    if (userId) await database.query('DELETE FROM "user" WHERE id=$1', [userId])
    await database.query('DELETE FROM "user" WHERE id=$1', [foreignOwner])
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('../db'), import('../workspace-db')])
    await Promise.all([database.end(), appPool.end(), workspacePool.end()])
  }
})
