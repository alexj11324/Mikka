import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'

const databaseUrl = process.env.E2E_DATABASE_URL
const eligible = databaseUrl && disposableDatabase(process.env, databaseUrl)
if (!eligible && process.env.REQUIRE_DB === '1') throw new Error('Demo cleanup acceptance requires isolated loopback *_e2e Postgres')

test('normal demo cleanup stops active runs, preserves history and excludes prefix/version lookalikes', { skip: !eligible }, async t => {
  const [{ createRequestDatabaseScope, pool }, { removeDemoDevices }] = await Promise.all([import('./db'), import('./demo-device-cleanup')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-demo-retirement-${randomUUID()}`
  const demo = 'de300000-' + randomUUID().slice(9)
  const prefixOnly = 'de300001-' + randomUUID().slice(9)
  const real = randomUUID()
  const agent = randomUUID(), realAgent = randomUUID()
  const active = randomUUID(), historic = randomUUID(), realRun = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [owner])
      await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [owner])
      await pool.query('DELETE FROM agents WHERE "userId"=$1', [owner])
      await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [owner])
      await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=$1', [owner])
      await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
    })
    await scope.close()
  })
  await scope.run(async () => {
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Demo retirement fixture',$2,true,now(),now())`, [owner, `${owner}@example.invalid`])
    const workspaceId = await seedFixtureWorkspace(pool, owner)
    // Completion wakes the real Coordinator, which may migrate legacy null-Bot
    // history. Give these ordinary runs their persisted source before snapshots.
    const { botId } = await (await import('./coordinator/coordinator-bot')).coordinatorBot(owner, workspaceId, { backfill: false })
    for (const [id, version] of [[demo, '0.9.4'], [prefixOnly, '0.0.503'], [real, '0.9.4']]) {
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType","daemonVersion",enabled,"lastSeenAt") VALUES($1,$2,'Same displayed name','local','laptop',$3,false,$4)`, [id, owner, version, new Date('2036-11-06')])
    }
    for (const [id, device] of [[agent, demo], [realAgent, real]]) await pool.query(`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,'codex',$4,$3)`, [id, owner, device, id])
    for (const [id, device, agentId, status] of [[active, demo, agent, 'running'], [historic, demo, agent, 'succeeded'], [realRun, real, realAgent, 'running']]) {
      await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId",status,"workspaceId","botId") VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, owner, agentId, device, status, workspaceId, botId])
    }
    const readReal = async () => (await pool.query(`SELECT row_to_json(d) AS device,(SELECT row_to_json(a) FROM agents a WHERE a.id=$2) AS agent FROM devices d WHERE d.id=$1`, [real, realAgent])).rows
    const beforeReal = await readReal()
    const beforeHistory = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [historic])).rows
    assert.deepEqual(await removeDemoDevices(), { devices: 1, activeRuns: 1, stoppedRuns: 0, removedDevices: 0 })
    assert.deepEqual(await removeDemoDevices(true), { devices: 1, activeRuns: 1, stoppedRuns: 1, removedDevices: 1 })
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [active])).rows[0].status, 'cancelled')
    assert.ok((await pool.query('SELECT "removedAt" FROM devices WHERE id=$1', [demo])).rows[0].removedAt)
    assert.equal((await pool.query('SELECT "deviceId" FROM agents WHERE id=$1', [agent])).rows[0].deviceId, null)
    assert.deepEqual(await readReal(), beforeReal)
    assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [historic])).rows, beforeHistory)
    assert.equal((await pool.query('SELECT "removedAt" FROM devices WHERE id=$1', [prefixOnly])).rows[0].removedAt, null)
    assert.deepEqual(await removeDemoDevices(true), { devices: 0, activeRuns: 0, stoppedRuns: 0, removedDevices: 0 })
  })
})
