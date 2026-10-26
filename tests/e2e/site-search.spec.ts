import { createHmac, randomUUID } from 'node:crypto'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'

// Real Next HTTP + Better Auth + PostgreSQL; all records are synthetic and retained.
const target = process.env.E2E_DATABASE_URL
if (!target || !['127.0.0.1', 'localhost'].includes(new URL(target).hostname) || new URL(target).pathname !== '/mikka_e2e') throw new Error('Site search requires isolated mikka_e2e')
const pool = new Pool({ connectionString: target, max: 2 })
const owner = `site-search-${randomUUID()}`, outsider = `site-search-${randomUUID()}`
const workspace = randomUUID(), otherWorkspace = randomUUID(), sessionId = randomUUID(), token = randomUUID()
const secret = process.env.BETTER_AUTH_SECRET
if (!secret) throw new Error('Synthetic auth secret required')
const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', secret).update(token).digest('base64')}`)}`
const prefix = `title-${randomUUID()}`
let groupIds: string[] = []
async function get(request: APIRequestContext, params: Record<string, string>, authenticated = true) {
  const response = await request.get(`/mikka/api/search?${new URLSearchParams(params)}`, { headers: authenticated ? { cookie } : {} })
  expect(response.headers()['cache-control']).toBe('private, no-store')
  return { response, body: await response.json() }
}

test.beforeAll(async () => {
  for (const id of [owner, outsider]) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
  await pool.query('insert into session (id,token,"userId","expiresAt","createdAt","updatedAt") values ($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, token, owner])
  for (const [id, user] of [[workspace, owner], [otherWorkspace, outsider]]) {
    await pool.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,\'Synthetic search\')', [id, user])
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",email,name,role,status) values ($1,$2,$3,$2,\'admin\',\'active\')', [id, user, `${user}@example.invalid`])
  }
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
  // Neither body nor prompt is a searchable source, even in an accessible container.
  await pool.query('insert into conversation_messages (id,"conversationId",position,"authorType","authorId",body) values ($1,$2,1,\'user\',$3,$4)', [randomUUID(), groupIds[0], owner, `${prefix}-body-secret`])
  const history = randomUUID()
  await pool.query('insert into agent_sessions (id,"userId",title) values ($1,$2,\'unrelated title\')', [history, owner])
  await pool.query('insert into agent_turns (id,"sessionId","userId",prompt,completion,status,"attemptId") values ($1,$2,$3,$4,$4,\'complete\',$5)', [randomUUID(), history, owner, `${prefix}-body-secret`, randomUUID()])
  for (const user of [owner, outsider]) await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,$3,$4,\'todo\',\'none\',\'personal\')', [randomUUID(), user, `${prefix}-task`, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 131 } } })])
})
test.afterAll(async () => { await pool.end() })

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

test('continuations recheck group leave, workspace suspension and real auth revocation', async ({ request }) => {
  const params = { source: 'groups', workspaceId: workspace, q: `${prefix}-group-`, limit: '1' }
  const first = await get(request, params)
  expect(first.body.nextCursor).toBeTruthy()
  await pool.query('update conversation_members set "leftAt"=now() where "conversationId"=any($1::uuid[]) and "memberId"=$2', [groupIds, owner])
  const left = await get(request, { ...params, cursor: first.body.nextCursor })
  expect(left.response.status()).toBe(200)
  expect(left.body.items).toEqual([])
  expect(left.body.nextCursor).toBeNull()
  await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspace, owner])
  expect((await get(request, { ...params, cursor: first.body.nextCursor })).response.status()).toBe(403)
  expect((await get(request, { source: 'tasks', workspaceId: workspace })).response.status()).toBe(403)
  // Owner archives remain personal even when a workspace membership is suspended.
  expect((await get(request, { source: 'history', q: `${prefix}-history-` })).body.items.length).toBeGreaterThan(0)
  await pool.query('update session set token=$1 where id=$2', [randomUUID(), sessionId])
  expect((await get(request, { source: 'history' })).response.status()).toBe(401)
  expect((await pool.query('select id from session where id=$1', [sessionId])).rowCount).toBe(1)
})
