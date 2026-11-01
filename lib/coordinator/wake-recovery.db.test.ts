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
  } finally {
    t.diagnostic(`Retained isolated wake recovery fixture schema ${schema}`)
    await pool.end()
    await admin.end()
  }
})
