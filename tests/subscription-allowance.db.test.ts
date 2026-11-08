import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import pg from 'pg'
import { SubscriptionRepository, type ConnectionRow } from '../lib/subscription-repository'
import type { Socket } from 'node:net'
import type { QuotaSnapshot } from '@mikka/protocol'
import { quotaDisplayKey } from '../lib/subscription-quota'
import { SubscriptionService } from '../lib/subscription-service'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('startup allowance preserves current Settings metadata in one epoch-fenced quota write', { skip: !dbUrl }, async t => {
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 })
  const ownerId = await seedUser(pool, 'allowance')
  const workspaceId = (await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])).id
  const ids: string[] = []
  t.after(async () => {
    await pool.query('DELETE FROM byos_connections WHERE id=ANY($1::uuid[])', [ids])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspaceId])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [ownerId])
    await pool.end()
  })
  const fixture = async (provider: 'claude' | 'codex', initialStatus: 'ok' | 'unknown' = 'ok') => {
    const id = randomUUID(); ids.push(id)
    const oldQuota = { vendor: provider === 'claude' ? 'claude_code' : 'codex', source: 'official', status: initialStatus,
      plan: 'Pro', observedAt: new Date(Date.now() - 5_000).toISOString(),
      windows: initialStatus === 'ok' ? [{ kind: 'five_hour', used: .2, resetsAt: '2030-01-01T00:00:00.000Z' }] : [] }
    await pool.query(`INSERT INTO byos_connections
      (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject",quota,"accountLabel")
      VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'fixture-allowance-subject',$7,'kept@example.invalid')`,
    [id, ownerId, workspaceId, provider, `fixture-${id}`, 'a'.repeat(64), JSON.stringify(oldQuota)])
    const statements: string[] = []
    const query = new Proxy(pool.query, { apply(target, _receiver, args) {
      statements.push(typeof args[0] === 'string' ? args[0] : args[0].text)
      return Reflect.apply(target, pool, args)
    } }) as typeof pool.query
    const repository = new SubscriptionRepository({ query })
    const calls: string[] = []
    const body = provider === 'claude'
      ? { five_hour: { utilization: 25, resets_at: '2030-01-01T00:00:00Z' } }
      : { plan_type: 'plus', credits: { has_credits: false, unlimited: false },
        rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1893456000 } } }
    let reply: { status: number; body: unknown; account?: string; plan?: string } = {
      status: 200, body, account: 'fresh@example.invalid', plan: 'Max',
    }
    let during: () => Promise<void> = async () => {}
    const worker = { async call(method: string, input: Record<string, unknown>, signal?: AbortSignal) {
      calls.push(method); assert.deepEqual(input, { revision: 1 })
      await during()
      if (signal?.aborted) throw new Error('fixture cancelled')
      return reply
    } }
    const service = new SubscriptionService(repository, scope => {
      assert.deepEqual(scope, { ownerId, workspaceId, connectionId: id, provider })
      return worker as never
    }, { ready: () => true, nativeIsolation: 'verified_runtime' })
    const row = async () => (await pool.query('SELECT quota,"accountLabel",epoch,state FROM byos_connections WHERE id=$1', [id])).rows[0]
    const budget = (read: number, quotaWrites: number, accountWrites = 0) => {
      assert.equal(statements.filter(sql => /^select id,/i.test(sql)).length, read)
      assert.equal(statements.filter(sql => /update byos_connections set quota=/i.test(sql)).length, quotaWrites)
      assert.equal(statements.filter(sql => /^update byos_connections set "accountLabel"/i.test(sql)).length, accountWrites)
      assert.equal(statements.length, read + quotaWrites + accountWrites, 'no additional database request')
    }
    return { id, oldQuota, calls, service, row, budget,
      setReply: (value: typeof reply) => { reply = value },
      during: (action: () => Promise<void>) => { during = action } }
  }

  await t.test('Claude keeps the plan and account committed during the provider await', async () => {
    const f = await fixture('claude')
    f.during(async () => {
      await pool.query(`UPDATE byos_connections SET quota=jsonb_set(quota,'{plan}','"Enterprise"'::jsonb),
        "accountLabel"='concurrent@example.invalid' WHERE id=$1`, [f.id])
    })
    await f.service.allowance(ownerId, f.id)
    const actual = await f.row()
    assert.deepEqual(f.calls, ['allowance'])
    assert.equal(actual.quota.plan, 'Enterprise', 'use the current database plan, never the pre-await row')
    assert.equal(actual.accountLabel, 'concurrent@example.invalid')
    assert.equal(actual.quota.windows[0].used, .25)
    assert.ok(Date.parse(actual.quota.observedAt) > Date.parse(f.oldQuota.observedAt))
    f.budget(1, 1)
  })

  await t.test('Codex may retain its plan already supplied by the quota response without an account write', async () => {
    const f = await fixture('codex')
    await f.service.allowance(ownerId, f.id)
    const actual = await f.row()
    assert.deepEqual(f.calls, ['allowance'])
    assert.equal(actual.quota.plan, 'Plus')
    assert.equal(actual.accountLabel, 'kept@example.invalid')
    assert.equal(actual.quota.windows[0].used, .25)
    f.budget(1, 1)
  })

  await t.test('known Codex plan without a usable quota projection cannot clear saved metadata', async () => {
    const f = await fixture('codex', 'unknown')
    f.setReply({ status: 200, body: { plan_type: 'plus', rate_limit: {} } })
    await f.service.allowance(ownerId, f.id)
    const actual = await f.row()
    assert.equal(actual.quota.plan, 'Pro')
    assert.equal(actual.quota.status, 'unknown')
    assert.equal(actual.accountLabel, 'kept@example.invalid')
    f.budget(1, 1)
  })

  await t.test('unknown Codex plan cannot replace known Settings metadata', async () => {
    const f = await fixture('codex')
    f.setReply({ status: 200, body: { plan_type: 'untrusted-plan', rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1893456000 } } } })
    await f.service.allowance(ownerId, f.id)
    const actual = await f.row()
    assert.equal(actual.quota.plan, 'Pro')
    assert.equal(actual.accountLabel, 'kept@example.invalid')
    assert.equal(actual.quota.windows[0].used, .25)
    f.budget(1, 1)
  })

  for (const status of [0, 401, 403, 503]) await t.test(`provider status ${status} preserves plan/account while retaining unknown quota`, async () => {
    const f = await fixture('claude', 'unknown')
    f.setReply({ status, body: {} })
    await f.service.allowance(ownerId, f.id)
    const actual = await f.row()
    assert.equal(actual.quota.plan, 'Pro'); assert.equal(actual.accountLabel, 'kept@example.invalid')
    assert.equal(actual.quota.status, 'unknown'); assert.deepEqual(actual.quota.windows, [])
    f.budget(1, 1)
  })

  for (const changed of ['epoch', 'disconnect'] as const) await t.test(`${changed} during the provider read prevents the quota write`, async () => {
    const f = await fixture('claude')
    f.during(async () => {
      await pool.query(changed === 'epoch' ? 'UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1'
        : "UPDATE byos_connections SET state='disconnected' WHERE id=$1", [f.id])
    })
    await f.service.allowance(ownerId, f.id)
    const actual = await f.row()
    assert.deepEqual(actual.quota, f.oldQuota); assert.equal(actual.accountLabel, 'kept@example.invalid')
    f.budget(1, 1)
  })

  await t.test('worker failure and cancellation retain the existing no-write fallback', async () => {
    for (const cancelled of [false, true]) {
      const f = await fixture('claude')
      const controller = new AbortController()
      f.during(async () => { if (cancelled) controller.abort(); else throw new Error('fixture worker unavailable') })
      await f.service.allowance(ownerId, f.id, controller.signal)
      const actual = await f.row()
      assert.deepEqual(actual.quota, f.oldQuota); assert.equal(actual.accountLabel, 'kept@example.invalid')
      f.budget(2, 0)
    }
  })

  await t.test('foreign owner is refused before any provider operation', async () => {
    const f = await fixture('claude')
    await assert.rejects(f.service.allowance('not-the-owner', f.id), { code: 'account_unavailable' })
    assert.deepEqual(f.calls, [])
    f.budget(1, 0)
  })

  await t.test('Settings still uses full usage and can update its sign-in account', async () => {
    const f = await fixture('claude')
    const result = await f.service.usage(ownerId, f.id)
    const actual = await f.row()
    assert.deepEqual(f.calls, ['usage'])
    assert.equal(result.account, 'fresh@example.invalid'); assert.equal(result.plan, 'Max')
    assert.equal(actual.accountLabel, 'fresh@example.invalid')
    f.budget(1, 1, 1)
  })
})


// Compare the actual repository statement with the former CTE on PostgreSQL.
// The fixture is synthetic; socket counters include PostgreSQL messages but not
// TCP/TLS overhead. No application query is added to collect these measurements.
const originalQuotaSql = `with old as (select quota from byos_connections where id=$1 and "ownerId"=$2)
      update byos_connections set quota=$3 where id=$1 and "ownerId"=$2 and epoch=$4 and state='connected' returning (select quota from old) as previous`
const ctePreserveQuotaSql = originalQuotaSql.replace('quota=$3', "quota=jsonb_set($3::jsonb,'{plan}',coalesce(quota->'plan','null'::jsonb))")

test('allowance quota statement keeps the CTE snapshot, fresh target plan and per-call byte budget', { skip: !dbUrl, timeout: 30_000 }, async t => {
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 })
  const ownerId = await seedUser(pool, 'allowance-sql')
  const workspaceId = (await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])).id
  const id = randomUUID(), client = await pool.connect(), blocker = await pool.connect()
  t.after(async () => {
    await blocker.query('ROLLBACK'); blocker.release()
    client.release()
    await pool.query('DELETE FROM byos_connections WHERE id=$1', [id])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspaceId])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [ownerId])
    await pool.end()
  })
  await client.query("SET statement_timeout='5s'")
  await pool.query(`INSERT INTO byos_connections
    (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject")
    VALUES ($1,$2,$3,'claude','connected',1,$4,$5,'fixture-allowance-sql')`,
  [id, ownerId, workspaceId, `fixture-${id}`, 'a'.repeat(64)])
  const now = Date.now()
  const quota: QuotaSnapshot = { vendor: 'claude_code', source: 'official', status: 'ok', plan: null,
    observedAt: new Date(now - 100).toISOString(), windows: [{ kind: 'five_hour', used: .25, resetsAt: '2030-01-01T00:00:00.000Z' }] }
  const oldQuota = { ...quota, plan: 'Pro', windows: [{ ...quota.windows[0], used: 1 }] }
  const row: ConnectionRow = { id, ownerId, workspaceId, provider: 'claude', state: 'connected', epoch: '1', quota: oldQuota }
  const captured: { text: string; values: unknown[] }[] = []
  const captureRepository = new SubscriptionRepository({ query: (async (text: string, values: unknown[]) => {
    captured.push({ text, values })
    return { rows: [] }
  }) as pg.Pool['query'] })
  await captureRepository.saveQuota(row, quota)
  await captureRepository.saveQuota(row, quota, { preservePlan: true })
  assert.equal(captured.length, 2, 'one existing statement for each call')
  const [settings, current] = captured
  const observations: unknown[] = []
  const stream = (client as unknown as { connection: { stream: Socket } }).connection.stream
  const reset = async (stored: unknown, sqlNull = false) => {
    await pool.query("UPDATE byos_connections SET quota=$2,state='connected',epoch=1 WHERE id=$1", [id, sqlNull ? null : JSON.stringify(stored)])
  }
  const measure = async (text: string, values = current.values) => {
    const written = stream.bytesWritten, read = stream.bytesRead
    const result = await client.query<{ previous: unknown }>(text, values)
    return { result: { rows: result.rows, rowCount: result.rowCount }, requestBytes: stream.bytesWritten - written, responseBytes: stream.bytesRead - read }
  }
  await t.test('ordinary Settings SQL is unchanged and allowance does not exceed its wire request', async () => {
    assert.equal(settings.text, originalQuotaSql)
    assert.equal(Buffer.byteLength(settings.text), 230)
    assert.deepEqual(current.values, settings.values)
    assert.equal(current.values.length, 4)
    await reset(oldQuota)
    const baseline = await measure(settings.text)
    await reset(oldQuota)
    const actual = await measure(current.text)
    observations.push({ case: 'byte-budget', statements: [
      { name: 'settings', text: settings.text, sqlBytes: Buffer.byteLength(settings.text), parameters: settings.values, ...baseline },
      { name: 'allowance', text: current.text, sqlBytes: Buffer.byteLength(current.text), parameters: current.values, ...actual },
    ] })
    assert.ok(Buffer.byteLength(current.text) <= Buffer.byteLength(settings.text), 'allowance SQL must not add bytes for each dynamic candidate')
    assert.ok(actual.requestBytes <= baseline.requestBytes, 'actual PostgreSQL request bytes cannot increase')
    assert.equal(actual.responseBytes, baseline.responseBytes, 'same previous row and result schema')
  })
  await t.test('even the shortest former Settings plan cannot make the allowance wire request larger', async () => {
    for (const plan of [null, '', 'Pro', '订阅']) {
      await captureRepository.saveQuota(row, { ...quota, plan })
      const previousSettings = captured.at(-1)!
      await reset(oldQuota)
      const baseline = await measure(previousSettings.text, previousSettings.values)
      await reset(oldQuota)
      const actual = await measure(current.text)
      const parameterDelta = Buffer.byteLength(String(current.values[2])) - Buffer.byteLength(String(previousSettings.values[2]))
      assert.ok(parameterDelta <= 2, 'JSON null is at most two bytes larger than an empty JSON string')
      assert.ok(actual.requestBytes <= baseline.requestBytes, 'the static SQL reduction also covers that worst-case parameter difference')
      assert.equal(actual.responseBytes, baseline.responseBytes)
      assert.deepEqual(actual.result.rows, baseline.result.rows)
      observations.push({ case: 'parameter-budget', priorPlan: plan, parameterDelta,
        baseline: { text: previousSettings.text, parameters: previousSettings.values, ...baseline },
        current: { text: current.text, parameters: current.values, ...actual } })
    }
  })
  const cases = [
    { name: 'changed allowance', stored: oldQuota, plan: 'Pro', notify: true },
    { name: 'plan-only difference', stored: { ...quota, plan: 'Enterprise' }, plan: 'Enterprise', notify: false },
    { name: 'missing plan', stored: { vendor: quota.vendor, source: quota.source, status: quota.status, observedAt: quota.observedAt, windows: quota.windows }, plan: null, notify: true },
    { name: 'SQL null quota', stored: null, sqlNull: true, plan: null, notify: true },
    { name: 'JSON null quota', stored: null, plan: null, notify: true },
    { name: 'JSON null plan', stored: { ...quota, plan: null }, plan: null, notify: false },
  ]
  for (const item of cases) await t.test(item.name + ' returns the same original snapshot and notification decision', async () => {
    const pair: unknown[] = []
    for (const [name, text] of [['cte', ctePreserveQuotaSql], ['current', current.text]]) {
      await reset(item.stored, item.sqlNull)
      const measured = await measure(text)
      const saved = (await pool.query('SELECT quota FROM byos_connections WHERE id=$1', [id])).rows[0].quota
      assert.equal(measured.result.rowCount, 1)
      assert.deepEqual(measured.result.rows, [{ previous: item.stored }])
      assert.deepEqual(saved, { ...quota, plan: item.plan })
      const notify = quotaDisplayKey(measured.result.rows[0].previous, now) !== quotaDisplayKey(quota, now)
      assert.equal(notify, item.notify)
      pair.push({ previous: measured.result.rows, saved, notify })
      observations.push({ case: item.name, name, ...measured })
    }
    assert.deepEqual(pair[0], pair[1])
  })
  for (const mutation of ['plan', 'epoch']) await t.test('a real row-lock wait preserves the CTE semantics after concurrent ' + mutation, async () => {
    const pair: unknown[] = []
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    for (const [name, text] of [['cte', ctePreserveQuotaSql], ['current', current.text]]) {
      await reset(oldQuota)
      await blocker.query('BEGIN')
      await blocker.query(mutation === 'plan'
        ? `UPDATE byos_connections SET quota=jsonb_set(quota,'{plan}','"Enterprise"'::jsonb) WHERE id=$1`
        : 'UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1', [id])
      const pending = measure(text)
      void pending.catch(() => {})
      try {
        const deadline = Date.now() + 3_000
        let blocked = false
        do {
          blocked = (await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 5))
        } while (!blocked && Date.now() < deadline)
        assert.equal(blocked, true, 'the actual UPDATE must wait for the concurrent Settings/epoch transaction')
        await blocker.query('COMMIT')
        const measured = await pending
        const saved = (await pool.query('SELECT quota,epoch FROM byos_connections WHERE id=$1', [id])).rows[0]
        if (mutation === 'plan') {
          assert.deepEqual(measured.result.rows, [{ previous: oldQuota }], 'RETURNING uses the statement snapshot, not the later target row')
          assert.deepEqual(saved.quota, { ...quota, plan: 'Enterprise' }, 'SET preserves the plan committed during the lock wait')
          assert.equal(quotaDisplayKey(measured.result.rows[0].previous, now) !== quotaDisplayKey(quota, now), true)
        } else {
          assert.equal(measured.result.rowCount, 0)
          assert.deepEqual(saved.quota, oldQuota)
          assert.equal(String(saved.epoch), '2')
        }
        pair.push({ rows: measured.result.rows, saved })
        observations.push({ case: 'concurrent-' + mutation, name, ...measured, saved })
      } finally {
        await blocker.query('ROLLBACK')
        await pending.catch(() => {})
      }
    }
    assert.deepEqual(pair[0], pair[1])
  })
  for (const refusal of ['owner', 'id', 'epoch', 'disconnected']) await t.test(refusal + ' still prevents both statements from writing or returning a previous row', async () => {
    for (const text of [ctePreserveQuotaSql, current.text]) {
      await reset(oldQuota)
      const values = [...current.values]
      if (refusal === 'owner') values[1] = 'foreign-owner'
      if (refusal === 'id') values[0] = randomUUID()
      if (refusal === 'epoch') values[3] = '2'
      if (refusal === 'disconnected') await pool.query("UPDATE byos_connections SET state='disconnected' WHERE id=$1", [id])
      assert.equal((await measure(text, values)).result.rowCount, 0)
      assert.deepEqual((await pool.query('SELECT quota FROM byos_connections WHERE id=$1', [id])).rows[0].quota, oldQuota)
    }
  })
  const version = (await client.query('SHOW server_version')).rows[0].server_version
  const plans = []
  for (const [name, text] of [['settings', originalQuotaSql], ['cte', ctePreserveQuotaSql], ['current', current.text]])
    plans.push({ name, plan: (await client.query('EXPLAIN (FORMAT JSON) ' + text, current.values)).rows[0]['QUERY PLAN'] })
  t.diagnostic('allowance-sql-evidence ' + JSON.stringify({ version, observations, plans }))
})
