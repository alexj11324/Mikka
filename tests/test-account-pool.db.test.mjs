import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { before, after, test } from 'node:test'
import { Pool } from 'pg'
import { loadEnvironment } from '../scripts/test-accounts/environment.mjs'
import { TestAccountPool } from '../scripts/test-accounts/pool.mjs'

// This suite intentionally fails when its independently verified environment is
// absent. A missing PostgreSQL gate must not become a passing skipped test.
let database
let accounts
let environment
const children = new Set()
const runId = `pool-concurrency-${randomUUID()}`
const request = (workerId, extra = {}) => ({ runId, workerId, requestId: randomUUID(), ...extra })

before(async () => {
  environment = await loadEnvironment()
  database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 })
  accounts = new TestAccountPool(database, environment)
  await accounts.prepare({ pairs: 1 })
})

after(async () => {
  for (const child of children) child.kill('SIGKILL')
  await database?.end()
})

async function worker() {
  const child = fork(fileURLToPath(new URL('./support/account-pool-process.mjs', import.meta.url)), [], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.add(child)
  const pending = new Map()
  let sequence = 0
  let outputBytes = 0
  // Never include a child's arbitrary stderr in a test assertion/report. The
  // structured error code is sufficient; bytes are counted to catch noisy logs.
  child.stdout.on('data', data => { outputBytes += data.length })
  child.stderr.on('data', data => { outputBytes += data.length })
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Pool child readiness timed out')) }, 10_000)
    child.on('message', message => {
      if ('ready' in message) { clearTimeout(timeout); return message.ready ? resolve() : reject(new Error(`Pool child initialization failed: ${message.error.code}`)) }
      const waiting = pending.get(message.id)
      if (waiting) { pending.delete(message.id); waiting.resolve(message) }
    })
    child.on('error', reject)
    child.on('exit', () => {
      clearTimeout(timeout)
      children.delete(child)
      reject(new Error('Pool child exited before ready'))
      for (const item of pending.values()) item.reject(new Error('Pool child exited'))
      pending.clear()
    })
  })
  await ready
  const call = (operation, input) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    child.send({ id, operation, input }, error => {
      if (error) { pending.delete(id); reject(new Error('Pool child IPC failed')) }
    })
  })
  return {
    child, call,
    async close() {
      const exited = once(child, 'exit')
      assert.equal((await call('close')).ok, true)
      await exited
      assert.equal(outputBytes, 0, 'Pool workers must not emit credentials or incidental logs')
    },
  }
}

async function metadataSnapshot() {
  const tables = await database.query(`select tablename from pg_tables where schemaname='mikka_test_accounts' order by tablename`)
  const snapshot = {}
  for (const { tablename } of tables.rows) {
    assert.match(tablename, /^[a-z_]+$/)
    const result = await database.query(`select row_to_json(r)::text as row from mikka_test_accounts."${tablename}" r`)
    snapshot[tablename] = result.rows.map(item => createHash('sha256').update(item.row).digest('hex')).sort()
  }
  for (const name of ['user', 'account', 'session']) {
    const exists = await database.query('select to_regclass($1) as table_name', [`public.${name}`])
    if (exists.rows[0].table_name) {
      const result = await database.query(`select row_to_json(r)::text as row from public."${name}" r`)
      snapshot[name] = result.rows.map(item => createHash('sha256').update(item.row).digest('hex')).sort()
    }
  }
  return snapshot
}

test('inspect and cleanup-plan do not mutate pool, auth users, accounts or sessions', async () => {
  const before = await metadataSnapshot()
  await accounts.inspect()
  await accounts.cleanupPlan({ runId })
  assert.deepEqual(await metadataSnapshot(), before)
})

test('wrong descriptor or actual PostgreSQL schema is rejected before pool writes', async () => {
  const before = await metadataSnapshot()
  for (const mismatch of [
    { ...environment, id: `different-${randomUUID()}` },
    { ...environment, deploymentSha: '0'.repeat(40) },
    { ...environment, instanceId: randomUUID() },
    { ...environment, origin: 'https://production.example.test' },
    { ...environment, kind: 'production' },
  ]) {
    await assert.rejects(async () => new TestAccountPool(database, mismatch).prepare({ pairs: 32 }))
  }
  // The URL still matches. This changes the *actual* connected schema so a
  // check based solely on a name, localhost or an env flag cannot pass.
  const wrongSchema = new Pool({ connectionString: process.env.E2E_DATABASE_URL, options: '-c search_path=pg_catalog', max: 1 })
  try {
    await assert.rejects(new TestAccountPool(wrongSchema, environment).prepare({ pairs: 32 }), { code: 'ACTUAL_DATABASE_MISMATCH' })
  } finally { await wrongSchema.end() }
  assert.deepEqual(await metadataSnapshot(), before)
})

test('lease deadlines use the PostgreSQL clock despite a skewed worker clock', async () => {
  const originalClock = Date.now
  let lease
  try {
    Date.now = () => originalClock() + 7 * 24 * 60 * 60 * 1000
    lease = await accounts.acquire(request('skewed-clock', { ttlMs: 60_000 }))
    await accounts.renew(lease, { ttlMs: 60_000 })
    const result = await database.query('select extract(epoch from (expires_at-clock_timestamp()))::float8 as remaining from mikka_test_accounts.leases where id=$1', [lease.id])
    assert.ok(result.rows[0].remaining > 50 && result.rows[0].remaining <= 60)
  } finally {
    Date.now = originalClock
    if (lease) await accounts.release(lease, { outcome: 'clean' })
  }
})

test('two independent processes competing for one pair produce exactly one exclusive lease', async () => {
  const first = await worker()
  const second = await worker()
  try {
    const result = await Promise.all([
      first.call('acquire', request('race-a')),
      second.call('acquire', request('race-b')),
    ])
    assert.equal(result.filter(item => item.ok).length, 1)
    assert.equal(result.filter(item => !item.ok).length, 1)
    const winner = result.find(item => item.ok).result
    assert.equal(winner.accounts.length, 2)
    assert.deepEqual(winner.accounts.map(item => item.role).sort(), ['owner', 'peer'])
    assert.notEqual(winner.accounts[0].slotId, winner.accounts[1].slotId)
    assert.notEqual(winner.accounts[0].namespace, winner.accounts[1].namespace)
    await accounts.release(winner, { outcome: 'clean' })
  } finally { await first.close(); await second.close() }
})

test('acquire retries across processes are idempotent and reject a different holder', async () => {
  const first = await worker()
  const second = await worker()
  const input = request('retry-worker')
  try {
    const original = await first.call('acquire', input)
    const retry = await second.call('acquire', input)
    assert.equal(original.ok, true)
    assert.equal(retry.ok, true)
    assert.equal(retry.result.id, original.result.id)
    assert.equal(retry.result.generation, original.result.generation)
    assert.equal((await second.call('acquire', { ...input, workerId: 'wrong-worker' })).ok, false)
    const renewed = await first.call('renew', { lease: original.result, options: { ttlMs: 90_000 } })
    assert.equal(renewed.ok, true)
    assert.equal((await second.call('renew', { lease: original.result, options: { ttlMs: 90_000 } })).ok, true)
    assert.equal((await first.call('release', { lease: original.result, options: { outcome: 'clean' } })).ok, true)
    assert.equal((await second.call('release', { lease: original.result, options: { outcome: 'clean' } })).ok, true)

    // Completion is terminal for an idempotency key: retrying it cannot acquire
    // another lease or leak an additional occupied pair.
    const completedRetry = await second.call('acquire', input)
    assert.ok(!completedRetry.ok || completedRetry.result.id === original.result.id)
    const replacement = await accounts.acquire(request('replacement'))
    assert.equal(replacement.pairId, original.result.pairId)
    assert.ok(replacement.generation > original.result.generation)
    assert.equal((await first.call('renew', { lease: original.result })).ok, false)
    assert.equal((await first.call('release', { lease: original.result, options: { outcome: 'clean' } })).ok, false)
    await accounts.release(replacement, { outcome: 'clean' })
  } finally { await first.close(); await second.close() }
})

test('distinct workers concurrently hold disjoint account slots', async () => {
  await accounts.prepare({ pairs: 2 })
  const first = await worker()
  const second = await worker()
  try {
    const result = await Promise.all([
      first.call('acquire', request('parallel-a')),
      second.call('acquire', request('parallel-b')),
    ])
    assert.ok(result.every(item => item.ok))
    assert.notEqual(result[0].result.pairId, result[1].result.pairId)
    assert.equal(new Set(result.flatMap(item => item.result.accounts.map(account => account.slotId))).size, 4)
    for (const item of result) await accounts.release(item.result, { outcome: 'clean' })
  } finally { await first.close(); await second.close() }
})

test('holder, run and generation fencing reject renewal, release and reset from stale actors', async () => {
  const lease = await accounts.acquire(request('fencing'))
  const before = await metadataSnapshot()
  for (const wrong of [
    { ...lease, workerId: 'different-worker' },
    { ...lease, runId: 'different-run' },
    { ...lease, pairId: lease.pairId === 'pair-000' ? 'pair-001' : 'pair-000' },
    { ...lease, generation: lease.generation + 1 },
    { ...lease, id: randomUUID() },
  ]) {
    await assert.rejects(accounts.renew(wrong))
    await assert.rejects(accounts.release(wrong, { outcome: 'clean' }))
    await assert.rejects(accounts.revokeSessions(wrong))
    await assert.rejects(accounts.bindAccount(wrong, {
      slotId: lease.accounts[0].slotId,
      userId: randomUUID(), email: `test-${randomUUID()}@example.test`, credentialRef: `${randomUUID()}.json`,
    }))
  }
  assert.deepEqual(await metadataSnapshot(), before)
  await accounts.release(lease, { outcome: 'clean' })
})

test('dirty and cancelled leases are quarantined; pool exhaustion terminates without provisioning fallback', async () => {
  const dirty = await accounts.acquire(request('dirty'))
  const cancelled = await accounts.acquire(request('cancelled'))
  await accounts.release(dirty, { outcome: 'dirty' })
  await accounts.release(cancelled, { outcome: 'cancelled' })
  const start = performance.now()
  await assert.rejects(accounts.acquire(request('exhausted')))
  assert.ok(performance.now() - start < 5_000, 'Exhaustion must be bounded, without an unbounded retry loop')
  const snapshot = JSON.stringify(await accounts.inspect())
  assert.match(snapshot, /quarantin/i)
  await assert.rejects(accounts.renew(dirty))
})

test('SIGKILL and TTL expiry quarantine an account pair until safety can be proved', async () => {
  // The two previous pairs remain quarantined. A third slot is explicitly
  // provisioned; an expired lease must never make the old ones reusable.
  await accounts.prepare({ pairs: 3 })
  const crashed = await worker()
  const result = await crashed.call('acquire', request('crashed-worker'))
  assert.equal(result.ok, true)
  const lease = result.result
  const exited = once(crashed.child, 'exit')
  crashed.child.kill('SIGKILL')
  await exited
  await assert.rejects(accounts.acquire(request('while-old-lease-live')), { code: 'POOL_EXHAUSTED' })

  // Advance only this owned test lease using PostgreSQL's server clock. No
  // machine clock mocks and no minute-long sleep weaken the process test.
  await database.query("update mikka_test_accounts.leases set expires_at=clock_timestamp()-interval '1 second' where id=$1", [lease.id])
  const before = await metadataSnapshot()
  await accounts.inspect()
  await accounts.cleanupPlan({ runId })
  assert.deepEqual(await metadataSnapshot(), before, 'Read-only commands cannot silently reclaim expired leases')
  await assert.rejects(accounts.renew(lease))
  await assert.rejects(accounts.release(lease, { outcome: 'clean' }))
  await assert.rejects(accounts.revokeSessions(lease))
  await assert.rejects(accounts.acquire(request('after-expiry')), { code: 'POOL_EXHAUSTED' })
  const pair = await database.query('select state from mikka_test_accounts.pairs where id=$1', [lease.pairId])
  assert.equal(pair.rows[0].state, 'quarantined')

  // Capacity can grow explicitly. A new worker receives a different pair;
  // even after replacement, the dead worker cannot reset or release anything.
  await accounts.prepare({ pairs: 4 })
  const replacement = await accounts.acquire(request('after-crash'))
  assert.notEqual(replacement.pairId, lease.pairId)
  assert.equal(replacement.accounts.some(item => lease.accounts.some(old => old.slotId === item.slotId)), false)
  await assert.rejects(accounts.release(lease, { outcome: 'clean' }))
  await accounts.release(replacement, { outcome: 'clean' })
})

test('partial provisioning preserves reservation provenance and cannot return to the available pool', async () => {
  const lease = await accounts.acquire(request('provision-interrupted'))
  const email = `test-${randomUUID()}@example.test`
  const credentialRef = `${randomUUID()}.json`
  const usersBefore = (await database.query('select count(*)::int as n from public."user"')).rows[0].n
  await accounts.reserveAccount(lease, { slotId: lease.accounts[0].slotId, email, credentialRef })
  const result = await accounts.release(lease, { outcome: 'clean' })
  assert.equal(result.state, 'quarantined')
  assert.equal((await database.query('select count(*)::int as n from public."user"')).rows[0].n, usersBefore)
  const stored = (await database.query('select email,credential_ref,provision_lease_id from mikka_test_accounts.accounts where slot_id=$1', [lease.accounts[0].slotId])).rows[0]
  assert.equal(stored.email, email)
  assert.equal(stored.credential_ref, credentialRef)
  assert.equal(stored.provision_lease_id, lease.id)
  const cleanup = await accounts.cleanupPlan({ runId })
  const pending = cleanup.pendingProvisioning.find(item => item.slotId === lease.accounts[0].slotId)
  assert.equal(pending.leaseId, lease.id)
  assert.equal(pending.reason, 'INCOMPLETE_PROVISIONING_QUARANTINED')
  assert.equal(pending.userId, null)
  assert.match(pending.identityHash, /^[a-f0-9]{64}$/)
  assert.equal(Object.hasOwn(pending, 'email'), false)
  await assert.rejects(accounts.acquire(request('no-incomplete-fallback')), { code: 'POOL_EXHAUSTED' })
  // Leave one explicit fresh pair for subsequent real HTTP/browser acceptance.
  await accounts.prepare({ pairs: 5 })
})

test('a lease that expires while renewal waits for a real PostgreSQL lock cannot be extended', async () => {
  const lease = await accounts.acquire(request('lock-expiry', { ttlMs: 2000 }))
  const locker = await database.connect()
  let renewal
  try {
    await locker.query('BEGIN')
    await locker.query('select id from mikka_test_accounts.leases where id=$1 for update', [lease.id])
    const blocker = (await locker.query('select pg_backend_pid() as id')).rows[0].id
    renewal = accounts.renew(lease, { ttlMs: 90_000 }).then(
      result => ({ ok: true, result }),
      error => ({ ok: false, code: error.code }),
    )
    let blocked = false
    let expired = false
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = (await database.query(`select expires_at<=clock_timestamp() as expired,
        exists(select 1 from pg_stat_activity where $2::int=any(pg_blocking_pids(pid))) as blocked
        from mikka_test_accounts.leases where id=$1`, [lease.id, blocker])).rows[0]
      blocked ||= state.blocked
      expired = state.expired
      if (blocked && expired) break
      await delay(50)
    }
    assert.equal(blocked, true, 'The renewal must actually wait for the independent PostgreSQL lock')
    assert.equal(expired, true, 'Expiry is observed using the database clock, not a mocked client clock')
  } finally {
    await locker.query('COMMIT')
    locker.release()
  }
  const result = await renewal
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LEASE_LOST')
  const actual = (await database.query('select expires_at<=clock_timestamp() as expired from mikka_test_accounts.leases where id=$1', [lease.id])).rows[0]
  assert.equal(actual.expired, true, 'A delayed renewal cannot resurrect the expired lease')
  assert.notEqual((await accounts.inspect()).pairs.find(item => item.id === lease.pairId).state, 'available')
  await assert.rejects(accounts.acquire(request('after-lock-expiry')), { code: 'POOL_EXHAUSTED' })
  // Preserve two fresh pairs for the HTTP suite's unrelated concurrent holder.
  await accounts.prepare({ pairs: 7 })
})
