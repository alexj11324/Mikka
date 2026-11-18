import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'
import { seedAgent, seedRun } from '../tests/support/workspace-admin-db'

// Database regressions run in CI against the ephemeral Postgres 17; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

dbTest('a change that takes a run\'s authority away stops it at once and leaves authorized runs alone', async t => {
  const [{ createRequestDatabaseScope, pool }, lifecycle, { stopRunsWithoutAuthority }, { deviceWork }] = await Promise.all([
    import('./db'), import('./bot-lifecycle'), import('./run-authority-stop'), import('./device-link')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  t.after(() => scope.close())
  await scope.run(async () => {
    const owner = `run-authority-${randomUUID()}`
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Authority fixture',$2,true,now(),now())`, [owner, `${owner}@example.invalid`])
    const workspaceId = await seedFixtureWorkspace(pool, owner)
    const deviceId = randomUUID(), botId = randomUUID(), agentId = await seedAgent(pool, owner)
    await pool.query(`INSERT INTO devices (id,name,"ownerId",harnesses,"sessionOpenedAt") VALUES ($1,'mine',$2,'[]',now())`, [deviceId, owner])
    await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Writer')`, [botId, workspaceId, owner])
    const running = async (bot: string | null) => {
      const id = await seedRun(pool, { userId: owner, agentId, workspaceId, botId: bot, status: 'running' })
      await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"leaseExpiresAt"=now()+interval '7 days' WHERE id=$1`, [id, deviceId])
      return id
    }
    const state = async (id: string) => (await pool.query<{ stopped: boolean; leased: boolean }>(
      `SELECT "stopRequestedAt" IS NOT NULL AS stopped, "leaseExpiresAt">clock_timestamp() AS leased FROM agent_runs WHERE id=$1`, [id])).rows[0]
    const onBot = await running(botId), direct = await running(null)

    assert.deepEqual(await stopRunsWithoutAuthority({ workspaceId }), [], 'authorized runs keep going')
    assert.deepEqual(await stopRunsWithoutAuthority({}), [], 'an empty scope stops nothing')

    // Archiving the Bot stops its run, and the device is told to stop it.
    await lifecycle.setOwnedBotArchived({ ownerId: owner, workspaceId }, botId, true)
    assert.deepEqual(await state(onBot), { stopped: true, leased: false })
    assert.deepEqual(await state(direct), { stopped: false, leased: true })
    const work = await deviceWork(deviceId, [])
    assert.ok(work.commands.some(command => command.kind === 'stop' && command.runId === onBot), 'the daemon reads the stop')

    // Losing the workspace membership stops the rest.
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspaceId, owner])
    assert.deepEqual(await stopRunsWithoutAuthority({ workspaceId }), [direct])
    assert.deepEqual(await state(direct), { stopped: true, leased: false })
    assert.deepEqual(await stopRunsWithoutAuthority({ workspaceId }), [], 'a stopped run is not stopped twice')
  })
})
