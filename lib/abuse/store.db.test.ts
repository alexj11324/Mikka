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
  // Settlement writes the cache breakdown, so this ledger's schema needs the
  // migration that adds those columns as well.
  await pool.query(readFileSync('drizzle/20261111060000_hosted_usage_token_breakdown.sql', 'utf8'))
  await t.test('ledger attribution upgrades existing receipts and can be applied twice', async () => {
    const migration = readFileSync('drizzle/20261121043334_add_hosted_usage_message_attribution.sql', 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const [legacyId, runId, threadId] = [randomUUID(), randomUUID(), randomUUID()]
      await client.query(`INSERT INTO hosted_usage (id,"workspaceId",model,state,"usageRunId","usageThreadId","inputTokens","costMicroUsd")
        VALUES ($1,$2,'fixture/model','settled',$3,$4,11,23)`, [legacyId, old, runId, threadId])
      await client.query(migration)
      await client.query(`INSERT INTO hosted_usage (id,"workspaceId",model,state,"usageRunId","usageMessageId","billingSource")
        SELECT source,$1,'fixture/model','settled',$2,'harness-message-1',source
        FROM unnest(ARRAY['credits','subscription','api_key']) source`, [old, runId])
      await client.query(migration)
      assert.deepEqual((await client.query(`SELECT "usageRunId","usageThreadId","usageMessageId","billingSource",
        "inputTokens"::int AS tokens,"costMicroUsd"::int AS cost FROM hosted_usage WHERE id=$1`, [legacyId])).rows,
      [{ usageRunId: runId, usageThreadId: threadId, usageMessageId: null, billingSource: null, tokens: 11, cost: 23 }])
      assert.deepEqual((await client.query(`SELECT DISTINCT "usageMessageId", "billingSource" FROM hosted_usage
        WHERE "usageRunId"=$1 AND "billingSource" IS NOT NULL ORDER BY "billingSource"`, [runId])).rows,
      ['api_key', 'credits', 'subscription'].map(billingSource => ({ usageMessageId: 'harness-message-1', billingSource })))
      await assert.rejects(client.query(`INSERT INTO hosted_usage (id,"workspaceId",model,state,"billingSource")
        VALUES ('invalid-source',$1,'fixture/model','settled','invalid')`, [old]), { code: '23514' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  const store = new HostedUsageStore(pool)
  await pool.query(readFileSync('drizzle/20261121043334_add_hosted_usage_message_attribution.sql', 'utf8'))
  await t.test('a scripted LiteLLM BYOK receipt keeps its usage and does not consume the workspace budget', async t => {
    const { createServer } = await import('node:http')
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const { handleModelGateway } = await import('../model-gateway/handler')
    const { recordExternalModelUsage } = await import('../model-gateway/ledger')
    const workspaceId = randomUUID(), runId = randomUUID(), threadId = randomUUID()
    const unknownMessage = 'msg_missing_cost'
    const server = createServer((_request, response) => {
      const missingCost = _request.headers.accept === 'application/x-missing-cost'
      const message = missingCost ? unknownMessage : 'msg_with_cost'
      response.writeHead(200, { 'content-type': 'application/json', ...(missingCost ? {} : { 'x-litellm-response-cost': '0.025' }) })
      response.end(JSON.stringify({ type: 'message', id: message, usage: { input_tokens: 11, output_tokens: 7 } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { server.closeAllConnections(); server.close() })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await pool.query('INSERT INTO workspace_settings VALUES ($1,11)', [workspaceId])
    await store.verify(workspaceId, 'cus_byok', `card_${workspaceId}`)
    await pool.query('INSERT INTO hosted_allowances ("workspaceId",remaining) VALUES ($1,1000000)', [workspaceId])
    for (const accept of ['application/json', 'application/x-missing-cost']) {
      const answer = await handleModelGateway(new Request('http://fixture.test', { method: 'POST',
        headers: { 'x-api-key': 'fixture-token', accept }, body: JSON.stringify({ messages: [] }) }), 'anthropic', 'messages', {
        fetch,
        verify: async () => ({ runId, ownerId: 'fixture-owner', workspaceId, harness: 'claude_code', model: 'fixture-model', source: { kind: 'api_key', keyId: randomUUID() } }),
        upstream: async () => ({ upstream: { url: `http://127.0.0.1:${address.port}`, masterKey: 'fixture-key' } }),
        reserve: async () => assert.fail('BYOK must not reserve credits'),
        settle: async () => assert.fail('BYOK must not settle credits'),
        catalogue: async () => assert.fail('BYOK cost is not inferred from list price'),
        recordExternal: (grant, id, receipt) => recordExternalModelUsage(drizzle(pool), { ...receipt, id, runId: grant.runId, threadId, ownerId: grant.ownerId,
          workspaceId, model: grant.model, source: 'api_key' }),
      })
      assert.equal(answer.status, 200)
      await answer.json()
    }
    assert.deepEqual((await pool.query(`SELECT "usageThreadId","usageMessageId","billingSource","costMicroUsd"::int AS cost,
      "inputTokens"::int AS input,"outputTokens"::int AS output FROM hosted_usage WHERE "usageRunId"=$1 ORDER BY "usageMessageId"`, [runId])).rows,
    [{ usageThreadId: threadId, usageMessageId: unknownMessage, billingSource: 'api_key', cost: null, input: 11, output: 7 },
      { usageThreadId: threadId, usageMessageId: 'msg_with_cost', billingSource: 'api_key', cost: 25_000, input: 11, output: 7 }])
    assert.equal((await store.balance(workspaceId)).free, 1_000_000)
    assert.equal((await store.status(workspaceId)).state, 'ready')
    assert.deepEqual(await store.recent(workspaceId), [])
  })
  await t.test('credits attribute an unknown receipt and settle it only once', async () => {
    const { hostedBillingScope } = await import('./context')
    const [workspaceId, runId, threadId, call] = Array.from({ length: 4 }, () => randomUUID())
    await store.verify(workspaceId, 'cus_credits', `card_${workspaceId}`)
    await pool.query('INSERT INTO hosted_allowances ("workspaceId",remaining) VALUES ($1,1000000)', [workspaceId])
    await hostedBillingScope.run({ workspaceId, billingAccountWorkspaceId: workspaceId, runId, threadId, billingSource: 'credits' },
      () => store.reserve(workspaceId, 'fixture-model', call))
    const receipt = async () => (await pool.query(`SELECT "usageRunId","usageThreadId","usageMessageId","billingSource",state,
      "costMicroUsd"::int AS cost,"inputTokens"::int AS input FROM hosted_usage WHERE id=$1`, [call])).rows[0]
    await store.settle(call, null, 11, 7, 'fixture-call', null, 'msg_credits')
    const attribution = { usageRunId: runId, usageThreadId: threadId, usageMessageId: 'msg_credits', billingSource: 'credits' }
    assert.deepEqual(await receipt(), { ...attribution, state: 'unknown', cost: null, input: 11 })
    await store.settle(call, 25_000, 11, 7, 'fixture-call')
    await store.settle(call, 75_000, 40, 8, 'fixture-call', null, 'different-message')
    assert.deepEqual(await receipt(), { ...attribution, state: 'settled', cost: 25_000, input: 11 })
    assert.equal((await store.balance(workspaceId)).free, 975_000)
  })
  /** `n` messages sent in this workspace's chats (created by `creator`), plus a 重试 and a welcome request that never count. */
  const sent = async (workspaceId: string, n: number, creator = `creator-${workspaceId}`) => {
    await pool.query('INSERT INTO mikka_workspaces VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [workspaceId, creator])
    const bot = randomUUID()
    await pool.query('INSERT INTO bots VALUES ($1,$2)', [bot, workspaceId])
    for (let i = 0; i < n; i++) await pool.query(`INSERT INTO coordinator_events VALUES ($1,$2,'user_message',$3)`, [randomUUID(), bot, JSON.stringify({ text: `message ${i}` })])
    await pool.query(`INSERT INTO coordinator_events VALUES ($1,$2,'user_message',$3),($4,$2,'user_message',$5)`, [randomUUID(), bot, JSON.stringify({ text: '', retry: true }), randomUUID(), JSON.stringify({ text: '[Welcome] hi' })])
  }
  // A workspace verified before 2026-11-15, holding the USD 1 allowance it was granted then.
  // New verifications grant nothing (decision 2026-11-15-1900); existing grants stay usable.
  const verified = async () => {
    const id = randomUUID()
    await store.verify(id, 'cus_fixture', `card_${id}`)
    await pool.query('INSERT INTO hosted_allowances ("workspaceId",remaining) VALUES ($1,1000000) ON CONFLICT DO NOTHING', [id])
    return id
  }
  await t.test('owner-only Decisions reservations attribute member spend and enforce the member budget', async () => {
    const { hostedBillingScope } = await import('./context')
    const { readResourceBudgets, resourceBudgetAdmission } = await import('../billing/resource-budgets')
    const workspaceId = await verified(), ownerId = `owner-${randomUUID()}`, call = randomUUID()
    const attribution = { workspaceId, billingAccountWorkspaceId: workspaceId, ownerId, attributionComplete: true }
    await pool.query(`insert into billing_resource_budgets (id,"workspaceId",scope,"scopeId",period,"limitPoints","warningPercent","updatedBy") values($1,$2,'member',$3,'month',10,50,$3)`, [randomUUID(), workspaceId, ownerId])
    await hostedBillingScope.run(attribution, () => store.reserve(workspaceId, 'mikka-decision', call))
    assert.equal((await pool.query('select "actorId" from hosted_usage where id=$1', [call])).rows[0].actorId, ownerId)
    await store.settle(call, 100_000)
    const [budget] = await readResourceBudgets(pool, [workspaceId])
    assert.equal(budget.spentPoints, 10)
    assert.equal(await resourceBudgetAdmission(pool, workspaceId, attribution, 1), false)
    await hostedBillingScope.run(attribution, () => assert.rejects(store.reserve(workspaceId, 'Decisions', randomUUID()), /usage_budget_exhausted/))
    const other = { ...attribution, actorId: `other-${randomUUID()}` }
    const otherCall = randomUUID()
    await hostedBillingScope.run(other, () => store.reserve(workspaceId, 'Decisions', otherCall))
    assert.equal((await pool.query('select "actorId" from hosted_usage where id=$1', [otherCall])).rows[0].actorId, other.actorId)
    await store.settle(otherCall, 0)
  })
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
  await t.test('no trial: an unfunded workspace spends nothing and records nothing', async () => {
    const fresh = randomUUID()
    await sent(fresh, 1)
    await assert.rejects(store.canUseMikkaPaid(fresh), /points_exhausted/)
    await assert.rejects(store.reserve(fresh, 'fixture-unfunded', randomUUID()), /points_exhausted/)
    assert.equal((await store.status(fresh)).state, 'points_exhausted')
    assert.equal((await pool.query('SELECT count(*)::int n FROM hosted_usage WHERE "workspaceId"=$1', [fresh])).rows[0].n, 0)
    // A card verified now grants no allowance.
    await store.verify(fresh, 'cus_new', `card_${fresh}`)
    assert.equal((await store.balance(fresh)).free, 0)
    await assert.rejects(store.reserve(fresh, 'fixture-unfunded', randomUUID()), /points_exhausted/)
  })
  await t.test('a legacy allowance stays usable until it is spent', async () => {
    const funded = await verified(), call = randomUUID()
    await store.canUseMikkaPaid(funded)
    await store.reserve(funded, 'fixture-legacy', call)
    await store.settle(call, 1_000, 5, 5)
    assert.equal((await store.balance(funded)).free, 999_000)
    await pool.query('UPDATE hosted_allowances SET remaining=0 WHERE "workspaceId"=$1', [funded])
    await assert.rejects(store.canUseMikkaPaid(funded), /points_exhausted/)
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
    'unfunded refused; same card verified concurrently grants no allowance, retained after workspace deletion',
    async () => {
      const past = randomUUID()
      await sent(past, 21)
      await assert.rejects(
        store.reserve(past, 'fixture', randomUUID()),
        /points_exhausted/,
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
        0,
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
        /points_exhausted/,
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
        if (r.status === 'rejected') assert.match(String(r.reason), /points_exhausted/)
      assert.equal((await store.status(id)).state, 'points_exhausted')
      // Settlement charges the actual cost and releases the hold.
      await store.settle(admitted[0], 30_000)
      assert.equal((await store.balance(id)).free, 220_000)
      await store.reserve(id, 'fixture', randomUUID())
      await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /points_exhausted/)
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
  await t.test('readiness ignores abandoned holds that a new reservation reaps', async () => {
    const id = await verified(), abandoned = randomUUID(), reconcilable = randomUUID()
    await pool.query('UPDATE hosted_allowances SET remaining=150000 WHERE "workspaceId"=$1', [id])
    await store.reserve(id, 'fixture', abandoned)
    await store.settle(abandoned, null)
    assert.equal((await store.status(id)).state, 'points_exhausted')
    await pool.query(`UPDATE hosted_usage SET "createdAt"=now()-interval '11 minutes' WHERE id=$1`, [abandoned])
    assert.equal((await store.status(id)).state, 'ready')
    assert.equal((await pool.query('SELECT state FROM hosted_usage WHERE id=$1', [abandoned])).rows[0].state, 'unknown')
    await store.reserve(id, 'fixture', reconcilable)
    assert.equal((await pool.query('SELECT state FROM hosted_usage WHERE id=$1', [abandoned])).rows[0].state, 'failed')
    await store.settle(reconcilable, null, 0, 0, 'fixture-generation')
    await pool.query(`UPDATE hosted_usage SET "createdAt"=now()-interval '11 minutes' WHERE id=$1`, [reconcilable])
    assert.equal((await store.status(id)).state, 'points_exhausted')
  })
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
    await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /points_exhausted/)
    await pool.query("INSERT INTO workspace_credit_grants VALUES ($1,$2,1,'purchased')", [randomUUID(), id])
    await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /points_exhausted/)
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
    await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /points_exhausted/)
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
