// Every turn the Coordinator and every Bot are told the allowed models (优先使用的模型) before they dispatch, and the
// host takes only those: against a real PostgreSQL, through composeEveInstructions and the dispatch steps. Model ids are
// fixtures standing for what an account reported.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { connectGitHub, githubAppStub } from './support/github-app-stub'

process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'

test('allowed models: every entry in every Bot\'s cached prompt, and a model outside the list queues nothing', { skip: !dbUrl }, async t => {
  process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'
  process.env.MIKKA_BYOS_ENABLED = '1'
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { composeEveInstructions } = await import('../lib/coordinator/product-instructions')
  const order = await import('../lib/model-order')
  const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
  const github = githubAppStub()
  github.install('octo/repo', { contents: 'write', pull_requests: 'write' })
  const users: string[] = []
  t.after(async () => {
    github.restore()
    for (const table of ['coordinator_events', 'agent_runs', 'agents', 'repository_settings', 'github_repository_installations', 'account']) await pool.query(`DELETE FROM ${table} WHERE "userId" = ANY($1)`, [users])
    for (const table of ['model_order_entries', 'model_order_settings', 'byos_bindings', 'byos_connections', 'devices']) await pool.query(`DELETE FROM ${table} WHERE "ownerId" = ANY($1)`, [users])
    // The app's own pools are shared with the next test, which ends them.
    await pool.end()
  })

  const userId = await seedUser(pool, 'model-list')
  users.push(userId)
  const githubAccountId = String(9_300_000 + Math.floor(Math.random() * 1000))
  await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), githubAccountId, userId])
  github.allowWriter('octo/repo', githubAccountId)
  await connectGitHub(github, userId, githubAccountId, ['octo/repo'])
  const ws = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }])
  const scope = { ownerId: userId, workspaceId: ws.id }
  // Two subscriptions, five models between them: more than the three the prompt used to show.
  const subscribe = async (provider: 'claude' | 'codex', models: string[]) => {
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-subject',$7,$8)`,
      [connection, userId, ws.id, provider, `synthetic-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models }),
        JSON.stringify({ vendor: provider === 'claude' ? 'claude_code' : 'codex', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: null }] })])
    for (const model of models) await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,$5,$6)`,
      [randomUUID(), userId, ws.id, connection, provider === 'codex' ? 'codex_cpa' : 'claude_cpa', model])
    return connection
  }
  const codex = await subscribe('codex', ['fx-codex-a', 'fx-codex-b', 'fx-codex-c'])
  const claude = await subscribe('claude', ['fx-claude-a', 'fx-claude-b'])
  // The person put all five in 优先使用的模型.
  const entries = [...['fx-codex-a', 'fx-codex-b', 'fx-codex-c'].map(model => ({ harness: 'codex' as const, model, source: { kind: 'subscription' as const, connectionId: codex } })),
    ...['fx-claude-a', 'fx-claude-b'].map(model => ({ harness: 'claude_code' as const, model, source: { kind: 'subscription' as const, connectionId: claude } }))]
  for (const entry of entries) await order.changeOrder(pool, scope, { kind: 'add', entries: [entry] })
  // The first add stored the untouched list, a default for each Agent (decision 2026-11-05-0400) with fx-claude-a first:
  // the person drags it into their order.
  const stored = (await order.readOrder(pool, scope)).entries
  await order.changeOrder(pool, scope, { kind: 'reorder', ids: entries.map(entry => stored.find(row => row.model === entry.model)!.id) })
  // Codex first in the prompt as in the stored list: the prompt lists them in dispatch order (decision 2026-11-05-0400).
  await order.changeOrder(pool, scope, { kind: 'preferred', harness: 'codex' })
  await order.changeOrder(pool, scope, { kind: 'location', location: 'local' })
  // A computer whose Codex reported fx-codex-a and fx-codex-b.
  const deviceId = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Fixture Mac','local','laptop',true,now(),$3)`,
    [deviceId, userId, JSON.stringify([{ harness: 'codex', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'a', model: 'fx-codex-a', name: 'A' }, { slot: 'b', model: 'fx-codex-b', name: 'B' }] }])])
  await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [randomUUID(), userId, deviceId, `codex-${deviceId.slice(0, 8)}`])
  // A legacy computer without subscription injection still needs an update.
  const oldId = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses,"createdAt") VALUES ($1,$2,'Old Mac','local','laptop',true,now(),$3,now()-interval '1 day')`,
    [oldId, userId, JSON.stringify([{ harness: 'codex', installed: true, subscriptionBroker: false }])])
  await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [randomUUID(), userId, oldId, `codex-${oldId.slice(0, 8)}`])
  const listed = (await order.readOrder(pool, scope)).entries.map(entry => `${entry.harness}:${entry.model}`)
  assert.deepEqual(listed, entries.map(entry => `${entry.harness}:${entry.model}`))

  const coordinator = await chatBotId(userId, null, ws.id)
  const bot = await seedBot(pool, ws.id, userId)

  await t.test('the Coordinator and a Bot both get the whole list, in the cached prefix, byte for byte the same on the next turn', async () => {
    for (const botId of [coordinator, bot]) {
      const instructions = await composeEveInstructions(userId, botId)
      const head = instructions.indexOf('Allowed models (优先使用的模型), in the order a new thread tries them')
      assert.ok(head >= 0, `the list reaches ${botId === bot ? 'the Bot' : 'the Coordinator'}`)
      const lines = instructions.slice(head).split('\n').slice(1, 6)
      assert.deepEqual(lines.map(line => line.replace(/^\d+\. \S+(?: \S+)? \((\w+)\) (\S+) .*$/, '$1:$2')), listed, 'every entry, in order')
      // Each entry describes Agent/injection readiness independently of model reports.
      const old = 'Old Mac (computer): its Mikka needs subscription injection support'
      assert.equal(lines[0], `1. Codex (codex) fx-codex-a · codex subscription · runs on: Fixture Mac (computer) · not on: ${old}`)
      assert.equal(lines[2], `3. Codex (codex) fx-codex-c · codex subscription · runs on: Fixture Mac (computer) · not on: ${old}`)
      assert.equal(lines[3], '4. Claude Code (claude_code) fx-claude-a · claude subscription · runs on: nowhere yet · not on: Fixture Mac (computer): Agent not installed; Old Mac (computer): Agent not installed')
      assert.equal(await composeEveInstructions(userId, botId), instructions, 'unchanged product context is stable across turns')
    }
  })

  const runs = async () => (await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [userId])).rows[0].n as number

  await t.test('dispatch_run: a model outside the list, even one an account offers, is refused and nothing is queued', async () => {
    const issueId = await seedIssue(pool, userId, ws.id)
    // A numbered task, so its thread gets a publication branch.
    await pool.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"number":7}}}' WHERE id=$1`, [issueId])
    const dispatch = (model: { harness: 'codex' | 'claude_code'; model?: string }) => steps.dispatchRun(userId, { issueId, repo: 'octo/repo', model, requestKey: `dispatch:${randomUUID()}` }, undefined, coordinator)
    const unknown = await dispatch({ harness: 'codex', model: 'fx-not-offered' }) as { error: string; allowed: { harness: string; model: string }[] }
    assert.equal(unknown.error, 'modelNotAllowed')
    assert.deepEqual(unknown.allowed.map(item => `${item.harness}:${item.model}`), listed)
    // Removed from the list, still offered by the account: refused all the same.
    const view = await order.orderView(pool, scope)
    await order.changeOrder(pool, scope, { kind: 'remove', id: view.entries.find(entry => entry.model === 'fx-codex-b')!.id })
    assert.equal((await dispatch({ harness: 'codex', model: 'fx-codex-b' }) as { error: string }).error, 'modelNotAllowed')
    assert.equal(await runs(), 0, 'nothing is queued')
    // A listed model runs.
    const queued = await dispatch({ harness: 'codex', model: 'fx-codex-a' }) as { status?: string; error?: string }
    assert.equal(queued.status, 'queued', JSON.stringify(queued))
    assert.deepEqual((await pool.query('SELECT "agentDefinition"->>\'model\' AS model,"deviceId" FROM agent_runs WHERE "userId"=$1', [userId])).rows, [{ model: 'fx-codex-a', deviceId }], 'only the computer with subscription injection')
    // An allowed model absent from CLI shortcuts runs exactly as selected.
    const other = await seedIssue(pool, userId, ws.id)
    await pool.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"number":8}}}' WHERE id=$1`, [other])
    const unreported = await steps.dispatchRun(userId, { issueId: other, repo: 'octo/repo', model: { harness: 'codex', model: 'fx-codex-c' }, requestKey: `dispatch:${randomUUID()}` }, undefined, coordinator) as { status?: string; runId?: string; error?: string }
    assert.equal(unreported.status, 'queued', JSON.stringify(unreported))
    const admitted = (await pool.query(`SELECT "agentDefinition"->>'model' AS model,"deviceId" FROM agent_runs WHERE id=$1`, [unreported.runId])).rows[0]
    assert.deepEqual(admitted, { model: 'fx-codex-c', deviceId })
    assert.equal(await runs(), 2)
  })

  await t.test('dispatch_bot_computer: a model outside the list is refused before anything is queued', async () => {
    const before = await runs()
    const issueId = await seedIssue(pool, userId, ws.id)
    const refused = await steps.dispatchComputerThread(userId, { botId: bot, issueId, harness: 'codex', model: 'fx-not-offered' }, `call-${randomUUID()}`) as { error: string; allowed: unknown[] }
    assert.equal(refused.error, 'modelNotAllowed')
    assert.ok(refused.allowed.length > 0)
    assert.equal(await runs(), before)
  })
})

test('an untouched list keeps each Agent\'s default order over connected models, dispatched where an Agent can receive its credentials; nothing connected is noModels', { skip: !dbUrl }, async t => {
  process.env.MIKKA_BYOS_ENABLED = '1'
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const order = await import('../lib/model-order')
  const { defaultOrderByAgent, dispatchOrder } = await import('../lib/model-order-plan')
  const { resolveModelDispatch } = await import('../lib/model-dispatch')
  const { executionContextParts } = await import('../lib/coordinator/execution-context')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const users: string[] = []
  t.after(async () => {
    for (const table of ['agents']) await pool.query(`DELETE FROM ${table} WHERE "userId" = ANY($1)`, [users])
    for (const table of ['model_order_entries', 'model_order_settings', 'byos_bindings', 'byos_connections', 'devices']) await pool.query(`DELETE FROM ${table} WHERE "ownerId" = ANY($1)`, [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    // Untouched: 运行位置 stays 云端, and with no E2B key a run goes to a computer.
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    return { ownerId: id, workspaceId: ws.id, botId: await seedBot(pool, ws.id, id) }
  }
  const subscribe = async (scope: { ownerId: string; workspaceId: string }, provider: 'claude' | 'codex', models: string[]) => {
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-subject',$7,$8)`,
      [connection, scope.ownerId, scope.workspaceId, provider, `synthetic-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models }),
        JSON.stringify({ vendor: provider === 'claude' ? 'claude_code' : 'codex', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: null }] })])
    for (const model of models) await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,$5,$6)`,
      [randomUUID(), scope.ownerId, scope.workspaceId, connection, provider === 'codex' ? 'codex_cpa' : 'claude_cpa', model])
  }
  const computer = async (ownerId: string, name: string, harnesses: object[]) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,$3,'local','laptop',true,now(),$4)`, [id, ownerId, name, JSON.stringify(harnesses)])
    for (const info of harnesses as { harness: string }[]) await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), ownerId, id, info.harness, `${info.harness}-${id.slice(0, 8)}`])
    return id
  }
  const promptList = async (scope: { ownerId: string; botId: string }) => (await executionContextParts(scope.ownerId, scope.botId)).models

  await t.test('untouched: each Agent\'s default prefix and expanded models; the prompt and dispatch use the preferred Agent\'s list first', async () => {
    const p = await person('default-list')
    await subscribe(p, 'claude', ['fx-sonnet', 'fx-opus'])
    await subscribe(p, 'codex', ['fx-codex-top', 'fx-codex-mini'])
    const prefix = defaultOrderByAgent(await order.orderCandidates(pool, p)).map(item => `${item.harness}:${item.model}`)
    assert.deepEqual(prefix, ['claude_code:fx-opus', 'codex:fx-codex-top'])
    const expected = [...prefix, 'claude_code:fx-sonnet', 'codex:fx-codex-mini']
    const stored = await order.readOrder(pool, p)
    assert.equal(stored.customized, false)
    assert.deepEqual(stored.entries.map(entry => `${entry.harness}:${entry.model}`), expected)
    const lines = (await promptList(p)).split('\n').slice(1)
    assert.deepEqual(lines.map(line => line.replace(/^\d+\. \S+(?: \S+)? \((\w+)\) (\S+) .*$/, '$1:$2')),
      dispatchOrder(stored.entries, stored.preferredHarness).map(entry => `${entry.harness}:${entry.model}`))
    // The credential’s first model runs even when the local report only lists Sonnet.
    const mac = await computer(p.ownerId, 'Mac', [{ harness: 'claude_code', installed: true, subscriptionBroker: true, models: ['fx-sonnet'] }, { harness: 'codex', installed: true, subscriptionBroker: true, models: ['fx-codex-top'] }])
    const target = await resolveModelDispatch(pool, p)
    assert.deepEqual(target.kind === 'device' && [target.deviceId, target.model], [mac, 'fx-opus'])
  })

  await t.test('nothing connected: the list is empty and dispatch refuses with noModels', async () => {
    const p = await person('nothing-connected')
    await computer(p.ownerId, 'Mac', [{ harness: 'claude_code', installed: true, subscriptionBroker: true, models: ['fx-opus'] }])
    assert.deepEqual((await order.readOrder(pool, p)).entries, [])
    assert.match(await promptList(p), /^Allowed models \(优先使用的模型\): none yet\./)
    const target = await resolveModelDispatch(pool, p)
    assert.deepEqual(target.kind === 'none' && target.reason, 'noModels')
  })

  await t.test('a daemon without subscription injection needsUpdate, regardless of model reports', async () => {
    const p = await person('default-old-daemon')
    await subscribe(p, 'claude', ['fx-opus'])
    await computer(p.ownerId, 'Old Mac', [{ harness: 'claude_code', installed: true, subscriptionBroker: false }])
    const target = await resolveModelDispatch(pool, p)
    assert.equal(target.kind, 'none')
    assert.equal(target.kind === 'none' && target.card.description, 'Old Mac 的 Mikka 需要更新')
    assert.match(await promptList(p), /fx-opus · claude subscription · runs on: nowhere yet · not on: Old Mac \(computer\): its Mikka needs subscription injection support$/)
  })
})
