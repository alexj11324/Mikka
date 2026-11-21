import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { seedCoordinator } from '../../tests/support/coordinator-bot'

// Commit callbacks and historical turn releases still have distinct delivery contracts.
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
  const [{ createRequestDatabaseScope, db }, store, { recordCoordinatorEvent }, { userMessageEvent }, { sql }, wake] = await Promise.all([
    import('../db'), import('@/tests/support/legacy-coordinator-store'), import('../coordinator-event-store'), import('../coordinator-events'), import('drizzle-orm'),
    import('../workflow-wake'),
  ])
  const { coordinatorWakeTransport } = await import('./wake-after-commit')
  const ownerWakes: string[] = []
  coordinatorWakeTransport.wake = async userId => { ownerWakes.push(userId) }
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-wake-events-${randomUUID()}`
  const woken: string[] = []
  wake.wakeTransport.resume = async token => { woken.push(token) }
  t.after(async () => {
    delete wake.wakeTransport.resume
    delete coordinatorWakeTransport.wake
    t.diagnostic(JSON.stringify({ event: 'coordinator_db_fixture_retained', fixtureOwnerIds: [owner], database: 'mikka_e2e' }))
    await scope.close()
  })
  await scope.run(async () => {
    await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Wake fixture', ${`${owner}@example.invalid`}, false, now(), now())`)
    const botId = (await seedCoordinator(owner)).botId
    const token = wake.wakeTokens.coordinatorWake(owner, botId)

    await t.test('a producer\'s pending row starts the owner\'s wake after COMMIT, once per commit, never on rollback', async () => {
      ownerWakes.length = 0
      await db.transaction(async tx => {
        await recordCoordinatorEvent(tx, userMessageEvent(owner, 'Producer one', { botId }))
        await recordCoordinatorEvent(tx, { userId: owner, botId, kind: 'run_report', dedupeKey: `test-report-${randomUUID()}`, issueId: null, runId: null, payload: { text: 'A report' } })
        await settle()
        assert.deepEqual(ownerWakes, [], 'nothing before COMMIT')
      })
      await settle()
      assert.deepEqual(ownerWakes, [owner])
      ownerWakes.length = 0
      await assert.rejects(db.transaction(async tx => {
        await recordCoordinatorEvent(tx, userMessageEvent(owner, 'Rolled back', { botId }))
        throw new Error('synthetic rollback')
      }), /synthetic rollback/)
      await settle()
      assert.deepEqual(ownerWakes, [])
      await db.execute(sql`update coordinator_events set "deliveredAt"=now() where "userId"=${owner}`)
    })

    await t.test('a row triage has not seen, written during a turn, is woken when the turn lets go', async () => {
      await recordCoordinatorEvent(db, userMessageEvent(owner, 'Turn request', { botId }))
      assert.equal((await store.takeInbox(owner, 'wrun_untriaged-fixture', botId)).held, true)
      // A tool's escalation during the turn: tier NULL, so not this loop's to take; its own wake deferred.
      await recordCoordinatorEvent(db, { userId: owner, botId, kind: 'run_question', dedupeKey: `test-question-${randomUUID()}`, issueId: null, runId: null, payload: { text: 'A question' } })
      await settle()
      ownerWakes.length = 0
      assert.equal(await store.releaseLease(owner, 'wrun_untriaged-fixture', botId), false, 'not a waking row for the loop')
      await settle()
      assert.deepEqual(ownerWakes, [owner])
      await db.execute(sql`update coordinator_events set "deliveredAt"=now() where "userId"=${owner}`)
    })

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

  })
})
