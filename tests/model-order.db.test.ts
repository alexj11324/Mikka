// 模型与订阅 › 允许使用的模型 against real PostgreSQL (decision 2026-11-02-1400):
// an untouched list is the default preference over what the person has, every
// change is stored under a per-scope lock, an add must be one of the person's
// candidates, and dispatch takes the first model that can run now, on a
// device that takes part (参与调度) and reported it, or says why nothing can.
// Model ids are fixtures standing for what an account or CLI reported.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('model order: default fill, edits, and dispatch in order', { skip: !dbUrl }, async t => {
  const saved = { key: process.env.WORKSPACE_SECRETS_KEY, byos: process.env.MIKKA_BYOS_ENABLED }
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_BYOS_ENABLED = '1'
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const order = await import('../lib/model-order')
  const { resolveModelDispatch, bindAgentToConnection } = await import('../lib/model-dispatch')
  const keys = await import('../lib/model-api-keys')
  const users: string[] = []
  t.after(async () => {
    for (const [name, value] of [['WORKSPACE_SECRETS_KEY', saved.key], ['MIKKA_BYOS_ENABLED', saved.byos]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value
    await pool.query('DELETE FROM model_order_entries WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_order_settings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_api_keys WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM devices WHERE "ownerId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    return { ownerId: id, workspaceId: ws.id }
  }
  /** A connected subscription whose account catalogue lists `models` (one binding each, as a refresh stores them). */
  const subscribe = async (scope: { ownerId: string; workspaceId: string }, provider: 'claude' | 'codex', models: string[]) => {
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-subject')`,
      [connection, scope.ownerId, scope.workspaceId, provider, `synthetic-${connection}`, 'a'.repeat(64)])
    for (const model of models) await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,$5,$6)`,
      [randomUUID(), scope.ownerId, scope.workspaceId, connection, provider === 'codex' ? 'codex_cpa' : 'claude_cpa', model])
    return connection
  }
  /** One of the person's devices, its CLI's report, and an Agent per installed harness. */
  const device = async (ownerId: string, harnesses: object[], enabled = true) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Laptop','local',$3,now(),$4)`, [id, ownerId, enabled, JSON.stringify(harnesses)])
    const agents: Record<string, string> = {}
    for (const info of harnesses as { harness: string }[]) {
      agents[info.harness] = randomUUID()
      await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)', [agents[info.harness], ownerId, id, info.harness, `${info.harness}-${id.slice(0, 6)}`])
    }
    return { id, agents }
  }

  await t.test('an untouched list is Claude Code\'s opus, then Codex\'s strongest tier, from what the accounts list; nothing is stored', async () => {
    const scope = await person('order-default')
    const claude = await subscribe(scope, 'claude', ['acct-sonnet-a', 'acct-opus-a'])
    await subscribe(scope, 'codex', ['acct-codex-low', 'acct-codex-xhigh'])
    const view = await order.orderView(pool, scope)
    assert.equal(view.customized, false)
    assert.deepEqual(view.entries.map(entry => [entry.harness, entry.model]), [['claude_code', 'acct-opus-a'], ['codex', 'acct-codex-xhigh']])
    assert.deepEqual(view.entries[0].source, { kind: 'subscription', connectionId: claude })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_order_entries WHERE "ownerId"=$1', [scope.ownerId])).rows[0].n, 0)
    assert.equal(view.candidates.length, 4)
  })

  await t.test('edits: the first change stores what was shown; adds must be candidates; reorder, remove and 运行位置 save', async () => {
    const scope = await person('order-edit')
    const claude = await subscribe(scope, 'claude', ['acct-opus-b', 'acct-sonnet-b'])
    const before = await order.orderView(pool, scope)
    await order.changeOrder(pool, scope, { kind: 'add', entries: [{ harness: 'claude_code', model: 'acct-sonnet-b', source: { kind: 'subscription', connectionId: claude } }] })
    let view = await order.orderView(pool, scope)
    assert.equal(view.customized, true)
    assert.deepEqual(view.entries.map(entry => entry.model), ['acct-opus-b', 'acct-sonnet-b'])
    assert.notEqual(view.entries[0].id, before.entries[0].id, 'stored under a real id')
    await assert.rejects(order.changeOrder(pool, scope, { kind: 'add', entries: [{ harness: 'claude_code', model: 'never-reported', source: { kind: 'subscription', connectionId: claude } }] }), { code: 'executionModelUnknown' })
    await assert.rejects(order.changeOrder(pool, scope, { kind: 'add', entries: [{ harness: 'codex', model: 'acct-opus-b', source: { kind: 'subscription', connectionId: claude } }] }), { code: 'executionModelUnknown' }, 'the same model under another Agent is not a candidate')
    await order.changeOrder(pool, scope, { kind: 'reorder', ids: [view.entries[1].id, view.entries[0].id] })
    view = await order.orderView(pool, scope)
    assert.deepEqual(view.entries.map(entry => entry.model), ['acct-sonnet-b', 'acct-opus-b'])
    await assert.rejects(order.changeOrder(pool, scope, { kind: 'reorder', ids: [view.entries[0].id] }), { code: 'executionRuleOrderInvalid' })
    await order.changeOrder(pool, scope, { kind: 'remove', id: view.entries[0].id })
    await order.changeOrder(pool, scope, { kind: 'remove', id: (await order.orderView(pool, scope)).entries[0].id })
    view = await order.orderView(pool, scope)
    assert.deepEqual([view.entries, view.customized], [[], true], 'an emptied list stays empty')
    await order.changeOrder(pool, scope, { kind: 'location', location: 'cloud' })
    assert.equal((await order.orderView(pool, scope)).location, 'cloud')
    // Another person's list is their own.
    const other = await person('order-other')
    assert.equal((await order.orderView(pool, other)).location, 'local')
  })

  await t.test('dispatch: the first model a device that takes part reported; then the next; a thread\'s own model first; nothing says why', async () => {
    const scope = await person('order-dispatch')
    const claude = await subscribe(scope, 'claude', ['acct-opus-c', 'acct-sonnet-c'])
    const ctx = { ...scope, botId: null }
    // Nothing reported anywhere yet: no device can run it.
    assert.deepEqual((await resolveModelDispatch(pool, ctx)).kind === 'none' && (await resolveModelDispatch(pool, ctx) as { reason: string }).reason, 'noDevice')
    const off = await device(scope.ownerId, [{ harness: 'claude_code', installed: true, modelSlots: [{ slot: 'top', model: 'acct-opus-c', name: 'Top' }] }], false)
    assert.equal((await resolveModelDispatch(pool, ctx)).kind, 'none', '参与调度 off: never picked')
    const mac = await device(scope.ownerId, [{ harness: 'claude_code', installed: true, modelSlots: [{ slot: 'top', model: 'acct-opus-c', name: 'Top' }, { slot: 'mid', model: 'acct-sonnet-c', name: 'Mid' }] }])
    const first = await resolveModelDispatch(pool, ctx)
    assert.deepEqual(first.kind === 'device' && [first.deviceId, first.agentId, first.model], [mac.id, mac.agents.claude_code, 'top'])
    assert.notEqual(first.kind === 'device' && first.deviceId, off.id)
    // The run's subscription is the entry's: the Agent's latest binding is that account and model.
    const bound = (await pool.query('SELECT "connectionId"::text AS c,"modelId" FROM byos_bindings WHERE "consumerId"=$1 ORDER BY "createdAt" DESC LIMIT 1', [mac.agents.claude_code])).rows[0]
    assert.deepEqual([bound.c, bound.modelId], [claude, 'acct-opus-c'])
    // Switching back and forth reuses one row per account, revision and model; the last one asked is the latest.
    const agentBindings = async () => (await pool.query<{ modelId: string }>('SELECT "modelId" FROM byos_bindings WHERE "consumerId"=$1 ORDER BY "createdAt" DESC,id DESC', [mac.agents.claude_code])).rows.map(row => row.modelId)
    for (const model of ['acct-sonnet-c', 'acct-opus-c', 'acct-sonnet-c', 'acct-opus-c']) await bindAgentToConnection(pool, scope, mac.agents.claude_code, 'claude_code', claude, model)
    assert.deepEqual(await agentBindings(), ['acct-opus-c', 'acct-sonnet-c'])
    // A reconnect is a new revision: a new row, the old one left as it was for runs frozen on it.
    await pool.query('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1', [claude])
    await bindAgentToConnection(pool, scope, mac.agents.claude_code, 'claude_code', claude, 'acct-opus-c')
    const revisions = (await pool.query<{ r: string }>('SELECT "connectionRevision"::text AS r FROM byos_bindings WHERE "consumerId"=$1 AND "modelId"=$2 ORDER BY "createdAt" DESC', [mac.agents.claude_code, 'acct-opus-c'])).rows.map(row => Number(row.r))
    assert.deepEqual([revisions.length, revisions[0] - revisions[1]], [2, 1])
    await pool.query('UPDATE byos_connections SET epoch=epoch-1 WHERE id=$1', [claude])
    // Used up: the next allowed model.
    await order.changeOrder(pool, scope, { kind: 'add', entries: [{ harness: 'claude_code', model: 'acct-sonnet-c', source: { kind: 'subscription', connectionId: claude } }] })
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [claude, JSON.stringify({ windows: [{ kind: 'five_hour', used: 1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })])
    const spent = await resolveModelDispatch(pool, ctx)
    assert.deepEqual([spent.kind, spent.kind === 'none' && spent.reason], ['none', 'unavailable'], 'one account for both: both used up')
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [claude])
    // The subscription switched off (启用 off): its models read 订阅已停用 and nothing runs on them.
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [claude])
    assert.deepEqual((await order.orderView(pool, scope)).entries.map(entry => entry.block?.reason), ['paused', 'paused'])
    assert.equal((await resolveModelDispatch(pool, ctx)).kind, 'none')
    await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [claude])
    // A key model on Claude Code: any installed Claude Code runs it.
    const key = await keys.addApiKey(pool, scope.ownerId, { provider: 'deepseek', apiKey: `sk-${randomBytes(12).toString('hex')}` }, { fetch: (async () => Response.json({ data: [{ id: 'key-model-c' }] })) as unknown as typeof fetch })
    // The thread's own model goes first.
    const picked = await resolveModelDispatch(pool, ctx, { harness: 'claude_code', model: 'key-model-c' })
    assert.deepEqual(picked.kind === 'device' && [picked.model, picked.entry.source], ['key-model-c', { kind: 'api_key', keyId: key.id }])
    // An entry that names its key runs on that key, not on the first key that lists the model too.
    const second = await keys.addApiKey(pool, scope.ownerId, { provider: 'custom', name: 'Gateway', baseUrl: 'https://gateway.example.com/v1', protocol: 'anthropic', apiKey: `sk-${randomBytes(12).toString('hex')}`, models: ['key-model-c'] },
      { fetch: (async () => Response.json({ data: [] })) as unknown as typeof fetch, resolve: async () => ['93.184.216.34'] })
    assert.notEqual(second.id, key.id)
    const { runCredentialSource } = await import('../lib/run-credential-source')
    const source = (keyId?: string) => runCredentialSource(pool, { ownerId: scope.ownerId, botId: null, harness: 'claude_code', model: 'key-model-c', keyId, botWorkspaceId: null, choiceWorkspaceId: null, subscription: null, localLogin: true })
    assert.equal((await source(second.id)).apiKey?.keyId, second.id)
    assert.equal((await source()).apiKey?.keyId, key.id, 'no key named: the first that lists it')
    assert.equal((await source(randomUUID())).apiKey?.keyId, key.id, 'a key the run may not use is never taken')
    await keys.removeApiKey(pool, scope.ownerId, second.id)
    const named = await resolveModelDispatch(pool, ctx, { harness: 'claude_code', model: 'acct-sonnet-c' })
    assert.equal(named.kind === 'device' && named.model, 'mid')
    // 云端 without the person's E2B key: the card says so.
    const cloud = await resolveModelDispatch(pool, ctx, null, undefined, 'cloud')
    assert.deepEqual([cloud.kind, cloud.kind === 'none' && cloud.reason, cloud.kind === 'none' && cloud.card.options.map(option => option.action)], ['none', 'cloudNotConfigured', ['e2bKey', 'modelSettings']])
    // An emptied list: noModels.
    for (const entry of (await order.orderView(pool, scope)).entries) await order.changeOrder(pool, scope, { kind: 'remove', id: entry.id })
    const none = await resolveModelDispatch(pool, ctx)
    assert.deepEqual([none.kind, none.kind === 'none' && none.reason], ['none', 'noModels'])
  })
})
