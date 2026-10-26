import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { test, expect, register, app } from './fixtures'

// Real HTTP + database, synthetic accounts on the disposable Actions service.
// This does not replace real-device / OAuth Preview acceptance.
test('active agents and heartbeat preserve the claimed-only lease contract over HTTP', async ({ page, playwright, baseURL }) => {
  test.skip(process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true', 'Disposable Actions database only')
  const target = new URL(process.env.E2E_DATABASE_URL!)
  expect(target.hostname).toBe('127.0.0.1')
  expect(target.port).toBe('5432')
  expect(target.pathname).toBe('/mikka_e2e')
  const pool = new Pool({ connectionString: target.href, max: 2 })
  const anonymous = await playwright.request.newContext({ baseURL })
  const token = `orv_${randomBytes(32).toString('base64url')}`
  const deviceClient = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } })
  const [device, foreignDevice, agent, foreignAgent, claimed, queued, foreignRun, tokenId] = Array.from({ length: 8 }, () => randomUUID())
  const foreignUser = `active-http-other-${randomUUID()}`
  const endpoint = app('/api/agent/sessions/active')
  const heartbeat = app(`/v1/devices/${device}/heartbeat`)
  try {
    const denied = await anonymous.get(endpoint)
    expect(denied.status()).toBe(401)
    expect(denied.headers()['cache-control']).toBe('private, no-store')
    const { email } = await register(page)
    const { rows: [user] } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [email])
    expect(user).toBeTruthy()
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,\'Synthetic other\',$2,false,now(),now())', [foreignUser, `${foreignUser}@example.test`])
    await pool.query('INSERT INTO devices (id,"ownerId",name,"lastSeenAt") VALUES ($1,$2,\'Active fixture\',now()),($3,$4,\'Foreign fixture\',now())', [device, user.id, foreignDevice, foreignUser])
    await pool.query('INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,\'Own active fixture\',\'codex\'),($3,$4,\'Foreign active fixture\',\'codex\')', [agent, user.id, foreignAgent, foreignUser])
    const oldLease = new Date(Date.now() - 1_000)
    const foreignLease = new Date(Date.now() + 60_000)
    await pool.query('INSERT INTO agent_runs (id,"userId","agentId","deviceId",status,"leaseExpiresAt","startedAt") VALUES ($1,$2,$3,$4,\'preparing\',$5,now()),($6,$2,$3,$4,\'queued\',$7,now()),($8,$9,$10,$11,\'running\',$12,now())', [claimed, user.id, agent, device, foreignLease, queued, oldLease, foreignRun, foreignUser, foreignAgent, foreignDevice, foreignLease])
    await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [tokenId, user.id, createHash('sha256').update(token).digest('hex')])
    const payload = { harnesses: [], runs: [claimed, queued, foreignRun, 'not-a-uuid'].map(runId => ({ runId, lastProgressAt: new Date().toISOString() })), worktreeDiskBytes: 0 }
    expect((await anonymous.post(heartbeat, { data: payload })).status()).toBe(401)
    expect((await deviceClient.post(app(`/v1/devices/${foreignDevice}/heartbeat`), { data: payload })).status()).toBe(404)
    const response = await deviceClient.post(heartbeat, { data: payload })
    expect(response.status()).toBe(200)
    const result = await response.json()
    expect(Object.keys(result.leases)).toEqual([claimed])
    expect(result.revoked).toEqual([queued, foreignRun, 'not-a-uuid'])
    const { rows } = await pool.query<{ id: string; leaseExpiresAt: Date }>('SELECT id,"leaseExpiresAt" FROM agent_runs WHERE id=ANY($1::uuid[])', [[claimed, queued, foreignRun]])
    expect(rows.find(row => row.id === queued)!.leaseExpiresAt.getTime()).toBe(oldLease.getTime())
    expect(rows.find(row => row.id === foreignRun)!.leaseExpiresAt.getTime()).toBe(foreignLease.getTime())
    expect(rows.find(row => row.id === claimed)!.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000)
    const active = await page.request.get(endpoint)
    expect(active.status()).toBe(200)
    expect(active.headers()['cache-control']).toBe('private, no-store')
    const body = await active.json()
    expect(body.agents.map((entry: { runId: string }) => entry.runId)).toEqual([claimed])
    expect(Object.keys(body.agents[0]).sort()).toEqual(['avatarUrl', 'id', 'issueId', 'kind', 'name', 'runId', 'startedAt', 'state'])
    expect((await page.request.get(`${endpoint}?userId=${foreignUser}`)).status()).toBe(400)
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [[claimed, queued, foreignRun]])
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[agent, foreignAgent]])
    await pool.query('DELETE FROM devices WHERE id=ANY($1::uuid[])', [[device, foreignDevice]])
    await pool.query('DELETE FROM device_tokens WHERE id=$1', [tokenId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [foreignUser])
    await deviceClient.dispose()
    await anonymous.dispose()
    await pool.end()
  }
})
