// 设置 › Bot against a real PostgreSQL (docs/design/bot-settings.md): admins govern 可用模型,
// a bot's owner sets its model and repository from what is allowed, everyone else reads.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('bot settings: workspace model allowlist and personal bot settings', { skip: !dbUrl }, async t => {
  // Codex / Claude bots need the subscription backend and the agent kit; the last case turns them off.
  process.env.MIKKA_BYOS_ENABLED = '1'
  process.env.MIKKA_AGENT_KIT = '1'
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const botAdmin = await import('../lib/workspace-admin/bots')
  const { botRunModelSource } = await import('../lib/bot-runtime-model')
  const { SubscriptionRefusal } = await import('@mikka/protocol/subscription')
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
    assert.equal(await botAdmin.newBotModel(ws.id, member), 'mikka')
  })

  await t.test('可用模型 is admin-only, needs one family, and the starting model must be allowed', async () => {
    await rejects(botAdmin.saveModelPolicy(member, ws.id, { allowedModels: ['codex'], startingModel: null }), 'workspaceAccessDenied')
    await rejects(botAdmin.saveModelPolicy(outsider, ws.id, { allowedModels: ['codex'], startingModel: null }), 'workspaceAccessDenied')
    await assert.rejects(botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: [], startingModel: null }))
    await assert.rejects(botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['gpt-x' as never], startingModel: null }))
    await rejects(botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka'], startingModel: 'claude' }), 'botModelNotAllowed')
    const saved = await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['claude', 'codex'], startingModel: 'codex', expectedVersion: 0 })
    assert.deepEqual([saved.allowedModels, saved.startingModel, saved.version], [['codex', 'claude'], 'codex', 1], 'stored in menu order')
    // The member has no Codex or Claude account connected, so a new bot could not run on either: legacy null.
    assert.equal(await botAdmin.newBotModel(ws.id, member), null)
    // 审计日志: who changed 可用模型, from what to what.
    const audit = (await pool.query('select "actorId", action, category, metadata from workspace_audit_events where "workspaceId"=$1 order by "createdAt"', [ws.id])).rows
    assert.deepEqual(audit, [{ actorId: admin, action: 'workspace.models_changed', category: 'permission', metadata: { fromModels: 'mikka,codex,claude', toModels: 'codex,claude', fromStarting: null, toStarting: 'codex' } }])
    assert.deepEqual((await botAdmin.modelPolicy(other.id)).allowedModels, ['mikka', 'codex', 'claude'], 'per workspace')
    // The database refuses what the action refuses.
    await assert.rejects(pool.query(`update workspace_settings set "allowedModels"='{}' where "workspaceId"=$1`, [ws.id]))
    await assert.rejects(pool.query(`update workspace_settings set "defaultModel"='mikka' where "workspaceId"=$1`, [ws.id]))
  })

  await t.test('optimistic lock: a stale version writes nothing; two admins racing from one version, one wins', async () => {
    const stale = await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka'], startingModel: null, expectedVersion: 0 }).then(() => null, (error: unknown) => error as { code?: string; current?: { version: number; allowedModels: string[] } })
    assert.equal(stale?.code, 'modelPolicyConflict')
    assert.deepEqual([stale?.current?.version, stale?.current?.allowedModels], [1, ['codex', 'claude']])
    assert.equal((await pool.query('select count(*)::int as n from workspace_audit_events where "workspaceId"=$1', [ws.id])).rows[0].n, 1, 'a refused save leaves no audit row')
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
    await pool.query(`insert into byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject") values ($1,$2,$3,'claude','connected',$6,repeat('a',64),'p1'), ($4,$2,$5,'codex','connected',$7,repeat('b',64),'p2')`, [randomUUID(), member, ws.id, randomUUID(), other.id, `s-${randomUUID()}`, `s-${randomUUID()}`])
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

  await t.test("a bot's run uses its owner's model; connecting an account once binds it; never another provider", async () => {
    const refused = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof SubscriptionRefusal && error.code === code)
    const rider = await seedUser(pool, 'rider')
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',\'active\')', [ws.id, rider, `${rider}@example.invalid`])
    const bot = await seedBot(pool, ws.id, rider, 'Rider bot')
    const connect = async (provider: string) => {
      const id = randomUUID()
      await pool.query(`insert into byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject") values ($1,$2,$3,$4,'connected',$5,repeat('c',64),'p')`, [id, rider, ws.id, provider, `s-${id}`])
      return id
    }
    const bindings = async () => (await pool.query<{ id: string; route: string; modelId: string; connectionId: string }>('select id, route, "modelId", "connectionId" from byos_bindings where "consumerId"=$1 order by "createdAt"', [bot])).rows
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka', 'codex', 'claude'], startingModel: null })

    // Claude chosen with no account: saved, nothing bound, the run is refused (the chat and 详情 say 未连接).
    await botAdmin.saveBotSettings(rider, ws.id, { botId: bot, model: 'claude' })
    assert.deepEqual(await bindings(), [])
    assert.deepEqual((await botAdmin.botSettingsFor(rider, ws.id, bot)).connectedProviders, [])
    await refused(botRunModelSource(rider, bot, undefined), 'binding_required')

    // Connecting the account once is enough: the next run binds it and runs with Claude.
    const claudeConnection = await connect('claude')
    const first = await botRunModelSource(rider, bot, undefined)
    const [claudeBinding] = await bindings()
    assert.deepEqual(first, { type: 'subscription', bindingId: claudeBinding.id })
    assert.deepEqual([claudeBinding.route, claudeBinding.modelId, claudeBinding.connectionId], ['claude_cpa', 'claude-sonnet-4-5', claudeConnection])
    assert.deepEqual(await botRunModelSource(rider, bot, undefined), first, 'the live binding is reused')

    // Choosing Codex with a connected account binds it in the same save.
    const codexConnection = await connect('codex')
    await botAdmin.saveBotSettings(rider, ws.id, { botId: bot, model: 'codex' })
    const codexBinding = (await bindings()).find(row => row.route === 'codex_cpa')!
    assert.equal(codexBinding.connectionId, codexConnection)
    assert.deepEqual(await botRunModelSource(rider, bot, undefined), { type: 'subscription', bindingId: codexBinding.id })
    await botAdmin.saveBotSettings(rider, ws.id, { botId: bot, model: 'codex' })
    assert.equal((await bindings()).length, 2, 'saving again creates no second binding')
    // A native CLI route is never a hosted run's model.
    await pool.query(`insert into byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") values ($1,$2,$3,$4,$5,1,'claude_code_cli','m')`, [randomUUID(), rider, ws.id, bot, claudeConnection])

    // Mikka chosen: hosted, even with a subscription selected in the definition.
    await botAdmin.saveBotSettings(rider, ws.id, { botId: bot, model: 'mikka' })
    assert.equal(await botRunModelSource(rider, bot, { type: 'subscription', bindingId: claudeBinding.id }), undefined)
    // Never chosen (legacy bot): the definition's existing subscription keeps running.
    await pool.query('update bots set model=null where id=$1', [bot])
    assert.deepEqual(await botRunModelSource(rider, bot, { type: 'subscription', bindingId: claudeBinding.id }), { type: 'subscription', bindingId: claudeBinding.id })
    // Claude removed from 可用模型: falls back to the starting model, Codex, on its own binding.
    await pool.query('update bots set model=$2 where id=$1', [bot, 'claude'])
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka', 'codex'], startingModel: 'codex' })
    assert.deepEqual(await botRunModelSource(rider, bot, { type: 'subscription', bindingId: claudeBinding.id }), { type: 'subscription', bindingId: codexBinding.id })

    // Disconnecting the account: refused (shown in the chat), never moved to Mikka or another provider.
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka', 'codex', 'claude'], startingModel: null })
    await pool.query(`update byos_connections set state='disconnected', "secretName"=null, "secretDigest"=null where id=$1`, [claudeConnection])
    const error = await botRunModelSource(rider, bot, undefined).then(() => null, (reason: unknown) => reason as Error & { code?: string })
    assert.equal(error?.code, 'binding_required')
    const { parseBotModelRefusal } = await import('../lib/workspace-admin/bot-model-policy')
    assert.deepEqual(parseBotModelRefusal(error?.message), { reason: 'binding_required', family: 'claude' })
    assert.deepEqual((await botAdmin.botSettingsFor(rider, ws.id, bot)).connectedProviders, ['codex'])

    // Mikka disallowed, only Codex allowed: the subscription runs, hosted never does.
    await pool.query('update bots set model=$2 where id=$1', [bot, 'mikka'])
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['codex'], startingModel: null })
    assert.deepEqual(await botRunModelSource(rider, bot, undefined), { type: 'subscription', bindingId: codexBinding.id }, 'a disallowed Mikka falls back to Codex')

    // Without the subscription backend, Codex / Claude are not offered, not accepted, and refuse to run.
    process.env.MIKKA_BYOS_ENABLED = '0'
    try {
      await refused(botRunModelSource(rider, bot, undefined), 'backend_unavailable')
      await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka', 'codex', 'claude'], startingModel: null })
      assert.deepEqual((await botAdmin.botSettingsFor(rider, ws.id, bot)).selectableModels, ['mikka'])
      await rejects(botAdmin.saveBotSettings(rider, ws.id, { botId: bot, model: 'claude' }), 'validationGeneric')
      assert.equal(await botRunModelSource(rider, bot, undefined), undefined)
    } finally {
      process.env.MIKKA_BYOS_ENABLED = '1'
    }
  })

  await t.test('a new bot starts on the first model that can run for its owner here, else null', async () => {
    const owner = await seedUser(pool, 'starter')
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',\'active\')', [ws.id, owner, `${owner}@example.invalid`])
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['mikka', 'codex', 'claude'], startingModel: 'claude' })
    // No Claude account: the starting model cannot run, Mikka (first runnable in menu order) is stored.
    assert.equal(await botAdmin.newBotModel(ws.id, owner), 'mikka')
    await pool.query(`insert into byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject") values ($1,$2,$3,'claude','connected',$4,repeat('d',64),'p')`, [randomUUID(), owner, ws.id, `s-${randomUUID()}`])
    assert.equal(await botAdmin.newBotModel(ws.id, owner), 'claude', 'connected: the starting model stands')
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['codex', 'claude'], startingModel: 'codex' })
    assert.equal(await botAdmin.newBotModel(ws.id, owner), 'claude', 'Codex is not connected: the first runnable allowed family')
    process.env.MIKKA_BYOS_ENABLED = '0'
    try {
      assert.equal(await botAdmin.newBotModel(ws.id, owner), null, 'nothing can run: legacy null')
    } finally {
      process.env.MIKKA_BYOS_ENABLED = '1'
    }
  })

  await t.test("a refused bot turn's error is what the chat's failed-turn alert reads", async () => {
    const { parseBotModelRefusal } = await import('../lib/workspace-admin/bot-model-policy')
    await botAdmin.saveModelPolicy(admin, ws.id, { allowedModels: ['codex'], startingModel: null })
    await pool.query('update bots set model=$2 where id=$1', [adminBot, 'codex'])
    const error = await botRunModelSource(admin, adminBot, undefined).then(() => null, (reason: unknown) => reason as Error & { code?: string })
    assert.equal(error?.code, 'binding_required')
    assert.deepEqual(parseBotModelRefusal(error?.message), { reason: 'binding_required', family: 'codex' })
  })

  await t.test('createBot binds a Codex / Claude bot in the same transaction as the bot row', async () => {
    const { ensureBotSubscriptionBinding } = await import('../lib/bot-subscription-binding')
    const { db } = await import('../lib/db')
    const { bots } = await import('../lib/db/schema')
    const maker = await seedUser(pool, 'maker')
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',\'active\')', [ws.id, maker, `${maker}@example.invalid`])
    await pool.query(`insert into byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject") values ($1,$2,$3,'claude','connected',$4,repeat('e',64),'p')`, [randomUUID(), maker, ws.id, `s-${randomUUID()}`])
    const create = (id: string, fail: boolean) => botAdmin.inAppTransaction(async client => {
      await db.insert(bots).values({ id, ownerId: maker, workspaceId: ws.id, name: `Made ${id.slice(0, 6)}`, model: 'claude' })
      await ensureBotSubscriptionBinding(client, { ownerId: maker, workspaceId: ws.id, botId: id, model: 'claude' })
      if (fail) throw new Error('later step failed')
    })
    const kept = randomUUID(), dropped = randomUUID()
    await create(kept, false)
    await assert.rejects(create(dropped, true), /later step failed/)
    const rows = async (id: string) => Number((await pool.query('select (select count(*) from bots where id=$1) + (select count(*) from byos_bindings where "consumerId"=$1::text) as n', [id])).rows[0].n)
    assert.equal(await rows(kept), 2, 'bot and its binding')
    assert.equal(await rows(dropped), 0, 'both rolled back together')
  })
})
