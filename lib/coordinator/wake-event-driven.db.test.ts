import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { seedCoordinator } from '../../tests/support/coordinator-bot'

// #1212 D: Coordinator wakes no longer get a minute sweep. These cases run with no
// sweep at all and show the write itself, or its persisted deadline, does the work;
// only a start lost before it was made waits for the slow reconciliation sweep.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

dbTest('event-driven Coordinator wakes need no minute sweep', async t => {
  const [{ createRequestDatabaseScope, db, pool }, store, { recordCoordinatorEvent }, { userMessageEvent }, { sql }, recoveryModule, wake] = await Promise.all([
    import('../db'), import('./store'), import('../coordinator-event-store'), import('../coordinator-events'), import('drizzle-orm'),
    import('./wake-recovery'), import('../workflow-wake'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-wake-events-${randomUUID()}`
  const woken: string[] = []
  wake.wakeTransport.resume = async token => { woken.push(token) }
  t.after(async () => {
    delete wake.wakeTransport.resume
    t.diagnostic(JSON.stringify({ event: 'coordinator_db_fixture_retained', fixtureOwnerIds: [owner], database: 'mikka_e2e' }))
    await scope.close()
  })
  await scope.run(async () => {
    await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Wake fixture', ${`${owner}@example.invalid`}, false, now(), now())`)
    const botId = (await seedCoordinator(owner)).botId
    const token = wake.wakeTokens.coordinatorWake(owner, botId)

    await t.test('releasing a turn lease wakes the deadline waiting behind it, after COMMIT and only when it was held', async () => {
      await recordCoordinatorEvent(db, userMessageEvent(owner, 'First request', { botId }))
      assert.equal((await store.takeInbox(owner, 'wrun_release-fixture', botId)).held, true)
      woken.length = 0
      assert.equal(await store.releaseLease(owner, 'wrun_other-holder', botId), false)
      await settle()
      assert.deepEqual(woken, [], 'a holder that does not own the lease releases nothing and wakes nothing')
      await store.releaseLease(owner, 'wrun_release-fixture', botId)
      await settle()
      assert.deepEqual(woken, [token])
    })

    await t.test('a failed turn releases its lease and wakes the deadline token', async () => {
      await recordCoordinatorEvent(db, userMessageEvent(owner, 'Second request', { botId }))
      assert.equal((await store.takeInbox(owner, 'wrun_failed-fixture', botId)).held, true)
      woken.length = 0
      await store.failTurn(owner, 'wrun_failed-fixture', 'synthetic_failure', botId)
      await settle()
      assert.deepEqual(woken, [token])
    })

    await t.test('a failed start is claimed again exactly at its backoff, with no sweep', async () => {
      await recordCoordinatorEvent(db, userMessageEvent(owner, 'Third request', { botId }))
      let now = new Date()
      const recovery = recoveryModule.createWakeRecovery(pool, () => now)
      // The producer's own wake after COMMIT (wakeCoordinator) claims at once.
      const claim = await recovery.claim({ userId: owner, botId })
      assert.ok(claim)
      assert.equal(claim.attempt, 1)
      // Its turn did not start: the failure commits a deadline ticket for the durable workflow.
      const ticket = await recovery.failed(claim, 'wake_failed')
      assert.ok(ticket)
      assert.equal(Date.parse(ticket.at), now.getTime() + recoveryModule.WAKE_BACKOFF_MS[0])
      now = new Date(Date.parse(ticket.at) - 1)
      assert.deepEqual(await recovery.resume(ticket), { kind: 'wait', at: ticket.at }, 'not one millisecond early')
      now = new Date(ticket.at)
      const resumed = await recovery.resume(ticket)
      assert.equal(resumed.kind, 'claimed', 'claimed at the deadline itself')
      if (resumed.kind === 'claimed') assert.equal(resumed.claim.attempt, 2)
      await db.execute(sql`update coordinator_events set "deliveredAt"=now() where "userId"=${owner}`)
    })

    await t.test('a start lost before it was made is recovered by the slow sweep', async () => {
      let now = new Date()
      const recovery = recoveryModule.createWakeRecovery(pool, () => now)
      // COMMIT happened, then the process died before wakeCoordinator: no claim, no workflow.
      await recordCoordinatorEvent(db, userMessageEvent(owner, 'Lost request', { botId }))
      // The next reconciliation sweep (every 5 min) finds and claims it.
      now = new Date(now.getTime() + 5 * 60_000)
      assert.ok((await recovery.due(1000)).some(row => row.userId === owner && row.botId === botId))
      const claim = await recovery.claim({ userId: owner, botId })
      assert.ok(claim)
      assert.equal(claim.attempt, 1)
      assert.ok(claim.ticket, 'the sweep\'s claim arms the same durable deadline')
    })
  })
})
