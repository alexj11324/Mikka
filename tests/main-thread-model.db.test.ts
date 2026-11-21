import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedBot, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { disposableDatabase } from './helpers/e2e-target.mjs'

if (dbUrl && !disposableDatabase(process.env, dbUrl)) throw Error('Main thread model DB tests require isolated loopback *_e2e targets')

// Decision 2026-11-15-1630: a new task follows the dispatching chat's own
// model, but only a model a thread can run; 「Mikka 默认」 has none.
test('a new task inherits the dispatching chat\'s subscription or API-key model, never 「Mikka 默认」', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const names = ['WORKSPACE_SECRETS_KEY', 'MIKKA_BYOS_ENABLED', 'MIKKA_BYOS_VALIDATED_MODEL_ROUTES'] as const
  const saved = new Map(names.map(name => [name, process.env[name]]))
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_BYOS_ENABLED = '1'
  process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const [{ pool: appPool }, { workspacePool }, keys, { mainThreadModel }] = await Promise.all([
    import('../lib/db'), import('../lib/workspace-db'), import('../lib/model-api-keys'), import('../lib/main-thread-model'),
  ])
  const users: string[] = [], workspaces: string[] = []
  t.after(async () => {
    try {
      await pool.query('DELETE FROM bot_model_choices WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM model_order_entries WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM model_order_settings WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM model_api_keys WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM byos_bindings WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM byos_connections WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM bots WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])
      await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaces])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    } finally {
      await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
      for (const name of names) {
        const value = saved.get(name)
        if (value === undefined) delete process.env[name]; else process.env[name] = value
      }
    }
  })

  const person = async (label: string) => {
    const ownerId = await seedUser(pool, label); users.push(ownerId)
    const { id: workspaceId } = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }]); workspaces.push(workspaceId)
    const botId = await seedBot(pool, workspaceId, ownerId)
    return { ownerId, workspaceId, botId }
  }
  /** A connected subscription with a catalogue binding per model; returns the binding of `model`. */
  const subscribe = async (who: { ownerId: string; workspaceId: string }, provider: 'claude' | 'codex', catalogue: string[], bound: string) => {
    const connectionId = randomUUID()
    const quota = JSON.stringify({ vendor: provider === 'claude' ? 'claude_code' : 'codex', source: 'official', status: 'ok', plan: null,
      observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota)
      VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-main-thread-subject',$7,$8)`,
    [connectionId, who.ownerId, who.workspaceId, provider, `synthetic-main-thread-${connectionId}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: catalogue }), quota])
    const bindingId = randomUUID()
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      VALUES ($1,$2,$3,'catalogue',$4,1,$5,$6)`, [bindingId, who.ownerId, who.workspaceId, connectionId, provider === 'claude' ? 'claude_cpa' : 'codex_cpa', bound])
    return { connectionId, bindingId }
  }
  const choose = (who: { ownerId: string; workspaceId: string }, botKey: string, choice: { bindingId?: string | null; apiKeyId?: string; apiKeyModel?: string; creditsModel?: string }) =>
    pool.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId","apiKeyId","apiKeyModel","creditsModel") VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=EXCLUDED."bindingId","apiKeyId"=EXCLUDED."apiKeyId","apiKeyModel"=EXCLUDED."apiKeyModel","creditsModel"=EXCLUDED."creditsModel"`,
    [who.ownerId, who.workspaceId, botKey, choice.bindingId ?? null, choice.apiKeyId ?? null, choice.apiKeyModel ?? null, choice.creditsModel ?? null])
  const scopeOf = (who: { ownerId: string; workspaceId: string }) => ({ ownerId: who.ownerId, workspaceId: who.workspaceId })

  await t.test('a subscription model the Coordinator chats on is inherited with its Agent', async () => {
    const who = await person('main-thread-subscription')
    const { bindingId } = await subscribe(who, 'claude', ['claude-sonnet-5-5'], 'claude-sonnet-5-5')
    await choose(who, 'coordinator', { bindingId })
    assert.deepEqual(await mainThreadModel(pool, scopeOf(who), null), { harness: 'claude_code', model: 'claude-sonnet-5-5' })
    // A Bot's own chat is its own main thread, independent of the Coordinator's.
    assert.equal(await mainThreadModel(pool, scopeOf(who), who.botId), null, 'a Bot with no choice inherits nothing')
    const codex = await subscribe(who, 'codex', ['gpt-6-sol'], 'gpt-6-sol')
    await choose(who, who.botId, { bindingId: codex.bindingId })
    assert.deepEqual(await mainThreadModel(pool, scopeOf(who), who.botId), { harness: 'codex', model: 'gpt-6-sol' })
  })

  await t.test('an API-key model the chat uses is inherited when a thread can run it', async () => {
    const who = await person('main-thread-api-key')
    const models = (ids: string[]) => (async () => Response.json({ data: ids.map(id => ({ id })) })) as typeof fetch
    const key = await keys.addApiKey(pool, who.ownerId, { provider: 'anthropic', apiKey: `sk-${randomBytes(16).toString('hex')}` }, { env: process.env, fetch: models(['claude-haiku-5-5']) })
    await choose(who, 'coordinator', { apiKeyId: key.id, apiKeyModel: 'claude-haiku-5-5' })
    assert.deepEqual(await mainThreadModel(pool, scopeOf(who), null), { harness: 'claude_code', model: 'claude-haiku-5-5' })
    await choose(who, 'coordinator', { apiKeyId: key.id, apiKeyModel: 'not-offered-by-this-key' })
    assert.equal(await mainThreadModel(pool, scopeOf(who), null), null, 'a key model the key does not offer is not a task candidate')
  })

  await t.test('a Mikka 额度 model is inherited; no choice and a model that is not a task candidate inherit nothing', async () => {
    const who = await person('main-thread-none')
    assert.equal(await mainThreadModel(pool, scopeOf(who), null), null, 'no saved choice')
    await choose(who, 'coordinator', { bindingId: null })
    assert.equal(await mainThreadModel(pool, scopeOf(who), null), null, 'a former 「Mikka 默认」 row reads as no choice')
    // A chat on Mikka 额度 hands its model to the task, on the CLI the model's vendor names (decision 2026-11-15-2000).
    await choose(who, 'coordinator', { creditsModel: 'anthropic/claude-sonnet-5.5' })
    assert.deepEqual(await mainThreadModel(pool, scopeOf(who), null), { harness: 'claude_code', model: 'anthropic/claude-sonnet-5.5' })
    await choose(who, 'coordinator', { creditsModel: 'openai/gpt-5.5' })
    assert.deepEqual(await mainThreadModel(pool, scopeOf(who), null), { harness: 'codex', model: 'openai/gpt-5.5' })
    await choose(who, 'coordinator', { creditsModel: 'deepseek/deepseek-v4-pro' })
    assert.deepEqual(await mainThreadModel(pool, scopeOf(who), null), { harness: 'claude_code', model: 'deepseek/deepseek-v4-pro' })
    // The binding names a model its connection's catalogue no longer lists.
    const stale = await subscribe(who, 'claude', ['claude-opus-5-5'], 'claude-retired-model')
    await choose(who, 'coordinator', { bindingId: stale.bindingId })
    assert.equal(await mainThreadModel(pool, scopeOf(who), null), null)
    // Another person's binding never counts, even if its id is saved.
    const other = await person('main-thread-other')
    const foreign = await subscribe(other, 'claude', ['claude-sonnet-5-5'], 'claude-sonnet-5-5')
    await choose(who, 'coordinator', { bindingId: foreign.bindingId })
    assert.equal(await mainThreadModel(pool, scopeOf(who), null), null)
  })
})
