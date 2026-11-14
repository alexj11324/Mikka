import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { deliverRunCompletion } from './run-completion-delivery'
import { runTriageBatch } from './triage-batch'

const target = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !disposableDatabase())
  throw new Error('Completion delivery requires isolated loopback *_e2e application databases')

type CompletionEvent = Parameters<typeof deliverRunCompletion>[1]
type Fixture = { event: CompletionEvent; scope: { userId: string; botId: string }; workspaceId: string; peer: string; otherBot: string }
const CREATED = '2026-11-03T01:00:00.123456Z'
const FINISHED = '2026-11-03T01:00:01.456789Z'

test('owned run completion delivery against real PostgreSQL', { skip: !disposableDatabase() }, async t => {
  const schema = `completion_delivery_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}`, max: 16 })
  try {
    await pool.query(`CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,"userId" text NOT NULL,kind text NOT NULL);
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid NOT NULL,"userId" text NOT NULL,status text NOT NULL,PRIMARY KEY ("workspaceId","userId"));
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text NOT NULL,"workspaceId" uuid NOT NULL);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text NOT NULL,"botId" uuid,"issueId" uuid,status text NOT NULL,"stopReason" text,"finishedAt" timestamptz);
      CREATE TABLE coordinator_events (id uuid PRIMARY KEY,"userId" text NOT NULL,"botId" uuid,kind text NOT NULL,tier text,"runId" uuid,"issueId" uuid,
        payload jsonb NOT NULL,"createdAt" timestamptz NOT NULL,"deliveredAt" timestamptz,"lastTriageAttemptAt" timestamptz,"triageDecision" jsonb);
      CREATE TABLE coordinator_sessions ("userId" text,"botId" uuid,"leaseHolder" text,"leaseUntil" timestamptz);
      CREATE TABLE hosted_verifications ("workspaceId" uuid PRIMARY KEY);
      CREATE TABLE workspace_credit_shares ("workspaceId" uuid,"userId" text);
    `)
    await pool.query(await readFile(new URL('../../drizzle/20261031002604_coordinator_wake_recovery.sql', import.meta.url), 'utf8'))

    const fixture = async (status = 'succeeded', issueId: string | null = randomUUID()): Promise<Fixture> => {
      const owner = `completion-owner-${randomUUID()}`, peer = `completion-peer-${randomUUID()}`
      const workspaceId = randomUUID(), botId = randomUUID(), otherBot = randomUUID(), runId = randomUUID(), eventId = randomUUID()
      await pool.query(`INSERT INTO mikka_workspaces VALUES ($1,$2,'team')`, [workspaceId, owner])
      await pool.query('INSERT INTO bots VALUES ($1,$3,$4),($2,$3,$4)', [botId, otherBot, owner, workspaceId])
      for (const member of [owner, peer, ...Array.from({ length: 6 }, () => `completion-member-${randomUUID()}`)])
        await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,$2,'active')`, [workspaceId, member])
      await pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,$5,'submitted',$6::timestamptz)`, [runId, owner, botId, issueId, status, FINISHED])
      await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"runId","issueId",payload,"createdAt","nextWakeAt")
        VALUES ($1,$2,$3,'run_finished',$4,$5,$6::jsonb,$7::timestamptz,$7::timestamptz)`,
      [eventId, owner, botId, runId, issueId, JSON.stringify({ status, stopReason: 'submitted', summary: 'Untrusted Agent summary; no approval or provider receipt.' }), CREATED])
      const event = (await pool.query<CompletionEvent>('SELECT * FROM coordinator_events WHERE id=$1', [eventId])).rows[0]
      // A host-read observation, never decoded from the event payload. The full
      // visibleRuns authorization gate is exercised by the application DB suite.
      event.observedRun = (await pool.query<NonNullable<CompletionEvent['observedRun']>>('SELECT id,status,"finishedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0]
      return { event, scope: { userId: owner, botId }, workspaceId, peer, otherBot }
    }
    const state = async (id: string) => (await pool.query('SELECT tier,"deliveredAt","triageDecision","wakeLastError" FROM coordinator_events WHERE id=$1', [id])).rows[0]

    await t.test('the same unpaid eight-member team event goes from triage_pending to one delivery without calling the paid classifier', async () => {
      const f = await fixture()
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM mikka_workspace_members WHERE "workspaceId"=$1 AND status=\'active\'', [f.workspaceId])).rows[0].n, 8)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM hosted_verifications WHERE "workspaceId"=$1', [f.workspaceId])).rows[0].n, 0)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_credit_shares WHERE "workspaceId"=$1', [f.workspaceId])).rows[0].n, 0)
      const now = new Date('2026-11-03T01:01:00Z')
      let claims = 0, classifications = 0, starts = 0, consumed = 0
      const deps = {
        claim: async (event: CompletionEvent) => {
          claims++
          return (await pool.query<{ attemptedAt: Date }>(`UPDATE coordinator_events SET "lastTriageAttemptAt"=$2
            WHERE id=$1 AND tier IS NULL AND "deliveredAt" IS NULL RETURNING "lastTriageAttemptAt" AS "attemptedAt"`, [event.id, now])).rows[0]?.attemptedAt ?? null
        },
        deliverUser: async () => { throw new Error('Not a user message') },
        // This is a deterministic admission refusal, not a fake provider
        // success. No billing reservation or external model call is made.
        classify: async () => { classifications++; throw new Error('verification_required') },
        complete: async () => { throw new Error('No model judgment exists') },
      }
      const hasWaking = async () => Boolean((await pool.query(`SELECT 1 FROM coordinator_events
        WHERE id=$1 AND "deliveredAt" IS NULL AND tier IS NOT NULL AND tier<>'background'`, [f.event.id])).rowCount)
      const start = async () => {
        starts++
        // A minimal delivery sink; the full workflow/takeInbox and provider
        // reply are deliberately accepted in separate application/live tests.
        const result = await pool.query(`UPDATE coordinator_events SET "deliveredAt"=$2
          WHERE id=$1 AND tier='result' AND "deliveredAt" IS NULL RETURNING id`, [f.event.id, now])
        consumed += result.rowCount ?? 0
      }
      const before = await runTriageBatch([f.event], deps, new AbortController().signal)
      assert.deepEqual(before.pending, [f.event.id])
      assert.equal(await hasWaking(), false)
      assert.deepEqual([claims, classifications, starts, consumed], [1, 2, 0, 0])

      const result = await runTriageBatch([f.event], {
        ...deps, deliverCompletion: event => deliverRunCompletion(pool, event, f.scope, pool),
      }, new AbortController().signal)
      assert.deepEqual(result, { classified: [f.event.id], pending: [], stale: [], unattempted: [] })
      assert.equal(await hasWaking(), true)
      await start()
      assert.deepEqual([claims, classifications, starts, consumed], [1, 2, 1, 1])
      assert.ok((await state(f.event.id)).deliveredAt)
      assert.equal(await hasWaking(), false)
      assert.equal(await deliverRunCompletion(pool, f.event, f.scope, pool), false)
      assert.deepEqual([starts, consumed], [1, 1])
    })

    await t.test('concurrent completion updates win once and persist only a transport receipt', async () => {
      const f = await fixture()
      const results = await Promise.all(Array.from({ length: 10 }, () => deliverRunCompletion(pool, f.event, f.scope, pool)))
      assert.equal(results.filter(Boolean).length, 1)
      const stored = await state(f.event.id)
      assert.equal(stored.tier, 'result')
      assert.equal(stored.deliveredAt, null, 'eligibility is not an invented consumed event or Bot reply')
      const receipt = stored.triageDecision
      assert.deepEqual(Object.keys(receipt).sort(), ['eventId', 'eventKind', 'finishedAt', 'method', 'runId', 'runStatus', 'version'])
      assert.deepEqual({ ...receipt, finishedAt: undefined }, { version: 1, method: 'run_completion_delivery', eventId: f.event.id,
        eventKind: 'run_finished', runId: f.event.runId, runStatus: 'succeeded', finishedAt: undefined })
      assert.equal(Date.parse(receipt.finishedAt), Date.parse(FINISHED))
      assert.ok(!JSON.stringify(receipt).includes('Untrusted Agent summary'))
    })

    await t.test('Postgres microseconds in both creation and completion dates preserve the observed event', async () => {
      const f = await fixture()
      const precision = (await pool.query(`SELECT extract(microseconds FROM e."createdAt")::int % 1000 AS created,
        extract(microseconds FROM r."finishedAt")::int % 1000 AS finished FROM coordinator_events e JOIN agent_runs r ON r.id=e."runId" WHERE e.id=$1`, [f.event.id])).rows[0]
      assert.deepEqual(precision, { created: 456, finished: 789 })
      assert.equal(await deliverRunCompletion(pool, f.event, f.scope, pool), true)
    })

    for (const status of ['failed', 'stopped', 'cancelled']) await t.test(`${status} is returned as actual terminal data, without manufacturing success or attention`, async () => {
      const f = await fixture(status, null)
      assert.equal(await deliverRunCompletion(pool, f.event, f.scope, pool), true)
      const stored = await state(f.event.id)
      assert.equal(stored.tier, 'result')
      assert.equal(stored.triageDecision.runStatus, status)
      assert.equal(stored.triageDecision.method, 'run_completion_delivery')
    })

    const denied: Array<{ name: string; change(f: Fixture): Promise<unknown> | void }> = [
      { name: 'another owner, even with a visible terminal run observation', change: f => pool.query('UPDATE agent_runs SET "userId"=$2 WHERE id=$1', [f.event.runId, f.peer]) },
      { name: 'another original Bot owned by the same person', change: f => pool.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [f.event.runId, f.otherBot]) },
      { name: 'a Bot whose owner changed', change: f => pool.query('UPDATE bots SET "ownerId"=$2 WHERE id=$1', [f.scope.botId, f.peer]) },
      { name: 'suspended workspace membership', change: f => pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [f.workspaceId, f.scope.userId]) },
      { name: 'removed workspace membership', change: f => pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [f.workspaceId, f.scope.userId]) },
      { name: 'an owner or Bot supplied outside the event scope', change: f => { f.scope.userId = f.peer } },
      { name: 'a different event Bot', change: f => { f.event.botId = f.otherBot } },
      { name: 'no visibleRuns observation', change: f => { f.event.observedRun = null } },
      { name: 'no host observation field', change: f => { delete f.event.observedRun } },
      { name: 'a different observed run', change: f => { f.event.observedRun!.id = randomUUID() } },
      { name: 'an observed unfinished run', change: f => { f.event.observedRun!.status = 'running' } },
      { name: 'an observed unknown status', change: f => { f.event.observedRun!.status = 'invented' } },
      { name: 'an observed run without a finish time', change: f => { f.event.observedRun!.finishedAt = null } },
      { name: 'a canonical unfinished run after the observation', change: f => pool.query(`UPDATE agent_runs SET status='finishing' WHERE id=$1`, [f.event.runId]) },
      { name: 'a canonical unknown status after the observation', change: f => pool.query(`UPDATE agent_runs SET status='invented' WHERE id=$1`, [f.event.runId]) },
      { name: 'a canonical missing finish time', change: f => pool.query('UPDATE agent_runs SET "finishedAt"=NULL WHERE id=$1', [f.event.runId]) },
      { name: 'a changed canonical finish time', change: f => pool.query(`UPDATE agent_runs SET "finishedAt"="finishedAt"+interval '1 second' WHERE id=$1`, [f.event.runId]) },
      { name: 'a mismatched canonical issue', change: f => pool.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=$1', [f.event.runId, randomUUID()]) },
      { name: 'a missing canonical run', change: f => pool.query('DELETE FROM agent_runs WHERE id=$1', [f.event.runId]) },
      { name: 'a changed persisted event payload', change: f => pool.query(`UPDATE coordinator_events SET payload=payload||'{"summary":"changed after observation"}'::jsonb WHERE id=$1`, [f.event.id]) },
      { name: 'a changed persisted event issue', change: f => pool.query('UPDATE coordinator_events SET "issueId"=$2 WHERE id=$1', [f.event.id, randomUUID()]) },
      { name: 'a changed persisted event timestamp', change: f => pool.query(`UPDATE coordinator_events SET "createdAt"="createdAt"+interval '1 millisecond' WHERE id=$1`, [f.event.id]) },
      { name: 'an already delivered event', change: f => pool.query('UPDATE coordinator_events SET "deliveredAt"=now() WHERE id=$1', [f.event.id]) },
      { name: 'an event already classified as background', change: f => pool.query(`UPDATE coordinator_events SET tier='background' WHERE id=$1`, [f.event.id]) },
      { name: 'OAuth Agent prose with a real run ID', change: async f => {
        f.event.kind = 'run_report'; f.event.payload.source = 'oauth_agent_mcp'
        await pool.query('UPDATE coordinator_events SET kind=$2,payload=$3::jsonb WHERE id=$1', [f.event.id, f.event.kind, JSON.stringify(f.event.payload)])
      } },
      { name: 'an unrelated runtime event kind', change: f => { f.event.kind = 'artifact_submitted' } },
      { name: 'an invented payload success against a failed canonical run', change: async f => {
        f.event.observedRun!.status = 'failed'
        await pool.query(`UPDATE agent_runs SET status='failed' WHERE id=$1`, [f.event.runId])
      } },
      { name: 'a payload stop reason contradicting canonical host state', change: async f => {
        f.event.payload.stopReason = 'forged'
        await pool.query('UPDATE coordinator_events SET payload=$2::jsonb WHERE id=$1', [f.event.id, JSON.stringify(f.event.payload)])
      } },
    ]
    for (const item of denied) await t.test(`refuses ${item.name}`, async () => {
      const f = await fixture()
      await item.change(f)
      assert.equal(await deliverRunCompletion(pool, f.event, f.scope, pool), false)
      assert.equal((await state(f.event.id)).triageDecision, null, 'a rejected result creates no transport/model receipt')
    })

    await t.test('separate application and workspace schemas never assume a cross-database membership table', async split => {
      const appSchema = `completion_app_${randomUUID().replaceAll('-', '')}`
      const workspaceSchema = `completion_workspace_${randomUUID().replaceAll('-', '')}`
      await admin.query(`CREATE SCHEMA ${appSchema}; CREATE SCHEMA ${workspaceSchema};
        CREATE TABLE ${appSchema}.bots (LIKE ${schema}.bots INCLUDING ALL);
        CREATE TABLE ${appSchema}.agent_runs (LIKE ${schema}.agent_runs INCLUDING ALL);
        CREATE TABLE ${appSchema}.coordinator_events (LIKE ${schema}.coordinator_events INCLUDING ALL);
        CREATE TABLE ${workspaceSchema}.mikka_workspace_members (LIKE ${schema}.mikka_workspace_members INCLUDING ALL)`)
      const appPool = new Pool({ connectionString: target, options: `-c search_path=${appSchema}`, max: 4 })
      const workspacePool = new Pool({ connectionString: target, options: `-c search_path=${workspaceSchema}`, max: 4 })
      const separateFixture = async () => {
        const f = await fixture()
        await admin.query(`INSERT INTO ${appSchema}.bots SELECT * FROM ${schema}.bots WHERE id=$1`, [f.scope.botId])
        await admin.query(`INSERT INTO ${appSchema}.agent_runs SELECT * FROM ${schema}.agent_runs WHERE id=$1`, [f.event.runId])
        await admin.query(`INSERT INTO ${appSchema}.coordinator_events SELECT * FROM ${schema}.coordinator_events WHERE id=$1`, [f.event.id])
        await admin.query(`INSERT INTO ${workspaceSchema}.mikka_workspace_members SELECT * FROM ${schema}.mikka_workspace_members WHERE "workspaceId"=$1`, [f.workspaceId])
        return f
      }
      try {
        assert.equal((await appPool.query(`SELECT to_regclass('mikka_workspace_members') IS NULL AS absent`)).rows[0].absent, true)
        assert.deepEqual((await workspacePool.query(`SELECT to_regclass('bots') IS NULL AS bots_absent,
          to_regclass('agent_runs') IS NULL AS runs_absent,to_regclass('coordinator_events') IS NULL AS events_absent`)).rows[0],
        { bots_absent: true, runs_absent: true, events_absent: true })
        await split.test('an active workspace member receives its application-owned completion', async () => {
          const f = await separateFixture()
          assert.equal(await deliverRunCompletion(appPool, f.event, f.scope, workspacePool), true)
          const row = (await appPool.query('SELECT tier,"triageDecision" FROM coordinator_events WHERE id=$1', [f.event.id])).rows[0]
          assert.equal(row.tier, 'result')
          assert.equal(row.triageDecision.method, 'run_completion_delivery')
        })
        for (const action of ['suspend', 'remove']) await split.test(`${action} in the workspace database wins over the application's still-active fixture copy`, async () => {
          const f = await separateFixture()
          if (action === 'suspend') await workspacePool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [f.workspaceId, f.scope.userId])
          else await workspacePool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [f.workspaceId, f.scope.userId])
          assert.equal(await deliverRunCompletion(appPool, f.event, f.scope, workspacePool), false)
          assert.equal((await appPool.query('SELECT tier FROM coordinator_events WHERE id=$1', [f.event.id])).rows[0].tier, null)
          assert.equal((await pool.query(`SELECT status FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2`, [f.workspaceId, f.scope.userId])).rows[0].status, 'active', 'the old application-side fixture is not the authorization source')
        })
        await split.test('workspace revocation cannot race past the membership lock held across the application CAS', async () => {
          const f = await separateFixture()
          let resume!: () => void, entered!: () => void
          const gate = new Promise<void>(resolve => { resume = resolve })
          const atCas = new Promise<void>(resolve => { entered = resolve })
          // Delay only scheduling of the real application UPDATE. Both reads,
          // the membership row lock and the CAS still execute in PostgreSQL.
          const delayedApp = { query: (async (query: string, values?: unknown[]) => {
            if (query.startsWith('UPDATE coordinator_events')) { entered(); await gate }
            return appPool.query(query, values)
          }) as Pool['query'] }
          const delivery = deliverRunCompletion(delayedApp, f.event, f.scope, workspacePool)
          const revoker = await workspacePool.connect()
          try {
            await Promise.race([atCas, delivery.then(() => { throw new Error('Completion did not reach the real application CAS') })])
            await revoker.query('BEGIN')
            await revoker.query(`SET LOCAL lock_timeout='100ms'`)
            await assert.rejects(revoker.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [f.workspaceId, f.scope.userId]), { code: '55P03' })
            await revoker.query('ROLLBACK')
            resume()
            assert.equal(await delivery, true)
            assert.equal((await revoker.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [f.workspaceId, f.scope.userId])).rowCount, 1, 'the delivery releases its row lock before returning')
          } finally {
            resume()
            await delivery.catch(() => undefined)
            await revoker.query('ROLLBACK')
            revoker.release()
          }
        })
      } finally {
        split.diagnostic(`Retained separate application ${appSchema} and workspace ${workspaceSchema} fixture schemas`)
        await appPool.end()
        await workspacePool.end()
      }
    })

    await t.test('peer prose remains pending under the same classifier admission refusal', async () => {
      const f = await fixture()
      f.event.kind = 'run_report'; f.event.payload.source = 'oauth_agent_mcp'
      await pool.query('UPDATE coordinator_events SET kind=$2,payload=$3::jsonb WHERE id=$1', [f.event.id, f.event.kind, JSON.stringify(f.event.payload)])
      let calls = 0
      const result = await runTriageBatch([f.event], {
        deliverUser: async () => false,
        deliverCompletion: event => deliverRunCompletion(pool, event, f.scope, pool),
        claim: async () => new Date(),
        classify: async () => { calls++; throw new Error('verification_required') },
        complete: async () => { throw new Error('No model result') },
      }, new AbortController().signal)
      assert.deepEqual(result.pending, [f.event.id])
      assert.equal(calls, 2)
      assert.equal((await state(f.event.id)).tier, null)
    })
  } finally {
    t.diagnostic(`Retained isolated completion delivery fixture schema ${schema}`)
    await pool.end()
    await admin.end()
  }
})
