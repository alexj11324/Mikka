import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'

// Real Next HTTP + Better Auth + PostgreSQL; all records are synthetic and retained.
const target = process.env.E2E_DATABASE_URL
if (!target || !['127.0.0.1', 'localhost'].includes(new URL(target).hostname) || new URL(target).pathname !== '/mikka_e2e') throw new Error('Site search requires isolated mikka_e2e')
const pool = new Pool({ connectionString: target, max: 2 })
const workspaceTarget = process.env.SITE_SEARCH_WORKSPACE_DATABASE_URL ?? target
const workspaceURL = new URL(workspaceTarget)
if (!['127.0.0.1', 'localhost'].includes(workspaceURL.hostname) || !['/mikka_e2e', '/mikka_workspace_e2e'].includes(workspaceURL.pathname)) throw new Error('Workspace fixtures require isolated loopback PG')
if (process.env.SITE_SEARCH_REQUIRE_DUAL_PG === '1' && (workspaceTarget === target || workspaceURL.port === new URL(target).port || workspaceURL.pathname !== '/mikka_workspace_e2e' || process.env.DATABASE_URL !== workspaceTarget)) throw new Error('Dedicated search CI must use distinct application/workspace PG services')
const workspacePool = new Pool({ connectionString: workspaceTarget, max: 2 })
let databaseIdentity: unknown
let nextProcess: ChildProcess | undefined
const sockets = new Set<Socket>()
type Gate = { released?: boolean; captured: boolean; ids: string[]; frames: Buffer[]; socket?: Socket }
let gate: Gate | undefined
// Delay a real PG result after its SQL snapshot has already passed the ACL.
// Match its RowDescription (id/title/to_char), never auth responses. No SQL/data mocks.
const proxy = createServer(client => {
  sockets.add(client)
  const appURL = new URL(target!)
  const upstream = createConnection({ host: appURL.hostname, port: Number(appURL.port) })
  sockets.add(upstream)
  let buffered = Buffer.alloc(0)
  let held: Gate | undefined
  client.pipe(upstream)
  upstream.on('data', chunk => {
    buffered = Buffer.concat([buffered, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
    while (buffered.length >= 5) {
      const length = buffered.readInt32BE(1) + 1
      if (buffered.length < length) break
      const frame = buffered.subarray(0, length)
      buffered = buffered.subarray(length)
      const type = String.fromCharCode(frame[0])
      if (type === 'T' && gate && !gate.socket) {
        let offset = 7
        const fields: string[] = []
        for (let i = 0; i < frame.readInt16BE(5); i++) {
          const end = frame.indexOf(0, offset)
          fields.push(frame.toString('utf8', offset, end))
          offset = end + 19
        }
        if (fields.join(',') === 'id,title,to_char') { held = gate; held.socket = client }
      }
      if (held && !held.released) {
        held.frames.push(frame)
        if (type === 'D') held.ids.push(frame.toString('utf8', 11, 11 + frame.readInt32BE(7)))
        if (type === 'Z') { held.captured = true; held = undefined }
      } else { client.write(frame); if (type === 'Z') held = undefined }
    }
  })
  for (const socket of [client, upstream]) {
    socket.on('error', () => { client.destroy(); upstream.destroy() })
    socket.on('close', () => { sockets.delete(socket); if (socket === client) upstream.destroy(); else client.destroy() })
  }
})
function releaseGate() {
  if (!gate) return
  gate.released = true
  for (const frame of gate.frames) gate.socket?.write(frame)
  gate = undefined
}
async function startIsolatedNext() {
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (!address || typeof address === 'string') throw new Error('PG proxy did not bind')
  const proxiedURL = new URL(target!)
  proxiedURL.port = String(address.port)
  nextProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3210'], {
    env: { ...process.env, MIKKA_DATABASE_URL: proxiedURL.href, DATABASE_URL: workspaceTarget, BETTER_AUTH_URL: 'http://127.0.0.1:3210' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  // Keep logs bounded; they contain only synthetic runtime failures in this isolated process.
  let stderr = ''
  nextProcess.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
  await expect.poll(async () => {
    if (nextProcess?.exitCode !== null) throw new Error(`Search Next exited: ${stderr}`)
    return fetch('http://127.0.0.1:3210/mikka/api/search?source=history').then(response => response.status).catch(() => 0)
  }, { timeout: 45000 }).toBe(401)
}
const owner = `site-search-${randomUUID()}`, outsider = `site-search-${randomUUID()}`
const workspace = randomUUID(), otherWorkspace = randomUUID(), sessionId = randomUUID(), token = randomUUID()
const secret = process.env.BETTER_AUTH_SECRET
if (!secret) throw new Error('Synthetic auth secret required')
const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', secret).update(token).digest('base64')}`)}`
const prefix = `title-${randomUUID()}`
const archivedId = randomUUID(), foreignToken = randomUUID()
const foreignCookie = `better-auth.session_token=${encodeURIComponent(`${foreignToken}.${createHmac('sha256', secret).update(foreignToken).digest('base64')}`)}`
const archivedCompletion = 'root = TextContent("synthetic retained archive body")'
let groupIds: string[] = []
async function get(request: APIRequestContext, params: Record<string, string>, authenticated = true) {
  const response = await request.get(`http://127.0.0.1:3210/mikka/api/search?${new URLSearchParams(params)}`, { headers: authenticated ? { cookie } : {} })
  expect(response.headers()['cache-control']).toBe('private, no-store')
  return { response, body: await response.json() }
}

test.beforeAll(async () => {
  const appIdentity = await pool.query('select current_database() name, pg_postmaster_start_time() started')
  const workspaceIdentity = await workspacePool.query('select current_database() name, pg_postmaster_start_time() started')
  databaseIdentity = { application: appIdentity.rows[0], workspace: workspaceIdentity.rows[0], distinctServices: new URL(target!).port !== workspaceURL.port }
  if (process.env.SITE_SEARCH_REQUIRE_DUAL_PG === '1') {
    expect(appIdentity.rows[0].name).toBe('mikka_e2e')
    expect(workspaceIdentity.rows[0].name).toBe('mikka_workspace_e2e')
  }
  console.log('search131 database identity:', JSON.stringify(databaseIdentity))
  await startIsolatedNext()
  for (const id of [owner, outsider]) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
  await pool.query('insert into session (id,token,"userId","expiresAt","createdAt","updatedAt") values ($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, token, owner])
  await pool.query('insert into session (id,token,"userId","expiresAt","createdAt","updatedAt") values ($1,$2,$3,now()+interval \'1 hour\',now(),now())', [randomUUID(), foreignToken, outsider])
  for (const [id, user] of [[workspace, owner], [otherWorkspace, outsider]]) {
    await workspacePool.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,\'Synthetic search\')', [id, user])
    await workspacePool.query('insert into mikka_workspace_members ("workspaceId","userId",email,name,role,status) values ($1,$2,$3,$2,\'admin\',\'active\')', [id, user, `${user}@example.invalid`])
  }
  await pool.query('insert into agent_sessions (id,"userId",title,"updatedAt") values ($1,$2,$3,\'1999-01-01T00:00:00Z\')', [archivedId, owner, `${prefix}-archive-locator`])
  await pool.query('insert into agent_turns (id,"sessionId","userId",prompt,completion,status,"attemptId") values ($1,$2,$3,\'synthetic archived question\',$4,\'complete\',$5)', [randomUUID(), archivedId, owner, archivedCompletion, randomUUID()])
  // Recent nonmatches and hidden matches cannot consume the page's visible LIMIT.
  for (const user of [owner, outsider]) await pool.query(`insert into agent_sessions (id,"userId",title,"updatedAt") select gen_random_uuid(),$1,$2||g,'2020-01-01T00:00:00.123456Z'::timestamptz + g * interval '1 microsecond' from generate_series(1,130) g`, [user, `${prefix}-history-`])
  await pool.query(`insert into agent_sessions (id,"userId",title,"updatedAt") select gen_random_uuid(),$1,'recent unrelated',now() from generate_series(1,130)`, [owner])
  await pool.query('insert into agent_sessions (id,"userId",title) values ($1,$2,$3)', [randomUUID(), owner, `${prefix} 50%_off`])
  const groups = await pool.query(`insert into conversations (id,"workspaceId",kind,title,"createdBy","createdAt") select gen_random_uuid(),$1,'group',$2||g,$3,'2020-01-01T00:00:00.123456Z'::timestamptz + g * interval '1 microsecond' from generate_series(1,125) g returning id`, [workspace, `${prefix}-group-`, owner])
  groupIds = groups.rows.map(row => row.id)
  await pool.query('insert into conversation_members ("conversationId","memberType","memberId",role) select unnest($1::uuid[]),\'user\',$2,\'member\'', [groupIds, owner])
  for (const [kind, w, member] of [['agent_dm', workspace, true], ['group', otherWorkspace, true], ['group', workspace, false]] as const) {
    const id = randomUUID()
    await pool.query('insert into conversations (id,"workspaceId",kind,title,"createdBy") values ($1,$2,$3,$4,$5)', [id, w, kind, `${prefix}-group-private`, outsider])
    if (member) await pool.query('insert into conversation_members ("conversationId","memberType","memberId",role) values ($1,\'user\',$2,\'member\')', [id, owner])
  }
  for (const suffix of ['page', 'peek']) {
    const rows = await pool.query(`insert into conversations (id,"workspaceId",kind,title,"createdBy") select gen_random_uuid(),$1,'group',$2,$3 from generate_series(1,2) returning id`, [workspace, `${prefix}-race-${suffix}`, owner])
    await pool.query('insert into conversation_members ("conversationId","memberType","memberId",role) select unnest($1::uuid[]),\'user\',$2,\'member\'', [rows.rows.map(row => row.id), owner])
  }
  const foreignTeam = randomUUID(), ownedLinkedTask = randomUUID()
  await workspacePool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Synthetic foreign team\',\'S131\')', [foreignTeam, otherWorkspace, outsider])
  await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,$3,$4,\'todo\',\'none\',\'workspace\')', [ownedLinkedTask, owner, `${prefix}-owner-policy`, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 132 } } })])
  await workspacePool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [ownedLinkedTask, foreignTeam, otherWorkspace, owner])
  // Neither body nor prompt is a searchable source, even in an accessible container.
  await pool.query('insert into conversation_messages (id,"conversationId",position,"authorType","authorId",body) values ($1,$2,1,\'user\',$3,$4)', [randomUUID(), groupIds[0], owner, `${prefix}-body-secret`])
  const history = randomUUID()
  await pool.query('insert into agent_sessions (id,"userId",title) values ($1,$2,\'unrelated title\')', [history, owner])
  await pool.query('insert into agent_turns (id,"sessionId","userId",prompt,completion,status,"attemptId") values ($1,$2,$3,$4,$4,\'complete\',$5)', [randomUUID(), history, owner, `${prefix}-body-secret`, randomUUID()])
  for (const user of [owner, outsider]) await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,$3,$4,\'todo\',\'none\',\'personal\')', [randomUUID(), user, `${prefix}-task`, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 131 } } })])
  if (process.env.SITE_SEARCH_REQUIRE_DUAL_PG === '1') {
    expect((await pool.query('select count(*)::int n from mikka_workspace_members where "userId"=$1', [owner])).rows[0].n).toBe(0)
    expect((await workspacePool.query('select count(*)::int n from agent_sessions where "userId"=$1', [owner])).rows[0].n).toBe(0)
    expect((await workspacePool.query('select count(*)::int n from issues where "userId"=$1', [owner])).rows[0].n).toBe(0)
    console.log('search131 placement: memberships only in workspace PG; task/history rows only in application PG')
  }
})
test.afterAll(async () => {
  try {
    const history = await pool.query('select id,"userId",title,"updatedAt" from agent_sessions where "userId"=any($1::text[])', [[owner, outsider]])
    const groups = await pool.query('select id,"workspaceId",kind,title,"createdBy","createdAt" from conversations where "createdBy"=any($1::text[])', [[owner, outsider]])
    const memberships = await pool.query('select "conversationId","memberType","memberId",role,"leftAt" from conversation_members where "memberId"=$1', [owner])
    const workspaces = await workspacePool.query('select "workspaceId","userId",status from mikka_workspace_members where "userId"=any($1::text[])', [[owner, outsider]])
    const tasks = await pool.query('select id,"userId",title,status,scope from issues where "userId"=any($1::text[])', [[owner, outsider]])
    const retainedSession = await pool.query('select id from session where id=$1', [sessionId])
    await mkdir('test-results', { recursive: true })
    // Retain only synthetic source rows and IDs; never export auth tokens/cookies.
    await writeFile('test-results/site-search-fixtures.json', JSON.stringify({ sha: process.env.GITHUB_SHA, databaseIdentity, owner, outsider, history: history.rows, groups: groups.rows, memberships: memberships.rows, workspaces: workspaces.rows, tasks: tasks.rows, retainedSession: retainedSession.rows }, null, 2))
  } finally {
    releaseGate()
    if (nextProcess && nextProcess.exitCode === null) {
      const exited = new Promise<void>(resolve => nextProcess!.once('exit', () => resolve()))
      nextProcess.kill('SIGTERM')
      await exited
    }
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    await Promise.all([pool.end(), workspacePool.end()])
  }
})

test('owner titles and authorized group titles page beyond 100 with exact projections', async ({ request }) => {
  for (const [source, count, q] of [['history', 130, `${prefix}-history-`], ['groups', 125, `${prefix}-group-`]] as const) {
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const { response, body } = await get(request, { source, q, limit: '17', ...(source === 'groups' ? { workspaceId: workspace } : {}), ...(cursor ? { cursor } : {}) })
      expect(response.status()).toBe(200)
      expect(body.source).toBe(source)
      for (const row of body.items) {
        expect(seen.has(row.id)).toBe(false)
        seen.add(row.id)
        expect(Object.keys(row).sort()).toEqual((source === 'history' ? ['id', 'title', 'timestamp', 'type', 'scope'] : ['id', 'title', 'timestamp', 'type', 'workspaceId']).sort())
        expect(row.timestamp).toMatch(/\.\d{6}Z$/)
      }
      cursor = body.nextCursor
    } while (cursor)
    expect(seen.size).toBe(count)
  }
  const literal = await get(request, { source: 'history', q: '50%_off' })
  expect(literal.body.items).toHaveLength(1)
  for (const source of ['history', 'groups']) expect((await get(request, { source, q: `${prefix}-body-secret`, ...(source === 'groups' ? { workspaceId: workspace } : {}) })).body.items).toEqual([])
  const task = await get(request, { source: 'tasks', q: `${prefix}-task`, workspaceId: workspace })
  expect(task.response.status()).toBe(200)
  expect(task.body.items).toHaveLength(1)
  expect(task.body.items[0].type).toBe('task')
})

test('auth, unsupported sources, invalid input and workspace existence share private responses', async ({ request }) => {
  expect((await get(request, { source: 'history' }, false)).response.status()).toBe(401)
  for (const source of ['agents', 'knowledge']) expect((await get(request, { source })).response.status()).toBe(422)
  for (const params of [{ source: 'history', q: 'x'.repeat(201) }, { source: 'history', cursor: 'bad' }, { source: 'groups' }, { source: 'history', workspaceId: workspace }] as Record<string, string>[]) expect((await get(request, params)).response.status()).toBe(400)
  const foreign = await get(request, { source: 'groups', workspaceId: otherWorkspace })
  const missing = await get(request, { source: 'groups', workspaceId: randomUUID() })
  expect(foreign.response.status()).toBe(403)
  expect(missing.body).toEqual(foreign.body)
  const first = await get(request, { source: 'history', q: `${prefix}-history-`, limit: '1' })
  expect((await get(request, { source: 'history', q: 'different', cursor: first.body.nextCursor })).response.status()).toBe(400)
})

test('retired archive title hit locates owner history beyond the latest 100 without generation', async ({ request }) => {
  const found = await get(request, { source: 'history', q: `${prefix}-archive-locator` })
  expect(found.response.status()).toBe(200)
  expect(found.body.items).toHaveLength(1)
  expect(found.body.items[0]).toMatchObject({ id: archivedId, title: `${prefix}-archive-locator`, type: 'history', scope: 'owner' })
  const endpoint = `http://127.0.0.1:3210/mikka/api/agent/sessions?sessionId=${encodeURIComponent(found.body.items[0].id)}`
  const archive = await request.get(endpoint, { headers: { cookie } })
  expect(archive.status()).toBe(200)
  expect(archive.headers()['cache-control']).toBe('private, no-store')
  const saved = await archive.json()
  expect(saved.sessionId).toBe(archivedId)
  expect(saved.turns[0].completion).toBe(archivedCompletion)
  expect(saved.sessions).toHaveLength(100)
  expect(saved.sessions.some((row: { id: string }) => row.id === archivedId)).toBe(false)
  // The recent-list title cap is a consumer limitation; do not fake an old-ID title here.
  const foreign = await request.get(endpoint, { headers: { cookie: foreignCookie } })
  const missing = await request.get(`http://127.0.0.1:3210/mikka/api/agent/sessions?sessionId=${randomUUID()}`, { headers: { cookie: foreignCookie } })
  expect(foreign.status()).toBe(404)
  expect(missing.status()).toBe(404)
  expect(await foreign.json()).toEqual(await missing.json())
  expect((await request.get(endpoint)).status()).toBe(401)
  const generated = await request.post('http://127.0.0.1:3210/mikka/api/agent', { headers: { cookie }, data: { prompt: 'synthetic retired generation must not execute' } })
  expect(generated.status()).toBe(405)
  const retained = await pool.query('select completion from agent_turns where "sessionId"=$1', [archivedId])
  expect(retained.rows.map(row => row.completion)).toEqual([archivedCompletion])
  console.log('search131 retired archive locator: title/id beyond recent100 -> owner GET 200, foreign/missing 404, unauthenticated 401, generation POST 405; selected title remains outside recent list')
})

test('real query result rechecks group exit including the hidden lookahead before response', async ({ request }) => {
  for (const [suffix, index] of [['page', 0], ['peek', 1]] as const) {
    gate = { captured: false, ids: [], frames: [] }
    const currentGate = gate
    const params = { source: 'groups', workspaceId: workspace, q: `${prefix}-race-${suffix}`, limit: '1' }
    const pending = get(request, params)
    try {
      await expect.poll(() => currentGate.captured, { timeout: 10000 }).toBe(true)
      expect(currentGate.ids).toHaveLength(2) // SQL already returned an allowed page + lookahead.
      await pool.query('update conversation_members set "leftAt"=now() where "conversationId"=$1 and "memberId"=$2', [currentGate.ids[index], owner])
    } finally { releaseGate() }
    const denied = await pending
    expect(denied.response.status()).toBe(403)
    expect(denied.body).toEqual({ error: 'searchAccessDenied' })
    const retry = await get(request, params)
    expect(retry.response.status()).toBe(200)
    expect(retry.body.items).toHaveLength(1)
    expect(retry.body.nextCursor).toBeNull()
    console.log(`search131 ${suffix}-exit after real PG snapshot: 403, retry one authorized row, no nextCursor`)
  }
})

test('task source preserves Auth owner-visible policy across workspace selection', async ({ request }) => {
  const result = await get(request, { source: 'tasks', workspaceId: workspace, q: `${prefix}-owner-policy` })
  expect(result.response.status()).toBe(200)
  expect(result.body.items).toHaveLength(1)
  // Caller has no membership in the task's linked workspace; ownership still grants reads.
  expect(result.body.items[0].title).toBe(`${prefix}-owner-policy`)
})

test('continuations recheck group leave, workspace suspension and real auth revocation', async ({ request }) => {
  const params = { source: 'groups', workspaceId: workspace, q: `${prefix}-group-`, limit: '1' }
  const first = await get(request, params)
  expect(first.body.nextCursor).toBeTruthy()
  await pool.query('update conversation_members set "leftAt"=now() where "conversationId"=any($1::uuid[]) and "memberId"=$2', [groupIds, owner])
  const left = await get(request, { ...params, cursor: first.body.nextCursor })
  expect(left.response.status()).toBe(200)
  expect(left.body.items).toEqual([])
  expect(left.body.nextCursor).toBeNull()
  await workspacePool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspace, owner])
  expect((await get(request, { ...params, cursor: first.body.nextCursor })).response.status()).toBe(403)
  expect((await get(request, { source: 'tasks', workspaceId: workspace })).response.status()).toBe(403)
  // Owner archives remain personal even when a workspace membership is suspended.
  expect((await get(request, { source: 'history', q: `${prefix}-history-` })).body.items.length).toBeGreaterThan(0)
  // Pause the real title SELECT, revoke after initial auth, then allow it to finish.
  const locker = await pool.connect()
  let pending: ReturnType<typeof get> | undefined
  try {
    await locker.query('BEGIN')
    await locker.query('LOCK agent_sessions IN ACCESS EXCLUSIVE MODE')
    pending = get(request, { source: 'history', q: `${prefix}-history-` })
    await expect.poll(async () => {
      const result = await pool.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and state='active' and query like '%agent_sessions%' and pid<>pg_backend_pid()")
      return result.rows[0].n
    }, { timeout: 10000 }).toBeGreaterThan(0)
    await pool.query('update session set token=$1 where id=$2', [randomUUID(), sessionId])
  } finally {
    await locker.query('ROLLBACK')
    locker.release()
  }
  expect((await pending!).response.status()).toBe(401)
  expect((await get(request, { source: 'history' })).response.status()).toBe(401)
  expect((await pool.query('select id from session where id=$1', [sessionId])).rowCount).toBe(1)
})
