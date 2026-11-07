import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import pg from 'pg'
import { SubscriptionRepository } from '../lib/subscription-repository'
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
