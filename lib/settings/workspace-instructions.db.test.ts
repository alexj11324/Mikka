import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, mock, test } from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
const available = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (!available && process.env.REQUIRE_DB === '1') throw new Error('Workspace instructions require an isolated loopback *_e2e database')
const dbTest = available ? test : test.skip
const owner = `instructions-admin-${randomUUID()}`, member = `instructions-member-${randomUUID()}`, outsider = `instructions-outsider-${randomUUID()}`
const workspaceId = randomUUID(), otherWorkspaceId = randomUUID(), ownerBot = randomUUID(), memberBot = randomUUID(), otherBot = randomUUID()
let currentUser: { id: string; email: string; name: string } | null = null
let pool: (typeof import('@/lib/db'))['pool'], workspacePool: (typeof import('@/lib/workspace-db'))['workspacePool']
let route: typeof import('@/app/api/settings/workspace/[workspaceId]/route')
let reset: typeof import('@/app/api/settings/workspace/[workspaceId]/reset/route')
let personal: typeof import('@/app/api/settings/personal/route')
let readForBot: typeof import('@/lib/coordinator/workspace-instructions')['readWorkspaceInstructionsForBot']
const as = (id: string | null) => { currentUser = id ? { id, email: `${id}@example.invalid`, name: id } : null }
const request = (method: string, body?: unknown) => new Request(`http://127.0.0.1/api/settings/workspace/${workspaceId}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
})
const context = { params: Promise.resolve({ workspaceId }) }
const patch = (values: Record<string, unknown>) => route.PATCH(request('PATCH', { values }), context)

before(async () => {
  if (!available) return
  mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  mock.module('@/lib/session', { namedExports: { getSession: async () => currentUser ? { user: currentUser, session: { id: 'instructions-test-session' } } : null } })
  ;({ pool } = await import('@/lib/db'))
  ;({ workspacePool } = await import('@/lib/workspace-db'))
  route = await import('@/app/api/settings/workspace/[workspaceId]/route')
  reset = await import('@/app/api/settings/workspace/[workspaceId]/reset/route')
  personal = await import('@/app/api/settings/personal/route')
  ;({ readWorkspaceInstructionsForBot: readForBot } = await import('@/lib/coordinator/workspace-instructions'))
  for (const id of [owner, member, outsider]) await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
  for (const [id, userId] of [[workspaceId, owner], [otherWorkspaceId, outsider]]) {
    await workspacePool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,\'Instructions team\',\'team\')', [id, userId])
  }
  for (const [id, userId, role] of [[workspaceId, owner, 'admin'], [workspaceId, member, 'member'], [otherWorkspaceId, outsider, 'admin']]) {
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,$4,\'active\')', [id, userId, `${userId}@example.invalid`, role])
  }
  for (const [id, userId, tenant] of [[ownerBot, owner, workspaceId], [memberBot, member, workspaceId], [otherBot, outsider, otherWorkspaceId]]) {
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4)', [id, userId, tenant, 'Instructions bot'])
  }
})

after(async () => {
  if (!available) return
  await pool.query('DELETE FROM bots WHERE id=ANY($1::uuid[])', [[ownerBot, memberBot, otherBot]])
  for (const table of ['workspace_instructions', 'workspace_setting_values', 'thread_title_settings']) {
    await pool.query(`DELETE FROM ${table} WHERE "workspaceId"=ANY($1::uuid[])`, [[workspaceId, otherWorkspaceId]])
  }
  await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[workspaceId, otherWorkspaceId]])
  await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[owner, member, outsider]])
  await (await import('@/lib/builtin-gateway/runtime')).builtinGateway()?.stop()
  await Promise.all([pool.end(), workspacePool.end()])
})

dbTest('workspace instruction and sharing writes reject unauthenticated, other tenant and member callers', async () => {
  for (const [who, expected] of [[null, 401], [outsider, 403], [member, 403]] as const) {
    as(who)
    assert.equal((await patch({ workspaceInstructions: 'not admitted' })).status, expected)
    assert.equal((await patch({ threadShareVisibility: 'link', artifactShareVisibility: 'link' })).status, expected)
    assert.equal((await reset.POST(request('POST', { group: 'instructions' }), context)).status, expected)
  }
  as(owner)
  const personalRequest = new Request(`http://127.0.0.1/api/settings/personal?workspaceId=${workspaceId}`, {
    method: 'PATCH', body: JSON.stringify({ values: { workspaceInstructions: 'personal override' } }), headers: { 'Content-Type': 'application/json' },
  })
  assert.equal((await personal.PATCH(personalRequest)).status, 400)
})

dbTest('dedicated instructions persist, apply to the next prompt read and stay separate from title and personal text', async () => {
  as(owner)
  assert.equal((await patch({ workspaceInstructions: 'x'.repeat(2001) })).status, 400)
  const saved = await patch({ workspaceInstructions: '  Team checklist  ', threadTitleInstructions: 'Title only' })
  assert.equal(saved.status, 200)
  assert.deepEqual((await saved.json()).values.workspaceInstructions, { value: 'Team checklist', source: 'workspace' })
  assert.equal((await pool.query('SELECT instructions FROM workspace_instructions WHERE "workspaceId"=$1', [workspaceId])).rows[0].instructions, 'Team checklist')
  assert.equal((await pool.query('SELECT instructions FROM thread_title_settings WHERE "workspaceId"=$1 AND "userId"=\'\'', [workspaceId])).rows[0].instructions, 'Title only')
  assert.equal(await readForBot(owner, ownerBot), 'Team checklist')
  assert.equal(await readForBot(member, memberBot), 'Team checklist')
  assert.equal(await readForBot(outsider, otherBot), '')
  assert.equal((await patch({ workspaceInstructions: 'Updated checklist' })).status, 200)
  assert.equal(await readForBot(owner, ownerBot), 'Updated checklist')
  const cleared = await reset.POST(request('POST', { group: 'instructions' }), context)
  assert.deepEqual((await cleared.json()).values.workspaceInstructions, { value: '', source: 'default' })
  assert.equal(await readForBot(owner, ownerBot), '')
})

dbTest('prompt reads reject other bot owners and freshly revoked workspace memberships', async () => {
  await assert.rejects(readForBot(member, ownerBot), { code: 'botNotFound' })
  await assert.rejects(readForBot(outsider, memberBot), { code: 'botNotFound' })
  await workspacePool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, member])
  try { await assert.rejects(readForBot(member, memberBot), { code: 'workspaceAccessDenied' }) }
  finally { await workspacePool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, member]) }
})

dbTest('sharing defaults expose source and reset without changing existing instruction rows', async () => {
  as(owner)
  const { readWorkspaceSharingDefaults } = await import('./workspace-sharing')
  assert.deepEqual(await readWorkspaceSharingDefaults(workspaceId), { thread: { value: 'private', source: 'default' }, artifact: { value: 'link', source: 'default' } })
  assert.equal((await patch({ threadShareVisibility: 'workspace', artifactShareVisibility: 'private' })).status, 200)
  as(member)
  const view = await (await route.GET(request('GET'), context)).json()
  assert.deepEqual(view.values.threadShareVisibility, { value: 'workspace', source: 'workspace' })
  assert.deepEqual(await readWorkspaceSharingDefaults(workspaceId), { thread: { value: 'workspace', source: 'workspace' }, artifact: { value: 'private', source: 'workspace' } })
  as(owner)
  assert.equal((await patch({ artifactShareVisibility: 'public' })).status, 400)
  assert.equal((await reset.POST(request('POST', { group: 'sharing' }), context)).status, 200)
  assert.deepEqual((await readWorkspaceSharingDefaults(workspaceId)).thread, { value: 'private', source: 'default' })
})

dbTest('the additive instruction migration replays without overwriting later writes or resets', async () => {
  as(owner)
  await patch({ workspaceInstructions: 'Keep current instructions' })
  const migration = await readFile(new URL('../../drizzle/20261120192546_workspace_instructions.sql', import.meta.url), 'utf8')
  await pool.query(migration); await pool.query(migration)
  assert.equal(await readForBot(owner, ownerBot), 'Keep current instructions')
  await reset.POST(request('POST', { group: 'instructions' }), context)
  await pool.query(migration)
  assert.equal(await readForBot(owner, ownerBot), '')
  await assert.rejects(pool.query('UPDATE workspace_instructions SET instructions=$2 WHERE "workspaceId"=$1', [workspaceId, 'x'.repeat(2001)]), { code: '23514' })
})
