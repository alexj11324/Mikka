import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../tests/support/workspace-admin-db'

// Real hashed cloud credential, machine/run ownership and withDeviceRoute fence.
// The external subscription provider is synthetic: no live login or paid request.
test('a bound cloud device can renew its own subscription lease through the actual route', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const owner = await seedUser(pool, 'cloud-lease-owner')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const device = randomUUID(), otherDevice = randomUUID(), agent = randomUUID(), runId = randomUUID(), otherRun = randomUUID(), tokenId = randomUUID()
  const { newDeviceToken, hashDeviceToken, authenticateDevice } = await import('./device-link')
  const credential = newDeviceToken()
  await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled,harnesses) VALUES($1,$2,'Lease fixture','cloud',true,'[{"harness":"claude_code","installed":true,"subscriptionBroker":true}]'),($3,$2,'Other fixture','cloud',true,'[]')`, [device, owner, otherDevice])
  await pool.query(`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,'claude_code','Lease fixture',$3)`, [agent, owner, device])
  await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId","workspaceId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$7,'running',now()+interval '1 hour'),($5,$2,$3,$6,$7,'running',now()+interval '1 hour')`, [runId, owner, agent, device, otherRun, otherDevice, workspace.id])
  await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","snapshotId","operationId",state,"deviceId") VALUES($1,$2,$3,'synthetic-template',$4,'running',$5)`, [runId, workspace.id, owner, randomUUID(), device])
  await pool.query(`INSERT INTO device_tokens(id,"userId","tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')`, [tokenId, owner, hashDeviceToken(credential), device, workspace.id])
  let issued = 0
  const { subscriptionRuntime } = await import('./subscription-runtime')
  mock.module('@/lib/subscription-runtime', { namedExports: {
    subscriptionRuntime: () => ({
      nativeRun: async (userId: string, deviceId: string, id: string) => {
        assert.deepEqual([userId, deviceId, id], [owner, device, runId])
        return { ownerId: owner, workspaceId: workspace.id, runId, execution: 'native' }
      },
      nativeLease: async () => { issued++; return { route: 'claude_code_cli', modelId: 'synthetic-model', revision: 1, accountId: 'synthetic-account', expiresAt: new Date(Date.now() + 60_000).toISOString(), accessToken: 'synthetic-non-provider-token' } },
    } as unknown as ReturnType<typeof subscriptionRuntime>),
  } })
  const route = await import('../app/v1/devices/[deviceId]/runs/[runId]/subscription-lease/route')
  const request = (deviceId = device, id = runId) => new Request(`http://127.0.0.1/mikka/v1/devices/${deviceId}/runs/${id}/subscription-lease`, { method: 'POST', headers: { authorization: `Bearer ${credential}` } })
  t.after(async () => {
    mock.restoreAll()
    await pool.query('DELETE FROM thread_machines WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM device_tokens WHERE id=$1', [tokenId])
    await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM agents WHERE id=$1', [agent])
    await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [owner])
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('./db'), import('./workspace-db')])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  await t.test('the same credential remains valid for its established heartbeat route', async () => {
    const caller = await authenticateDevice(new Request(`http://127.0.0.1/v1/devices/${device}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${credential}` } }))
    assert.equal(caller?.tokenId, tokenId)
  })
  await t.test('own run renewal passes route authentication and reaches issuance once', async () => {
    const response = await route.POST(request(), { params: Promise.resolve({ deviceId: device, runId }) })
    assert.deepEqual({ status: response.status, issued }, { status: 200, issued: 1 })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
  })
  await t.test('another device and another run remain refused before issuance', async () => {
    const before = issued
    for (const [deviceId, id] of [[otherDevice, otherRun], [device, otherRun], [device, randomUUID()]]) {
      const response = await route.POST(request(deviceId, id), { params: Promise.resolve({ deviceId, runId: id }) })
      assert.equal(response.status, 401)
    }
    assert.equal(issued, before)
  })
  await t.test('an ended machine cannot obtain a new lease', async () => {
    await pool.query("UPDATE thread_machines SET state='ended' WHERE \"runId\"=$1", [runId])
    const before = issued
    const response = await route.POST(request(), { params: Promise.resolve({ deviceId: device, runId }) })
    assert.deepEqual({ status: response.status, issued }, { status: 401, issued: before })
    await pool.query("UPDATE thread_machines SET state='running' WHERE \"runId\"=$1", [runId])
  })
  await t.test('revoked cloud credentials remain refused', async () => {
    await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
    const before = issued
    const response = await route.POST(request(), { params: Promise.resolve({ deviceId: device, runId }) })
    assert.deepEqual({ status: response.status, issued }, { status: 401, issued: before })
  })
})
