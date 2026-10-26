import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import test from 'node:test'
import { Pool } from 'pg'
import { createOperationLedger, type OperationIntent, type OperationIdentity } from './ledger'

const url = process.env.OPERATION_TEST_DATABASE_URL
const enabled = process.env.OPERATION_DB_TESTS === '1'
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
test('operation ledger: real PG concurrency, reconnect and HTTP fault windows', { skip: !enabled }, async t => {
  assert.ok(url, 'explicit test database required')
  const parsed = new URL(url)
  assert.ok(['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.pathname === '/mikka_208_test', 'isolated loopback test DB only')
  const pool = new Pool({ connectionString: url, max: 12 })
  t.after(() => pool.end())
  await pool.query(await readFile(new URL('../../drizzle/20261026002505_operation_ledger.sql', import.meta.url), 'utf8'))
  await pool.query(await readFile(new URL('../../drizzle/20261026002505_operation_ledger.sql', import.meta.url), 'utf8'))
  const ownerId = randomUUID(), workspaceId = randomUUID()
  let revoked = false
  let allowedRun: string | null = null
  const authorize = async (_tx: unknown, b: OperationIntent, run: string | null, phase: string) => {
    assert.equal(b.ownerId, ownerId); assert.equal(b.workspaceId, workspaceId)
    if (revoked || (phase === 'claim' && allowedRun && run !== allowedRun)) throw new Error('denied')
  }
  const ledger = createOperationLedger(pool, authorize)
  const make = (): OperationIntent => ({ operationId: randomUUID(), ownerId, workspaceId, provider: 'synthetic-loopback', accountId: 'fixture', action: 'create', target: 'fixture-object', approvalId: randomUUID(), candidateSha: 'a'.repeat(40), payloadDigest: digest('fixture') })
  const identity = (b: OperationIntent): OperationIdentity => ({ operationId: b.operationId, ownerId, workspaceId })
  await t.test('ten reservations, changed binding, owner/workspace isolation', async () => {
    const b = make(), id = identity(b)
    const rows = await Promise.all(Array.from({ length: 10 }, () => ledger.reserve(b)))
    assert.equal(new Set(rows.map(r => r.idempotencyKey)).size, 1)
    for (const patch of [{ payloadDigest: digest('changed') }, { approvalId: randomUUID() }, { candidateSha: 'b'.repeat(40) }, { target: 'other' }]) await assert.rejects(ledger.reserve({ ...b, ...patch }), /operationBindingConflict/)
    await assert.rejects(ledger.read({ ...id, ownerId: 'other' }), /operationUnavailable/)
    await assert.rejects(ledger.read({ ...id, workspaceId: 'other' }), /operationUnavailable/)
    const claims = await Promise.allSettled(Array.from({ length: 10 }, () => ledger.claim(id, randomUUID())))
    assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal((await pool.query('SELECT count(*) FROM operation_ledger WHERE "operationId"=$1', [b.operationId])).rows[0].count, '1')
  })
  await t.test('both unique indexes tolerate repeated ten-way reservation races', async () => {
    for (let round = 0; round < 25; round++) {
      const b = make()
      const rows = await Promise.all(Array.from({ length: 10 }, () => ledger.reserve(b)))
      assert.equal(rows.every(row => row.operationId === b.operationId), true)
      assert.equal(new Set(rows.map(row => row.idempotencyKey)).size, 1)
    }
  })
  await t.test('reservation and claim use the same database authorization lock order', async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS operation_test_authority (id uuid PRIMARY KEY)')
    const b = make(), id = identity(b)
    await pool.query('INSERT INTO operation_test_authority VALUES ($1)', [b.operationId])
    const locked = createOperationLedger(pool, async (tx, binding) => {
      await tx.query('SELECT id FROM operation_test_authority WHERE id=$1 FOR UPDATE', [binding.operationId])
      await tx.query('SELECT pg_sleep(0.01)')
    })
    await locked.reserve(b)
    const results = await Promise.allSettled([
      ...Array.from({ length: 10 }, () => locked.reserve(b)), locked.claim(id, randomUUID()),
    ])
    assert.equal(results.filter(r => r.status === 'rejected').length, 0)
  })
  await t.test('revocation and stale run fail before claim; new run retains operation', async () => {
    const b = make(), id = identity(b); await ledger.reserve(b)
    revoked = true; await assert.rejects(ledger.claim(id, randomUUID()), /denied/); revoked = false
    allowedRun = randomUUID(); await assert.rejects(ledger.claim(id, randomUUID()), /denied/)
    const row = await ledger.claim(id, allowedRun); allowedRun = null
    await assert.rejects(ledger.settle(id, randomUUID(), { status: 'failed' }), /operationStaleAttempt/)
    await ledger.settle(id, row.attemptToken!, { status: 'uncertain' })
    await assert.rejects(ledger.claim(id, randomUUID()), /operationAlreadyClaimed/)
    assert.equal((await ledger.reserve(b)).idempotencyKey, row.idempotencyKey)
    assert.equal((await ledger.reconcile(id, async () => null)).status, 'uncertain')
  })
  await t.test('SIGKILL and new process recover pre-send and post-effect windows without replay', async () => {
    const objects = new Map<string, string>(); let writes = 0
    const server = createServer((req, res) => {
      const key = req.url!.slice(1)
      if (req.method === 'POST') { writes++; objects.set(key, randomUUID()) }
      res.writeHead(objects.has(key) ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ objectId: objects.get(key) }))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    for (const mode of ['claim', 'effect'] as const) {
      const b = make(), id = identity(b); await ledger.reserve(b)
      const config = { url: url!, identity: id, endpoint: `http://127.0.0.1:${address.port}`, mode }
      const spawn = () => {
        const child = fork(fileURLToPath(new URL('./fixtures/restart-worker.ts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
        return child
      }
      const first = spawn(), ready = once(first, 'message', { signal: AbortSignal.timeout(10000) })
      first.send(config)
      const [committed] = await ready; assert.equal(committed.ready, true)
      const killed = once(first, 'exit'); first.kill('SIGKILL')
      assert.equal((await killed)[1], 'SIGKILL')
      assert.equal((await ledger.read(id)).status, 'executing')
      const second = spawn(), recovered = once(second, 'message', { signal: AbortSignal.timeout(10000) }), exited = once(second, 'exit')
      second.send({ ...config, mode: 'recover' })
      const [result] = await recovered
      assert.equal(result.status, mode === 'claim' ? 'uncertain' : 'succeeded')
      assert.equal(result.key, committed.key)
      assert.equal((await exited)[0], 0)
    }
    assert.equal(writes, 1)
  })
  await t.test('HTTP success followed by PG writeback failure; fresh connection reads back without resend', async () => {
    const objects = new Map<string, string>(); let writes = 0
    const server = createServer((req, res) => {
      const key = req.url!.slice(1)
      if (req.method === 'POST') { writes++; objects.set(key, randomUUID()) }
      const objectId = objects.get(key)
      res.writeHead(objectId ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ objectId }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())))
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const b = make(), id = identity(b); await ledger.reserve(b)
    const row = await ledger.claim(id, randomUUID())
    const endpoint = `http://127.0.0.1:${address.port}/${row.idempotencyKey}`
    const response = await fetch(endpoint, { method: 'POST' }); assert.equal(response.status, 200)
    const { objectId } = await response.json()
    // Actual SQL trigger aborts receipt persistence after remote HTTP effect.
    await pool.query(`CREATE OR REPLACE FUNCTION operation_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' AND NEW."operationId"='${b.operationId}'::uuid THEN RAISE EXCEPTION 'injected writeback failure'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE OR REPLACE TRIGGER operation_test_fault BEFORE UPDATE ON operation_ledger FOR EACH ROW EXECUTE FUNCTION operation_test_fail()')
    await assert.rejects(ledger.settle(id, row.attemptToken!, { status: 'succeeded', receipt: { providerObjectId: objectId, evidenceDigest: digest(objectId) } }), /injected writeback failure/)
    assert.equal((await ledger.read(id)).status, 'executing')
    // Disable only test fault injection; preserve all test ledger records.
    await pool.query('ALTER TABLE operation_ledger DISABLE TRIGGER operation_test_fault')
    const freshPool = new Pool({ connectionString: url }); t.after(() => freshPool.end())
    const fresh = createOperationLedger(freshPool, authorize)
    await assert.rejects(fresh.claim(id, randomUUID()), /operationAlreadyClaimed/)
    const recovered = await fresh.reconcile(id, async record => {
      assert.equal(record.idempotencyKey, row.idempotencyKey)
      const readback = await fetch(endpoint); assert.equal(readback.status, 200)
      const data = await readback.json(); return { providerObjectId: data.objectId, evidenceDigest: digest(data.objectId) }
    })
    assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.receipt?.providerObjectId, objectId); assert.equal(writes, 1)
    await assert.rejects(fresh.settle(id, row.attemptToken!, { status: 'failed' }), /operationStaleAttempt/)
  })
})
