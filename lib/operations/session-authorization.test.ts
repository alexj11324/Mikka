import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { betterAuth } from 'better-auth'
import { Pool } from 'pg'
import { createOperationLedger, OperationError, type OperationAuthorize, type OperationIntent } from './ledger'
import { withOperationSession } from './session-authorization'

const enabled = process.env.OPERATION_DB_TESTS === '1'
test('real Better Auth HTTP + PG session and pending approval fences (isolated synthetic account)', { skip: !enabled }, async t => {
  const url = new URL(process.env.OPERATION_TEST_DATABASE_URL!)
  assert.ok(url.hostname === '127.0.0.1' && url.pathname === '/mikka_208_test')
  const admin = new Pool({ connectionString: url.toString() })
  const schema = `operation_auth_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}`, application_name: schema })
  t.after(async () => { await pool.end(); await admin.end() }) // No schema/fixture deletion.
  for (const migration of ['20261023221259_application_baseline.sql', '20261025043000_pending_actions.sql', '20261026002505_operation_ledger.sql']) {
    await pool.query(await readFile(new URL(`../../drizzle/${migration}`, import.meta.url), 'utf8'))
  }
  // Better Auth deletes expired sessions internally. Preserve synthetic evidence rows.
  await pool.query('CREATE RULE retain_test_sessions AS ON DELETE TO "session" DO INSTEAD NOTHING')
  const payload = { value: 'synthetic' }, payloadDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  // Test-only #204 adapter: real existing approval rows, NOT a new approval store.
  // Production integration still needs workspace/account/candidate binding (#177).
  const domain: OperationAuthorize = async (tx, binding) => {
    await tx.query('SELECT id FROM pending_actions WHERE id=$1 FOR SHARE', [binding.approvalId])
    const { rows } = await tx.query(`SELECT * FROM pending_actions WHERE id=$1 AND "userId"=$2 AND status='running' AND "createdAt">clock_timestamp()-interval '7 days'`, [binding.approvalId, binding.ownerId])
    const row = rows[0]
    if (!row || row.action !== binding.action || createHash('sha256').update(JSON.stringify(row.input)).digest('hex') !== binding.payloadDigest) throw new OperationError('approvalUnavailable')
  }
  let origin = ''
  const makeAuth = (baseURL: string) => betterAuth({ database: pool, baseURL, secret: randomUUID() + randomUUID(), emailAndPassword: { enabled: true }, session: { disableSessionRefresh: true }, logger: { disabled: true } })
  let auth: ReturnType<typeof makeAuth>
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) })
      if (req.url?.startsWith('/api/auth/')) {
        const response = await auth.handler(request)
        res.writeHead(response.status, { 'Content-Type': 'application/json', 'Set-Cookie': response.headers.getSetCookie() }); res.end(await response.text()); return
      }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      if (request.headers.get('authorization')) { res.writeHead(401); res.end(); return }
      if (request.headers.get('origin') !== origin) { res.writeHead(403); res.end(); return }
      const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
      if (!session) { res.writeHead(401); res.end(); return }
      const { operationId, workspaceId, runId } = JSON.parse(body)
      const ledger = createOperationLedger(pool, withOperationSession({ userId: session.user.id, sessionId: session.session.id }, domain))
      const row = await ledger.claim({ operationId, ownerId: session.user.id, workspaceId }, runId)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify({ status: row.status }))
    } catch (error) {
      res.writeHead(error instanceof OperationError ? 403 : 500); res.end()
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`; auth = makeAuth(origin)
  const signup = await fetch(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic', email: `${randomUUID()}@example.invalid`, password: randomUUID() + randomUUID() }) })
  assert.equal(signup.status, 200)
  const cookie = signup.headers.getSetCookie().map(v => v.split(';')[0]).join('; ')
  const signed = await signup.json(), ownerId: string = signed.user.id
  const { rows: [session] } = await pool.query('SELECT * FROM "session" WHERE "userId"=$1', [ownerId])
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  const scoped = createOperationLedger(pool, withOperationSession({ userId: ownerId, sessionId: session.id }, domain))
  const prepare = async () => {
    const intent: OperationIntent = { operationId: randomUUID(), ownerId, workspaceId: randomUUID(), provider: 'synthetic', accountId: 'fixture', action: 'create', target: 'fixture', approvalId: randomUUID(), candidateSha: 'a'.repeat(40), payloadDigest }
    await pool.query('INSERT INTO pending_actions (id,"userId",action,input,status) VALUES ($1,$2,$3,$4,\'running\')', [intent.approvalId, ownerId, intent.action, payload])
    await scoped.reserve(intent)
    return intent
  }
  const claim = (b: OperationIntent, override = {}) => fetch(`${origin}/claim`, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify({ operationId: b.operationId, workspaceId: b.workspaceId, runId: randomUUID() }) })
  const state = async (b: OperationIntent) => (await pool.query('SELECT status FROM operation_ledger WHERE "operationId"=$1', [b.operationId])).rows[0].status
  await t.test('cookie auth, bearer rejection, origin and successful authorized claim', async () => {
    const b = await prepare()
    assert.equal((await claim(b, { Cookie: '' })).status, 401)
    assert.equal((await claim(b, { Authorization: 'Bearer synthetic' })).status, 401)
    assert.equal((await claim(b, { Origin: 'http://foreign.invalid' })).status, 403)
    assert.equal(await state(b), 'reserved')
    assert.equal((await claim(b)).status, 200)
    assert.equal(await state(b), 'executing')
  })
  await t.test('committed approval revocation and expiry refuse claim without changing ledger', async () => {
    for (const update of ["status='declined'", '"createdAt"=clock_timestamp()-interval \'8 days\'']) {
      const b = await prepare()
      await pool.query(`UPDATE pending_actions SET ${update} WHERE id=$1`, [b.approvalId])
      assert.equal((await claim(b)).status, 403); assert.equal(await state(b), 'reserved')
    }
  })
  await t.test('revocation transaction wins while HTTP claim waits for its approval row', async () => {
    const b = await prepare(), tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query("UPDATE pending_actions SET status='declined' WHERE id=$1", [b.approvalId])
      const response = claim(b)
      // Observe the real backend blocked on our row lock, then commit revocation.
      let waiting = false
      for (let i = 0; i < 200; i++) {
        const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM pending_actions%'", [schema])
        if (result.rows.length) { waiting = true; break }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await tx.query('COMMIT')
      assert.equal(waiting, true); assert.equal((await response).status, 403); assert.equal(await state(b), 'reserved')
    } finally { await tx.query('ROLLBACK'); tx.release() }
  })
  await t.test('session that expires while waiting for domain authorization cannot claim', async () => {
    const b = await prepare(), tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query('SELECT id FROM pending_actions WHERE id=$1 FOR UPDATE', [b.approvalId])
      await pool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '1 second' WHERE id=$1`, [session.id])
      const response = claim(b)
      let waiting = false
      for (let i = 0; i < 100; i++) {
        const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM pending_actions%'", [schema])
        if (result.rows.length) { waiting = true; break }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await tx.query('SELECT pg_sleep(1.1)')
      await tx.query('COMMIT')
      assert.equal(waiting, true); assert.equal((await response).status, 403); assert.equal(await state(b), 'reserved')
    } finally {
      await tx.query('ROLLBACK'); tx.release()
      await pool.query(`UPDATE "session" SET "expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=$1`, [session.id])
    }
  })
  await t.test('expired session denied by HTTP and transaction guard after authentication', async () => {
    const b = await prepare()
    await pool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()-interval \'1 second\' WHERE id=$1', [session.id])
    // Direct guard models expiry between getSession and claim; session row retained.
    await assert.rejects(scoped.claim({ operationId: b.operationId, ownerId, workspaceId: b.workspaceId }, randomUUID()), /operationSessionUnavailable/)
    assert.equal((await claim(b)).status, 401); assert.equal(await state(b), 'reserved')
    assert.equal((await pool.query('SELECT count(*) FROM "session" WHERE id=$1', [session.id])).rows[0].count, '1')
  })
})
