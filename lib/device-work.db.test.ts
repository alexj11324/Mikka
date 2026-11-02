import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'

// Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure runs skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

dbTest('one read of a device\'s runs finds its stops, messages and queued runs', async t => {
  const [{ createRequestDatabaseScope, pool }, { deviceWork }] = await Promise.all([import('./db'), import('./device-link')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-device-work-${randomUUID()}`
  const device = randomUUID(), other = randomUUID(), agent = randomUUID()
  const ids = { queued: randomUUID(), skippedQueued: randomUUID(), stopping: randomUUID(), running: randomUUID(), finished: randomUUID(), elsewhere: randomUUID() }
  const message = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('delete from run_messages where "userId"=$1', [owner])
      await pool.query('delete from agent_runs where "userId"=$1', [owner])
      await pool.query('delete from agents where "userId"=$1', [owner])
      await pool.query('delete from devices where "ownerId"=$1', [owner])
      await pool.query('delete from "user" where id=$1', [owner])
    })
    await scope.close()
  })
  await scope.run(async () => {
    await pool.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, 'Device work fixture', $1 || '@example.invalid', false, now(), now())`, [owner])
    await pool.query(`insert into devices (id, name, "ownerId") values ($1, 'mine', $3), ($2, 'other', $3)`, [device, other, owner])
    await pool.query(`insert into agents (id, "userId", harness, name) values ($1, $2, 'codex', 'a')`, [agent, owner])
    const run = (id: string, deviceId: string, status: string, stop = false) => pool.query(
      `insert into agent_runs (id, "agentId", "userId", "deviceId", status, "stopRequestedAt") values ($1, $2, $3, $4, $5, ${stop ? 'now()' : 'null'})`, [id, agent, owner, deviceId, status])
    await run(ids.queued, device, 'queued')
    await run(ids.skippedQueued, device, 'queued')
    await run(ids.stopping, device, 'running', true)
    await run(ids.running, device, 'running')
    await run(ids.finished, device, 'succeeded', true)
    await run(ids.elsewhere, other, 'queued')
    await pool.query(`insert into run_messages (id, "runId", "userId", text) values ($1, $2, $3, 'please also add a test')`, [message, ids.running, owner])

    const work = await deviceWork(device, [ids.skippedQueued], { queued: true })
    assert.deepEqual(work.queuedRuns, [ids.queued], 'queued runs of this device, without skipped ones')
    assert.deepEqual(work.commands, [
      { kind: 'stop', runId: ids.stopping },
      { kind: 'input', runId: ids.running, messageId: message, text: 'please also add a test' },
    ])
    assert.deepEqual((await deviceWork(device, [], { queued: false })).queuedRuns, [], 'a device with scheduling off is offered no runs')
    assert.deepEqual(await deviceWork(other, [ids.elsewhere], { queued: true }), { commands: [], queuedRuns: [] })
  })
})
