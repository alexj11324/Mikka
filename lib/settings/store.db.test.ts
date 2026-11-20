import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { after, before, mock, test } from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { wireKeys } from '../live/wire-keys.test-support'
import { liveChannelId } from '../live/scope'

const target = process.env.E2E_DATABASE_URL
const available = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (!available && process.env.REQUIRE_DB === '1') throw new Error('Settings tests require an isolated loopback *_e2e database')
const dbTest = available ? test : test.skip
const owner = `settings-admin-${randomUUID()}`, member = `settings-member-${randomUUID()}`, outsider = `settings-outsider-${randomUUID()}`
const workspaceId = randomUUID(), otherWorkspaceId = randomUUID()
let currentUser: { id: string; email: string; name: string } | null = null
let sessionId = 'settings-test-session'
const liveJobs: (() => Promise<void>)[] = []
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
  mock.module('@/lib/session', { namedExports: { getSession: async () => currentUser ? { user: currentUser, session: { id: sessionId } } : null } })
  const server = await import('@/lib/server-runtime/server')
  mock.module('@/lib/server-runtime/server', { namedExports: { ...server, after: (work: () => Promise<void>) => { liveJobs.push(work) } } })
  mock.module('@/lib/suggestions/sources', { namedExports: { connectedComposioApps: async () => [] } })
  ;({ pool } = await import('@/lib/db'))
  pool.options.max = 1
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

dbTest('a new member changing an unrelated preference still inherits the same archive days in settings and the directory', async () => {
  const { savePreferences } = await import('@/lib/preferences')
  const { readSettings, writeSettings } = await import('./store')
  const { conversationDirectory } = await import('@/lib/conversation-directory')
  const { directoryInput } = await import('@/lib/conversation-directory-input')
  const userId = `settings-new-${randomUUID()}`, agentId = randomUUID(), runId = randomUUID()
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
  await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'member\',\'active\')', [workspaceId, userId, `${userId}@example.invalid`])
  await pool.query('INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,\'Archive default fixture\',\'codex\')', [agentId, userId])
  await pool.query(`INSERT INTO agent_runs (id,"userId","workspaceId","agentId",status,prompt,"createdAt","updatedAt","finishedAt")
    VALUES ($1,$2,$3,$4,'succeeded','Archive fixture',now()-interval '10 days',now()-interval '10 days',now()-interval '10 days')`, [runId, userId, workspaceId, agentId])
  try {
    await writeSettings({ userId: owner, workspaceId }, 'workspace', patch({ archiveIdleAfterDays: 7 }))
    await savePreferences(userId, { pushFinished: false })
    assert.equal((await pool.query('SELECT "archiveIdleAfterDays" FROM user_preferences WHERE "userId"=$1', [userId])).rows[0].archiveIdleAfterDays, 30)
    assert.equal((await pool.query('SELECT 1 FROM personal_setting_values WHERE "userId"=$1 AND key=\'archiveIdleAfterDays\'', [userId])).rowCount, 0)
    assert.deepEqual((await readSettings({ userId, workspaceId })).values.archiveIdleAfterDays, { value: 7, source: 'workspace' })
    const directory = await conversationDirectory(pool, userId, workspaceId, directoryInput.parse({ archived: true }))
    assert.equal(directory.items.some(row => row.id === runId), true, 'a legacy default from an unrelated patch cannot override workspace inheritance')
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId])
    await pool.query('DELETE FROM agents WHERE id=$1', [agentId])
    await workspacePool.query('DELETE FROM mikka_workspace_members WHERE "userId"=$1', [userId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [userId])
  }
})

dbTest('a continuation copying a manual title cannot overwrite a later committed human rename', async () => {
  const { nameThread, renameThreadTitle } = await import('@/lib/thread-title-server')
  const { READ_CHAIN_TITLE } = await import('@/lib/thread-title')
  const agentId = randomUUID(), first = randomUUID(), continuation = randomUUID()
  await pool.query('INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,\'Title copy fixture\',\'codex\')', [agentId, member])
  await pool.query(`INSERT INTO agent_runs (id,"userId","workspaceId","agentId",status,prompt,title,"titleSource")
    VALUES ($1,$2,$3,$4,'succeeded','Fixture','Observed title','manual')`, [first, member, workspaceId, agentId])
  await pool.query(`INSERT INTO agent_runs (id,"userId","workspaceId","agentId",status,prompt,"continuesRunId")
    VALUES ($1,$2,$3,$4,'succeeded','Fixture',$5)`, [continuation, member, workspaceId, agentId, first])
  let interleaved = false
  const atCopy = { query: async (text: string, values?: unknown[]) => {
    const result = await pool.query(text, values)
    if (text === READ_CHAIN_TITLE && !interleaved) {
      interleaved = true
      assert.equal(await renameThreadTitle(pool, continuation, member, 'Newer human title', workspaceId), 'Newer human title')
    }
    return result
  } }
  try {
    assert.equal(await nameThread(atCopy, continuation, member, 'created', async () => { assert.fail('copying a manual title never calls a model') }), null)
    assert.equal(interleaved, true)
    assert.deepEqual((await pool.query('SELECT title,"titleSource" FROM agent_runs WHERE id=ANY($1::uuid[])', [[first, continuation]])).rows,
      [{ title: 'Newer human title', titleSource: 'manual' }, { title: 'Newer human title', titleSource: 'manual' }])
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [[first, continuation]])
    await pool.query('DELETE FROM agents WHERE id=$1', [agentId])
  }
})

dbTest('an SSO-authenticated administrator manages a member device with one APP connection and no owner session', async () => {
  const { PATCH } = await import('@/app/api/devices/[deviceId]/settings/route')
  const organizationId = randomUUID(), providerId = `settings-provider-${randomUUID()}`, identityId = randomUUID()
  const deviceId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), priorSession = sessionId
  sessionId = randomUUID()
  await workspacePool.query('INSERT INTO mikka_organizations (id,name,"createdBy") VALUES ($1,\'Settings SSO fixture\',$2)', [organizationId, owner])
  await workspacePool.query('INSERT INTO mikka_organization_workspaces ("organizationId","workspaceId") VALUES ($1,$2)', [organizationId, workspaceId])
  await pool.query('INSERT INTO enterprise_sso_provider (id,"providerId","organizationScopeId","userId",issuer,domain,"domainVerified","oidcConfig","domainTokenHash") VALUES ($1,$2,$3,$4,\'https://settings-idp.example.invalid\',$5,true,\'{}\',$6)',
    [randomUUID(), providerId, organizationId, owner, `${randomUUID()}.example.invalid`, randomUUID()])
  await pool.query('INSERT INTO enterprise_identity (id,"providerId",issuer,subject,"userId") VALUES ($1,$2,\'https://settings-idp.example.invalid\',$3,$3)', [identityId, providerId, owner])
  await pool.query('INSERT INTO session (id,token,"userId","expiresAt","createdAt","updatedAt","enterpriseOrganizationId","enterpriseProviderId","enterpriseIdentityId") VALUES ($1,$2,$3,now()+interval \'1 hour\',now(),now(),$4,$5,$6)',
    [sessionId, randomUUID(), owner, organizationId, providerId, identityId])
  await pool.query('INSERT INTO enterprise_org_policy ("organizationId","enforceSso") VALUES ($1,true)', [organizationId])
  await pool.query('INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,\'Member device\')', [deviceId, member])
  await pool.query('INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,\'SSO device fixture\',\'codex\')', [agentId, member])
  await pool.query('INSERT INTO agent_runs (id,"userId","workspaceId","agentId",status,prompt) VALUES ($1,$2,$3,$4,\'succeeded\',\'fixture\')', [runId, member, workspaceId, agentId])
  await pool.query('INSERT INTO thread_machines ("runId","workspaceId","ownerId","snapshotId","operationId",state,"deviceId") VALUES ($1,$2,$3,\'fixture\',$4,\'paused\',$5)', [runId, workspaceId, member, randomUUID(), deviceId])
  const send = () => PATCH(new Request(`http://127.0.0.1/api/devices/${deviceId}/settings?workspaceId=${workspaceId}`, {
    method: 'PATCH', body: JSON.stringify({ maxConcurrentRuns: 9 }),
  }), { params: Promise.resolve({ deviceId }) })
  try {
    as(owner)
    assert.equal((await send()).status, 200)
    assert.equal((await pool.query('SELECT "maxConcurrentRuns" FROM devices WHERE id=$1', [deviceId])).rows[0].maxConcurrentRuns, 9)
    assert.equal(pool.totalCount, 1, 'Enterprise checks do not acquire an APP connection inside the held device transaction')
    await workspacePool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, member])
    assert.equal((await send()).status, 403)
    await workspacePool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, member])
    await pool.query('UPDATE session SET "enterpriseIdentityId"=NULL WHERE id=$1', [sessionId])
    assert.equal((await send()).status, 403, 'the administrator must retain their own SSO assurance')
  } finally {
    await workspacePool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, member])
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [runId])
    await pool.query('DELETE FROM agents WHERE id=$1', [agentId])
    await pool.query('DELETE FROM devices WHERE id=$1', [deviceId])
    await pool.query('DELETE FROM session WHERE id=$1', [sessionId])
    await pool.query('DELETE FROM enterprise_identity WHERE id=$1', [identityId])
    await pool.query('DELETE FROM enterprise_sso_provider WHERE "providerId"=$1', [providerId])
    await pool.query('DELETE FROM enterprise_org_policy WHERE "organizationId"=$1', [organizationId])
    await workspacePool.query('DELETE FROM mikka_organizations WHERE id=$1', [organizationId])
    sessionId = priorSession
  }
})

dbTest('archive and pin writers publish exact directory scopes after commit and no directory keys after rollback', async () => {
  const { db, withDatabaseTransaction } = await import('@/lib/db')
  const { writeSettings, resetSettings } = await import('./store')
  const sent: { channel: string; key: string }[] = []
  const errors: unknown[] = []
  const receiver = createServer(async (request, response) => {
    try {
      let body = ''; for await (const part of request) body += part
      const channel = request.url!.split('/')[3]
      for (const event of wireKeys(JSON.parse(body))) {
        if (event.kind === 'thread_list' || event.kind === 'group_list') sent.push({ channel, key: `${event.kind}:${event.id}` })
      }
      response.writeHead(204).end()
    } catch (error) { errors.push(error); response.writeHead(500).end() }
  })
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening')
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'settings-directory-live-fixture'
  const drain = async () => { while (liveJobs.length) await liveJobs.shift()!(); assert.deepEqual(errors, []) }
  const expected = (scopes: { ownerId: string; workspaceId: string }[]) => new Set(scopes.flatMap(scope => ['thread_list', 'group_list'].map(kind => `${liveChannelId(scope)}:${kind}:${scope.workspaceId}`)))
  const received = () => new Set(sent.map(value => `${value.channel}:${value.key}`))
  const revisions = async () => (await pool.query('SELECT kind,revision FROM live_revisions WHERE id=$1 AND kind IN (\'thread_list\',\'group_list\') ORDER BY kind', [workspaceId])).rows
  try {
    await drain(); sent.length = 0
    await writeSettings({ userId: member, workspaceId }, 'personal', patch({ keepPinnedThreadsActive: false }))
    await drain()
    assert.deepEqual(received(), expected([{ ownerId: member, workspaceId }]))
    // group_list is an unversioned key in the existing wire contract.
    assert.deepEqual((await revisions()).map(row => [row.kind, Number(row.revision) > 0]), [['thread_list', true]])
    sent.length = 0
    await writeSettings({ userId: owner, workspaceId }, 'workspace', patch({ archiveIdleAfterDays: 14 }))
    await drain()
    assert.deepEqual(received(), expected([{ ownerId: owner, workspaceId }, { ownerId: member, workspaceId }]))
    sent.length = 0
    await workspacePool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, member])
    await resetSettings({ userId: owner, workspaceId }, 'workspace', { group: 'threads' })
    await drain()
    assert.deepEqual(received(), expected([{ ownerId: owner, workspaceId }]), 'suspended members and unrelated tenants receive no directory key')
    await workspacePool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, member])
    sent.length = 0
    await writeSettings({ userId: member, workspaceId }, 'personal', patch({ archiveIdleAfterDays: 3 }))
    await drain()
    assert.deepEqual(received(), expected([{ ownerId: member, workspaceId }, { ownerId: member, workspaceId: homes.get(member)! }]))
    sent.length = 0
    const beforeRollback = await revisions()
    await assert.rejects(db.transaction(tx => withDatabaseTransaction(tx, async () => {
      await writeSettings({ userId: member, workspaceId }, 'personal', patch({ keepPinnedThreadsActive: true }))
      throw new Error('rollback directory setting fixture')
    })), /rollback directory setting fixture/)
    await drain()
    assert.equal(sent.length, 0)
    assert.deepEqual(await revisions(), beforeRollback, 'rolled-back settings do not advance persisted directory revisions')
  } finally {
    await workspacePool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, member])
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    receiver.closeAllConnections(); await new Promise<void>(resolve => receiver.close(() => resolve()))
  }
})
