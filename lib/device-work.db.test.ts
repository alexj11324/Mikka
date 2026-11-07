import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'
import { runMessagePrompt } from './run-message-prompt'
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
    const workspaceId = await seedFixtureWorkspace(pool, owner)
    const run = (id: string, deviceId: string, status: string, stop = false) => pool.query(
      `insert into agent_runs (id, "agentId", "userId", "deviceId", "workspaceId", status, "stopRequestedAt") values ($1, $2, $3, $4, $6, $5, ${stop ? 'now()' : 'null'})`, [id, agent, owner, deviceId, status, workspaceId])
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
      { kind: 'input', runId: ids.running, messageId: message, text: runMessagePrompt({ id: message, runId: ids.running, origin: 'owner', text: 'please also add a test' }) },
    ])
    assert.deepEqual((await deviceWork(device, [], { queued: false })).queuedRuns, [], 'a device with scheduling off is offered no runs')
    assert.deepEqual(await deviceWork(other, [ids.elsewhere], { queued: true }), { commands: [], queuedRuns: [] })
  })
})

dbTest('the idle check answers in one statement, finds the same work and pending device commands, and refuses a revoked credential', async t => {
  const [{ createRequestDatabaseScope, pool }, { deviceMayHaveWork }, { withDeviceDatabaseAuthority, DeviceAuthorityRevoked }] = await Promise.all([import('./db'), import('./device-link'), import('./db/device-scope')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-device-idle-${randomUUID()}`
  const device = randomUUID(), agent = randomUUID(), tokenId = randomUUID(), run = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('delete from run_messages where "userId"=$1', [owner])
      await pool.query('delete from agent_runs where "userId"=$1', [owner])
      await pool.query('delete from agents where "userId"=$1', [owner])
      await pool.query('delete from device_tokens where "userId"=$1', [owner])
      await pool.query('delete from device_management_commands where "deviceId"=$1', [device])
      await pool.query('delete from devices where "ownerId"=$1', [owner])
      await pool.query('delete from "user" where id=$1', [owner])
    })
    await scope.close()
  })
  await scope.run(async () => {
    await pool.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, 'Idle check fixture', $1 || '@example.invalid', false, now(), now())`, [owner])
    await pool.query(`insert into devices (id, name, "ownerId") values ($1, 'mine', $2)`, [device, owner])
    await pool.query(`insert into device_tokens (id, "userId", "tokenHash") values ($1, $2, $3)`, [tokenId, owner, randomUUID()])
    await pool.query(`insert into agents (id, "userId", harness, name) values ($1, $2, 'codex', 'a')`, [agent, owner])
    const workspaceId = await seedFixtureWorkspace(pool, owner)
    const idle = (options: { queued?: boolean; mailboxNotices?: boolean; skipDeviceCommands?: string[] } = {}, skip: string[] = []) =>
      withDeviceDatabaseAuthority({ tokenId, userId: owner }, () => deviceMayHaveWork(device, skip, options))
    const check = async (options: { queued?: boolean; mailboxNotices?: boolean } = {}, skip: string[] = []) => (await idle(options, skip)).work

    assert.equal(await check({ queued: true }), false, 'no runs: nothing to read')
    await pool.query(`insert into agent_runs (id, "agentId", "userId", "deviceId", "workspaceId", status) values ($1, $2, $3, $4, $5, 'queued')`, [run, agent, owner, device, workspaceId])
    assert.equal(await check({ queued: true }), true, 'a queued run')
    assert.equal(await check({ queued: false }), false, 'scheduling off: a queued run is not work')
    assert.equal(await check({ queued: true }, [run, 'not-a-uuid']), false, 'a skipped run is not work')
    await pool.query(`update agent_runs set status='running' where id=$1`, [run])
    assert.equal(await check(), false, 'a running run with nothing for it')
    assert.equal(await check({ mailboxNotices: true }), true, 'with mailbox notices a live run defers to the full read')
    await pool.query(`insert into run_messages (id, "runId", "userId", text) values ($1, $2, $3, 'more')`, [randomUUID(), run, owner])
    assert.equal(await check(), true, 'an undelivered message')
    await pool.query(`update run_messages set "deliveredAt"=now() where "runId"=$1`, [run])
    await pool.query(`update agent_runs set "stopRequestedAt"=now() where id=$1`, [run])
    assert.equal(await check(), true, 'a stop to deliver')

    const update = randomUUID(), restart = randomUUID()
    assert.equal((await idle({ skipDeviceCommands: [] })).deviceCommand, null, 'no device command pending')
    await pool.query(`insert into device_management_commands (id, "deviceId", kind, "createdAt") values ($1, $3, 'update', now() - interval '1 minute'), ($2, $3, 'restart', now())`, [update, restart, device])
    assert.equal((await idle()).deviceCommand, null, 'a daemon that does not read device commands from the poll is not told')
    assert.deepEqual((await idle({ skipDeviceCommands: [] })).deviceCommand, { id: update, kind: 'update' }, 'the oldest pending command')
    assert.deepEqual((await idle({ skipDeviceCommands: [update, 'not-a-uuid'] })).deviceCommand, { id: restart, kind: 'restart' }, 'commands the daemon holds are left out')
    await pool.query(`update device_management_commands set "completedAt"=now() where "deviceId"=$1`, [device])
    assert.equal((await idle({ skipDeviceCommands: [] })).deviceCommand, null, 'completed commands are not news')

    await pool.query(`update device_tokens set "revokedAt"=now() where id=$1`, [tokenId])
    await assert.rejects(check(), DeviceAuthorityRevoked, 'a revoked credential ends the poll')
  })
})
