import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
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
const request = (f: Fixture, path = `/v1/devices/${f.device}/runs?state=queued`) => new Request(`http://127.0.0.1/mikka${path}`, { headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${f.token}` } })
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

test('deferred heartbeat work cannot retain a token lock after its request; owner revoke fences its next statement', { skip: !url, timeout: 20_000 }, async t => {
  const [{ afterJob }, { withDeviceUnitFence, deviceScopedPool, FENCE_IDLE_MS, isDeviceAuthorityRevoked },
    { revokeDeviceCredential }] = await Promise.all([import('./background'), import('./db/device-scope'), import('./device-revocation')])
  const f = await fixture(), applicationName = `cleanup1826_${randomUUID()}`
  const target = new URL(url!)
  target.searchParams.set('application_name', applicationName)
  const source = new Pool({ connectionString: target.toString(), max: 2 })
  let scheduled!: () => unknown, release!: () => void, ready!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { ready = resolve })
  let pending: Promise<unknown> | undefined
  // Vercel can suspend a request's unref timers once its response/job settles.
  // Freeze only the fence's idle timer; PG lock_timeout still runs in the server.
  const timers: ReturnType<typeof setTimeout>[] = [], originalSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = originalSetTimeout(callback, ms === FENCE_IDLE_MS ? 60_000 : ms, ...args)
    if (ms === FENCE_IDLE_MS) timers.push(timer)
    return timer
  }) as typeof setTimeout)
  t.after(async () => {
    release()
    await pending?.catch(() => undefined)
    for (const timer of timers) clearTimeout(timer)
    // Only this test's dedicated source/fence connections, including a leak
    // in the old implementation; no shared application/other-test backend.
    await source.end()
    await admin!.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()', [applicationName])
  })
  await withDeviceUnitFence({ tokenId: f.tokenId, userId: f.owner }, async () => {
    afterJob('after:factory-dispatch-recovery', async () => {
      await deviceScopedPool(source).query('SELECT 1')
      ready()
      await gate
      await deviceScopedPool(source).query('UPDATE devices SET name=$1 WHERE id=$2', ['must not land after revoke', f.device])
    }, { retainContext: true, schedule: task => { scheduled = task } })
  })
  pending = Promise.resolve(scheduled())
  // Observe rejection now as well as below; a failed assertion still closes
  // the deferred job in the test's cleanup without an unhandled rejection.
  void pending.catch(() => undefined)
  await began
  const started = Date.now()
  const receipt = await revokeDeviceCredential(admin!, f.owner, f.tokenId)
  assert.equal(receipt?.revokedBy, f.owner)
  assert.ok(Date.now() - started < 2_000, 'owner revoke does not wait for a background idle timer or its 5-second lock timeout')
  release()
  await assert.rejects(pending, isDeviceAuthorityRevoked)
  assert.equal((await admin!.query('SELECT name FROM devices WHERE id=$1', [f.device])).rows[0].name, 'Unit fence device')
})

test('an async callback cannot reopen an already-finished request unit fence', { skip: !url }, async () => {
  const { withDeviceUnitFence, deviceScopedPool, isDeviceAuthorityError } = await import('./db/device-scope')
  const f = await fixture()
  let deferred!: () => Promise<unknown>
  await withDeviceUnitFence({ tokenId: f.tokenId, userId: f.owner }, async () => {
    deferred = AsyncLocalStorage.bind(() => deviceScopedPool(admin!).query('SELECT 1'))
  })
  await assert.rejects(deferred(), isDeviceAuthorityError)
})

test('a hung unit loses its fence after 10 s; the revocation then completes and the unit fails closed', { skip: !url, timeout: 30_000 }, async t => {
  const { withDeviceRoute, pool } = await modules()
  // Production fences time out after 10 s of idle transaction. The same
  // PostgreSQL timeout is shortened here to 2 s and the bounds scale with it
  // (at least 80% of it, at most it plus 1.5 s), so the test does not wait 12 s.
  const { FENCE_IDLE_IN_TRANSACTION, fenceIdleInTransaction } = await import('./db/device-scope')
  assert.equal(FENCE_IDLE_IN_TRANSACTION, '10s')
  assert.equal(fenceIdleInTransaction.seconds, 10)
  fenceIdleInTransaction.seconds = 2
  t.after(() => { fenceIdleInTransaction.seconds = 10 })
  const timeoutMs = fenceIdleInTransaction.seconds * 1000
  const f = await fixture()
  let inBurst!: () => void
  const started = new Promise<void>(resolve => { inBurst = resolve })
  let after: unknown
  const route = withDeviceRoute(async () => {
    const client: PoolClient = await pool.connect()   // held, idle: a stuck handler
    try {
      await client.query('SELECT 1'); inBurst()
      await delay(timeoutMs + 2_000)
      try { await pool.query('SELECT 1') } catch (error) { after = error; throw error }
    } finally { client.release() }
    return Response.json({ ok: true })
  })
  const answer = route(request(f))
  await started
  const began = Date.now()
  await revoke(f)                                     // no lock timeout: it waits for the fence to go
  const waited = Date.now() - began
  assert.ok(waited >= timeoutMs * 0.8 && waited < timeoutMs + 1_500, `the revocation completed after ${waited} ms`)
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

test('ten concurrent multi-statement device requests complete with three fence connections; fewer authorization transactions and round trips than one fence per statement', { skip: !url }, async t => {
  const { overrideDeploymentSwitch, withDeviceRoute, pool } = await modules()
  // Pure polling routes carry authority in one read snapshot. Keep exercising
  // the unit fence with an actual protected burst of two separate statements.
  const protectedBurst = withDeviceRoute(async () => {
    await pool.query('SELECT 1')
    await pool.query('SELECT 2')
    return Response.json({ ok: true })
  })
  const fs = await Promise.all(Array.from({ length: 10 }, () => fixture()))
  const answers = await Promise.all(fs.map(f => protectedBurst(request(f))))
  for (const answer of answers) assert.equal(answer.status, 200)

  // Count actual backend transaction completions on the request's checked-out
  // clients. Database-wide statistics lag each backend and include our reader's
  // own transactions, so a sleep + pg_stat_clear_snapshot cannot isolate this burst.
  let completed = 0, roundTrips = 0, explicit = 0
  type Message = { status?: string; text?: string }
  type MessageConnection = { on: (event: string, listener: (message: Message) => void) => unknown; removeListener: (event: string, listener: (message: Message) => void) => unknown }
  const observed = new Map<MessageConnection, { ready: (message: Message) => void; command: (message: Message) => void }>()
  const emit = Pool.prototype.emit
  Pool.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === 'acquire') {
      const connection = (args[0] as unknown as { connection: MessageConnection }).connection
      if (!observed.has(connection)) {
        const ready = (message: Message) => { roundTrips++; if (message.status === 'I') completed++ }
        const command = (message: Message) => { if (message.text === 'BEGIN') explicit++ }
        observed.set(connection, { ready, command })
        connection.on('readyForQuery', ready)
        connection.on('commandComplete', command)
      }
    }
    return emit.call(this, event, ...args)
  }
  try {
    const count = async (unit: boolean) => {
      overrideDeploymentSwitch('deviceUnitFence', unit)
      const f = fs[0]
      // Warm connections and install the observer before the measured request.
      assert.equal((await protectedBurst(request(f))).status, 200)
      const before = { completed, roundTrips, explicit }
      assert.equal((await protectedBurst(request(f))).status, 200)
      // The route awaits its fence COMMIT in finally. ReadyForQuery(I) includes
      // both explicit COMMIT/ROLLBACK and implicit autocommit transactions.
      return { completed: completed - before.completed, roundTrips: roundTrips - before.roundTrips, explicit: explicit - before.explicit }
    }
    const perStatement = await count(false)
    const perUnit = await count(true)
    t.diagnostic(JSON.stringify({ perStatement, perUnit, measurement: 'backend_command_tags_and_ready_for_query' }))
    assert.ok(perUnit.explicit < perStatement.explicit, `unit fence ${perUnit.explicit} explicit authorization transactions, per statement ${perStatement.explicit}`)
    assert.ok(perUnit.roundTrips < perStatement.roundTrips, `unit fence ${perUnit.roundTrips} round trips, per statement ${perStatement.roundTrips}`)
  } finally {
    Pool.prototype.emit = emit
    for (const [connection, listeners] of observed) {
      connection.removeListener('readyForQuery', listeners.ready)
      connection.removeListener('commandComplete', listeners.command)
    }
  }
  overrideDeploymentSwitch('deviceUnitFence', true)
})
