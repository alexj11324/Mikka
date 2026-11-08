import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import { dbUrl, seedUser, seedWorkspace, seedBot, seedIssue } from './support/workspace-admin-db'
import { dropTestDatabase } from './support/drop-test-database'
import { templateModelsFixture } from './support/template-models'
import { orderMigrations } from '../scripts/migration-order.mjs'

type Run = typeof import('../lib/db/schema').agentRuns.$inferSelect
type Phase = { calls: number; statements: number; rows: number; jsonBytes: number; repeatedRunReads: number }
type Socket = { bytesRead: number; bytesWritten: number }
const empty = (): Phase => ({ calls: 0, statements: 0, rows: 0, jsonBytes: 0, repeatedRunReads: 0 })

test('cloud locked run Profile: fresh authority and normal Task database budget', { skip: !dbUrl, timeout: 120_000 }, async t => {
  assert.ok(dbUrl)
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  const database = 'claim_locked_run_' + randomUUID().replaceAll('-', '') + '_e2e'
  await admin.query('CREATE DATABASE "' + database + '" TEMPLATE template0')
  console.info(JSON.stringify({ event: 'claim_locked_run_owned_database', database }))
  const target = new URL(dbUrl); target.pathname = '/' + database
  const saved = Object.fromEntries(['E2E_DATABASE_URL', 'DATABASE_URL', 'MIKKA_DATABASE_URL', 'MIKKA_BYOS_ENABLED', 'MIKKA_BYOS_VALIDATED_MODEL_ROUTES'].map(k => [k, process.env[k]]))
  const pool = new Pool({ connectionString: target.toString(), max: 6, options: '-c statement_timeout=15000 -c lock_timeout=5000' })
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  t.after(async () => {
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0)
    await admin.end()
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  })
  const migrations = new URL('../drizzle/', import.meta.url)
  for (const file of orderMigrations((await readdir(migrations)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(file, migrations), 'utf8'))
  Object.assign(process.env, { E2E_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), MIKKA_DATABASE_URL: target.toString(), MIKKA_BYOS_ENABLED: '1', MIKKA_BYOS_VALIDATED_MODEL_ROUTES: 'claude_cpa,codex_cpa' })
  const runtime = await import('../lib/subscription-runtime')
  let allowanceCalls = 0
  t.mock.module(new URL('../lib/subscription-runtime.ts', import.meta.url).href, { namedExports: {
    ...runtime,
    subscriptionRuntime: () => ({
      member: runtime.authorizeSubscriptionWorkspace, workspace: runtime.authorizeSubscriptionWorkspace,
      allowance: async (_owner: string, connection: string) => {
        allowanceCalls++
        await pool.query('UPDATE byos_connections SET quota=jsonb_set(quota,\'{observedAt}\',to_jsonb($2::text)) WHERE id=$1', [connection, new Date().toISOString()])
      },
    }),
  } })
  let externalRequests = 0
  t.mock.method(globalThis, 'fetch', async () => { externalRequests++; throw new Error('This fixture permits no external request') })
  const [{ pool: app }, { workspacePool: workspace }, profiles, { bindAgentToConnection }, { queueCloudRun }, claims, { rebindExecutionDevice }, { authorizedClaimResponse }] = await Promise.all([
    import('../lib/db'), import('../lib/workspace-db'), import('../lib/factory/agent-profile'),
    import('../lib/model-dispatch'), import('../lib/computer/queue-run'), import('../lib/computer/claim'),
    import('../lib/execution-identity'), import('../lib/run-claim-response'),
  ])
  appPool = app; workspacePool = workspace
  const template = templateModelsFixture(['claude-haiku-5-5', 'gpt-6-luna']); t.after(() => template.restore())
  const profileStore = new profiles.AgentProfileStore(pool)
  const clients = new Set<PoolClient>()
  const wrapped = new WeakSet<PoolClient>()
  let active: { phase: string; phases: Record<string, Phase>; sockets: Map<Socket, { read: number; written: number }> } | undefined
  const socket = (client: PoolClient) => (client as unknown as { connection: { stream: Socket } }).connection.stream
  const wrap = (client: PoolClient) => {
    clients.add(client)
    if (wrapped.has(client)) return
    wrapped.add(client)
    const query = client.query
    client.query = new Proxy(query, { apply(fn, self, args) {
      const sample = active
      if (!sample) return Reflect.apply(fn, self, args)
      const wire = socket(client)
      if (!sample.sockets.has(wire)) sample.sockets.set(wire, { read: wire.bytesRead, written: wire.bytesWritten })
      const phase = sample.phases[sample.phase] ??= empty()
      phase.calls++
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text
      if (text === 'SELECT * FROM agent_runs WHERE id=$1') phase.repeatedRunReads++
      const record = (result: QueryResult | QueryResult[]) => {
        const results = Array.isArray(result) ? result : [result]
        phase.statements += results.length
        for (const item of results) {
          phase.rows += item?.rows?.length ?? 0
          if (item?.rows?.length) phase.jsonBytes += Buffer.byteLength(JSON.stringify(item.rows))
        }
      }
      const callback = args.at(-1)
      if (typeof callback === 'function') return Reflect.apply(fn, self, [...args.slice(0, -1), (error: unknown, result: QueryResult) => {
        if (!error) record(result); else phase.statements++
        return callback(error, result)
      }])
      const pending = Reflect.apply(fn, self, args)
      return pending instanceof Promise ? pending.then(result => { record(result); return result }, error => { phase.statements++; throw error }) : pending
    } }) as typeof client.query
  }
  for (const p of [pool, appPool, workspacePool]) {
    for (const c of (p as unknown as { _clients: PoolClient[] })._clients) wrap(c)
    p.on('connect', wrap)
  }
  const measure = async <T>(name: string, operation: (phase: (name: string) => void) => Promise<T>) => {
    assert.equal(active, undefined)
    const sample = { phase: 'start', phases: {} as Record<string, Phase>, sockets: new Map<Socket, { read: number; written: number }>() }
    for (const client of clients) { const s = socket(client); sample.sockets.set(s, { read: s.bytesRead, written: s.bytesWritten }) }
    active = sample
    try { return { value: await operation(name => { sample.phase = name }), sample } }
    finally {
      active = undefined
      const wire = [...sample.sockets].reduce((sum, [s, before]) => ({ read: sum.read + s.bytesRead - before.read, written: sum.written + s.bytesWritten - before.written }), { read: 0, written: 0 })
      t.diagnostic(JSON.stringify({ event: 'claim_locked_run_wire', name, phases: sample.phases,
        actualPostgresWire: { responseBytes: wire.read, requestBytes: wire.written, totalBytes: wire.read + wire.written },
        providerCalls: externalRequests, scope: 'selection_queue_synthetic_handoff_real_claim_final_response_and_terminal_sql' }))
    }
  }
  const fixture = async (harness: 'claude_code' | 'codex' = 'claude_code') => {
    const ownerId = await seedUser(pool, 'locked-requester'), payer = await seedUser(pool, 'locked-subscriber')
    const { id: workspaceId } = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }, { userId: payer, role: 'member' }])
    const { id: payerWorkspace } = await seedWorkspace(pool, payer, [{ userId: payer, role: 'admin' }])
    const botId = await seedBot(pool, workspaceId, ownerId), issueId = await seedIssue(pool, ownerId, workspaceId)
    const deviceId = randomUUID(), repoId = randomUUID(), agentId = randomUUID(), connection = randomUUID()
    const model = harness === 'claude_code' ? 'claude-haiku-5-5' : 'gpt-6-luna'
    const actor = { userId: ownerId, workspaceId }, scope = { ownerId, workspaceId, botId }
    await pool.query('INSERT INTO user_e2b_keys ("userId",ciphertext,iv,"keyVersion",last4) VALUES ($1,\'synthetic-unopened\',\'synthetic-unopened\',1,\'test\')', [ownerId])
    await pool.query('INSERT INTO model_order_settings ("ownerId","workspaceId",location,customized) VALUES ($1,$2,\'cloud\',true)', [ownerId, workspaceId])
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,\'Fixture\',\'cloud\',true,now(),$3)', [deviceId, ownerId, JSON.stringify([{ harness, installed: true, models: [model], subscriptionBroker: true, computerBroker: true }])])
    await pool.query('INSERT INTO cloud_machines ("workspaceId","ownerId","deviceId","sandboxId","operationId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,\'running\',true)', [workspaceId, ownerId, deviceId, 'synthetic-' + deviceId, randomUUID()])
    await pool.query('INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)', [botId, workspaceId, ownerId])
    await pool.query('INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,\'Fixture\',$3,$4)', [agentId, ownerId, harness, deviceId])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") VALUES ($1,$2,$3,\'v2/github.com/fixture/repository\',\'https://github.com/fixture/repository.git\',\'main\')', [repoId, deviceId, ownerId])
    await pool.query('INSERT INTO bot_cloud_runtimes ("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES ($1,$2,$3,$4,$5,$6)', [botId, workspaceId, ownerId, harness, agentId, repoId])
    const quota = { vendor: harness, source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }
    await pool.query('INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,$4,\'connected\',1,(\'synthetic-\'||$1::uuid::text),$5,\'synthetic-subject\',$6,$7)', [connection, payer, payerWorkspace, harness === 'codex' ? 'codex' : 'claude', 'a'.repeat(64), JSON.stringify({ revision: '1', models: [model] }), JSON.stringify(quota)])
    await pool.query('INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,\'catalogue\',$4,1,$5,$6)', [randomUUID(), payer, payerWorkspace, connection, harness === 'codex' ? 'codex_cpa' : 'claude_cpa', model])
    await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ($1,$2,true)', [payer, workspaceId])
    await pool.query('INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId") VALUES ($1,$2,$3,0,$4,$5,\'subscription\',$6)', [randomUUID(), ownerId, workspaceId, harness, model, connection])
    const profile = await profileStore.create(scope, { name: 'Fixture role', roles: ['execute'], harness, model: { mode: 'fixed', harness, model, source: { kind: 'subscription', connectionId: connection } }, instructions: 'Synthetic Profile instructions', skills: [] })
    const prepare = async (phase: (name: string) => void = () => undefined) => {
      phase('selection')
      const selection = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: profile.id, location: 'cloud', cloudPurpose: 'desktop' })
      assert.equal(selection.target.kind, 'cloud')
      const bindingId = await bindAgentToConnection(pool, scope, agentId, harness, connection, model)
      phase('queue')
      const { runId } = await queueCloudRun(pool, actor, { botId, issueId, agentId, deviceRepoId: repoId, title: 'Inspect repository', body: 'Local fixture only', model, subscriptionBindingId: bindingId, agentProfile: selection.agentProfile, readOnly: true })
      phase('handoff')
      const threadDevice = randomUUID()
      await pool.query('INSERT INTO devices (id,"ownerId",name,kind,enabled) VALUES ($1,$2,\'Fixture thread\',\'cloud\',true)', [threadDevice, ownerId])
      await pool.query('UPDATE thread_machines SET state=\'running\',"deviceId"=$2,"sandboxId"=$3 WHERE "runId"=$1', [runId, threadDevice, 'synthetic-thread-' + runId])
      const row = (await pool.query<Run>('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
      const definition = await rebindExecutionDevice(pool, row, threadDevice, pool)
      assert.ok(definition)
      await pool.query('UPDATE agent_runs SET "deviceId"=$2,"agentDefinition"=$3 WHERE id=$1', [runId, threadDevice, JSON.stringify(definition)])
      return { runId, threadDevice, bindingId, definition, hint: { ...row, deviceId: threadDevice } }
    }
    return { actor, scope, ownerId, payer, workspaceId, profile, prepare, connection }
  }
  const claim = (f: Awaited<ReturnType<typeof fixture>>, run: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['prepare']>>, lease: Date,
    before?: (tx: PoolClient) => Promise<boolean | void>, after?: (tx: PoolClient) => Promise<void>) =>
    claims.claimCloudRun(pool, f.actor, run.runId, run.threadDevice, lease, run.bindingId, before, after, false)
  const unchanged = async (id: string) => {
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [id])).rows[0].status, 'queued')
    assert.equal((await pool.query('SELECT 1 FROM byos_native_runs WHERE "runId"=$1', [id])).rowCount, 0)
  }
  for (const harness of ['claude_code', 'codex'] as const) await t.test('normal shared fixed Profile Task: ' + harness, async () => {
    const f = await fixture(harness), before = allowanceCalls
    const measured = await measure(harness, async phase => {
      const run = await f.prepare(phase), lease = new Date(Date.now() + 60_000)
      phase('claim')
      assert.equal((await claim(f, run, lease))?.ownerId, f.ownerId)
      phase('response_fence')
      const response = await authorizedClaimResponse(f.ownerId, run.hint, lease.toISOString(), current => Response.json({ runId: current.id, profile: current.agentDefinition?.agentProfile?.profileId }))
      assert.equal(response?.status, 200)
      assert.equal((await response!.json()).profile, f.profile.id)
      phase('terminal')
      await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now(),"leaseExpiresAt"=NULL WHERE id=$1', [run.runId])
      await pool.query('DELETE FROM byos_native_runs WHERE "runId"=$1', [run.runId])
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.runId])).rows[0].status, 'succeeded')
      return run
    })
    assert.ok(allowanceCalls > before, 'fresh allowance admission remains before the locked Profile check')
    assert.equal(measured.sample.phases.claim.repeatedRunReads, 0, 'the complete already-locked row is used without a second run read')
    assert.equal(externalRequests, 0)
  })
  await t.test('a beforeClaim write is observed and rolled back on Profile denial', async () => {
    const f = await fixture(), run = await f.prepare()
    await assert.rejects(claim(f, run, new Date(Date.now() + 60_000), async tx => {
      await tx.query('UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",\'{agentProfile,scope,ownerId}\',\'"foreign"\') WHERE id=$1', [run.runId])
    }), { code: 'agentProfileUnavailable' })
    await unchanged(run.runId)
    assert.deepEqual((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [run.runId])).rows[0].agentDefinition, run.definition)
  })
  await t.test('a stop between identity and qualified lock keeps its original missing-row COMMIT', async () => {
    const f = await fixture(), run = await f.prepare()
    await measure('stopped_before_lock', async phase => {
      phase('claim')
      assert.equal(await claim(f, run, new Date(Date.now() + 60_000), async tx => {
        await tx.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [run.runId])
      }), null)
    })
    await unchanged(run.runId)
    assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [run.runId])).rows[0].stopRequestedAt)
  })
  await t.test('later Profile/source reads and final membership fence stay fresh', async () => {
    const f = await fixture(), run = await f.prepare(), lease = new Date(Date.now() + 60_000)
    await assert.rejects(claim(f, run, lease, async tx => {
      await tx.query('UPDATE factory_agent_profiles SET "archivedAt"=now() WHERE id=$1', [f.profile.id])
    }), { code: 'agentProfileUnavailable' })
    await unchanged(run.runId)
    assert.equal((await claim(f, run, lease))?.ownerId, f.ownerId)
    await workspacePool!.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.workspaceId, f.payer])
    let delivered = false
    assert.equal(await authorizedClaimResponse(f.ownerId, run.hint, lease.toISOString(), () => { delivered = true; return Response.json({ ok: true }) }), null)
    assert.equal(delivered, false)
  })
  await t.test('afterClaim failure rolls back both native binding and lease', async () => {
    const f = await fixture(), run = await f.prepare()
    await measure('after_claim_rollback', async phase => {
      phase('claim')
      await assert.rejects(claim(f, run, new Date(Date.now() + 60_000), undefined, async () => { throw new Error('fixture_after_claim') }), { message: 'fixture_after_claim' })
    })
    await unchanged(run.runId)
  })
  await t.test('the same run remains locked through the final claim callback', async () => {
    const f = await fixture(), run = await f.prepare(), other = await pool.connect()
    try {
      const claimed = await claim(f, run, new Date(Date.now() + 60_000), undefined, async () => {
        await other.query('BEGIN')
        try {
          await assert.rejects(other.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT', [run.runId]), { code: '55P03' })
        } finally { await other.query('ROLLBACK') }
      })
      assert.equal(claimed?.ownerId, f.ownerId)
      await other.query('BEGIN')
      assert.equal((await other.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT', [run.runId])).rowCount, 1)
      await other.query('ROLLBACK')
    } finally { other.release() }
  })
  await t.test('generic callers still read current row and Profile state', async () => {
    const f = await fixture(), run = await f.prepare()
    const { assertRunProfileClaim } = await import('../lib/factory/profile-admission')
    const first = await measure('generic_read', async phase => { phase('generic'); await assertRunProfileClaim(pool, run.runId) })
    assert.equal(first.sample.phases.generic.repeatedRunReads, 1)
    await pool.query('UPDATE factory_agent_profiles SET "archivedAt"=now() WHERE id=$1', [f.profile.id])
    await assert.rejects(assertRunProfileClaim(pool, run.runId), { code: 'agentProfileUnavailable' })
  })
  assert.equal(externalRequests, 0)
  t.diagnostic(JSON.stringify({ event: 'claim_locked_run_database_cleanup', database, cleanup: 'drop_and_readback_in_after_hook', productionAcceptance: false }))
})
