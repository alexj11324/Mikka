import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, mock, test } from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
const available = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (!available && process.env.REQUIRE_DB === '1') throw new Error('Settings tests require an isolated loopback *_e2e database')
const dbTest = available ? test : test.skip
const owner = `settings-admin-${randomUUID()}`, member = `settings-member-${randomUUID()}`, outsider = `settings-outsider-${randomUUID()}`
const workspaceId = randomUUID(), otherWorkspaceId = randomUUID()
let currentUser: { id: string; email: string; name: string } | null = null
let pool: (typeof import('@/lib/db'))['pool']
let workspacePool: (typeof import('@/lib/workspace-db'))['workspacePool']
let personal: typeof import('@/app/api/settings/personal/route')
let workspace: typeof import('@/app/api/settings/workspace/[workspaceId]/route')
let personalReset: typeof import('@/app/api/settings/personal/reset/route')
let workspaceReset: typeof import('@/app/api/settings/workspace/[workspaceId]/reset/route')
let schema: typeof import('@/app/api/settings/schema/route')
const homes = new Map<string, string>()
const as = (userId: string | null) => { currentUser = userId ? { id: userId, email: `${userId}@example.invalid`, name: userId } : null }
const request = (path: string, method = 'GET', body?: unknown) => new Request(`http://127.0.0.1/api/settings/${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
})
const context = (id = workspaceId) => ({ params: Promise.resolve({ workspaceId: id }) })
const patch = (values: Record<string, unknown>) => ({ values })

before(async () => {
  if (!available) return
  mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  mock.module('@/lib/intl/i18n-server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
  mock.module('@/lib/session', { namedExports: { getSession: async () => currentUser ? { user: currentUser, session: { id: 'settings-test-session' } } : null } })
  mock.module('@/lib/suggestions/sources', { namedExports: { connectedComposioApps: async () => [] } })
  ;({ pool } = await import('@/lib/db'))
  ;({ workspacePool } = await import('@/lib/workspace-db'))
  personal = await import('@/app/api/settings/personal/route')
  workspace = await import('@/app/api/settings/workspace/[workspaceId]/route')
  personalReset = await import('@/app/api/settings/personal/reset/route')
  workspaceReset = await import('@/app/api/settings/workspace/[workspaceId]/reset/route')
  schema = await import('@/app/api/settings/schema/route')
  for (const id of [owner, member, outsider]) {
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
    const home = randomUUID(); homes.set(id, home)
    await workspacePool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,$3,\'personal\')', [home, id, 'Personal'])
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [home, id, `${id}@example.invalid`])
  }
  for (const id of [workspaceId, otherWorkspaceId]) {
    await workspacePool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,\'Settings team\',\'team\')', [id, id === workspaceId ? owner : outsider])
  }
  for (const [id, person, role] of [[workspaceId, owner, 'admin'], [workspaceId, member, 'member'], [otherWorkspaceId, outsider, 'admin']]) {
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,$4,\'active\')', [id, person, `${person}@example.invalid`, role])
  }
})

after(async () => {
  if (!available) return
  const workspaceIds = [workspaceId, otherWorkspaceId, ...homes.values()]
  await pool.query('DELETE FROM personal_setting_values WHERE "userId"=ANY($1)', [[owner, member, outsider]])
  await pool.query('DELETE FROM workspace_setting_values WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM thread_title_settings WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[owner, member, outsider]])
  // Real writes start the builtin live bus; shut down its LISTEN connection too.
  await (await import('@/lib/builtin-gateway/runtime')).builtinGateway()?.stop()
  await Promise.all([pool.end(), workspacePool.end()])
})

dbTest('every settings route rejects unauthenticated readers and writers', async () => {
  as(null)
  const responses = [
    await schema.GET(request('schema')), await personal.GET(request('personal')),
    await personal.PATCH(request('personal', 'PATCH', patch({ archiveIdleAfterDays: 7 }))),
    await personalReset.POST(request('personal/reset', 'POST', { group: 'threads' })),
    await workspace.GET(request(`workspace/${workspaceId}`), context()),
    await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ archiveIdleAfterDays: 7 })), context()),
    await workspaceReset.POST(request(`workspace/${workspaceId}/reset`, 'POST', { group: 'threads' }), context()),
  ]
  for (const response of responses) { assert.equal(response.status, 401); assert.equal((await response.json()).error, 'authRequired') }
})

dbTest('other-workspace members cannot read/write/reset; ordinary members cannot write admin fields', async () => {
  as(outsider)
  for (const response of [
    await personal.GET(request(`personal?workspaceId=${workspaceId}`)),
    await personal.PATCH(request(`personal?workspaceId=${workspaceId}`, 'PATCH', patch({ archiveIdleAfterDays: 7 }))),
    await personalReset.POST(request(`personal/reset?workspaceId=${workspaceId}`, 'POST', { group: 'threads' })),
    await workspace.GET(request(`workspace/${workspaceId}`), context()),
    await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ subagentMaxConcurrent: 9 })), context()),
    await workspaceReset.POST(request(`workspace/${workspaceId}/reset`, 'POST', { group: 'threads' }), context()),
  ]) assert.equal(response.status, 403)
  as(member)
  assert.equal((await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ subagentMaxConcurrent: 9 })), context())).status, 403)
  assert.equal((await workspaceReset.POST(request(`workspace/${workspaceId}/reset`, 'POST', { group: 'threads' }), context())).status, 403)
  assert.equal((await personal.PATCH(request(`personal?workspaceId=${workspaceId}`, 'PATCH', { ...patch({ archiveIdleAfterDays: 7 }), userId: owner }))).status, 400)
  assert.equal((await personal.PATCH(request(`personal?workspaceId=${workspaceId}`, 'PATCH', patch({ subagentMaxConcurrent: 9 })))).status, 400)
  assert.equal((await schema.GET(request('schema'))).status, 200)
})

dbTest('typed values persist, inherit, reset, and mirror existing actions without separate field migrations', async () => {
  as(owner)
  const response = await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ archiveIdleAfterDays: 7, subagentMaxConcurrent: 9, threadTitleInstructions: 'team title' })), context())
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).values.subagentMaxConcurrent, { value: 9, source: 'workspace' })
  assert.equal((await pool.query('SELECT "integerValue" FROM workspace_setting_values WHERE "workspaceId"=$1 AND key=\'subagentMaxConcurrent\'', [workspaceId])).rows[0].integerValue, 9)
  as(member)
  assert.deepEqual((await (await personal.GET(request(`personal?workspaceId=${workspaceId}`))).json()).values.archiveIdleAfterDays, { value: 7, source: 'workspace' })
  let saved = await personal.PATCH(request(`personal?workspaceId=${workspaceId}`, 'PATCH', patch({ archiveIdleAfterDays: 0, threadTitleInstructions: '' })))
  assert.equal(saved.status, 200)
  let view = await saved.json()
  assert.deepEqual(view.values.archiveIdleAfterDays, { value: 0, source: 'personal' })
  assert.deepEqual(view.values.threadTitleInstructions, { value: '', source: 'personal' })
  saved = await personal.PATCH(request(`personal?workspaceId=${workspaceId}`, 'PATCH', patch({ archiveIdleAfterDays: null })))
  assert.deepEqual((await saved.json()).values.archiveIdleAfterDays, { value: 7, source: 'workspace' })
  const { updatePreferences } = await import('@/app/actions/preferences')
  assert.equal((await updatePreferences({ archiveIdleAfterDays: 14 })).error, undefined)
  view = await (await personal.GET(request(`personal?workspaceId=${workspaceId}`))).json()
  assert.deepEqual(view.values.archiveIdleAfterDays, { value: 14, source: 'personal' })
  const { saveThreadTitleSettings } = await import('@/app/actions/thread-title-settings')
  assert.equal((await saveThreadTitleSettings({ workspaceId, scope: 'mine', triggers: 'pull_opened' })).error, undefined)
  assert.deepEqual((await (await personal.GET(request(`personal?workspaceId=${workspaceId}`))).json()).values.threadTitleTriggers, { value: 'pull_opened', source: 'personal' })
  const reset = await personalReset.POST(request(`personal/reset?workspaceId=${workspaceId}`, 'POST', { group: 'threads' }))
  assert.deepEqual((await reset.json()).values.archiveIdleAfterDays, { value: 7, source: 'workspace' })
  as(owner)
  const resetWorkspace = await workspaceReset.POST(request(`workspace/${workspaceId}/reset`, 'POST', { group: 'threads' }), context())
  assert.deepEqual((await resetWorkspace.json()).values.archiveIdleAfterDays, { value: 30, source: 'default' })
})

dbTest('migration upgrade preserves zero and scoped title overrides; replay preserves later resets', async () => {
  await pool.query('DELETE FROM personal_setting_values WHERE "userId"=$1', [member])
  await pool.query('INSERT INTO user_preferences ("userId","archiveIdleAfterDays") VALUES ($1,0) ON CONFLICT ("userId") DO UPDATE SET "archiveIdleAfterDays"=0', [member])
  await pool.query('INSERT INTO thread_title_settings ("workspaceId","userId",instructions,triggers) VALUES ($1,$2,\'migrated title\',\'either\') ON CONFLICT ("workspaceId","userId") DO UPDATE SET instructions=excluded.instructions,triggers=excluded.triggers', [workspaceId, member])
  const migration = await readFile(new URL('../../drizzle/20261120185516_typed_setting_values.sql', import.meta.url), 'utf8')
  await pool.query(migration)
  as(member)
  let view = await (await personal.GET(request(`personal?workspaceId=${workspaceId}`))).json()
  assert.deepEqual(view.values.archiveIdleAfterDays, { value: 0, source: 'personal' })
  assert.deepEqual(view.values.threadTitleInstructions, { value: 'migrated title', source: 'personal' })
  await personalReset.POST(request(`personal/reset?workspaceId=${workspaceId}`, 'POST', { group: 'threads' }))
  await pool.query(migration)
  view = await (await personal.GET(request(`personal?workspaceId=${workspaceId}`))).json()
  assert.equal(view.values.archiveIdleAfterDays.source, 'default')
  await assert.rejects(pool.query('INSERT INTO workspace_setting_values ("workspaceId",key,"integerValue","booleanValue") VALUES ($1,\'invalid\',1,true)', [workspaceId]), { code: '23514' })
})

dbTest('device concurrency authenticates owner/admin, rejects other members and foreign workspaces, and persists scheduler capacity', async () => {
  const { PATCH } = await import('@/app/api/devices/[deviceId]/settings/route')
  const deviceId = randomUUID(), unbound = randomUUID(), foreignDevice = randomUUID(), runId = randomUUID(), agentId = randomUUID()
  const send = (id = deviceId, value: unknown = 5, space = workspaceId) => PATCH(
    new Request(`http://127.0.0.1/api/devices/${id}/settings?workspaceId=${space}`, { method: 'PATCH', body: JSON.stringify({ maxConcurrentRuns: value }) }),
    { params: Promise.resolve({ deviceId: id }) })
  await pool.query('INSERT INTO devices (id,"ownerId",name) VALUES ($1,$4,\'bound\'),($2,$4,\'private\'),($3,$5,\'foreign\')', [deviceId, unbound, foreignDevice, member, outsider])
  await pool.query('INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,\'device-test\',\'codex\')', [agentId, member])
  await pool.query('INSERT INTO agent_runs (id,"userId","workspaceId","agentId",status,prompt) VALUES ($1,$2,$3,$4,\'succeeded\',\'fixture\')', [runId, member, workspaceId, agentId])
  await pool.query('INSERT INTO thread_machines ("runId","workspaceId","ownerId","snapshotId","operationId",state,"deviceId") VALUES ($1,$2,$3,\'fixture\',$4,\'ended\',$5)', [runId, workspaceId, member, randomUUID(), deviceId])
  try {
    as(null); assert.equal((await send()).status, 401)
    as(outsider); assert.equal((await send()).status, 403)
    as(member); assert.equal((await send(foreignDevice)).status, 403)
    assert.equal((await send(deviceId, 5, otherWorkspaceId)).status, 403)
    for (const invalid of [0, 65, 1.5, '5', null]) assert.equal((await send(deviceId, invalid)).status, 400)
    let response = await send(); assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deviceId, maxConcurrentRuns: 5 })
    as(owner); assert.equal((await send(unbound)).status, 403)
    assert.equal((await send(foreignDevice)).status, 403)
    response = await send(deviceId, 8); assert.equal(response.status, 200)
    assert.equal((await pool.query('SELECT "maxConcurrentRuns" FROM devices WHERE id=$1', [deviceId])).rows[0].maxConcurrentRuns, 8)
    assert.equal((await send(randomUUID())).status, 404)
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId])
    await pool.query('DELETE FROM agents WHERE id=$1', [agentId])
    await pool.query('DELETE FROM devices WHERE id=ANY($1::uuid[])', [[deviceId, unbound, foreignDevice]])
  }
})

dbTest('real thread directory resolves workspace archive defaults, protects open/draft PRs and honors explicit personal and pin settings', async () => {
  const { conversationDirectory } = await import('@/lib/conversation-directory')
  const { directoryInput } = await import('@/lib/conversation-directory-input')
  const { writeSettings } = await import('./store')
  const issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID()
  await pool.query('INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,\'archive-test\',\'codex\')', [agentId, member])
  await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,$2,$3,'Archive fixture','{"type":"doc"}','doing','normal')`, [issueId, member, workspaceId])
  await pool.query(`INSERT INTO agent_runs (id,"userId","workspaceId","issueId","agentId",status,prompt,"createdAt","updatedAt","finishedAt")
    VALUES ($1,$2,$3,$4,$5,'succeeded','Archive fixture',now()-interval '10 days',now()-interval '10 days',now()-interval '10 days')`, [runId, member, workspaceId, issueId, agentId])
  const archived = async () => (await conversationDirectory(pool, member, workspaceId, directoryInput.parse({ archived: true }))).items.some(row => row.id === runId)
  try {
    await writeSettings({ userId: owner, workspaceId }, 'workspace', patch({ archiveIdleAfterDays: 7 }))
    await writeSettings({ userId: member, workspaceId }, 'personal', patch({ archiveIdleAfterDays: null }))
    assert.equal(await archived(), true)
    await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest")
      VALUES ($1,$2,$3,'https://github.com/settings/fixture','settings/fixture','published',$4)`, [runId, member, issueId, JSON.stringify({ url: 'https://github.com/settings/fixture/pull/1', state: 'open', title: 'Fixture PR' })])
    for (const state of ['open', 'draft', 'closed', 'merged']) {
      await pool.query(`UPDATE run_publications SET "pullRequest"=jsonb_set("pullRequest",'{state}',to_jsonb($2::text)) WHERE "runId"=$1`, [runId, state])
      assert.equal(await archived(), ['closed', 'merged'].includes(state), state)
    }
    await writeSettings({ userId: member, workspaceId }, 'personal', patch({ archiveIdleAfterDays: 0 }))
    assert.equal(await archived(), false)
    await writeSettings({ userId: member, workspaceId }, 'personal', patch({ archiveIdleAfterDays: null }))
    await pool.query('UPDATE agent_runs SET "conversationPinnedAt"=now() WHERE id=$1', [runId])
    assert.equal(await archived(), false)
    await writeSettings({ userId: owner, workspaceId }, 'workspace', patch({ keepPinnedThreadsActive: false }))
    assert.equal(await archived(), true)
    await writeSettings({ userId: member, workspaceId }, 'personal', patch({ keepPinnedThreadsActive: true }))
    assert.equal(await archived(), false)
    as(member)
    assert.equal((await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ protectManualThreadTitles: false, keepPinnedThreadsActive: false })), context())).status, 403)
    const { nameThread, renameThreadTitle } = await import('@/lib/thread-title-server')
    await pool.query('UPDATE agent_runs SET title=\'My title\',"titleSource"=\'manual\',"promptTaskStart"=0,"promptTaskLength"=length(prompt) WHERE id=$1', [runId])
    let calls = 0
    const generate = async () => { calls++; return 'Generated title' }
    assert.equal(await nameThread(pool, runId, member, 'pull_opened', generate), null)
    assert.equal(calls, 0, 'protected titles never invoke the supplied fake generator')
    await writeSettings({ userId: owner, workspaceId }, 'workspace', patch({ protectManualThreadTitles: false }))
    assert.equal(await nameThread(pool, runId, member, 'pull_opened', generate), 'Generated title')
    assert.equal(calls, 1)
    await renameThreadTitle(pool, runId, member, 'Observed title', workspaceId)
    assert.equal(await nameThread(pool, runId, member, 'pull_opened', async () => {
      await renameThreadTitle(pool, runId, member, 'Newer rename', workspaceId)
      return 'Late generated title'
    }), null, 'even an unprotected automatic rename cannot overwrite a newer human edit')
    assert.equal((await pool.query('SELECT title FROM agent_runs WHERE id=$1', [runId])).rows[0].title, 'Newer rename')
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId])
    await pool.query('DELETE FROM issues WHERE id=$1', [issueId])
    await pool.query('DELETE FROM agents WHERE id=$1', [agentId])
  }
})

dbTest('subagent admission reads the workspace cap and leaves a saturated queued task unclaimed', async () => {
  const { SubagentStore } = await import('@/lib/cloud-computer/subagents')
  const { writeSettings } = await import('./store')
  const { readRuntimeSetting } = await import('./runtime')
  const botId = randomUUID(), active = randomUUID(), waiting = randomUUID()
  await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'cap fixture\')', [botId, member, workspaceId])
  await pool.query(`INSERT INTO bot_subagents (id,"ownerId","workspaceId","botId",task,status) VALUES ($1,$3,$4,$5,'active','running'),($2,$3,$4,$5,'waiting','queued')`, [active, waiting, member, workspaceId, botId])
  try {
    await writeSettings({ userId: owner, workspaceId }, 'workspace', patch({ subagentMaxConcurrent: 1 }))
    assert.deepEqual(await readRuntimeSetting(pool, 'subagentMaxConcurrent', { userId: member, workspaceId }), { value: 1, source: 'workspace' })
    const result = await new SubagentStore(pool).start({ userId: member, workspaceId }, botId, waiting)
    assert.equal(result.status, 'queued')
    assert.equal((await pool.query('SELECT "startLeaseId" FROM bot_subagents WHERE id=$1', [waiting])).rows[0].startLeaseId, null)
    await assert.rejects(new SubagentStore(pool).get({ userId: outsider, workspaceId }, botId, waiting), { status: 404 })
    await assert.rejects(new SubagentStore(pool).get({ userId: member, workspaceId: otherWorkspaceId }, botId, waiting), { status: 404 })
  } finally {
    await pool.query('DELETE FROM bot_subagents WHERE "botId"=$1', [botId])
    await pool.query('DELETE FROM bots WHERE id=$1', [botId])
  }
})
