import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { Pool } from 'pg'
import { retryInboxWakes } from './inbox-retry'
import { CoordinatorInbox, isolatedInboxOptions, wakeFixture, controlledEffect } from './wake-test-helpers'
import type { WakeDelivery } from './inbox-receipts'
const url = process.env.WAKE_TEST_DATABASE_URL
if (!url || new URL(url).hostname !== '127.0.0.1' || !new URL(url).pathname.endsWith('_176'))
  throw new Error('isolated wake database required')
const pool = new Pool({ connectionString: url, max: 20 }),
  members = new Pool({ connectionString: url, max: 20 })
let now = new Date('2036-01-01T00:00:00Z')
const options = () => isolatedInboxOptions(pool, members, () => now)
const inbox = () => new CoordinatorInbox(pool, options())
const row = async (id: string) => (await pool.query('SELECT * FROM coordinator_events WHERE id=$1', [id])).rows[0]
async function claimed(owner: string) {
  const claim = await inbox().claim(owner)
  assert.ok(claim && 'delivery' in claim)
  return claim.delivery
}
async function killed(owner: string, delivery: WakeDelivery, phase: string) {
  const holder = `child-${randomUUID()}`
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/fixtures/wake-consumer.ts'], {
    env: {
      ...process.env,
      WAKE_CHILD_INPUT: JSON.stringify({ owner, delivery, holder, phase, clock: now.toISOString() }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const reader = createInterface({ input: child.stdout }),
    timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  try {
    const [line] = await once(reader, 'line')
    const output = JSON.parse(line)
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    assert.deepEqual(await exited, [null, 'SIGKILL'])
    return { holder, ...output }
  } finally {
    clearTimeout(timer)
    reader.close()
  }
}
test('formal inbox: accepted delivery, lost ACK, real consumer SIGKILL, checkpoint, exhaustion and authority', async (t) => {
  try {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS wake_control_effects(operation_id uuid PRIMARY KEY,executions integer NOT NULL)',
    )
    await t.test('legacy staged events require reconciliation; migration replay preserves decisions', async () => {
      const namespace = `wake_legacy_${randomUUID().replaceAll('-', '')}`
      await pool.query(`CREATE SCHEMA ${namespace}`)
      const fixture = new Pool({ connectionString: url, options: `-c search_path=${namespace}` })
      try {
        const names = orderMigrations(
          (await readdir(new URL('../../drizzle/', import.meta.url))).filter((n) => n.endsWith('.sql')),
        )
        const current = '20261025191001_coordinator_consumption_receipts.sql'
        for (const name of names.filter((n) => n !== current))
          await fixture.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'))
        const ids = Array.from({ length: 4 }, () => randomUUID())
        for (let i = 0; i < ids.length; i++)
          await fixture.query(
            'INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,"deliveredAt","accountActionBatch") VALUES($1::uuid,\'legacy-fixture\',\'user_message\',$1::text,\'{}\',$2,$3)',
            [
              ids[i],
              i === 0 ? null : new Date(),
              i > 1 ? { holder: 'old-process', closed: i === 2, batches: [] } : null,
            ],
          )
        const migration = await readFile(new URL(`../../drizzle/${current}`, import.meta.url), 'utf8')
        await fixture.query(migration)
        const snapshot = async () =>
          (await fixture.query('SELECT id,wake_status,processed_at FROM coordinator_events ORDER BY id')).rows
        const before = await snapshot()
        await fixture.query(migration)
        assert.deepEqual(await snapshot(), before)
        const states = new Map(before.map((e) => [e.id, e]))
        assert.equal(states.get(ids[0]).wake_status, 'pending')
        assert.equal(states.get(ids[1]).wake_status, 'legacy_review')
        assert.equal(states.get(ids[2]).wake_status, 'completed')
        assert.ok(states.get(ids[2]).processed_at)
        assert.equal(states.get(ids[3]).wake_status, 'legacy_review')
      } finally {
        await fixture.end()
      }
    })
    await t.test('three transport failures persist; ten duplicate claims lead to one atomic response', async () => {
      const f = await wakeFixture(pool)
      let calls = 0
      let delivery: WakeDelivery | undefined
      for (let n = 0; n < 4; n++) {
        await retryInboxWakes(
          pool,
          async (_owner, d) => {
            calls++
            if (calls < 4) throw new Error('controlled transport failure')
            delivery = d
          },
          true,
          1,
          { ...options(), onlyOwner: f.owner },
        )
        const event = await row(f.eventId)
        assert.equal(event.wake_attempts, n + 1)
        now = new Date(event.wake_next_at.getTime() + 1)
      }
      assert.ok(delivery)
      assert.equal(calls, 4)
      const holders = Array.from({ length: 10 }, () => randomUUID())
      const receipts = await Promise.all(holders.map((h) => inbox().take(f.owner, h, delivery)))
      assert.equal(receipts.filter((r) => r.held).length, 1)
      const index = receipts.findIndex((r) => r.held),
        holder = holders[index]
      assert.ok((await row(f.eventId)).deliveredAt)
      assert.equal((await row(f.eventId)).processed_at, null)
      await Promise.all(
        Array.from({ length: 10 }, () =>
          inbox().acknowledge(f.owner, holder, delivery!, [
            { role: 'assistant', content: 'one actual persisted result' },
          ]),
        ),
      )
      assert.equal((await row(f.eventId)).wake_status, 'completed')
      assert.equal(
        (await pool.query('SELECT count(*)::int n FROM coordinator_messages WHERE source_event_id=$1', [f.eventId]))
          .rows[0].n,
        2,
      )
    })
    await t.test('accepted start whose ACK is lost after consumption never reopens completed event', async () => {
      const f = await wakeFixture(pool)
      await retryInboxWakes(
        pool,
        async (owner, d) => {
          const h = randomUUID()
          await inbox().take(owner, h, d)
          await inbox().acknowledge(owner, h, d, [
            { role: 'assistant', content: 'committed before lost transport ACK' },
          ])
          throw new Error('ACK lost')
        },
        true,
        1,
        { ...options(), onlyOwner: f.owner },
      )
      assert.equal((await row(f.eventId)).wake_status, 'completed')
      assert.equal(await inbox().claim(f.owner), null)
    })
    for (const phase of ['staged', 'checkpoint', 'effect'])
      await t.test(`actual SIGKILL after ${phase}: fenced restart and no blind generation resend`, async () => {
        const f = await wakeFixture(pool),
          delivery = await claimed(f.owner)
        const child = await killed(f.owner, delivery, phase)
        assert.equal((await row(f.eventId)).processed_at, null)
        now = new Date(now.getTime() + 1500)
        const claim = await inbox().claim(f.owner)
        if (phase === 'effect') {
          assert.ok(claim && 'exhausted' in claim)
          assert.equal((await row(f.eventId)).wake_generation_state, 'uncertain')
          await assert.rejects(inbox().replay(f.owner, f.eventId, 0), /wakeReconciliationRequired/)
        } else {
          assert.ok(claim && 'delivery' in claim)
          await assert.rejects(
            inbox().acknowledge(f.owner, child.holder, delivery, [
              { role: 'assistant', content: 'STALE MUST NOT PUBLISH' },
            ]),
            /wakeLeaseLost/,
          )
          const h = randomUUID(),
            receipt = await inbox().take(f.owner, h, claim.delivery)
          assert.ok(receipt.recovery)
          assert.equal(receipt.operationId, f.eventId)
          const cached = await inbox().cached(f.owner, claim.delivery)
          if (phase === 'checkpoint') {
            assert.ok(cached)
            await inbox().acknowledge(f.owner, h, claim.delivery, cached.messages, cached.warning)
          } else {
            assert.equal(cached, null)
            await inbox().acknowledge(f.owner, h, claim.delivery, [
              { role: 'assistant', content: 'resumed staged input exactly once' },
            ])
          }
          assert.equal(
            (await pool.query('SELECT count(*)::int n FROM coordinator_messages WHERE source_event_id=$1', [f.eventId]))
              .rows[0].n,
            2,
          )
        }
        assert.equal(
          (
            await pool.query(
              'SELECT COALESCE(sum(executions),0)::int n FROM wake_control_effects WHERE operation_id=$1',
              [f.eventId],
            )
          ).rows[0].n,
          phase === 'staged' ? 0 : 1,
        )
        console.log(
          JSON.stringify({
            evidence: 'actual child SIGKILL',
            phase,
            eventId: f.eventId,
            state: (await row(f.eventId)).wake_status,
            generation: (await row(f.eventId)).wake_generation_state,
          }),
        )
      })
    await t.test('publication PG failure keeps checkpoint; fresh lease ACK reuses result without effect', async () => {
      const f = await wakeFixture(pool),
        d = await claimed(f.owner),
        h = randomUUID()
      await inbox().take(f.owner, h, d)
      await inbox().beginGeneration(f.owner, h, d)
      await controlledEffect(pool, f.eventId)
      const name = `wake_fault_${randomUUID().replaceAll('-', '')}`
      await pool.query(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_event_id='${f.eventId}'::uuid AND NEW.message->>'role'='assistant' THEN RAISE EXCEPTION 'controlled publication failure'; END IF; RETURN NEW; END $$`,
      )
      await pool.query(
        `CREATE TRIGGER ${name} BEFORE INSERT ON coordinator_messages FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      )
      try {
        await assert.rejects(
          inbox().acknowledge(f.owner, h, d, [
            { role: 'assistant', content: 'PAID-RESULT PROBE IS CONTROLLED PG ONLY' },
          ]),
          /publication failure/,
        )
      } finally {
        await pool.query(`DROP TRIGGER ${name} ON coordinator_messages`)
      }
      assert.equal((await row(f.eventId)).wake_generation_state, 'returned')
      assert.ok((await row(f.eventId)).wake_checkpoint)
      await inbox().fail(f.owner, h, d)
      now = new Date(now.getTime() + 1500)
      const next = await claimed(f.owner),
        holder = randomUUID()
      await inbox().take(f.owner, holder, next)
      const checkpoint = await inbox().cached(f.owner, next)
      assert.ok(checkpoint)
      await inbox().acknowledge(f.owner, holder, next, checkpoint.messages, checkpoint.warning)
      assert.equal(
        (
          await pool.query(
            'SELECT COALESCE(sum(executions),0)::int n FROM wake_control_effects WHERE operation_id=$1',
            [f.eventId],
          )
        ).rows[0].n,
        1,
      )
    })
    await t.test('exhaustion and owner-scoped replay preserve operation ID and never grant new approval', async () => {
      const f = await wakeFixture(pool),
        other = await wakeFixture(pool)
      for (let n = 0; n < 5; n++) {
        await retryInboxWakes(
          pool,
          async () => {
            throw new Error('controlled unavailable')
          },
          true,
          1,
          { ...options(), onlyOwner: f.owner },
        )
        now = new Date((await row(f.eventId)).wake_next_at.getTime() + 1)
      }
      assert.equal((await row(f.eventId)).wake_status, 'failed')
      await assert.rejects(inbox().replay(other.owner, f.eventId, 0), /wakeNotFound/)
      assert.deepEqual(await inbox().replay(f.owner, f.eventId, 0), {
        eventId: f.eventId,
        generation: 1,
        operationId: f.eventId,
      })
      await assert.rejects(inbox().replay(f.owner, f.eventId, 0), /wakeReplayConflict/)
      const d = await claimed(f.owner),
        h = randomUUID()
      await inbox().take(f.owner, h, d)
      await inbox().acknowledge(f.owner, h, d, [{ role: 'assistant', content: 'replayed same logical event' }])
    })
    await t.test('current workspace revocation and scope mismatch prevent consumption and publication', async () => {
      const f = await wakeFixture(pool),
        d = await claimed(f.owner),
        h = randomUUID()
      await inbox().take(f.owner, h, d)
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1`, [f.workspace])
      await assert.rejects(
        inbox().acknowledge(f.owner, h, d, [{ role: 'assistant', content: 'PRIVATE MUST NOT PUBLISH' }]),
        /wakeWorkspaceAccessDenied/,
      )
      now = new Date(now.getTime() + 1500)
      const rejected = await inbox().claim(f.owner)
      assert.ok(rejected && 'exhausted' in rejected)
      assert.equal((await row(f.eventId)).wake_status, 'cancelled')
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int n FROM coordinator_messages WHERE source_event_id=$1 AND message->>'role'='assistant'`,
            [f.eventId],
          )
        ).rows[0].n,
        0,
      )
      const mismatch = await wakeFixture(pool)
      await pool.query(
        `UPDATE coordinator_events SET payload=jsonb_set(payload,'{workspaceId}',to_jsonb($2::text)) WHERE id=$1`,
        [mismatch.eventId, randomUUID()],
      )
      await inbox().claim(mismatch.owner)
      assert.equal((await row(mismatch.eventId)).wake_status, 'cancelled')
      await assert.rejects(
        pool.query('UPDATE coordinator_events SET wake_workspace_id=$2 WHERE id=$1', [mismatch.eventId, randomUUID()]),
        /immutable/,
      )
    })
    await t.test('persisted output publishes without a new resource admission or generation', async () => {
      const f = await wakeFixture(pool),
        d = await claimed(f.owner),
        h = randomUUID()
      await inbox().take(f.owner, h, d)
      await inbox().checkpoint(f.owner, h, d, [{ role: 'assistant', content: 'Already persisted; no new generation' }])
      await inbox().fail(f.owner, h, d)
      now = new Date(now.getTime() + 1500)
      let checks = 0
      const denied = new CoordinatorInbox(pool, {
        ...options(),
        admit: async () => {
          checks++
          return { admitted: false, retryAt: new Date(now.getTime() + 10000) }
        },
      })
      const c = await denied.claim(f.owner)
      assert.ok(c && 'delivery' in c)
      assert.equal(checks, 0)
      const next = randomUUID()
      await denied.take(f.owner, next, c.delivery)
      const cached = await denied.cached(f.owner, c.delivery)
      assert.ok(cached)
      await denied.acknowledge(f.owner, next, c.delivery, cached.messages, cached.warning)
      assert.equal((await row(f.eventId)).wake_status, 'completed')
      assert.equal(checks, 0)
    })
    await t.test('stop committed after staging fences generation and recovered notice has zero effects', async () => {
      const f = await wakeFixture(pool),
        device = randomUUID(),
        agent = randomUUID(),
        run = randomUUID()
      await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'stop fixture\')', [device, f.owner])
      await pool.query(
        'INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'stop fixture\',\'codex\',$3)',
        [agent, f.owner, device],
      )
      await pool.query(
        'INSERT INTO agent_runs(id,"userId","agentId","deviceId",status) VALUES($1,$2,$3,$4,\'running\')',
        [run, f.owner, agent, device],
      )
      await pool.query('UPDATE coordinator_events SET "runId"=$2 WHERE id=$1', [f.eventId, run])
      const child = randomUUID(),
        late = randomUUID()
      await pool.query(
        `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,wake_workspace_id) VALUES($1::uuid,$2,'run_report',$1::text,'{}','background',$3)`,
        [child, f.owner, f.workspace],
      )
      const d = await claimed(f.owner),
        h = randomUUID()
      assert.equal((await inbox().take(f.owner, h, d)).added, 2)
      await pool.query('UPDATE agent_runs SET status=\'cancelled\',"stopRequestedAt"=now() WHERE id=$1', [run])
      await pool.query(
        `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,wake_workspace_id) VALUES($1::uuid,$2,'run_report',$1::text,'{}','background',$3)`,
        [late, f.owner, f.workspace],
      )
      await assert.rejects(inbox().beginGeneration(f.owner, h, d), /wakeRunStopped/)
      await inbox().fail(f.owner, h, d)
      now = new Date(now.getTime() + 1500)
      const denied = new CoordinatorInbox(pool, {
        ...options(),
        admit: async () => {
          throw new Error('stop notice cannot reserve model quota')
        },
      })
      const c = await denied.claim(f.owner)
      assert.ok(c && 'delivery' in c)
      const holder = randomUUID(),
        receipt = await denied.take(f.owner, holder, c.delivery)
      assert.equal(receipt.notifyOnly, true)
      await denied.acknowledge(f.owner, holder, c.delivery, [
        { role: 'assistant', content: 'MUST BE REPLACED BY STOP NOTICE' },
      ])
      const output = (
        await pool.query(
          `SELECT message FROM coordinator_messages WHERE source_event_id=$1 AND message->>'role'='assistant'`,
          [f.eventId],
        )
      ).rows[0].message.content
      assert.match(output, /has not been resumed/)
      assert.doesNotMatch(output, /MUST BE REPLACED/)
      assert.equal((await row(f.eventId)).wake_generation_state, 'returned')
      assert.equal((await row(child)).wake_status, 'completed')
      assert.equal((await row(late)).deliveredAt, null)
      assert.equal(
        (await pool.query('SELECT count(*)::int n FROM wake_control_effects WHERE operation_id=$1', [f.eventId]))
          .rows[0].n,
        0,
      )
    })
    await t.test('budget deferral neither sends nor burns retry; late start ACK preserves defer', async () => {
      const f = await wakeFixture(pool)
      let sent = 0
      const denied = new CoordinatorInbox(pool, {
        ...options(),
        admit: async () => ({ admitted: false, retryAt: new Date(now.getTime() + 10000) }),
      })
      const c = await denied.claim(f.owner)
      assert.ok(c && 'deferred' in c)
      assert.equal((await row(f.eventId)).wake_attempts, 0)
      assert.equal(sent, 0)
      now = new Date(now.getTime() + 11000)
      const d = await claimed(f.owner)
      const holder = randomUUID()
      await denied.take(f.owner, holder, d)
      await denied.beginGeneration(f.owner, holder, d)
      sent++
      const before = (await row(f.eventId)).wake_next_at
      await denied.delivered(f.owner, d, 'late-synthetic-run')
      assert.equal((await row(f.eventId)).wake_next_at.getTime(), before.getTime())
      assert.equal((await row(f.eventId)).wake_attempts, 0)
    })
  } finally {
    await pool.end()
    await members.end()
  }
})
