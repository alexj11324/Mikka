import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { createWakeRecovery, deliverWake, MAX_WAKE_ATTEMPTS, WAKE_BACKOFF_MS, WAKE_LEASE_MS } from './wake-recovery'

const target = process.env.E2E_DATABASE_URL
/** Each owner's Coordinator: an ordinary bot row (this isolated schema has no bots table). */
const COORDINATOR = 'c0000000-0000-4000-8000-0000000c0de1'
if (process.env.REQUIRE_DB === '1' && !isE2eTarget(target)) throw new Error('Wake recovery requires an isolated loopback _e2e database')

test('durable Coordinator wake recovery against real PostgreSQL', { skip: !isE2eTarget(target) }, async t => {
  const schema = `wake_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}`, max: 16 })
  let now = new Date('2026-10-30T12:00:00Z')
  const recovery = createWakeRecovery(pool, () => now)
  await pool.query(`CREATE TABLE coordinator_events (
    id uuid PRIMARY KEY,"userId" text NOT NULL,"botId" uuid,kind text NOT NULL,tier text,
    payload jsonb NOT NULL DEFAULT '{}',"createdAt" timestamptz NOT NULL DEFAULT now(),"deliveredAt" timestamptz
  ); CREATE TABLE coordinator_sessions ("userId" text,"botId" uuid,"leaseHolder" text,"leaseUntil" timestamptz)`)
  await pool.query(await readFile(new URL('../../drizzle/20261031002604_coordinator_wake_recovery.sql', import.meta.url), 'utf8'))
  const event = async (userId: string, botId: string | null = COORDINATOR, tier: string | null = 'attention') => {
    const id = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,tier,"nextWakeAt") VALUES ($1,$2,$3,'user_message',$4,$5)`, [id, userId, botId, tier, now])
    return id
  }
  const ticket = async (scope: { userId: string; botId: string }, ids: string[]) => {
    const rows = (await pool.query<{ id: string; wakeAttempts: number; nextWakeAt: Date; wakeLeaseUntil: Date | null }>(
      `SELECT id,"wakeAttempts","nextWakeAt","wakeLeaseUntil" FROM coordinator_events
       WHERE "userId"=$1 AND "botId"=$2::uuid AND id=ANY($3::uuid[]) ORDER BY id`, [scope.userId, scope.botId, ids])).rows
    assert.ok(rows.length)
    return { ...scope, at: new Date(Math.min(...rows.map(row => Math.max(row.nextWakeAt.getTime(), row.wakeLeaseUntil?.getTime() ?? 0)))).toISOString(),
      events: rows.map(row => ({ id: row.id, attempt: row.wakeAttempts, nextWakeAt: row.nextWakeAt.toISOString(), leaseUntil: row.wakeLeaseUntil?.toISOString() ?? null })) }
  }
  try {
    await t.test('ten simultaneous wakes claim one chat once and another owner remains independent', async () => {
      await event('race-owner')
      await event('race-peer')
      const claims = await Promise.all(Array.from({ length: 10 }, () => recovery.claim({ userId: 'race-owner', botId: COORDINATOR })))
      assert.equal(claims.filter(Boolean).length, 1)
      assert.ok(await recovery.claim({ userId: 'race-peer', botId: COORDINATOR }))
    })

    await t.test('failure persists attempts and next retry; no new event is needed for recovery', async () => {
      const id = await event('retry-owner')
      const scope = { userId: 'retry-owner', botId: COORDINATOR }
      for (let index = 0; index < 3; index++) {
        const claim = await recovery.claim(scope)
        assert.ok(claim)
        assert.equal(await deliverWake(claim, { triage: async () => {}, hasWaking: async () => true,
          start: async () => { throw new Error('sensitive-provider-detail') }, failed: recovery.failed }), 'failed')
        const row = (await pool.query(`SELECT * FROM coordinator_events WHERE id=$1`, [id])).rows[0]
        assert.equal(row.wakeAttempts, index + 1)
        assert.equal(row.wakeLastError, 'wake_failed')
        assert.equal(row.nextWakeAt.getTime(), now.getTime() + WAKE_BACKOFF_MS[index])
        assert.equal(await recovery.claim(scope), null)
        now = row.nextWakeAt
      }
      assert.ok((await recovery.due()).some(scope => scope.userId === 'retry-owner'))
      const claim = await createWakeRecovery(pool, () => now).claim(scope)
      assert.ok(claim)
      assert.equal(await deliverWake(claim, { triage: async () => {}, hasWaking: async () => true,
        start: async () => { await pool.query(`UPDATE coordinator_events SET "deliveredAt"=$2 WHERE id=$1`, [id, now]) }, failed: recovery.failed }), 'started')
      assert.equal(await recovery.claim(scope), null)
      assert.equal(await recovery.replay(id), false)
    })

    await t.test('a process exiting after claim leaves a recoverable expired lease', async () => {
      const id = await event('crash-owner')
      const script = `import {Pool} from 'pg'; import {createWakeRecovery} from './lib/coordinator/wake-recovery.ts';
        const pool=new Pool({connectionString:process.env.E2E_DATABASE_URL,options:'-c search_path='+process.env.WAKE_TEST_SCHEMA});
        const claim=await createWakeRecovery(pool,()=>new Date(process.env.WAKE_TEST_TIME)).claim({userId:'crash-owner',botId:'c0000000-0000-4000-8000-0000000c0de1'});
        if(!claim)process.exitCode=2; await pool.end();`
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(), env: { ...process.env, WAKE_TEST_SCHEMA: schema, WAKE_TEST_TIME: now.toISOString() }, encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(await recovery.claim({ userId: 'crash-owner', botId: COORDINATOR }), null)
      now = new Date(now.getTime() + WAKE_LEASE_MS + 1)
      const replacement = await recovery.claim({ userId: 'crash-owner', botId: COORDINATOR })
      assert.deepEqual(replacement?.ids, [id])
      assert.equal(replacement?.attempt, 2)
    })

    await t.test('exhausted deliveries remain observable and require explicit replay', async () => {
      const id = await event('exhausted-owner')
      for (let index = 0; index < MAX_WAKE_ATTEMPTS; index++) {
        const claim = await recovery.claim({ userId: 'exhausted-owner', botId: COORDINATOR })
        assert.ok(claim)
        await recovery.failed(claim, 'wake_failed')
        now = new Date(now.getTime() + 900_001)
      }
      const row = (await pool.query(`SELECT "wakeAttempts","wakeLastError" FROM coordinator_events WHERE id=$1`, [id])).rows[0]
      assert.deepEqual(row, { wakeAttempts: MAX_WAKE_ATTEMPTS, wakeLastError: 'wake_exhausted' })
      assert.equal(await recovery.claim({ userId: 'exhausted-owner', botId: COORDINATOR }), null)
      assert.equal(await recovery.replay(id), true)
      assert.equal((await recovery.claim({ userId: 'exhausted-owner', botId: COORDINATOR }))?.attempt, 1)
    })

    await t.test('an active workflow lease prevents a second start; bot chats are separate', async () => {
      const botId = randomUUID()
      await event('leased-owner')
      await event('leased-owner', botId)
      await pool.query(`INSERT INTO coordinator_sessions VALUES ('leased-owner',$2,'existing-turn',$1)`, [new Date(now.getTime() + WAKE_LEASE_MS), COORDINATOR])
      assert.equal(await recovery.claim({ userId: 'leased-owner', botId: COORDINATOR }), null)
      assert.ok(await recovery.claim({ userId: 'leased-owner', botId }))
    })

    await t.test('background and delivered events never start another generation', async () => {
      await event('quiet-owner', COORDINATOR, 'background')
      const id = await event('delivered-owner')
      await pool.query(`UPDATE coordinator_events SET "deliveredAt"=$2 WHERE id=$1`, [id, now])
      assert.equal(await recovery.claim({ userId: 'quiet-owner', botId: COORDINATOR }), null)
      assert.equal(await recovery.claim({ userId: 'delivered-owner', botId: COORDINATOR }), null)
    })

    await t.test('an event written before the Coordinator had its bot row is still due, with no bot, for the sweep to move', async () => {
      await event('legacy-owner', null)
      assert.ok((await recovery.due()).some(scope => scope.userId === 'legacy-owner' && scope.botId === null))
    })

    await t.test('late failure from an expired claim cannot overwrite its replacement', async () => {
      const id = await event('late-owner')
      const prior = await recovery.claim({ userId: 'late-owner', botId: COORDINATOR })
      assert.ok(prior)
      now = new Date(now.getTime() + WAKE_LEASE_MS + 1)
      const current = await recovery.claim({ userId: 'late-owner', botId: COORDINATOR })
      assert.ok(current)
      await recovery.failed(prior, 'wake_failed')
      const row = (await pool.query(`SELECT "wakeLeaseUntil","wakeLastError" FROM coordinator_events WHERE id=$1`, [id])).rows[0]
      assert.equal(row.wakeLeaseUntil.getTime(), current.leaseUntil.getTime())
      assert.equal(row.wakeLastError, null)
    })

    await t.test('a stale deadline cannot claim an unrelated new message after its original batch was delivered', async () => {
      const scope = { userId: 'deadline-delivered-owner', botId: COORDINATOR }
      const original = await event(scope.userId)
      assert.ok(await recovery.claim(scope))
      const prior = await ticket(scope, [original])
      await pool.query(`UPDATE coordinator_events SET "deliveredAt"=$2 WHERE id=$1`, [original, now])
      const replacement = await event(scope.userId)
      now = new Date(prior.at)
      assert.equal(await recovery.claim(scope, prior), null)
      assert.equal((await pool.query(`SELECT "wakeAttempts" FROM coordinator_events WHERE id=$1`, [replacement])).rows[0].wakeAttempts, 0)
      assert.equal((await recovery.claim(scope))?.attempt, 1, 'normal producer/sweep still admits the new event')
    })

    await t.test('an old deadline cannot consume a replacement claim after its backoff elapsed', async () => {
      const scope = { userId: 'deadline-replaced-owner', botId: COORDINATOR }
      const id = await event(scope.userId)
      assert.ok(await recovery.claim(scope))
      const prior = await ticket(scope, [id])
      now = new Date(prior.at)
      const replacement = await recovery.claim(scope)
      assert.ok(replacement)
      await recovery.failed(replacement, 'wake_failed')
      now = (await pool.query(`SELECT "nextWakeAt" FROM coordinator_events WHERE id=$1`, [id])).rows[0].nextWakeAt
      assert.equal(await recovery.claim(scope, prior), null)
      assert.equal((await pool.query(`SELECT "wakeAttempts" FROM coordinator_events WHERE id=$1`, [id])).rows[0].wakeAttempts, 2)
    })

    await t.test('explicit exhausted-event replay invalidates the previous deadline generation', async () => {
      const scope = { userId: 'deadline-replayed-owner', botId: COORDINATOR }
      const id = await event(scope.userId)
      const claim = await recovery.claim(scope)
      assert.ok(claim)
      await recovery.failed(claim, 'wake_failed')
      const prior = await ticket(scope, [id])
      await pool.query(`UPDATE coordinator_events SET "wakeAttempts"=$2 WHERE id=$1`, [id, MAX_WAKE_ATTEMPTS])
      assert.equal(await recovery.replay(id), true)
      now = new Date(prior.at)
      assert.equal(await recovery.claim(scope, prior), null)
      assert.equal((await pool.query(`SELECT "wakeAttempts" FROM coordinator_events WHERE id=$1`, [id])).rows[0].wakeAttempts, 0)
    })

    await t.test('a deadline from another owner or Bot cannot claim that scope\'s unrelated due event', async () => {
      const source = { userId: 'deadline-source-owner', botId: COORDINATOR }
      const id = await event(source.userId)
      assert.ok(await recovery.claim(source))
      const prior = await ticket(source, [id])
      const other = { userId: 'deadline-other-owner', botId: randomUUID() }
      const otherId = await event(other.userId, other.botId)
      now = new Date(prior.at)
      assert.equal(await recovery.claim(other, prior), null)
      assert.equal((await pool.query(`SELECT "wakeAttempts" FROM coordinator_events WHERE id=$1`, [otherId])).rows[0].wakeAttempts, 0)
    })

    await t.test('a real deadline ticket waits until the exact persisted boundary without consuming an attempt', async () => {
      const scope = { userId: 'deadline-exact-owner', botId: COORDINATOR }
      await event(scope.userId)
      const claim = await recovery.claim(scope)
      assert.ok(claim?.ticket)
      assert.deepEqual(Object.keys(claim.ticket).sort(), ['at', 'botId', 'events', 'userId'])
      assert.deepEqual(Object.keys(claim.ticket.events[0]).sort(), ['attempt', 'id', 'leaseUntil', 'nextWakeAt'])
      now = new Date(claim.leaseUntil.getTime() - 1)
      assert.deepEqual(await recovery.resume(claim.ticket), { kind: 'wait', at: claim.leaseUntil.toISOString() })
      now = claim.leaseUntil
      const resumed = await recovery.resume(claim.ticket)
      assert.equal(resumed.kind, 'claimed')
      if (resumed.kind !== 'claimed') throw new Error('Expected an exact-deadline claim')
      assert.equal(resumed.claim.attempt, 2)
      assert.deepEqual(await recovery.resume(claim.ticket), { kind: 'obsolete' }, 'lost step completion cannot consume the new generation again')
    })

    await t.test('a failure ticket is committed, uses the original backoff, and carries no claim or message payload', async () => {
      const scope = { userId: 'deadline-failure-owner', botId: COORDINATOR }
      const id = await event(scope.userId)
      const claim = await recovery.claim(scope)
      assert.ok(claim)
      const next = await recovery.failed(claim, 'triage_pending')
      assert.ok(next)
      assert.deepEqual(Object.keys(next).sort(), ['at', 'botId', 'events', 'userId'])
      assert.equal(next.at, new Date(now.getTime() + WAKE_BACKOFF_MS[0]).toISOString())
      const visible = (await admin.query(`SELECT "nextWakeAt","wakeLeaseUntil","wakeLastError" FROM ${schema}.coordinator_events WHERE id=$1`, [id])).rows[0]
      assert.equal(visible.nextWakeAt.toISOString(), next.at)
      assert.equal(visible.wakeLeaseUntil, null)
      assert.equal(visible.wakeLastError, 'triage_pending')
      now = new Date(Date.parse(next.at) - 1)
      assert.deepEqual(await recovery.resume(next), { kind: 'wait', at: next.at })
      now = new Date(next.at)
      assert.equal((await recovery.resume(next)).kind, 'claimed')
    })

    await t.test('timers and the independent sweep still converge on one attempt', async () => {
      const scope = { userId: 'deadline-race-owner', botId: COORDINATOR }
      const id = await event(scope.userId)
      const claim = await recovery.claim(scope)
      assert.ok(claim?.ticket)
      now = claim.leaseUntil
      const won = await Promise.all([
        ...Array.from({ length: 10 }, () => recovery.resume(claim.ticket!).then(result => result.kind === 'claimed')),
        recovery.claim(scope).then(Boolean),
      ])
      assert.equal(won.filter(Boolean).length, 1)
      assert.equal((await pool.query(`SELECT "wakeAttempts" FROM coordinator_events WHERE id=$1`, [id])).rows[0].wakeAttempts, 2)
    })

    await t.test('real session and other-batch leases postpone a timer to their actual expiry without adding attempts', async () => {
      const scope = { userId: 'deadline-held-owner', botId: COORDINATOR }
      const original = await event(scope.userId)
      const claim = await recovery.claim(scope)
      assert.ok(claim)
      const pending = await recovery.failed(claim, 'wake_failed')
      assert.ok(pending)
      const fresh = await event(scope.userId)
      const freshClaim = await recovery.claim(scope)
      assert.deepEqual(freshClaim?.ids, [fresh])
      assert.ok(freshClaim)
      now = new Date(pending.at)
      assert.deepEqual(await recovery.resume(pending), { kind: 'wait', at: freshClaim.leaseUntil.toISOString() })
      const sessionUntil = new Date(freshClaim.leaseUntil.getTime() + 180_000)
      await pool.query(`INSERT INTO coordinator_sessions VALUES ($1,$2,'active-turn',$3)`, [scope.userId, scope.botId, sessionUntil])
      now = freshClaim.leaseUntil
      assert.deepEqual(await recovery.resume(pending), { kind: 'wait', at: sessionUntil.toISOString() })
      assert.equal((await pool.query(`SELECT "wakeAttempts" FROM coordinator_events WHERE id=$1`, [original])).rows[0].wakeAttempts, 1)
      now = sessionUntil
      const result = await recovery.resume(pending)
      assert.equal(result.kind, 'claimed')
      if (result.kind !== 'claimed') throw new Error('Expected the expired session to release the batch')
      assert.deepEqual(result.claim.ids, [original])
      assert.equal((await pool.query(`SELECT "wakeAttempts" FROM coordinator_events WHERE id=$1`, [fresh])).rows[0].wakeAttempts, 1)
    })

    await t.test('the remaining original event can recover without adopting new events or background siblings', async () => {
      const scope = { userId: 'deadline-partial-owner', botId: COORDINATOR }
      const remaining = await event(scope.userId), background = await event(scope.userId), delivered = await event(scope.userId)
      const claim = await recovery.claim(scope)
      assert.ok(claim?.ticket)
      await pool.query(`UPDATE coordinator_events SET tier='background' WHERE id=$1`, [background])
      await pool.query(`UPDATE coordinator_events SET "deliveredAt"=$2 WHERE id=$1`, [delivered, now])
      const fresh = await event(scope.userId)
      now = claim.leaseUntil
      const result = await recovery.resume(claim.ticket)
      assert.equal(result.kind, 'claimed')
      if (result.kind !== 'claimed') throw new Error('Expected only the remaining original event')
      assert.deepEqual(result.claim.ids, [remaining])
      const rows = (await pool.query(`SELECT id,"wakeAttempts" FROM coordinator_events WHERE id=ANY($1::uuid[])`, [[background, delivered, fresh]])).rows
      assert.equal(rows.find(row => row.id === fresh).wakeAttempts, 0)
      assert.equal(rows.find(row => row.id === background).wakeAttempts, 1)
      assert.equal(rows.find(row => row.id === delivered).wakeAttempts, 1)
    })

    await t.test('deadline recovery retains the same eight-attempt budget and finite backoff', async () => {
      const scope = { userId: 'deadline-cap-owner', botId: COORDINATOR }
      const id = await event(scope.userId)
      let claim = await recovery.claim(scope)
      assert.ok(claim)
      for (let attempt = 1; attempt <= MAX_WAKE_ATTEMPTS; attempt++) {
        assert.equal(claim.attempt, attempt)
        const next = await recovery.failed(claim, 'wake_failed')
        if (attempt === MAX_WAKE_ATTEMPTS) { assert.equal(next, null); break }
        assert.ok(next)
        assert.equal(Date.parse(next.at), now.getTime() + WAKE_BACKOFF_MS[Math.min(attempt - 1, WAKE_BACKOFF_MS.length - 1)])
        now = new Date(next.at)
        const result = await recovery.resume(next)
        assert.equal(result.kind, 'claimed')
        if (result.kind !== 'claimed') throw new Error('Expected the next bounded attempt')
        claim = result.claim
      }
      assert.equal(await recovery.claim(scope), null)
      assert.deepEqual((await pool.query(`SELECT "wakeAttempts","wakeLastError" FROM coordinator_events WHERE id=$1`, [id])).rows[0],
        { wakeAttempts: MAX_WAKE_ATTEMPTS, wakeLastError: 'wake_exhausted' })
    })

    await t.test('failed COMMIT cannot return a claim or failure ticket to a scheduler', async () => {
      await pool.query(`CREATE FUNCTION reject_wake_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."userId"='deadline-commit-owner' OR (NEW."userId"='deadline-failure-commit-owner' AND NEW."wakeLeaseUntil" IS NULL)
        THEN RAISE EXCEPTION 'synthetic_wake_commit_rejected' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
        CREATE CONSTRAINT TRIGGER reject_wake_commit AFTER UPDATE ON coordinator_events DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION reject_wake_commit()`)
      try {
        const rejected = await event('deadline-commit-owner')
        let scheduled = 0
        await assert.rejects(async () => {
          const claim = await recovery.claim({ userId: 'deadline-commit-owner', botId: COORDINATOR })
          if (claim?.ticket) scheduled++
        }, (error: unknown) => (error as { code?: string }).code === 'P0001')
        assert.equal(scheduled, 0)
        assert.equal((await admin.query(`SELECT "wakeAttempts" FROM ${schema}.coordinator_events WHERE id=$1`, [rejected])).rows[0].wakeAttempts, 0)
        const id = await event('deadline-failure-commit-owner')
        const claim = await recovery.claim({ userId: 'deadline-failure-commit-owner', botId: COORDINATOR })
        assert.ok(claim)
        await assert.rejects(async () => { if (await recovery.failed(claim, 'wake_failed')) scheduled++ },
          (error: unknown) => (error as { code?: string }).code === 'P0001')
        assert.equal(scheduled, 0)
        const row = (await admin.query(`SELECT "wakeLeaseUntil","nextWakeAt","wakeLastError" FROM ${schema}.coordinator_events WHERE id=$1`, [id])).rows[0]
        assert.equal(row.wakeLeaseUntil.toISOString(), claim.leaseUntil.toISOString())
        assert.equal(row.nextWakeAt.toISOString(), claim.leaseUntil.toISOString())
        assert.equal(row.wakeLastError, null)
      } finally { await pool.query('DROP TRIGGER reject_wake_commit ON coordinator_events; DROP FUNCTION reject_wake_commit()') }
    })

    for (const kind of ['session', 'wake'] as const) await t.test(`a ${kind} lease one PostgreSQL microsecond in the future still blocks the millisecond clock`, async () => {
      const scope = { userId: `deadline-microsecond-${kind}`, botId: COORDINATOR }
      const id = await event(scope.userId)
      const first = await recovery.claim(scope)
      assert.ok(first)
      const pending = await recovery.failed(first, 'wake_failed')
      assert.ok(pending)
      now = new Date(pending.at)
      if (kind === 'session') {
        await pool.query(`INSERT INTO coordinator_sessions VALUES ($1,$2,'microsecond-turn',$3::timestamptz + interval '1 microsecond')`, [scope.userId, scope.botId, now])
      } else {
        const other = await event(scope.userId)
        await pool.query(`UPDATE coordinator_events SET "wakeLeaseUntil"=$2::timestamptz + interval '1 microsecond' WHERE id=$1`, [other, now])
      }
      const expected = new Date(now.getTime() + 1)
      assert.deepEqual(await recovery.resume(pending), { kind: 'wait', at: expected.toISOString() })
      assert.equal((await pool.query(`SELECT "wakeAttempts" FROM coordinator_events WHERE id=$1`, [id])).rows[0].wakeAttempts, 1)
      now = expected
      const resumed = await recovery.resume(pending)
      assert.equal(resumed.kind, 'claimed')
      if (resumed.kind !== 'claimed') throw new Error('Expected the rounded-up lease to expire')
      assert.deepEqual(resumed.claim.ids, [id])
    })
  } finally {
    t.diagnostic(`Retained isolated wake recovery fixture schema ${schema}`)
    await pool.end()
    await admin.end()
  }
})
