// Bot settings aligned with Capy's Captain (drizzle/20261120044916_bot_settings.sql) against a real PostgreSQL:
// Environment binding and the retired repository's backfill, alias, defaults, effort, access, followers and transfer.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedBot, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('bot settings', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { ActionFailureError } = await import('../lib/action-error')
  const { createOwnedBot } = await import('../lib/bot-create')
  const { updateOwnedBot } = await import('../lib/bot-update')
  const store = await import('../lib/bot-settings-store')
  const access = await import('../lib/bot-access')
  const { botRepository } = await import('../lib/bot-environment')
  const { backfillBotEnvironments, MIGRATION_ACTOR } = await import('../scripts/bot-environment-backfill.mjs')
  const { pool: appPool } = await import('../lib/db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof ActionFailureError && error.code === code)
  const environment = async (workspaceId: string, name: string, repositoryKeys: string[], archived = false) => {
    const id = randomUUID()
    await pool.query(`insert into workspace_environments(id,"workspaceId",name,configuration,"createdBy","updatedBy","archivedAt") values($1,$2,$3,$4,'fixture','fixture',$5)`,
      [id, workspaceId, name, JSON.stringify({ runtime: 'any', harness: 'any', variables: {}, secretIds: [], repositoryKeys }), archived ? new Date() : null])
    return id
  }
  const row = async (id: string) => (await pool.query('select * from bots where id=$1', [id])).rows[0]

  const owner = await seedUser(pool, 'owner'), member = await seedUser(pool, 'member'), outsider = await seedUser(pool, 'outsider')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  const me = { ownerId: owner, workspaceId: ws.id }
  const actor = { userId: owner, workspaceId: ws.id }
  // Created a moment apart: the oldest live Environment is the workspace default.
  const defaultEnv = await environment(ws.id, 'Default', ['v2/github.com/acme/web'])
  await new Promise(resolve => setTimeout(resolve, 5))
  const apiEnv = await environment(ws.id, 'API', ['v2/github.com/acme/api', 'v2/github.com/acme/shared'])
  const archivedEnv = await environment(ws.id, 'Old', [], true)
  const foreignEnv = await environment(other.id, 'Theirs', [])

  await t.test('a new Bot binds an Environment and never writes the retired repository', async () => {
    const plain = await createOwnedBot(me, { name: 'Plain', color: 'encre', shape: 'cercle' })
    assert.equal((await row(plain.id)).environmentId, defaultEnv, 'no choice: the workspace default')
    assert.equal((await row(plain.id)).repository, null)
    const picked = await createOwnedBot(me, { name: 'Picked', color: 'encre', shape: 'cercle', environmentId: apiEnv })
    assert.equal((await row(picked.id)).environmentId, apiEnv)
    assert.equal(await botRepository({ workspaceId: ws.id, environmentId: apiEnv, repository: 'acme/legacy' }), 'v2/github.com/acme/api', 'the Environment wins over the retired value')
    assert.equal(await botRepository({ workspaceId: ws.id, environmentId: archivedEnv, repository: 'acme/legacy' }), 'acme/legacy', 'a gone Environment falls back until the backfill')
    await rejects(createOwnedBot(me, { name: 'Archived', color: 'encre', shape: 'cercle', environmentId: archivedEnv }), 'botEnvironmentUnavailable')
    await rejects(createOwnedBot(me, { name: 'Foreign', color: 'encre', shape: 'cercle', environmentId: foreignEnv }), 'botEnvironmentUnavailable')
    assert.equal((await pool.query('select count(*)::int as n from bots where name in ($1,$2) and "workspaceId"=$3', ['Archived', 'Foreign', ws.id])).rows[0].n, 0)
  })

  await t.test('alias: lowercase, unique in the workspace, cleared with null', async () => {
    const a = await createOwnedBot(me, { name: 'Alias A', color: 'encre', shape: 'cercle', alias: 'Release' })
    assert.equal((await row(a.id)).alias, 'release')
    const b = await seedBot(pool, ws.id, member, 'Alias B')
    await rejects(updateOwnedBot({ ownerId: member, workspaceId: ws.id }, { botId: b, alias: 'RELEASE' }), 'botAliasTaken')
    await rejects(updateOwnedBot({ ownerId: member, workspaceId: ws.id }, { botId: b, alias: 'no spaces' }), 'botAliasInvalid')
    const elsewhere = await seedBot(pool, other.id, outsider, 'Elsewhere')
    await updateOwnedBot({ ownerId: outsider, workspaceId: other.id }, { botId: elsewhere, alias: 'release' })
    assert.equal((await row(elsewhere)).alias, 'release', 'another workspace may reuse it')
    await updateOwnedBot(me, { botId: a.id, alias: null })
    await updateOwnedBot({ ownerId: member, workspaceId: ws.id }, { botId: b, alias: 'release' })
    assert.equal((await row(b)).alias, 'release')
  })

  await t.test('Tasks run on, default Agent and profile belong to the owner', async () => {
    const bot = await seedBot(pool, ws.id, owner, 'Captain')
    await updateOwnedBot(me, { botId: bot, environmentId: defaultEnv })
    const device = randomUUID(), theirs = randomUUID()
    await pool.query(`insert into devices (id,"ownerId",name,kind,enabled) values ($1,$2,'mine','local',true),($3,$4,'theirs','local',true)`, [device, owner, theirs, member])
    await updateOwnedBot(me, { botId: bot, crewTarget: { kind: 'device', deviceId: device }, defaultAgent: 'codex', runsOn: { kind: 'device', deviceId: device, checkout: 'worktree' } })
    assert.deepEqual(await store.botDispatchDefaults(pool, bot), { crewTarget: { kind: 'device', deviceId: device }, defaultAgent: 'codex', defaultProfileId: null, repository: 'v2/github.com/acme/web' })
    await rejects(updateOwnedBot(me, { botId: bot, crewTarget: { kind: 'device', deviceId: theirs } }), 'botTargetUnavailable')
    await rejects(updateOwnedBot(me, { botId: bot, runsOn: { kind: 'device', deviceId: theirs, checkout: 'linked' } }), 'botTargetUnavailable')
    await rejects(updateOwnedBot(me, { botId: bot, defaultProfileId: randomUUID() }), 'botTargetUnavailable')
    await rejects(updateOwnedBot(me, { botId: bot, defaultAgent: 'cursor' as 'codex' }), 'validationGeneric')
    await rejects(updateOwnedBot({ ownerId: member, workspaceId: ws.id }, { botId: bot, defaultAgent: 'claude_code' }), 'botNotFound')
    await updateOwnedBot(me, { botId: bot, crewTarget: { kind: 'cloud', provider: 'cloudflare' } })
    assert.deepEqual((await row(bot)).crewTarget, { kind: 'cloud', provider: 'cloudflare' })
    await updateOwnedBot(me, { botId: bot, crewTarget: null, defaultAgent: null, runsOn: null })
    assert.deepEqual(await store.botDispatchDefaults(pool, bot), { crewTarget: null, defaultAgent: null, defaultProfileId: null, repository: 'v2/github.com/acme/web' })
  })

  await t.test('effort sits beside the model choice and keeps it', async () => {
    const bot = await seedBot(pool, ws.id, owner, 'Effort')
    await pool.query(`insert into bot_model_choices("ownerId","workspaceId","botKey","creditsModel") values($1,$2,$3,'openai/gpt')`, [owner, ws.id, bot])
    await store.setBotModelEffort(pool, me, bot, 'high')
    const [choice] = (await pool.query('select "creditsModel",effort from bot_model_choices where "botKey"=$1', [bot])).rows
    assert.deepEqual(choice, { creditsModel: 'openai/gpt', effort: 'high' })
    assert.equal((await store.readOwnedBotSettings(pool, me, bot))?.effort, 'high')
    await store.setBotModelEffort(pool, me, bot, null)
    assert.equal((await store.readOwnedBotSettings(pool, me, bot))?.effort, null)
    await rejects(store.setBotModelEffort(pool, me, bot, 'extreme'), 'validationGeneric')
    await rejects(store.setBotModelEffort(pool, { ownerId: member, workspaceId: ws.id }, bot, 'low'), 'botNotFound')
    assert.equal(await store.readOwnedBotSettings(pool, { ownerId: member, workspaceId: ws.id }, bot), null)
  })

  await t.test('access, followers and the Coordinator', async () => {
    const bot = (await createOwnedBot(me, { name: 'Shared', color: 'encre', shape: 'cercle' })).id
    const memberActor = { userId: member, workspaceId: ws.id }
    await rejects(access.followBot(memberActor, bot, true), 'botNotFound')
    await rejects(access.setBotSubscribers(actor, bot, [member]), 'botSubscriberNoAccess')
    assert.equal((await access.setBotVisibility(actor, bot, 'shared')).visibility, 'shared')
    assert.deepEqual(await access.followBot(memberActor, bot, true), { subscribed: true })
    assert.deepEqual((await access.botAccess(memberActor, bot)).subscribers, [member])
    assert.deepEqual((await access.followedBots(memberActor)).map(item => item.id), [bot])
    await rejects(access.setBotSubscribers(actor, bot, [outsider]), 'workspaceAccessDenied')
    await rejects(access.setBotVisibility(memberActor, bot, 'private'), 'botNotFound')
    // Private again: followers who can no longer find it go.
    assert.deepEqual((await access.setBotVisibility(actor, bot, 'private')).subscribers, [])
    await rejects(createOwnedBot(me, { name: 'Early follower', color: 'encre', shape: 'cercle', subscribers: [member] }), 'botSubscriberNoAccess')
    const created = await createOwnedBot(me, { name: 'Born shared', color: 'encre', shape: 'cercle', visibility: 'shared', subscribers: [member] })
    assert.deepEqual(await access.botAccess(actor, created.id), { visibility: 'shared', ownerId: owner, subscribers: [member] })
    const personal = { id: randomUUID() }
    await pool.query(`insert into mikka_workspaces (id,"userId",name,slug,kind) values ($1,$2,'Solo',$3,'personal')`, [personal.id, member, `ws-${personal.id.slice(0, 8)}`])
    await pool.query(`insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,'admin','active')`, [personal.id, member, `${member}@example.invalid`])
    await rejects(createOwnedBot({ ownerId: member, workspaceId: personal.id }, { name: 'Solo', color: 'encre', shape: 'cercle', visibility: 'shared' }), 'botShareUnavailable')
    const coordinator = await seedBot(pool, ws.id, owner, 'Coordinator')
    await pool.query('insert into coordinator_bots ("ownerId","workspaceId","botId") values ($1,$2,$3)', [owner, ws.id, coordinator])
    await rejects(access.setBotVisibility(actor, coordinator, 'shared'), 'botNotFound')
  })

  await t.test('transfer hands the Bot and its access policy to another member', async () => {
    const bot = (await createOwnedBot(me, { name: 'Handed', color: 'encre', shape: 'cercle', visibility: 'shared', subscribers: [member] })).id
    await rejects(access.transferBotOwnership(actor, bot, outsider), 'workspaceAccessDenied')
    assert.deepEqual(await access.transferBotOwnership(actor, bot, member), { id: bot, ownerId: member })
    assert.equal((await row(bot)).ownerId, member)
    const policy = (await pool.query(`select "ownerId",visibility from resource_access_policies where kind='bot' and id=$1`, [bot])).rows[0]
    assert.deepEqual(policy, { ownerId: member, visibility: 'shared' })
    assert.deepEqual((await access.botAccess(actor, bot)).subscribers, [], 'the new owner no longer follows their own Bot')
    await rejects(access.transferBotOwnership(actor, bot, owner), 'validationGeneric')
    await rejects(updateOwnedBot(me, { botId: bot, alias: 'mine' }), 'botNotFound')
  })

  await t.test('a Slack thread started with bot=<alias> keeps its Bot, while the Bot is still the owner\'s', async () => {
    const threads = await import('../lib/slack/thread-bots')
    const bot = await seedBot(pool, ws.id, owner, 'Slack routed')
    const thread = { linkId: randomUUID(), channelId: 'C123', threadTs: '1700000000.000100' }
    assert.equal(await threads.slackThreadBot(pool, thread, owner, ws.id), null)
    await threads.rememberSlackThreadBot(pool, thread, owner, bot)
    assert.equal(await threads.slackThreadBot(pool, thread, owner, ws.id), bot)
    assert.equal(await threads.slackThreadBot(pool, { ...thread, threadTs: '1700000000.000200' }, owner, ws.id), null, 'another thread')
    assert.equal(await threads.slackThreadBot(pool, thread, owner, other.id), null, 'another workspace')
    assert.equal(await threads.slackThreadBot(pool, thread, member, ws.id), null, 'another person')
    const moved = await seedBot(pool, ws.id, owner, 'Slack moved')
    await threads.rememberSlackThreadBot(pool, thread, owner, moved)
    assert.equal(await threads.slackThreadBot(pool, thread, owner, ws.id), moved, 'a later alias moves the thread')
    await pool.query('update bots set "archivedAt"=now() where id=$1', [moved])
    assert.equal(await threads.slackThreadBot(pool, thread, owner, ws.id), null, 'an archived Bot no longer answers')
  })

  await t.test('the backfill moves each retired repository into an Environment, once', async () => {
    const fresh = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const listed = await seedBot(pool, ws.id, owner, 'Legacy listed')
    const appended = await seedBot(pool, ws.id, owner, 'Legacy appended')
    const invalid = await seedBot(pool, ws.id, owner, 'Legacy invalid')
    const lonely = await seedBot(pool, fresh.id, owner, 'Legacy lonely')
    const chosen = await seedBot(pool, ws.id, owner, 'Legacy chosen')
    await pool.query(`update bots set repository=$2,"environmentId"=null where id=$1`, [listed, 'Acme/API'])
    await pool.query(`update bots set repository=$2,"environmentId"=null where id=$1`, [appended, 'acme/new-repo'])
    await pool.query(`update bots set repository=$2,"environmentId"=null where id=$1`, [invalid, 'not a repository'])
    await pool.query(`update bots set repository=$2,"environmentId"=null where id=$1`, [lonely, 'acme/solo'])
    await pool.query(`update bots set repository=$2,"environmentId"=$3 where id=$1`, [chosen, 'acme/other', apiEnv])
    const first = await backfillBotEnvironments(pool, pool, { batch: 2 })
    assert.ok(first.bound >= 3 && first.created >= 1 && first.skipped >= 1, JSON.stringify(first))
    assert.equal((await row(listed)).environmentId, apiEnv, 'the Environment that already lists it')
    assert.equal((await row(appended)).environmentId, defaultEnv, 'else the workspace default, which gains it')
    const keys = (await pool.query(`select configuration->'repositoryKeys' as keys,"updatedBy" from workspace_environments where id=$1`, [defaultEnv])).rows[0]
    assert.deepEqual(keys, { keys: ['v2/github.com/acme/web', 'v2/github.com/acme/new-repo'], updatedBy: MIGRATION_ACTOR })
    assert.equal((await row(invalid)).environmentId, null, 'a value that is no repository stays for a person to fix')
    const made = (await row(lonely)).environmentId
    assert.deepEqual((await pool.query(`select name,configuration->'repositoryKeys' as keys from workspace_environments where id=$1`, [made])).rows[0], { name: 'Default', keys: ['v2/github.com/acme/solo'] })
    assert.equal((await row(chosen)).environmentId, apiEnv, 'a Bot that already has an Environment keeps it')
    assert.equal((await row(listed)).repository, 'Acme/API', 'the retired column stays for rollback')
    const again = await backfillBotEnvironments(pool, pool)
    assert.equal(again.bound + again.created, 0, 'a second deploy changes nothing')
    assert.equal((await pool.query(`select count(*)::int as n from workspace_environments where "workspaceId"=$1`, [fresh.id])).rows[0].n, 1)
  })
})
