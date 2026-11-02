// 模型与订阅 › 允许使用的模型 against real PostgreSQL (decision 2026-11-02-1400):
// an untouched list is the default preference over what the person has, every
// change is stored under a per-scope lock, an add must be one of the person's
// candidates, and dispatch takes the first model that can run now, on a
// device that takes part (参与调度) and reported it, or says why nothing can.
// Model ids are fixtures standing for what an account or CLI reported.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { dbUrl, seedUser, seedWorkspace, useUpFreeMessages } from './support/workspace-admin-db'
// Subscription chats answer only on validated routes (lib/subscription-routes.ts); these tests run with both on.
process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'

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
    // The catalogue as the account listed it (refreshBotModels stores the same): its order is the account's.
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog") VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-subject',$7)`,
      [connection, scope.ownerId, scope.workspaceId, provider, `synthetic-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models })])
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [connection, allowance(provider)])
    for (const model of models) await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,$5,$6)`,
      [randomUUID(), scope.ownerId, scope.workspaceId, connection, provider === 'codex' ? 'codex_cpa' : 'claude_cpa', model])
    return connection
  }
  const allowance = (provider: 'claude' | 'codex', used = .2) => JSON.stringify({ vendor: provider === 'claude' ? 'claude_code' : 'codex', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })
  /**
   * One of the person's devices, its CLI's report, and an Agent per installed
   * harness. Its daemon takes subscription runs (subscriptionBroker) unless the
   * report says otherwise, as a current local daemon does.
   */
  const device = async (ownerId: string, harnesses: object[], enabled = true, over: { name?: string; online?: boolean; server?: boolean; joinedMinutesAgo?: number } = {}) => {
    const id = randomUUID()
    const report = harnesses.map(info => ({ subscriptionBroker: true, ...info }))
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses,"deviceType","createdAt") VALUES ($1,$2,$5,'local',$3,$6,$4,$7,$8)`,
      [id, ownerId, enabled, JSON.stringify(report), over.name ?? 'Laptop', over.online === false ? new Date(Date.now() - 3_600_000) : new Date(),
        over.server ? 'server' : 'laptop', new Date(Date.now() - (over.joinedMinutesAgo ?? 0) * 60_000)])
    const agents: Record<string, string> = {}
    for (const info of harnesses as { harness: string }[]) {
      agents[info.harness] = randomUUID()
      await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)', [agents[info.harness], ownerId, id, info.harness, `${info.harness}-${id.slice(0, 6)}`])
    }
    return { id, agents }
  }

  await t.test('a new binding can dispatch before Settings is opened: probe null/stale quota once, and keep paid keys out after a failed check', async () => {
    const scope = await person('order-first-dispatch')
    const ctx = { ...scope, botId: null }
    const connection = await subscribe(scope, 'claude', ['claude-opus-5-5', 'claude-sonnet-5-5'])
    const mac = await device(scope.ownerId, [{ harness: 'claude_code', installed: true }])
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [connection])
    let probes = 0
    const refreshQuota = async (checked: { ownerId: string; workspaceId: string }, id: string) => {
      assert.deepEqual(checked, ctx)
      assert.equal(id, connection)
      probes++
      await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1 AND "ownerId"=$3', [id, allowance('claude'), scope.ownerId])
    }
    const first = await resolveModelDispatch(pool, { ...scope, botId: null }, undefined, undefined, undefined, { refreshQuota })
    assert.deepEqual(first.kind === 'device' && [first.deviceId, first.model], [mac.id, 'claude-opus-5-5'])
    assert.equal(probes, 1)
    const candidates = await order.orderCandidates(pool, scope)
    const entries = candidates.map((candidate, at) => ({ ...candidate, id: String(at) }))
    await pool.query(`UPDATE byos_connections SET quota=jsonb_set(quota,'{observedAt}',to_jsonb((now()-interval '61 seconds')::text)) WHERE id=$1`, [connection])
    const states = await order.credentialStates(pool, ctx, entries, candidates, undefined, { refresh: refreshQuota })
    assert.equal(probes, 2, 'two model entries refresh their one connection once')
    assert.ok([...states.values()].every(state => state.credential.usable))
    const key = await keys.addApiKey(pool, scope.ownerId, { provider: 'deepseek', apiKey: `sk-${randomBytes(12).toString('hex')}` }, { fetch: (async () => Response.json({ data: [{ id: 'key-fallback' }] })) as unknown as typeof fetch })
    await order.changeOrder(pool, scope, { kind: 'add', entries: [{ harness: 'claude_code', model: 'key-fallback', source: { kind: 'api_key', keyId: key.id } }] })
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [connection])
    const { pointsFallback } = await import('../lib/points-fallback')
    assert.equal(await pointsFallback(pool, scope), null, 'an unconfirmed subscription must not silently charge the later key when Mikka points run out')
    const failed = await resolveModelDispatch(pool, { ...scope, botId: null }, undefined, undefined, undefined, { refreshQuota: async () => { probes++; throw new Error('fixture unavailable') } })
    assert.deepEqual([failed.kind, failed.kind === 'none' && failed.reason], ['none', 'checking'])
    assert.equal(probes, 3)
    assert.equal((await order.orderView(pool, scope)).entries[0].block?.reason, 'checking')
    const checked = await order.checkOrderQuota(pool, scope, connection, async (checkedScope, id, _signal, owner) => {
      assert.deepEqual(checkedScope, scope)
      assert.equal(owner, scope.ownerId)
      await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [id, allowance('claude')])
    })
    assert.equal(checked.entries[0].block, null, 'the explicit retry persists new allowance and returns the same real readiness projection')
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [connection])
    const revoked = await order.credentialStates(pool, scope, entries, candidates, undefined, { refresh: async () => {
      await pool.query('UPDATE byos_connections SET paused=true,quota=$2 WHERE id=$1', [connection, allowance('claude')])
    } })
    assert.ok([...revoked.values()].every(state => !state.credential.usable && state.credential.reason === 'paused'), 'a pause during the provider read wins over its new quota')
    const stranger = await person('order-probe-stranger')
    const foreign = await subscribe(stranger, 'claude', ['claude-opus-5-5'])
    const forged = { id: 'foreign', harness: 'claude_code' as const, model: 'claude-opus-5-5', source: { kind: 'subscription' as const, connectionId: foreign } }
    const denied = await order.credentialStates(pool, scope, [forged], [{ ...forged, provider: 'claude', name: forged.model }], undefined, { refresh: async () => { throw new Error('a foreign connection reached quota probe') } })
    assert.deepEqual(denied.get(forged.id)?.credential, { usable: false, reason: 'missing' })
    await assert.rejects(order.checkOrderQuota(pool, scope, foreign, async () => { throw new Error('foreign retry reached quota probe') }), { code: 'executionAccountUnavailable' })
  })

  await t.test('an untouched list: opus, then the first Codex model reported, else the first model anything reported; nothing is stored', async () => {
    const scope = await person('order-default')
    const claude = await subscribe(scope, 'claude', ['acct-sonnet-a', 'acct-opus-a'])
    await subscribe(scope, 'codex', ['acct-codex-top', 'acct-codex-next'])
    const view = await order.orderView(pool, scope)
    assert.equal(view.customized, false)
    assert.deepEqual(view.entries.map(entry => [entry.harness, entry.model]), [['claude_code', 'acct-opus-a'], ['codex', 'acct-codex-top']])
    assert.deepEqual(view.entries[0].source, { kind: 'subscription', connectionId: claude })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM model_order_entries WHERE "ownerId"=$1', [scope.ownerId])).rows[0].n, 0)
    assert.equal(view.candidates.length, 4)
    // Only a ChatGPT subscription: its Codex model.
    const chatgptOnly = await person('order-default-chatgpt')
    await subscribe(chatgptOnly, 'codex', ['acct-codex-top', 'acct-codex-next'])
    assert.deepEqual((await order.orderView(pool, chatgptOnly)).entries.map(entry => [entry.harness, entry.model]), [['codex', 'acct-codex-top']])
    // Only a DeepSeek key: DeepSeek's first reported model, on the key.
    const deepseekOnly = await person('order-default-deepseek')
    const key = await keys.addApiKey(pool, deepseekOnly.ownerId, { provider: 'deepseek', apiKey: `sk-${randomBytes(12).toString('hex')}` }, { fetch: (async () => Response.json({ data: [{ id: 'key-deepseek-first' }, { id: 'key-deepseek-second' }] })) as unknown as typeof fetch })
    const deepseekView = await order.orderView(pool, deepseekOnly)
    assert.deepEqual(deepseekView.entries.map(entry => [entry.model, entry.source]), [['key-deepseek-first', { kind: 'api_key', keyId: key.id }]])
  })

  await t.test('no points for Mikka 默认: the next allowed model a chat can run on, in the person\'s order', async () => {
    const { hostedPointsRefusal, pointsFallback, hostedPointsHere } = await import('../lib/points-fallback')
    const scope = await person('order-points')
    // A new workspace with nothing bought or verified: its free messages first (TRIAL_MESSAGES), then refused for points.
    assert.equal(await hostedPointsRefusal(scope.workspaceId), null)
    assert.deepEqual(await hostedPointsHere(scope.workspaceId), { points: 0, trialLeft: 20 }, 'the menu lists Mikka 默认 with its free messages')
    await useUpFreeMessages(pool, scope.workspaceId, scope.ownerId)
    assert.equal(await hostedPointsRefusal(scope.workspaceId), 'verification_required')
    assert.deepEqual(await hostedPointsHere(scope.workspaceId), { points: 0, trialLeft: 0 }, 'the menu leaves Mikka 默认 out')
    assert.equal(await pointsFallback(pool, scope), null, 'nothing else to run on')
    const claude = await subscribe(scope, 'claude', ['acct-opus-p'])
    const key = await keys.addApiKey(pool, scope.ownerId, { provider: 'deepseek', apiKey: `sk-${randomBytes(12).toString('hex')}` }, { fetch: (async () => Response.json({ data: [{ id: 'key-deepseek-p' }] })) as unknown as typeof fetch })
    const binding = (await pool.query('SELECT id FROM byos_bindings WHERE "connectionId"=$1 AND "modelId"=$2', [claude, 'acct-opus-p'])).rows[0].id
    assert.deepEqual(await pointsFallback(pool, scope), { kind: 'subscription', bindingId: binding, model: 'acct-opus-p' }, 'the first allowed model')
    // The subscription is out of quota: the next one, the key.
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [claude, allowance('claude', 1)])
    // The untouched list holds only opus here (decision 2026-11-02-1400): the key is not allowed, so nothing runs.
    assert.equal(await pointsFallback(pool, scope), null, 'a key not in 允许使用的模型 is never used')
    const candidate = (await order.orderView(pool, scope)).candidates.find(item => item.source.kind === 'api_key')!
    await order.changeOrder(pool, scope, { kind: 'add', entries: [{ harness: candidate.harness, model: candidate.model, source: candidate.source }] })
    assert.deepEqual(await pointsFallback(pool, scope), { kind: 'api_key', keyId: key.id, model: 'key-deepseek-p' }, 'once added, the key is next')
    const keyEntry = (await order.orderView(pool, scope)).entries.find(entry => entry.source.kind === 'api_key')!
    await order.changeOrder(pool, scope, { kind: 'remove', id: keyEntry.id })
    assert.equal(await pointsFallback(pool, scope), null)
    // Points bought: Mikka 默认 runs, no fallback asked for.
    await pool.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",bucket,points,reason,"externalId") VALUES ($1,$2,'purchased',100,'pack',$3)`, [randomUUID(), scope.workspaceId, `points-${randomUUID()}`])
    assert.equal(await hostedPointsRefusal(scope.workspaceId), null)
    assert.deepEqual(await hostedPointsHere(scope.workspaceId), { points: 100, trialLeft: 0 }, 'the menu shows what this workspace can spend')
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
    // No computer connected yet: no device can run it, and the card says so.
    const empty = await resolveModelDispatch(pool, ctx)
    assert.deepEqual([empty.kind === 'none' && empty.reason, empty.kind === 'none' && empty.card.description], ['noDevice', '还没有连接电脑'])
    const off = await device(scope.ownerId, [{ harness: 'claude_code', installed: true, modelSlots: [{ slot: 'top', model: 'acct-opus-c', name: 'Top' }] }], false)
    assert.equal((await resolveModelDispatch(pool, ctx)).kind, 'none', '参与调度 off: never picked')
    const mac = await device(scope.ownerId, [{ harness: 'claude_code', installed: true, modelSlots: [{ slot: 'top', model: 'acct-opus-c', name: 'Top' }, { slot: 'mid', model: 'acct-sonnet-c', name: 'Mid' }] }])
    const first = await resolveModelDispatch(pool, ctx)
    assert.deepEqual(first.kind === 'device' && [first.deviceId, first.agentId, first.model], [mac.id, mac.agents.claude_code, 'acct-opus-c'])
    assert.notEqual(first.kind === 'device' && first.deviceId, off.id)
    // The run's subscription is the entry's: the Agent's latest binding is that account and model.
    const bound = (await pool.query('SELECT id,"connectionId"::text AS c,"modelId" FROM byos_bindings WHERE "consumerId"=$1 ORDER BY "createdAt" DESC LIMIT 1', [mac.agents.claude_code])).rows[0]
    assert.deepEqual([bound.c, bound.modelId], [claude, 'acct-opus-c'])
    assert.equal(first.kind === 'device' && first.subscriptionBindingId, bound.id, 'dispatch carries the exact binding, independently of its CLI model slot')
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
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [claude, allowance('claude', 1)])
    const spent = await resolveModelDispatch(pool, ctx)
    assert.deepEqual([spent.kind, spent.kind === 'none' && spent.reason], ['none', 'unavailable'], 'one account for both: both used up')
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [claude])
    // The subscription switched off (启用 off): its models read 订阅已停用 and nothing runs on them.
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [claude])
    assert.deepEqual((await order.orderView(pool, scope)).entries.map(entry => entry.block?.reason), ['paused', 'paused'])
    assert.equal((await resolveModelDispatch(pool, ctx)).kind, 'none')
    await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [claude])
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [claude, allowance('claude')])
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
    assert.equal(named.kind === 'device' && named.model, 'acct-sonnet-c')
    // The thread's model is the only one tried; it never falls back to the list, which has a model that runs (opus).
    const notOffered = await resolveModelDispatch(pool, ctx, { harness: 'codex', model: 'acct-opus-c' })
    assert.deepEqual([notOffered.kind, notOffered.kind === 'none' && notOffered.reason, notOffered.kind === 'none' && notOffered.card.description], ['none', 'notOffered', '没有订阅或 Key 能用 Codex 跑 acct-opus-c'])
    // Only the Agent named (「派给 Codex」): the DeepSeek key speaks the OpenAI protocol too, so it offers its model on Codex
    // (decision 2026-11-02-1620); no computer here has Codex, so the card says so for that model.
    const noCodex = await resolveModelDispatch(pool, ctx, { harness: 'codex' })
    assert.deepEqual([noCodex.kind === 'none' && noCodex.reason, noCodex.kind === 'none' && noCodex.card.description], ['pickedNoDevice', '没有电脑能用 Codex 跑 key-model-c'])
    // With only a Claude subscription nothing offers Codex at all, so the card names the Agent alone.
    const claudeOnlyPerson = await person('order-dispatch-claude-only')
    await subscribe(claudeOnlyPerson, 'claude', ['acct-opus-d'])
    const nothingOnCodex = await resolveModelDispatch(pool, { ...claudeOnlyPerson, botId: null }, { harness: 'codex' })
    assert.deepEqual([nothingOnCodex.kind === 'none' && nothingOnCodex.reason, nothingOnCodex.kind === 'none' && nothingOnCodex.card.description], ['notOffered', '没有订阅或 Key 能用 Codex'])
    // Only Claude Code named: its first model in the list, the same one the list would run.
    const claudeOnly = await resolveModelDispatch(pool, ctx, { harness: 'claude_code' })
    assert.equal(claudeOnly.kind === 'device' && claudeOnly.entry.harness, 'claude_code')
    const byList = await resolveModelDispatch(pool, ctx)
    assert.equal(claudeOnly.kind === 'device' && claudeOnly.model, byList.kind === 'device' && byList.model)
    await subscribe(scope, 'codex', ['acct-codex-z'])
    // Codex connected but not in the list: its first offered model, and the card says what keeps it from running.
    const codexOnly = await resolveModelDispatch(pool, ctx, { harness: 'codex' })
    assert.deepEqual([codexOnly.kind === 'none' && codexOnly.reason, codexOnly.kind === 'none' && codexOnly.card.description], ['pickedNoDevice', '没有电脑能用 Codex 跑 acct-codex-z'])
    const noComputer = await resolveModelDispatch(pool, ctx, { harness: 'codex', model: 'acct-codex-z' })
    assert.deepEqual([noComputer.kind === 'none' && noComputer.reason, noComputer.kind === 'none' && noComputer.card.description, noComputer.kind === 'none' && noComputer.card.options.map(option => option.action)],
      ['pickedNoDevice', '没有电脑能用 Codex 跑 acct-codex-z', ['connectServer', 'modelSettings']])
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [claude])
    const paused = await resolveModelDispatch(pool, ctx, { harness: 'claude_code', model: 'acct-sonnet-c' })
    assert.deepEqual([paused.kind === 'none' && paused.reason, paused.kind === 'none' && paused.card.description], ['pickedUnavailable', 'Claude Code 的 acct-sonnet-c 暂时不可用'])
    await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [claude])
    // 云端 without the person's E2B key: the card says so.
    const cloud = await resolveModelDispatch(pool, ctx, null, 'cloud')
    assert.deepEqual([cloud.kind, cloud.kind === 'none' && cloud.reason, cloud.kind === 'none' && cloud.card.options.map(option => option.action)], ['none', 'cloudNotConfigured', ['e2bKey', 'modelSettings']])
    // An emptied list: noModels.
    for (const entry of (await order.orderView(pool, scope)).entries) await order.changeOrder(pool, scope, { kind: 'remove', id: entry.id })
    const none = await resolveModelDispatch(pool, ctx)
    assert.deepEqual([none.kind, none.kind === 'none' && none.reason], ['none', 'noModels'])
  })

  await t.test('a named computer fixes where, not which model: the thread\'s own model, else the list in order, among what it runs; else it says what it lacks', async () => {
    const scope = await person('order-named')
    await subscribe(scope, 'claude', ['acct-opus-n'])
    const chatgpt = await subscribe(scope, 'codex', ['acct-codex-n'])
    const ctx = { ...scope, botId: null }
    // The list (untouched): Claude Code's opus, then Codex.
    assert.deepEqual((await order.orderView(pool, scope)).entries.map(entry => [entry.harness, entry.model]), [['claude_code', 'acct-opus-n'], ['codex', 'acct-codex-n']])
    const both = await device(scope.ownerId, [
      { harness: 'claude_code', installed: true, modelSlots: [{ slot: 'top', model: 'acct-opus-n', name: 'Top' }] },
      { harness: 'codex', installed: true, modelSlots: [{ slot: 'acct-codex-n', model: 'acct-codex-n', name: 'acct-codex-n' }] },
    ])
    const codexOnly = await device(scope.ownerId, [{ harness: 'codex', installed: true, modelSlots: [{ slot: 'acct-codex-n', model: 'acct-codex-n', name: 'acct-codex-n' }] }])
    const claudeOnly = await device(scope.ownerId, [{ harness: 'claude_code', installed: true, modelSlots: [{ slot: 'top', model: 'acct-opus-n', name: 'Top' }] }])
    // Named computer and the thread's own Codex model: Codex runs it there, though the list starts with Claude Code.
    const asked = await resolveModelDispatch(pool, ctx, { harness: 'codex', model: 'acct-codex-n' }, undefined, both.id)
    assert.deepEqual(asked.kind === 'device' && [asked.deviceId, asked.agentId, asked.entry.harness, asked.entry.source], [both.id, both.agents.codex, 'codex', { kind: 'subscription', connectionId: chatgpt }])
    // Named computer that lacks Codex: refused with what it lacks; Claude Code is never put in its place.
    const lacking = await resolveModelDispatch(pool, ctx, { harness: 'codex', model: 'acct-codex-n' }, undefined, claudeOnly.id)
    assert.deepEqual([lacking.kind, lacking.kind === 'none' && lacking.reason, lacking.kind === 'none' && lacking.card.description], ['none', 'namedDevice', '这台电脑没装 Codex'])
    // No model of the thread's own: the list in order, the first this computer runs (Codex here; opus first elsewhere).
    const listed = await resolveModelDispatch(pool, ctx, null, undefined, codexOnly.id)
    assert.deepEqual(listed.kind === 'device' && [listed.deviceId, listed.entry.harness, listed.model], [codexOnly.id, 'codex', 'acct-codex-n'])
    const first = await resolveModelDispatch(pool, ctx, null, undefined, both.id)
    assert.deepEqual(first.kind === 'device' && [first.deviceId, first.entry.harness], [both.id, 'claude_code'])
    // Its Codex installed and reporting other models: the subscription's model runs there all the same.
    const elsewhere = await device(scope.ownerId, [{ harness: 'codex', installed: true, modelSlots: [{ slot: 'other', model: 'other-model', name: 'other' }] }])
    const unreported = await resolveModelDispatch(pool, ctx, { harness: 'codex', model: 'acct-codex-n' }, undefined, elsewhere.id)
    assert.deepEqual(unreported.kind === 'device' && [unreported.deviceId, unreported.model], [elsewhere.id, 'acct-codex-n'])
    // Its Mikka too old to take a subscription run (no subscriptionBroker): it says so.
    const old = await device(scope.ownerId, [{ harness: 'codex', installed: true, subscriptionBroker: false }])
    const stale = await resolveModelDispatch(pool, ctx, { harness: 'codex', model: 'acct-codex-n' }, undefined, old.id)
    assert.equal(stale.kind === 'none' && stale.card.description, '这台电脑的 Mikka 需要更新')
    // A model of the thread's own that no subscription or key offers on that Agent (a DeepSeek key runs on Claude Code): refused, not swapped.
    const notOffered = await resolveModelDispatch(pool, ctx, { harness: 'codex', model: 'deepseek-flash' }, undefined, both.id)
    assert.deepEqual([notOffered.kind, notOffered.kind === 'none' && notOffered.card.description], ['none', '没有订阅或 Key 能用 Codex 跑 deepseek-flash'])
    // 运行位置 云端 does not move a run the person pinned to a computer.
    await order.changeOrder(pool, scope, { kind: 'location', location: 'cloud' })
    assert.equal((await resolveModelDispatch(pool, ctx, null, undefined, codexOnly.id)).kind, 'device')
  })

  await t.test('a subscription model runs on a computer that takes subscription runs, whether or not its CLI reported the model; else the row says what is missing', async () => {
    // Production 2026-11-02: Claude Max connected, 本地, two computers online and taking part, Claude Code installed, no models reported.
    const scope = await person('order-unreported')
    await subscribe(scope, 'claude', ['acct-opus-u'])
    const ctx = { ...scope, botId: null }
    const row = async () => (await order.orderView(pool, scope)).entries[0].block
    assert.deepEqual(await row(), { reason: 'noDevice', device: { why: 'none' } })
    await device(scope.ownerId, [{ harness: 'claude_code', installed: true }], false, { name: 'MacBook Pro' })
    assert.deepEqual(await row(), { reason: 'noDevice', device: { why: 'off', device: 'MacBook Pro', count: 1 } })
    await device(scope.ownerId, [{ harness: 'claude_code', installed: true }], true, { name: 'Server', online: false })
    assert.deepEqual(await row(), { reason: 'noDevice', device: { why: 'offline', device: 'Server', count: 1 } })
    await device(scope.ownerId, [{ harness: 'codex', installed: true }], true, { name: 'Linux box' })
    assert.deepEqual(await row(), { reason: 'noDevice', device: { why: 'notInstalled', device: 'Linux box', count: 1 } })
    const old = await device(scope.ownerId, [{ harness: 'claude_code', installed: true, subscriptionBroker: false }], true, { name: 'Old Mac' })
    assert.deepEqual(await row(), { reason: 'noDevice', device: { why: 'needsUpdate', device: 'Old Mac', count: 1 } })
    const card = await resolveModelDispatch(pool, ctx)
    assert.deepEqual([card.kind === 'none' && card.reason, card.kind === 'none' && card.card.description], ['noDevice', 'Old Mac 的 Mikka 需要更新'])
    const mac = await device(scope.ownerId, [{ harness: 'claude_code', installed: true }], true, { name: 'Mac' })
    assert.equal(await row(), null, '可用')
    const run = await resolveModelDispatch(pool, ctx)
    assert.deepEqual(run.kind === 'device' && [run.deviceId, run.agentId, run.model], [mac.id, mac.agents.claude_code, 'acct-opus-u'])
    assert.notEqual(run.kind === 'device' && run.deviceId, old.id, 'a daemon that cannot take a subscription run is never picked for one')
  })

  await t.test('本地: a server before a computer, then the least busy, then the one that joined first; 会先用 names the same device dispatch picks', async () => {
    const scope = await person('order-server-first')
    await subscribe(scope, 'claude', ['acct-opus-s'])
    const ctx = { ...scope, botId: null }
    const claude = [{ harness: 'claude_code', installed: true }]
    const mac = await device(scope.ownerId, claude, true, { name: 'Mac', joinedMinutesAgo: 600 })
    let view = await order.orderView(pool, scope)
    assert.equal(view.firstDevice, 'Mac', 'only a computer: it')
    const server = await device(scope.ownerId, claude, true, { name: 'instance-a', server: true, joinedMinutesAgo: 60 })
    const later = await device(scope.ownerId, claude, true, { name: 'instance-b', server: true, joinedMinutesAgo: 30 })
    view = await order.orderView(pool, scope)
    const run = await resolveModelDispatch(pool, ctx)
    assert.deepEqual([view.firstDevice, run.kind === 'device' && run.deviceId], ['instance-a', server.id], 'a server before the computer that joined first; of two idle servers, the earlier')
    // A run not yet ended on instance-a: the idle server takes the next one; an ended run does not count.
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId",status) VALUES ($1,$2,$3,$4,'running')`, [randomUUID(), scope.ownerId, server.agents.claude_code, server.id])
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId",status) VALUES ($1,$2,$3,$4,'succeeded'),($5,$2,$6,$7,'succeeded')`,
      [randomUUID(), scope.ownerId, later.agents.claude_code, later.id, randomUUID(), later.agents.claude_code, later.id])
    view = await order.orderView(pool, scope)
    const next = await resolveModelDispatch(pool, ctx)
    assert.deepEqual([view.firstDevice, next.kind === 'device' && next.deviceId], ['instance-b', later.id])
    // Both servers offline: the computer.
    await pool.query(`UPDATE devices SET "lastSeenAt"=now()-interval '1 hour' WHERE id = ANY($1)`, [[server.id, later.id]])
    view = await order.orderView(pool, scope)
    const fallback = await resolveModelDispatch(pool, ctx)
    assert.deepEqual([view.firstDevice, fallback.kind === 'device' && fallback.deviceId], ['Mac', mac.id])
    // Nothing can run: no 会先用.
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [mac.id])
    assert.equal((await order.orderView(pool, scope)).firstDevice, null)
  })

  await t.test('移出列表 then 撤销 puts the model back where it was; 设备 › 能跑 lists the allowed models each computer can run', async () => {
    const scope = await person('order-undo')
    const claude = await subscribe(scope, 'claude', ['acct-opus-u2', 'acct-sonnet-u2', 'acct-haiku-u2'])
    const source = { kind: 'subscription' as const, connectionId: claude }
    await order.changeOrder(pool, scope, { kind: 'add', entries: [{ harness: 'claude_code', model: 'acct-sonnet-u2', source }, { harness: 'claude_code', model: 'acct-haiku-u2', source }] })
    let view = await order.orderView(pool, scope)
    assert.deepEqual(view.entries.map(entry => entry.model), ['acct-opus-u2', 'acct-sonnet-u2', 'acct-haiku-u2'])
    await order.changeOrder(pool, scope, { kind: 'remove', id: view.entries[1].id })
    await order.changeOrder(pool, scope, { kind: 'add', at: 1, entries: [{ harness: 'claude_code', model: 'acct-sonnet-u2', source }] })
    view = await order.orderView(pool, scope)
    assert.deepEqual(view.entries.map(entry => entry.model), ['acct-opus-u2', 'acct-sonnet-u2', 'acct-haiku-u2'], 'back in its place')
    await order.changeOrder(pool, scope, { kind: 'add', at: 99, entries: [{ harness: 'claude_code', model: 'acct-sonnet-u2', source }] })
    assert.equal((await order.orderView(pool, scope)).entries.length, 3, 'already listed: nothing added')
    await assert.rejects(order.changeOrder(pool, scope, { kind: 'add', at: -1, entries: [{ harness: 'claude_code', model: 'acct-opus-u2', source }] }))
    // 能跑: whatever 参与调度 and online say (they have their own lines), the allowed models each computer's Agents can run.
    const mac = await device(scope.ownerId, [{ harness: 'claude_code', installed: true }], false, { name: 'Mac', online: false })
    const codexBox = await device(scope.ownerId, [{ harness: 'codex', installed: true }], true, { name: 'codex-box' })
    const old = await device(scope.ownerId, [{ harness: 'claude_code', installed: true, subscriptionBroker: false }], true, { name: 'old' })
    view = await order.orderView(pool, scope)
    assert.deepEqual([view.deviceModels[mac.id], view.deviceModels[codexBox.id], view.deviceModels[old.id]],
      [['acct-opus-u2', 'acct-sonnet-u2', 'acct-haiku-u2'], [], []])
  })

  await t.test('优先使用的 Agent and a row\'s Agent: a DeepSeek model both Agents run goes on the preferred one; a row switches; 0 credentials for the empty state', async () => {
    const empty = await person('order-agent-empty')
    assert.equal((await order.orderView(pool, empty)).credentials, 0, 'nothing connected: the empty state asks to connect one (C8)')
    const scope = await person('order-agent')
    await subscribe(scope, 'claude', ['acct-opus-p'])
    const deepseek = await keys.addApiKey(pool, scope.ownerId, { provider: 'deepseek', apiKey: `sk-${randomBytes(12).toString('hex')}` }, { fetch: (async () => Response.json({ data: [{ id: 'ds-a' }, { id: 'ds-b' }] })) as unknown as typeof fetch })
    const key = { kind: 'api_key' as const, keyId: deepseek.id }
    let view = await order.orderView(pool, scope)
    assert.deepEqual([view.preferredHarness, view.credentials], ['claude_code', 2])
    assert.deepEqual(view.entries.map(entry => [entry.model, entry.harness, entry.agents]), [['acct-opus-p', 'claude_code', ['claude_code']]], 'a two-Agent key adds no Codex model to the default')
    // An untouched list follows the preferred Agent at read time: Codex has the DeepSeek model now.
    await order.changeOrder(pool, scope, { kind: 'preferred', harness: 'codex' })
    view = await order.orderView(pool, scope)
    assert.deepEqual([view.preferredHarness, view.customized, view.entries.map(entry => [entry.model, entry.harness])], ['codex', false, [['acct-opus-p', 'claude_code'], ['ds-a', 'codex']]])
    // A stored list: rows of two-Agent models on the old preferred Agent move with it; one-Agent rows stay.
    await order.changeOrder(pool, scope, { kind: 'add', entries: [{ harness: 'codex', model: 'ds-b', source: key }] })
    await order.changeOrder(pool, scope, { kind: 'preferred', harness: 'claude_code' })
    view = await order.orderView(pool, scope)
    assert.deepEqual(view.entries.map(entry => [entry.model, entry.harness, entry.agents.length]), [['acct-opus-p', 'claude_code', 1], ['ds-a', 'claude_code', 2], ['ds-b', 'claude_code', 2]])
    // One row's Agent: switched, then refused where the model is not offered or would be listed twice.
    const dsA = view.entries[1]
    await order.changeOrder(pool, scope, { kind: 'harness', id: dsA.id, harness: 'codex' })
    view = await order.orderView(pool, scope)
    assert.deepEqual(view.entries.map(entry => [entry.model, entry.harness]), [['acct-opus-p', 'claude_code'], ['ds-a', 'codex'], ['ds-b', 'claude_code']], 'same place in the list')
    await assert.rejects(order.changeOrder(pool, scope, { kind: 'harness', id: view.entries[0].id, harness: 'codex' }), { code: 'executionModelUnknown' }, 'a Claude subscription model has no Codex')
    await order.changeOrder(pool, scope, { kind: 'add', entries: [{ harness: 'claude_code', model: 'ds-a', source: key }] })
    view = await order.orderView(pool, scope)
    await assert.rejects(order.changeOrder(pool, scope, { kind: 'harness', id: view.entries[1].id, harness: 'claude_code' }), { code: 'executionRuleOrderInvalid' }, 'already listed on that Agent')
    // Dispatch takes the row's own Agent.
    await device(scope.ownerId, [{ harness: 'codex', installed: true }], true, { name: 'codex-only' })
    await order.changeOrder(pool, scope, { kind: 'reorder', ids: [view.entries[1].id, view.entries[0].id, view.entries[2].id, view.entries[3].id] })
    const run = await resolveModelDispatch(pool, { ...scope, botId: null })
    assert.deepEqual(run.kind === 'device' && [run.entry.model, run.entry.harness, run.entry.source], ['ds-a', 'codex', key])
  })
})
