import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { dbUrl, seedAgent, seedRun, seedUser } from './support/workspace-admin-db'

test('thread waiting device uses the same private queue projection as visibleRuns', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const fixtures = new Pool({ connectionString: dbUrl })
  const owner = await seedUser(fixtures, 'thread-owner'), other = await seedUser(fixtures, 'thread-other')
  let actor = owner
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }) } })
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => ({ user: { id: actor } }) } } } })
  const { listThreads } = await import('../app/actions/task-runs')
  const { visibleRuns } = await import('../lib/agent-runs')
  const { pool } = await import('../lib/db')
  t.after(async () => {
    await fixtures.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [[owner, other]])
    await fixtures.query('DELETE FROM agents WHERE "userId" = ANY($1)', [[owner, other]])
    await fixtures.query('DELETE FROM devices WHERE "ownerId" = ANY($1)', [[owner, other]])
    await fixtures.query('DELETE FROM "user" WHERE id = ANY($1)', [[owner, other]])
    await Promise.all([fixtures.end(), pool.end()])
  })
  const agentId = await seedAgent(fixtures, owner)
  const deviceId = randomUUID()
  await fixtures.query(`INSERT INTO devices (id,"ownerId",name,"deviceType",enabled,"lastSeenAt") VALUES ($1,$2,'Alex MacBook Pro','laptop',true,now()-interval '1 hour')`, [deviceId, owner])
  const runId = await seedRun(fixtures, { userId: owner, agentId, status: 'queued' })
  await fixtures.query(`UPDATE agent_runs SET "deviceId"=$2,"agentDefinition"='{"harness":"claude"}' WHERE id=$1`, [runId, deviceId])
  const thread = async () => (await listThreads()).find(row => row.id === runId)
  const waitFor = async () => (await visibleRuns(actor, { runIds: [runId] }))[0]?.waitFor

  await t.test('offline queued run returns device metadata and snapshotted harness', async () => {
    assert.deepEqual((await thread())?.waitingFor, { deviceId, deviceName: 'Alex MacBook Pro', deviceType: 'laptop', harness: 'claude' })
    assert.equal(await waitFor(), deviceId)
    assert.ok(!Object.hasOwn((await thread())!, 'lastSeenAt'), 'join metadata stays private')
  })
  await t.test('online device omits the field', async () => {
    await fixtures.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [deviceId])
    assert.equal(Object.hasOwn((await thread())!, 'waitingFor'), false)
    assert.equal(await waitFor(), undefined)
  })
  await t.test('disabled online device waits as well', async () => {
    await fixtures.query('UPDATE devices SET enabled=false,"deviceType"=\'server\' WHERE id=$1', [deviceId])
    assert.equal((await thread())?.waitingFor?.deviceType, 'server')
    assert.equal(await waitFor(), deviceId)
  })
  await t.test('nonqueued run omits the field even for disabled device', async () => {
    await fixtures.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [runId])
    assert.equal(Object.hasOwn((await thread())!, 'waitingFor'), false)
    assert.equal(await waitFor(), undefined)
  })
  await t.test('another caller receives no thread or waiting metadata', async () => {
    await fixtures.query(`UPDATE agent_runs SET status='queued' WHERE id=$1`, [runId])
    actor = other
    assert.equal(await thread(), undefined)
    assert.equal(await waitFor(), undefined)
  })
})
