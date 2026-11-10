import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Pool } from 'pg'
import { HostedUsageStore } from './store'
import { signupRateLimit as configuredSignupRateLimit } from './signup'
const signupRateLimit = (
  ...args: Parameters<typeof configuredSignupRateLimit>
) => configuredSignupRateLimit(args[0], args[1], args[2], args[3], args[4], {})
const url = process.env.E2E_DATABASE_URL
if (!url && process.env.REQUIRE_DB === '1')
  throw Error('E2E_DATABASE_URL required')
if (url) {
  const target = new URL(url)
  if (target.hostname !== '127.0.0.1' || !target.pathname.endsWith('_e2e'))
    throw Error('isolated loopback database required')
}
test('hosted controls on isolated PostgreSQL', { skip: !url }, async (t) => {
  const schema = `abuse_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({
    connectionString: url,
    max: 8,
    options: `-c search_path=${schema}`,
  })
  t.after(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  await pool.query(`CREATE TABLE "user" (id text primary key,email text not null);
    CREATE TABLE workspace_credit_grants (id uuid primary key,"workspaceId" uuid not null,points integer not null,bucket text not null,"periodStart" timestamptz,"expiresAt" timestamptz,"parentGrantId" uuid);
    CREATE TABLE workspace_settings ("workspaceId" uuid primary key,"monthlyCreditLimit" integer);
    CREATE TABLE workspace_audit_events (id uuid primary key,"workspaceId" uuid,"actorType" text,"actorName" text,action text,category text,metadata jsonb);
    CREATE TABLE mikka_workspaces(id uuid primary key,"userId" text);
    CREATE TABLE bots (id uuid primary key,"workspaceId" uuid);
    CREATE TABLE coordinator_events (id uuid primary key,"botId" uuid,kind text,payload jsonb)`)
  const old = randomUUID()
  await pool.query('INSERT INTO mikka_workspaces VALUES ($1)', [old])
  await pool.query(
    readFileSync('drizzle/20261030230000_hosted_usage.sql', 'utf8'),
  )
  await pool.query(readFileSync('drizzle/20261031004200_card_verification_checkout.sql', 'utf8'))
  await pool.query(
    readFileSync('drizzle/20261030230001_legacy_hosted_workspaces.sql', 'utf8'),
  )
  await pool.query(readFileSync('drizzle/20261101130000_hosted_usage_concurrent.sql', 'utf8'))
  await pool.query(readFileSync('drizzle/20261110150010_plan_credit_usage.sql', 'utf8'))
  await pool.query(readFileSync('drizzle/20261110150011_resource_budgets.sql', 'utf8'))
  const store = new HostedUsageStore(pool)
  /** `n` messages sent in this workspace's chats (created by `creator`), plus a 重试 and a welcome request that never count. */
  const sent = async (workspaceId: string, n: number, creator = `creator-${workspaceId}`) => {
    await pool.query('INSERT INTO mikka_workspaces VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [workspaceId, creator])
    const bot = randomUUID()
    await pool.query('INSERT INTO bots VALUES ($1,$2)', [bot, workspaceId])
    for (let i = 0; i < n; i++) await pool.query(`INSERT INTO coordinator_events VALUES ($1,$2,'user_message',$3)`, [randomUUID(), bot, JSON.stringify({ text: `message ${i}` })])
    await pool.query(`INSERT INTO coordinator_events VALUES ($1,$2,'user_message',$3),($4,$2,'user_message',$5)`, [randomUUID(), bot, JSON.stringify({ text: '', retry: true }), randomUUID(), JSON.stringify({ text: '[Welcome] hi' })])
  }
  const verified = async () => {
    const id = randomUUID()
    await store.verify(id, 'cus_fixture', `card_${id}`)
    return id
  }
  await t.test('plan points are usable, settle once across an expiry boundary, and leave purchased balances intact', async () => {
    const id = await verified(), grant = randomUUID(), call = randomUUID()
    await pool.query('update hosted_allowances set remaining=0 where "workspaceId"=$1', [id])
    await pool.query(`insert into workspace_credit_grants (id,"workspaceId",points,bucket,"periodStart","expiresAt") values($1,$2,100,'plan',now()-interval '1 day',now()+interval '1 day')`, [grant, id])
    await store.reserve(id, 'synthetic/plan', call)
    const { rows: [usage] } = await pool.query('select "createdAt" from hosted_usage where id=$1', [call])
    const expiry = new Date(usage.createdAt.getTime() + 1)
    await pool.query('update workspace_credit_grants set "expiresAt"=$2 where id=$1', [grant, expiry])
    assert.equal((await store.balance(id, pool, new Date(expiry.getTime() + 1))).plan, 0)
    await store.settle(call, 25_000)
    await store.settle(call, 25_000)
    const receipt = (await pool.query('select "costMicroUsd"::int cost,"planMicroUsd"::int plan,"purchasedMicroUsd"::int purchased,"planAllocations" from hosted_usage where id=$1', [call])).rows[0]
    assert.deepEqual(receipt, { cost: 25_000, plan: 25_000, purchased: 0, planAllocations: { [grant]: 25_000 } })
    assert.equal((await pool.query('select points from workspace_credit_grants where id=$1', [grant])).rows[0].points, 100)
  })
  await t.test('workspace, member, project, thread and run budgets serialize concurrent holds and retain unknown cost', async () => {
    const { hostedBillingScope } = await import('./context'), { readResourceBudgets } = await import('../billing/resource-budgets')
    for (const scope of ['workspace', 'member', 'project', 'thread', 'run'] as const) {
      const workspaceId = await verified(), actorId = `member-${randomUUID()}`, projectId = randomUUID(), threadId = randomUUID(), runId = randomUUID()
      const scopeId = { workspace: workspaceId, member: actorId, project: projectId, thread: threadId, run: runId }[scope]
      await pool.query(`insert into billing_resource_budgets (id,"workspaceId",scope,"scopeId",period,"limitPoints","warningPercent","updatedBy") values($1,$2,$3,$4,'month',20,50,$5)`, [randomUUID(), workspaceId, scope, scopeId, actorId])
      assert.equal((await store.status(workspaceId)).state, 'ready', 'an unscoped billing summary does not pretend every private resource budget is exhausted')
      const attribution = { workspaceId, billingAccountWorkspaceId: workspaceId, actorId, projectId, threadId, runId, attributionComplete: true }
      const calls = [randomUUID(), randomUUID(), randomUUID()]
      const outcomes = await hostedBillingScope.run(attribution, () => Promise.allSettled(calls.map(call => store.reserve(workspaceId, 'synthetic/budget', call))))
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 2, scope)
      for (const result of outcomes) if (result.status === 'rejected') assert.match(String(result.reason), /usage_budget_exhausted/)
      const accepted = calls.filter((_, n) => outcomes[n].status === 'fulfilled')
      await store.settle(accepted[0], 100_000)
      await store.settle(accepted[1], null)
      const [budget] = await readResourceBudgets(pool, [workspaceId])
      assert.equal(budget.exhausted, true); assert.equal(budget.thresholdReached, true)
      if (scope !== 'workspace') await assert.rejects(store.reserve(workspaceId, 'synthetic/missing-attribution', randomUUID()), /usage_budget_exhausted/)
      await store.settle(accepted[1], 0)
      await hostedBillingScope.run(attribution, () => store.reserve(workspaceId, 'synthetic/resumed', randomUUID()))
    }
  })
  await t.test('trial identity reads the Workspace database while receipts remain in APP, including single-connection pools', async () => {
    const workspaceSchema = `${schema}_ws`, isolatedApp = new Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` })
    await admin.query(`create schema ${workspaceSchema}`)
    const workspaceDatabase = new Pool({ connectionString: url, max: 1, options: `-c search_path=${workspaceSchema}` })
    const hiddenTable = `mikka_workspaces_${randomUUID().replaceAll('-', '')}`
    await pool.query(`alter table mikka_workspaces rename to ${hiddenTable}`)
    try {
      await workspaceDatabase.query('create table mikka_workspaces(id uuid primary key,"userId" text)')
      const first = randomUUID(), second = randomUUID(), another = randomUUID(), bot = randomUUID()
      await workspaceDatabase.query(`insert into mikka_workspaces values($1,'trial-owner'),($2,'trial-owner'),($3,'another-owner')`, [first, second, another])
      await isolatedApp.query('insert into bots values($1,$2)', [bot, first])
      for (let i = 0; i < 20; i++) await isolatedApp.query(`insert into coordinator_events values($1,$2,'user_message','{"text":"synthetic trial message"}')`, [randomUUID(), bot])
      const separated = new HostedUsageStore(isolatedApp, { workspaceDatabase, quota: async () => {
        const lease = await workspaceDatabase.connect(); await lease.query('begin')
        return { limit: 8, close: async () => { await lease.query('rollback'); lease.release() } }
      } })
      assert.equal((await separated.status(second)).trialLeft, 0)
      await separated.reserve(second, 'synthetic/split-db', randomUUID())
      await isolatedApp.query(`insert into coordinator_events values($1,$2,'user_message','{"text":"over limit"}')`, [randomUUID(), bot])
      await assert.rejects(separated.reserve(second, 'synthetic/split-db', randomUUID()), /verification_required/)
      await assert.rejects(separated.canUseMikkaPaid(second), /verification_required/)
      assert.equal((await separated.status(another)).trialLeft, 20)
    } finally {
      await pool.query(`alter table ${hiddenTable} rename to mikka_workspaces`)
      await Promise.all([isolatedApp.end(), workspaceDatabase.end()])
      await admin.query(`drop schema ${workspaceSchema} cascade`)
    }
  })
  await t.test('a paid-only store requires verification and positive balance without consuming a chat trial', async () => {
    const paidOnly = new HostedUsageStore(pool, { metered: true, allowTrial: false }), fresh = randomUUID()
    await assert.rejects(paidOnly.canUseMikkaPaid(fresh), /verification_required/)
    await assert.rejects(paidOnly.reserve(fresh, 'fixture-paid-only', randomUUID()), /verification_required/)
    assert.deepEqual([(await paidOnly.status(fresh)).state, (await paidOnly.status(fresh)).trialLeft], ['verification_required', null])
    assert.equal((await pool.query('SELECT count(*)::int n FROM hosted_usage WHERE "workspaceId"=$1', [fresh])).rows[0].n, 0)
    const funded = await verified(), call = randomUUID()
    await paidOnly.canUseMikkaPaid(funded)
    await paidOnly.reserve(funded, 'fixture-paid-only', call)
    await paidOnly.settle(call, 1_000, 5, 5)
    assert.equal((await paidOnly.balance(funded)).free, 999_000)
    await pool.query('UPDATE hosted_allowances SET remaining=0 WHERE "workspaceId"=$1', [funded])
    await assert.rejects(paidOnly.canUseMikkaPaid(funded), /free_allowance_used/)
  })
  await t.test('no card: the first 20 messages are answered, paid by the platform, once per person; the 21st needs a card', async () => {
    const fresh = randomUUID()
    // Nothing sent yet (the welcome turn): admitted, 20 left.
    assert.deepEqual([(await store.status(fresh)).state, (await store.status(fresh)).trialLeft], ['ready', 20])
    await sent(fresh, 1)
    const first = randomUUID()
    await store.reserve(fresh, 'fixture', first)
    await store.settle(first, 30_000, 10, 10)
    // The platform pays: unpaid spend under its daily cap, never a debt the allowance repays after a card.
    const row = (await pool.query('SELECT "unpaidMicroUsd","purchasedMicroUsd","freeMicroUsd" FROM hosted_usage WHERE id=$1', [first])).rows[0]
    assert.deepEqual([Number(row.unpaidMicroUsd), Number(row.purchasedMicroUsd), Number(row.freeMicroUsd)], [30_000, 0, 0])
    assert.deepEqual(await store.balance(fresh), { verified: false, free: 0, plan: 0, purchased: 0 })
    assert.equal((await store.canUseMikkaPaid(fresh) as { trialLeft?: number }).trialLeft, 19)
    // The 20th message's turn still runs; the 21st needs a card. 重试 and the welcome request never count.
    await sent(fresh, 19)
    await store.reserve(fresh, 'fixture', randomUUID())
    assert.deepEqual([(await store.status(fresh)).state, (await store.status(fresh)).trialLeft], ['verification_required', 0])
    await sent(fresh, 1)
    await assert.rejects(store.reserve(fresh, 'fixture', randomUUID()), /verification_required/)
    await assert.rejects(store.canUseMikkaPaid(fresh), /verification_required/)
    // A verified card: the allowance as before, the free messages no longer count, and nothing was owed from them.
    await store.verify(fresh, 'cus_trial', `card_${fresh}`)
    assert.equal((await store.balance(fresh)).free, 1e6)
    assert.equal((await store.status(fresh)).trialLeft, null)
  })
  await t.test('the free messages are the person\'s: a second workspace they create shares the same 20', async () => {
    const first = randomUUID(), second = randomUUID(), someoneElse = randomUUID()
    await sent(first, 15, 'pat')
    await sent(second, 0, 'pat')
    assert.equal((await store.status(second)).trialLeft, 5, 'a new workspace starts where the person is')
    await sent(second, 5, 'pat')
    await store.reserve(second, 'fixture', randomUUID())
    await sent(second, 1, 'pat')
    await assert.rejects(store.reserve(second, 'fixture', randomUUID()), /verification_required/)
    await assert.rejects(store.reserve(first, 'fixture', randomUUID()), /verification_required/, 'the first one is used up too')
    await sent(someoneElse, 0, 'sam')
    assert.equal((await store.status(someoneElse)).trialLeft, 20, 'another person keeps their own')
  })
  await t.test(
    'legacy snapshot contains existing workspaces only',
    async () => {
      const fresh = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces VALUES ($1)', [fresh])
      assert.deepEqual(
        (await pool.query('SELECT * FROM hosted_legacy_workspaces')).rows,
        [{ workspaceId: old }],
      )
    },
  )
  await t.test(
    'unverified past its free messages refused; same card concurrent claims one allowance, retained after workspace deletion',
    async () => {
      const past = randomUUID()
      await sent(past, 21)
      await assert.rejects(
        store.reserve(past, 'fixture', randomUUID()),
        /verification_required/,
      )
      const a = randomUUID(),
        b = randomUUID(),
        card = randomUUID()
      const result = await Promise.all([
        store.verify(a, 'cus_a', card),
        store.verify(b, 'cus_b', card),
      ])
      assert.equal(result.filter(Boolean).length, 1)
      assert.equal(
        (await store.balance(a)).free + (await store.balance(b)).free,
        1e6,
      )
      const winner = result[0] ? a : b
      await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [winner])
      const third = randomUUID()
      assert.equal(await store.verify(third, 'cus_c', card), false)
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) AS n FROM workspace_audit_events WHERE action='billing.card_verified' AND \"workspaceId\"=ANY($1::uuid[])",
              [[a, b, third]],
            )
          ).rows[0].n,
        ),
        3,
      )
    },
  )
  await t.test(
    'free then purchased; expired plan retained without spending; replay and parallel settlement idempotent; zero refused',
    async () => {
      const id = await verified()
      await pool.query(
        "INSERT INTO workspace_credit_grants VALUES ($1,$2,100,'purchased'),($3,$2,99999,'plan')",
        [randomUUID(), id, randomUUID()],
      )
      await pool.query(`update workspace_credit_grants set "expiresAt"=now()-interval '1 day' where "workspaceId"=$1 and bucket='plan'`, [id])
      const call = randomUUID()
      await store.reserve(id, 'fixture', call)
      await Promise.all([
        store.settle(call, 1_200_000, 20, 4),
        store.settle(call, 1_200_000, 20, 4),
      ])
      assert.deepEqual(await store.balance(id), {
        verified: true,
        free: 0,
        plan: 0,
        purchased: 800_000,
      })
      const call2 = randomUUID()
      await store.reserve(id, 'fixture', call2)
      await store.settle(call2, 800_000)
      assert.equal((await store.balance(id)).purchased, 0)
      await assert.rejects(
        store.reserve(id, 'fixture', randomUUID()),
        /free_allowance_used/,
      )
      await store.settle(call2, 800_000)
      assert.equal((await store.recent(id)).length, 2)
    },
  )
  await t.test(
    'one workspace runs calls concurrently up to the cap; replay refused; unknown receipt keeps its hold',
    async () => {
      const id = await verified()
      const calls = Array.from({ length: 10 }, () => randomUUID())
      const results = await Promise.allSettled(
        calls.map((call) => store.reserve(id, 'fixture', call)),
      )
      const admitted = calls.filter((_, i) => results[i].status === 'fulfilled')
      assert.equal(admitted.length, 8)
      for (const r of results)
        if (r.status === 'rejected') assert.match(String(r.reason), /usage_concurrency_limit/)
      assert.equal((await store.status(id)).state, 'usage_concurrency_limit')
      // Holds gate admission only; they are not charged.
      assert.equal((await store.balance(id)).free, 1_000_000)
      await assert.rejects(store.reserve(id, 'fixture', admitted[0]), /usage_in_progress/)
      await store.settle(admitted[0], null)
      // An unknown receipt frees its slot but keeps its hold: 7 pending, 800k held.
      const next = randomUUID()
      await store.reserve(id, 'fixture', next)
      await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /usage_concurrency_limit/)
      await Promise.all([next, ...admitted.slice(1)].map((call) => store.settle(call, 0)))
      assert.equal((await store.status(id)).state, 'ready')
      await store.settle(admitted[0], 100)
      assert.equal((await store.balance(id)).free, 999_900)
      await assert.rejects(store.reserve(id, 'fixture', admitted[0]), /usage_in_progress/)
    },
  )
  await t.test(
    'concurrent calls must fit the balance together; only the excess is refused',
    async () => {
      const id = await verified()
      await pool.query('UPDATE hosted_allowances SET remaining=250000 WHERE "workspaceId"=$1', [id])
      const calls = Array.from({ length: 5 }, () => randomUUID())
      const results = await Promise.allSettled(
        calls.map((call) => store.reserve(id, 'fixture', call)),
      )
      const admitted = calls.filter((_, i) => results[i].status === 'fulfilled')
      // 250k covers the lone call plus one more 100k hold; the rest do not fit.
      assert.equal(admitted.length, 2)
      for (const r of results)
        if (r.status === 'rejected') assert.match(String(r.reason), /free_allowance_used/)
      assert.equal((await store.status(id)).state, 'free_allowance_used')
      // Settlement charges the actual cost and releases the hold.
      await store.settle(admitted[0], 30_000)
      assert.equal((await store.balance(id)).free, 220_000)
      await store.reserve(id, 'fixture', randomUUID())
      await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /free_allowance_used/)
    },
  )
  await t.test(
    'an abandoned reservation is released so one stuck row never bricks the workspace',
    async () => {
      const id = await verified()
      // A finished call whose cost could not be determined and whose generation
      // id was never recorded: unknown, unreconcilable (the observed 27h brick).
      const stuck = randomUUID()
      await store.reserve(id, 'fixture', stuck)
      await store.settle(stuck, null)
      // Recent: it is kept (its cost may still arrive) and does not block others.
      const alongside = randomUUID()
      await store.reserve(id, 'fixture', alongside)
      await store.settle(alongside, 0)
      assert.equal((await pool.query('SELECT state FROM hosted_usage WHERE id=$1', [stuck])).rows[0].state, 'unknown')
      // Past the margin it can never settle; the next reservation reaps it.
      await pool.query('UPDATE hosted_usage SET "createdAt"=now()-interval \'11 minutes\' WHERE id=$1', [stuck])
      const next = randomUUID()
      await store.reserve(id, 'fixture', next)
      const states = Object.fromEntries((await pool.query('SELECT id,state FROM hosted_usage WHERE id=ANY($1)', [[stuck, next]])).rows.map(r => [r.id, r.state]))
      assert.equal(states[stuck], 'failed')
      assert.equal(states[next], 'pending')
      await store.settle(next, 100)
      // The write-off charged nothing; only the settled call drew down the allowance.
      assert.equal((await store.balance(id)).free, 999_900)
      // A stale pending row (a crashed call that never settled) is released the same way.
      const crashed = randomUUID()
      await store.reserve(id, 'fixture', crashed)
      await pool.query('UPDATE hosted_usage SET "createdAt"=now()-interval \'11 minutes\' WHERE id=$1', [crashed])
      const after = randomUUID()
      await store.reserve(id, 'fixture', after)
      assert.equal((await pool.query('SELECT state FROM hosted_usage WHERE id=$1', [crashed])).rows[0].state, 'failed')
      await store.settle(after, null)
    },
  )
  await t.test(
    'actual rolling spend pauses subsequent calls; purchased calls bypass pause; clears after window',
    async capTest => {
      const previous = process.env.MIKKA_FREE_MODEL_DAILY_CENTS
      process.env.MIKKA_FREE_MODEL_DAILY_CENTS = '10'
      capTest.after(() => { if (previous === undefined) delete process.env.MIKKA_FREE_MODEL_DAILY_CENTS; else process.env.MIKKA_FREE_MODEL_DAILY_CENTS = previous })
      await pool.query(
        'UPDATE hosted_usage SET "createdAt"=now()-interval \'25 hours\'',
      )
      const a = await verified(),
        b = await verified()
      const cap = { MIKKA_FREE_MODEL_DAILY_CENTS: '10' }
      const call = randomUUID()
      await store.reserve(a, 'fixture', call, cap)
      await store.settle(call, 100_000)
      await assert.rejects(
        store.reserve(b, 'fixture', randomUUID(), cap),
        /platform_paused/,
      )
      await pool.query(
        "INSERT INTO workspace_credit_grants VALUES ($1,$2,100,'purchased')",
        [randomUUID(), b],
      )
      const paid = randomUUID()
      await store.reserve(b, 'fixture', paid, cap)
      await store.settle(paid, 10_000)
      assert.equal(
        (await store.balance(b)).free,
        1e6,
        'paused call uses purchased balance only',
      )
      await pool.query(
        'UPDATE hosted_usage SET "createdAt"=now()-interval \'25 hours\'',
      )
      await store.reserve(a, 'fixture', randomUUID(), cap)
    },
  )
  await t.test(
    'concurrent workspaces do not freeze estimated money; actual receipts trip the platform cap',
    async capTest => {
      const previous = process.env.MIKKA_FREE_MODEL_DAILY_CENTS
      process.env.MIKKA_FREE_MODEL_DAILY_CENTS = '10'
      capTest.after(() => { if (previous === undefined) delete process.env.MIKKA_FREE_MODEL_DAILY_CENTS; else process.env.MIKKA_FREE_MODEL_DAILY_CENTS = previous })
      await pool.query(
        `UPDATE hosted_usage SET "createdAt"=now()-interval '25 hours'`,
      )
      const a = await verified(),
        b = await verified()
      const calls = [randomUUID(), randomUUID()]
      const results = await Promise.allSettled(
        [a, b].map((ws, index) =>
          store.reserve(ws, 'fixture', calls[index], {
            MIKKA_FREE_MODEL_DAILY_CENTS: '10',
          }),
        ),
      )
      assert.equal(
        results.filter((row) => row.status === 'fulfilled').length,
        2,
      )
      assert.equal((await store.balance(a)).free, 1_000_000)
      assert.equal((await store.balance(b)).free, 1_000_000)
      await Promise.all(calls.map(call => store.settle(call, 100_000)))
      const c = await verified()
      await assert.rejects(store.reserve(c, 'fixture', randomUUID(), { MIKKA_FREE_MODEL_DAILY_CENTS: '10' }), /platform_paused/)
    },
  )
  await t.test('positive balance admits without prepayment; actual overrun debt blocks until sufficient credit arrives', async () => {
    await pool.query('UPDATE hosted_usage SET "createdAt"=now()-interval \'25 hours\'')
    const id = await verified(), call = randomUUID()
    await pool.query('UPDATE hosted_allowances SET remaining=1 WHERE "workspaceId"=$1', [id])
    await store.reserve(id, 'fixture', call, {}, 100_000)
    assert.deepEqual(await store.balance(id), { verified: true, free: 1, plan: 0, purchased: 0 })
    const pending = (await pool.query('SELECT "reservedFree","reservedPurchased","reservedUnpaid","costMicroUsd" FROM hosted_usage WHERE id=$1', [call])).rows[0]
    assert.deepEqual(Object.values(pending).map(value => value === null ? null : Number(value)), [0, 0, 0, null])
    await Promise.all([store.settle(call, 20_001), store.settle(call, 20_001)])
    assert.equal(Number((await store.recent(id))[0].purchasedMicroUsd), 20_000)
    await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /free_allowance_used/)
    await pool.query("INSERT INTO workspace_credit_grants VALUES ($1,$2,1,'purchased')", [randomUUID(), id])
    await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /free_allowance_used/)
    await pool.query("INSERT INTO workspace_credit_grants VALUES ($1,$2,2,'purchased')", [randomUUID(), id])
    assert.equal((await store.balance(id)).purchased, 10_000)
    await store.reserve(id, 'fixture', randomUUID())
  })
  await t.test('legacy prepaid rows settle once without charging prepaid money twice', async () => {
    const id = await verified(), freeCall = randomUUID(), paidCall = randomUUID()
    await pool.query("INSERT INTO workspace_credit_grants VALUES ($1,$2,100,'purchased')", [randomUUID(), id])
    await pool.query('UPDATE hosted_allowances SET remaining=900000 WHERE "workspaceId"=$1', [id])
    await pool.query('INSERT INTO hosted_usage (id,"workspaceId",model,state,"reservedFree","reservedUnpaid") VALUES ($1,$2,\'legacy\',\'pending\',100000,100000)', [freeCall, id])
    await Promise.all([store.settle(freeCall, 120_000), store.settle(freeCall, 120_000)])
    assert.deepEqual(await store.balance(id), { verified: true, free: 880_000, plan: 0, purchased: 1_000_000 })
    await pool.query('INSERT INTO hosted_usage (id,"workspaceId",model,state,"reservedPurchased") VALUES ($1,$2,\'legacy\',\'pending\',100000)', [paidCall, id])
    assert.equal((await store.balance(id)).purchased, 900_000)
    await Promise.all([store.settle(paidCall, 120_000), store.settle(paidCall, 120_000)])
    assert.deepEqual(await store.balance(id), { verified: true, free: 880_000, plan: 0, purchased: 880_000 })
    const overrun = randomUUID()
    await pool.query('INSERT INTO hosted_usage (id,"workspaceId",model,state,"reservedPurchased") VALUES ($1,$2,\'legacy\',\'pending\',100000)', [overrun, id])
    await store.settle(overrun, 1_800_000)
    assert.deepEqual(await store.balance(id), { verified: true, free: 0, plan: 0, purchased: 0 }, 'unused allowance cannot hide a larger already-incurred debt')
    await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /free_allowance_used/)
  })
  await t.test(
    'atomic normalized uniqueness and per-IP/global mail quotas',
    async () => {
      const results = await Promise.allSettled([
        pool.query('INSERT INTO "user" VALUES ($1,$2)', [
          randomUUID(),
          'test.abuse+one@gmail.com',
        ]),
        pool.query('INSERT INTO "user" VALUES ($1,$2)', [
          randomUUID(),
          't.e.s.t.abuse+two@googlemail.com',
        ]),
      ])
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
      // Production's limits, set explicitly: a local shell may carry CI's higher ones or local test mode.
      const limits = { MIKKA_SIGNUP_IP_HOURLY: '5', MIKKA_SIGNUP_GLOBAL_HOURLY: '100', MIKKA_VERIFICATION_IP_HOURLY: '15', MIKKA_VERIFICATION_GLOBAL_HOURLY: '300' }
      const limited = (kind: 'signup' | 'verification', ip: string, email: string) => signupRateLimit(pool, kind, ip, email, Date.now(), limits)
      for (let n = 0; n < 5; n++)
        await limited('signup', 'ip-a', `x${n}@example.com`)
      await assert.rejects(
        limited('signup', 'ip-a', 'fresh@example.com'),
        /SIGNUP_RATE_LIMITED/,
      )
      await limited('signup', 'ip-b', 'fresh@example.com')
      await pool.query(
        'UPDATE "rateLimit" SET count=300 WHERE key LIKE \'abuse:verification:global:%\'',
      )
      await limited('verification', 'ip-a', 'a@example.com')
      await pool.query(
        'UPDATE "rateLimit" SET count=300 WHERE key LIKE \'abuse:verification:global:%\'',
      )
      await assert.rejects(
        limited('verification', 'ip-b', 'b@example.com'),
        /SIGNUP_RATE_LIMITED/,
      )
    },
  )
})
