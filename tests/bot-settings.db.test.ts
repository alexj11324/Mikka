// 设置 › Bot against a real PostgreSQL (docs/design/bot-settings.md): admins govern 可用模型,
// a bot's owner sets its model and repository from what is allowed, everyone else reads.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('bot settings: workspace model allowlist and personal bot settings', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const botAdmin = await import('../lib/workspace-admin/bots')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
  const install = (userId: string, remoteKey: string) => pool.query('insert into github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") values ($1,$2,\'1\',1,1)', [userId, remoteKey])
  const stored = async (botId: string) => (await pool.query<{ model: string | null; repository: string | null }>('select model, repository from bots where id=$1', [botId])).rows[0]

  const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member'), outsider = await seedUser(pool, 'outsider')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  const repo = `acme/${randomUUID().slice(0, 8)}`, foreignRepo = `other/${randomUUID().slice(0, 8)}`
  await install(member, repo)
  await install(outsider, foreignRepo)
  const memberBot = await seedBot(pool, ws.id, member, 'Member bot')
  const adminBot = await seedBot(pool, ws.id, admin, 'Admin bot')

  await t.test('a workspace that never saved allows every family and has no starting model', async () => {
    assert.deepEqual(await botAdmin.modelPolicy(ws.id), { allowedModels: ['mikka', 'codex', 'claude'], startingModel: null, version: 0, modelGroups: (await botAdmin.modelPolicy(ws.id)).modelGroups })
    assert.equal(await botAdmin.newBotModel(ws.id), 'mikka')
  })

  await t.test('可用模型 is admin-only, needs one family, and the starting model must be allowed', async () => {
    await rejects(botAdmin.saveModelPolicy(member, ws.id, { allowedModels: ['codex'], startingModel: null }), 'workspaceAccessDenied')
    await rejects(botAdmin.saveModelPolicy(outsider, ws.id, { allowedModels: ['codex'], startingModel: null }), 'workspaceAccessDenied')
    await assert.rejects(botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: [], startingModel: null }))
    await assert.rejects(botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['gpt-x' as never], startingModel: null }))
    await rejects(botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka'], startingModel: 'claude' }), 'botModelNotAllowed')
    const saved = await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['claude', 'codex'], startingModel: 'codex', expectedVersion: 0 })
    assert.deepEqual([saved.allowedModels, saved.startingModel, saved.version], [['codex', 'claude'], 'codex', 1], 'stored in menu order')
    assert.equal(await botAdmin.newBotModel(ws.id), 'codex')
    assert.deepEqual((await botAdmin.modelPolicy(other.id)).allowedModels, ['mikka', 'codex', 'claude'], 'per workspace')
    // The database refuses what the action refuses.
    await assert.rejects(pool.query(`update workspace_settings set "allowedModels"='{}' where "workspaceId"=$1`, [ws.id]))
    await assert.rejects(pool.query(`update workspace_settings set "defaultModel"='mikka' where "workspaceId"=$1`, [ws.id]))
  })

  await t.test('optimistic lock: a stale version writes nothing; two admins racing from one version, one wins', async () => {
    const stale = await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka'], startingModel: null, expectedVersion: 0 }).then(() => null, (error: unknown) => error as { code?: string; current?: { version: number; allowedModels: string[] } })
    assert.equal(stale?.code, 'modelPolicyConflict')
    assert.deepEqual([stale?.current?.version, stale?.current?.allowedModels], [1, ['codex', 'claude']])
    const admin2 = await seedUser(pool, 'admin2')
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'admin\',\'active\')', [ws.id, admin2, `${admin2}@example.invalid`])
    const race = await Promise.allSettled([
      botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['codex', 'claude'], startingModel: 'claude', expectedVersion: 1 }),
      botAdmin.saveModelPolicy(admin2, ws.id, { allowedModels: ['mikka', 'codex', 'claude'], startingModel: null, expectedVersion: 1 }),
    ])
    assert.deepEqual(race.map(result => result.status).sort(), ['fulfilled', 'rejected'])
    assert.equal(((race.find(result => result.status === 'rejected') as PromiseRejectedResult).reason as { code?: string }).code, 'modelPolicyConflict')
    const winner = (race.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ version: number; startingModel: string | null }>).value
    assert.equal(winner.version, 2)
    assert.equal((await botAdmin.modelPolicy(ws.id)).startingModel, winner.startingModel)
    // Back to a known state for the next cases.
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['codex', 'claude'], startingModel: 'codex' })
  })

  await t.test("only the bot's owner changes its model and repository, within what the workspace allows", async () => {
    await rejects(botAdmin.saveBotSettings(admin, ws.id, { botId: memberBot, model: 'claude' }), 'botOwnerOnly')
    await rejects(botAdmin.saveBotSettings(outsider, ws.id, { botId: memberBot, model: 'claude' }), 'workspaceAccessDenied')
    await rejects(botAdmin.saveBotSettings(member, other.id, { botId: memberBot, model: 'claude' }), 'workspaceAccessDenied')
    await rejects(botAdmin.saveBotSettings(member, ws.id, { botId: memberBot, model: 'mikka' }), 'botModelNotAllowed')
    await rejects(botAdmin.saveBotSettings(member, ws.id, { botId: memberBot, repository: foreignRepo }), 'botRepositoryUnavailable')
    await assert.rejects(botAdmin.saveBotSettings(member, ws.id, { botId: memberBot, model: 'gpt-x' as never }))
    assert.deepEqual(await stored(memberBot), { model: null, repository: null }, 'refused saves wrote nothing')
    const saved = await botAdmin.saveBotSettings(member, ws.id, { botId: memberBot, model: 'claude', repository: repo })
    assert.deepEqual([saved.canEdit, saved.model, saved.repository, saved.effectiveModel, saved.effectiveRepository, saved.modelUnavailable, saved.repositoryUnavailable], [true, 'claude', repo, 'claude', repo, false, false])
    assert.deepEqual(saved.allowedModels, ['codex', 'claude'])
    assert.deepEqual(saved.repositories, [repo], 'only installations of this workspace')
    // Omitted fields stay; null clears.
    await botAdmin.saveBotSettings(member, ws.id, { botId: memberBot, repository: null })
    assert.deepEqual(await stored(memberBot), { model: 'claude', repository: null })
    await botAdmin.saveBotSettings(member, ws.id, { botId: memberBot, repository: repo })
    // Anyone in the workspace reads it; only the owner may edit.
    const asAdmin = await botAdmin.botSettingsFor(admin, ws.id, memberBot)
    assert.deepEqual([asAdmin.canEdit, asAdmin.model], [false, 'claude'])
    await rejects(botAdmin.botSettingsFor(outsider, ws.id, memberBot), 'workspaceAccessDenied')
    await rejects(botAdmin.botSettingsFor(admin, other.id, memberBot), 'workspaceAccessDenied')
    await rejects(botAdmin.botSettingsFor(member, ws.id, randomUUID()), 'botNotFound')
    // Codex / Claude use the owner's own subscription; only the owner sees which ones are connected.
    assert.deepEqual((await botAdmin.botSettingsFor(member, ws.id, memberBot)).connectedProviders, [])
    await pool.query(`insert into byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject") values ($1,$2,$3,'claude','connected','s1',repeat('a',64),'p1'), ($4,$2,$5,'codex','connected','s2',repeat('b',64),'p2')`, [randomUUID(), member, ws.id, randomUUID(), other.id])
    assert.deepEqual((await botAdmin.botSettingsFor(member, ws.id, memberBot)).connectedProviders, ['claude'], 'only this workspace')
    assert.deepEqual((await botAdmin.botSettingsFor(admin, ws.id, memberBot)).connectedProviders, [], "never another person's accounts")
    // The admin's own bot is theirs to change.
    assert.equal((await botAdmin.saveBotSettings(admin, ws.id, { botId: adminBot, model: 'codex' })).model, 'codex')
  })

  await t.test('a model removed from 可用模型: the bot keeps its choice, runs on the starting model, and comes back when re-allowed', async () => {
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka', 'codex'], startingModel: 'codex' })
    const view = await botAdmin.botSettingsFor(member, ws.id, memberBot)
    assert.deepEqual([view.model, view.effectiveModel, view.modelUnavailable], ['claude', 'codex', true])
    assert.deepEqual(await stored(memberBot), { model: 'claude', repository: repo }, 'never rewritten by the admin save')
    // The owner must pick an allowed model; the stale one cannot be saved again.
    await rejects(botAdmin.saveBotSettings(member, ws.id, { botId: memberBot, model: 'claude' }), 'botModelNotAllowed')
    // Without a starting model the bot falls back to the first allowed family.
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka', 'codex'], startingModel: null })
    assert.equal((await botAdmin.botSettingsFor(member, ws.id, memberBot)).effectiveModel, 'mikka')
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka', 'codex', 'claude'], startingModel: null })
    const back = await botAdmin.botSettingsFor(member, ws.id, memberBot)
    assert.deepEqual([back.effectiveModel, back.modelUnavailable], ['claude', false])
  })

  await t.test('a repository whose installation is gone is reported, not used', async () => {
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [ws.id, member])
    // The member is suspended, so reads go through the admin: the installation no longer counts.
    const view = await botAdmin.botSettingsFor(admin, ws.id, memberBot)
    assert.deepEqual([view.repository, view.effectiveRepository, view.repositoryUnavailable], [repo, null, true])
    await rejects(botAdmin.saveBotSettings(member, ws.id, { botId: memberBot, repository: repo }), 'workspaceAccessDenied')
    await pool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2', [ws.id, member])
  })

  await t.test("a bot save waits for an admin's 可用模型 save on the same workspace (FOR SHARE on the settings row)", async () => {
    const holder = await pool.connect()
    let save: Promise<unknown> = Promise.resolve()
    try {
      await holder.query('begin')
      await holder.query('select 1 from workspace_settings where "workspaceId"=$1 for update', [ws.id])
      let settled = false
      save = botAdmin.saveBotSettings(member, ws.id, { botId: memberBot, model: 'claude' }).finally(() => { settled = true })
      save.catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(settled, false, 'the bot save is blocked while the policy row is being written')
      // The held "admin" removes claude before releasing; the waiting bot save must then refuse it.
      await holder.query(`update workspace_settings set "allowedModels"='{mikka,codex}', "defaultModel"=null where "workspaceId"=$1`, [ws.id])
    } finally {
      await holder.query('commit')
      holder.release()
    }
    await rejects(save, 'botModelNotAllowed')
  })

  await t.test('全部 Bot: every bot with owner and live thread count, read-only', async () => {
    const agent = await seedAgent(pool, member)
    await seedRun(pool, { userId: member, agentId: agent, botId: memberBot, status: 'running', startedAt: new Date() })
    await seedRun(pool, { userId: member, agentId: agent, botId: memberBot, status: 'queued' })
    await seedRun(pool, { userId: member, agentId: agent, botId: memberBot, status: 'succeeded' })
    await seedBot(pool, other.id, outsider, 'Elsewhere')
    const listed = await botAdmin.workspaceBots(ws.id)
    assert.deepEqual(listed.map(bot => [bot.id, bot.status, bot.runningThreads, bot.ownerName]), [[memberBot, 'running', 2, member], [adminBot, 'idle', 0, admin]])
    assert.deepEqual(listed.map(bot => bot.model), ['claude', 'codex'])
  })
})
