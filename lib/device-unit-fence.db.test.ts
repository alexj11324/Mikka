import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type PoolClient } from 'pg'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'

// M1b: the device credential fence is held once per burst of statements (lib/db/device-scope.ts).
const url = disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Device unit fence test requires a loopback *_e2e database')

const admin = url ? new Pool({ connectionString: url, max: 4 }) : null
const fixtures: { owner: string; device: string; tokenId: string }[] = []
after(async () => {
  if (!admin) return
  for (const f of fixtures) {
    await admin.query('DELETE FROM device_credential_revocations WHERE "tokenId"=$1', [f.tokenId]).catch(() => undefined)
    await admin.query('DELETE FROM device_tokens WHERE id=$1', [f.tokenId])
    await admin.query('DELETE FROM devices WHERE id=$1', [f.device])
  }
  await admin.end()
  const { pool } = await import('./db')
  await pool.end().catch(() => undefined)
})

async function fixture() {
  const owner = `unit-fence-${randomUUID()}`, device = randomUUID(), tokenId = randomUUID()
  const token = `orv_${randomBytes(32).toString('base64url')}`
  await admin!.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,$3)', [device, owner, 'Unit fence device'])
  await admin!.query('INSERT INTO device_tokens(id,"userId","tokenHash","lastUsedAt") VALUES($1,$2,$3,now())', [tokenId, owner, createHash('sha256').update(token).digest('hex')])
  const f = { owner, device, tokenId, token }
  fixtures.push(f)
  return f
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const request = (f: Fixture, path = `/v1/devices/${f.device}/runs?state=queued`) => new Request(`http://127.0.0.1/mikka${path}`, { headers: { authorization: `Bearer ${f.token}` } })
/** A revocation, as every revocation path does it: an UPDATE of the token row. */
const revoke = async (f: Fixture, lockTimeoutMs?: number) => {
  const client = await admin!.connect()
  try {
    await client.query('BEGIN')
    if (lockTimeoutMs) await client.query(`SET LOCAL lock_timeout='${lockTimeoutMs}ms'`)
    await client.query('UPDATE device_tokens SET "revokedAt"=clock_timestamp() WHERE id=$1', [f.tokenId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

async function modules() {
  const [{ withDeviceRoute }, { pool }, { overrideDeploymentSwitch }, runs] = await Promise.all([
    import('./device-route'), import('./db'), import('./deployment-switches'), import('../app/v1/devices/[deviceId]/runs/route'),
  ])
  overrideDeploymentSwitch('deviceUnitFence', true)
  return { withDeviceRoute, pool, overrideDeploymentSwitch, runs }
}

test('a revocation waits for the burst in flight; the next burst answers 401', { skip: !url }, async () => {
  const { withDeviceRoute, pool } = await modules()
  const f = await fixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let inBurst!: () => void
  const started = new Promise<void>(resolve => { inBurst = resolve })
  const route = withDeviceRoute(async () => {
    const client: PoolClient = await pool.connect()   // a checked-out client keeps the burst open
    try { await client.query('SELECT 1'); inBurst(); await held } finally { client.release() }
    return Response.json({ ok: true })
  })
  const answer = route(request(f))
  await started
  const revoking = revoke(f)
  const early = await Promise.race([revoking.then(() => 'revoked'), delay(400).then(() => 'waiting')])
  assert.equal(early, 'waiting', 'the revocation waits for the fenced burst')
  release()
  assert.equal((await answer).status, 200)
  await revoking
  const later = await withDeviceRoute(async () => { await pool.query('SELECT 1'); return Response.json({ ok: true }) })(request(f))
  assert.equal(later.status, 401)
})

test('between bursts (a wait, network IO) the fence is not held: a revocation goes through at once', { skip: !url }, async () => {
  const { withDeviceRoute, pool } = await modules()
  const { FENCE_IDLE_MS } = await import('./db/device-scope')
  const f = await fixture()
  let second = 0
  const route = withDeviceRoute(async () => {
    await pool.query('SELECT 1')
    await delay(FENCE_IDLE_MS + 300)                 // the burst has ended; this stands for network IO
    await revoke(f, 500)                              // would time out if the fence were still held
    await pool.query('SELECT 1').then(() => { second++ })
    return Response.json({ ok: true })
  })
  assert.equal((await route(request(f))).status, 401, 'the next burst takes the fence again and finds the token revoked')
  assert.equal(second, 0)
})

test('a hung unit loses its fence after 10 s; the revocation then completes and the unit fails closed', { skip: !url, timeout: 30_000 }, async () => {
  const { withDeviceRoute, pool } = await modules()
  const f = await fixture()
  let inBurst!: () => void
  const started = new Promise<void>(resolve => { inBurst = resolve })
  let after: unknown
  const route = withDeviceRoute(async () => {
    const client: PoolClient = await pool.connect()   // held, idle: a stuck handler
    try {
      await client.query('SELECT 1'); inBurst()
      await delay(12_000)
      try { await pool.query('SELECT 1') } catch (error) { after = error; throw error }
    } finally { client.release() }
    return Response.json({ ok: true })
  })
  const answer = route(request(f))
  await started
  const began = Date.now()
  await revoke(f)                                     // no lock timeout: it waits for the fence to go
  const waited = Date.now() - began
  assert.ok(waited >= 8_000 && waited < 11_500, `the revocation completed after ${waited} ms`)
  assert.equal((await answer).status, 503, 'the rest of the unit fails closed')
  assert.ok(after)
})

test('when no fence connection can be had the request is refused with 503, never run unfenced', { skip: !url, timeout: 20_000 }, async () => {
  const { withDeviceRoute, pool } = await modules()
  const fs = await Promise.all([fixture(), fixture(), fixture(), fixture()])
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let ran = 0
  const holding = fs.slice(0, 3).map(f => withDeviceRoute(async () => {
    const client: PoolClient = await pool.connect()
    try { await client.query('SELECT 1'); await held } finally { client.release() }
    return Response.json({ ok: true })
  })(request(f)))
  await delay(300)
  const refused = await withDeviceRoute(async () => { await pool.query('SELECT 1'); ran++; return Response.json({ ok: true }) })(request(fs[3]))
  assert.equal(refused.status, 503)
  assert.equal(refused.headers.get('retry-after'), '2')
  assert.equal(ran, 0)
  release()
  for (const answer of await Promise.all(holding)) assert.equal(answer.status, 200)
})

test('ten concurrent device requests complete with three fence connections; fewer transactions than one fence per statement', { skip: !url }, async t => {
  const { overrideDeploymentSwitch, runs } = await modules()
  const fs = await Promise.all(Array.from({ length: 10 }, () => fixture()))
  const answers = await Promise.all(fs.map(f => runs.GET(request(f), { params: Promise.resolve({ deviceId: f.device }) })))
  for (const answer of answers) assert.equal(answer.status, 200)

  // Statements the server ran for one queued-runs poll, with and without the unit fence.
  const count = async (unit: boolean) => {
    overrideDeploymentSwitch('deviceUnitFence', unit)
    const f = fs[0]
    await runs.GET(request(f), { params: Promise.resolve({ deviceId: f.device }) })
    const before = (await admin!.query(`SELECT coalesce(sum(xact_commit+xact_rollback),0)::bigint n FROM pg_stat_database WHERE datname=current_database()`)).rows[0].n
    await runs.GET(request(f), { params: Promise.resolve({ deviceId: f.device }) })
    await delay(1200)  // the fence's own COMMIT lands after the idle window
    await admin!.query('SELECT pg_stat_clear_snapshot()')
    const after = (await admin!.query(`SELECT coalesce(sum(xact_commit+xact_rollback),0)::bigint n FROM pg_stat_database WHERE datname=current_database()`)).rows[0].n
    return Number(after) - Number(before)
  }
  const perStatement = await count(false)
  const perUnit = await count(true)
  t.diagnostic(JSON.stringify({ transactionsPerPollWithFencePerStatement: perStatement, transactionsPerPollWithUnitFence: perUnit }))
  assert.ok(perUnit < perStatement, `unit fence ${perUnit} transactions, per statement ${perStatement}`)
  overrideDeploymentSwitch('deviceUnitFence', true)
})
