import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { Pool } from 'pg'
import { betterAuth } from 'better-auth'
import type { CalendarProvider } from './calendar-provider'

const enabled = process.env.OPERATION_DB_TESTS === '1'
test('actual proposal/decision entrypoints -> ledger -> local calendar HTTP provider', { skip: !enabled }, async t => {
  assert.ok(!process.env.COMPOSIO_API_KEY && !process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL, 'requires isolated fixture without real providers')
  const url = new URL(process.env.OPERATION_TEST_DATABASE_URL!)
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/mikka_208_test')
  const schema = `calendar_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE SCHEMA ${schema}`)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: url.toString() })
  for (const name of ['20261023221259_application_baseline.sql', '0001_agents_devices.sql', '0007_coordinator_events.sql', '0011_coordinator_event_tier.sql', '0008_coordinator_sessions.sql', '0010_coordinator_session_error.sql', '0009_oauth_provider.sql', '20261025043000_pending_actions.sql', '20261025052001_operation_ledger.sql', '20261025060001_calendar_operation_binding.sql', '20261025070001_account_action_intents.sql']) {
    await pool.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'))
  }
  await pool.query('CREATE RULE retain_test_sessions AS ON DELETE TO "session" DO INSTEAD NOTHING')
  process.env.MIKKA_DATABASE_URL = url.toString()
  process.env.CI = 'true'
  process.env.BETTER_AUTH_URL = 'http://127.0.0.1:3000'
  process.env.BETTER_AUTH_SECRET = randomUUID() + randomUUID()
  assert.equal(process.env.NODE_ENV, 'test')
  // Next replaces this marker in its server build. Node fixture only removes the
  // marker; actual application modules, auth, DB and provider calls are unmocked.
  const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { url: 'data:text/javascript,export{}', shortCircuit: true } : next(specifier, context) } })
  const { proposeAction, listPendingActions } = await import('../pending-action-store')
  const { decidePendingAction } = await import('../pending-actions')
  const inboxStore = await import('../coordinator/store')
  const { recordUserSubmission } = await import('../coordinator-event-store')
  const runtime = await import('./calendar-runtime')
  const database = await import('../db/request-scope')
  const scope = database.createRequestDatabaseScope(url.toString())
  t.after(async () => { hooks.deregister(); await scope.close(); await database.pool.end(); await pool.end(); await admin.end() })
  const storage = (globalThis as unknown as Record<symbol, AsyncLocalStorage<unknown>>)[Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE')]
  assert.ok(storage, 'actual Workflow SDK step context must exist')
  const objects = new Map<string, string>(); let writes = 0, account = 'fixture-account', loseResponse = false, lookupMissing = false, preflightDelay = 0
  const providerServer = createServer((req, res) => {
    const key = req.url!.slice(1)
    if (req.method === 'POST') { writes++; objects.set(key, randomUUID()); if (loseResponse) { loseResponse = false; req.socket.destroy(); return } }
    res.writeHead(objects.has(key) ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: objects.get(key) }))
  })
  providerServer.listen(0, '127.0.0.1'); await once(providerServer, 'listening')
  const address = providerServer.address(); assert.ok(address && typeof address !== 'string')
  const remote = `http://127.0.0.1:${address.port}`
  const receipt = (id: string) => ({ providerObjectId: id, evidenceDigest: createHash('sha256').update(id).digest('hex') })
  const provider: CalendarProvider = {
    name: 'synthetic-calendar-http',
    async prepare() { return { accountId: account, version: 'fixture-v1' } },
    async execute(input) {
      if (input.accountId !== account) throw new Error('account changed')
      if (preflightDelay) await new Promise(resolve => setTimeout(resolve, preflightDelay))
      await input.beforeSend()
      input.signal.throwIfAborted()
      const response = await fetch(`${remote}/${input.idempotencyKey}`, { method: 'POST', signal: AbortSignal.any([input.signal, AbortSignal.timeout(3000)]) })
      assert.equal(response.status, 200); return receipt((await response.json()).id)
    },
    async lookup(input) {
      if (lookupMissing) return null
      const response = await fetch(`${remote}/${input.idempotencyKey}`, { signal: AbortSignal.timeout(3000) })
      return response.status === 404 ? null : receipt((await response.json()).id)
    },
  }
  let origin = ''
  const makeAuth = (baseURL: string) => betterAuth({ database: pool, baseURL, secret: randomUUID() + randomUUID(), emailAndPassword: { enabled: true }, session: { disableSessionRefresh: true }, logger: { disabled: true } })
  let auth: ReturnType<typeof makeAuth>
  const input = { summary: 'Controlled fixture', start: '2026-10-27T10:00:00Z', end: '2026-10-27T11:00:00Z', notify_attendees: false }
  const server = createServer(async (req, res) => {
    try {
      const parts = []; for await (const part of req) parts.push(part)
      const body = Buffer.concat(parts).toString()
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) })
      if (req.url?.startsWith('/api/auth/')) {
        const response = await auth.handler(request); res.writeHead(response.status, { 'Set-Cookie': response.headers.getSetCookie(), 'Content-Type': 'application/json' }); res.end(await response.text()); return
      }
      if (request.headers.get('origin') !== origin) { res.writeHead(403); res.end(); return }
      const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
      if (!session) { res.writeHead(401); res.end(); return }
      const args = JSON.parse(body)
      const result = await scope.run(() => runtime.withCalendarTestProvider(provider, () => req.url === '/propose'
        // Synthetic SDK context, real getStepMetadata implementation. This verifies
        // application propagation, not a deployed Workflow scheduler restart.
        ? storage.run({ stepMetadata: { stepId: args.stepId, attempt: args.attempt, stepName: 'proposeAccountAction', stepStartedAt: new Date() } }, () => proposeAction(session.user.id, 'create_calendar_event', args.input ?? input))
        : decidePendingAction(session.user.id, args.id, args.approve, session.session.id)))
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result))
    } catch { res.writeHead(403); res.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const endpoint = server.address(); assert.ok(endpoint && typeof endpoint !== 'string'); origin = `http://127.0.0.1:${endpoint.port}`
  auth = makeAuth(origin)
  t.after(async () => { await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => providerServer.close(() => r()))]) })
  const signup = await fetch(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Fixture', email: `${randomUUID()}@example.invalid`, password: randomUUID() + randomUUID() }) })
  assert.equal(signup.status, 200)
  const owner = (await signup.json()).user.id
  const cookie = signup.headers.getSetCookie().map(v => v.split(';')[0]).join('; ')
  const call = (path: string, data: unknown) => fetch(origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const propose = async (stepId = randomUUID(), attempt = 1) => { const r = await call('/propose', { stepId, attempt }); assert.equal(r.status, 200); return r.json() }
  await t.test('step retry and ten concurrent proposals reuse persisted identity; actual approval invokes once', async () => {
    const stepId = randomUUID(), proposals = await Promise.all(Array.from({ length: 10 }, (_, i) => propose(stepId, i + 1)))
    const id = proposals[0].actionId; assert.ok(id); assert.equal(new Set(proposals.map(p => p.actionId)).size, 1); assert.equal(writes, 0)
    const conflict = await call('/propose', { stepId, attempt: 11, input: { ...input, summary: 'changed' } }); assert.equal((await conflict.json()).error, 'operationBindingConflict')
    const results = await Promise.all(Array.from({ length: 10 }, () => call('/decide', { id, approve: true })))
    assert.equal(results.every(r => r.status === 200), true); assert.equal(writes, 1)
    assert.equal((await (await call('/decide', { id, approve: true })).json()).status, 'done'); assert.equal(writes, 1)
    const row = (await pool.query('SELECT * FROM operation_ledger WHERE "operationId"=$1', [id])).rows[0]
    assert.equal(row.status, 'succeeded'); assert.equal(row.workspaceId, `personal:${owner}`); assert.ok(row.binding.proposalDigest); assert.equal(row.binding.candidateSha, undefined)
    assert.equal((await propose(stepId, 12)).actionId, id)
    assert.equal((await pool.query('SELECT count(*) FROM coordinator_events WHERE "dedupeKey"=$1', [`action_decided:${id}`])).rows[0].count, '1')
  })
  for (const historicalInput of ['missing', 'null'] as const) await t.test(`lost provider response with historical ${historicalInput} input reconciles without resending`, async () => {
    const holder = randomUUID()
    while ((await scope.run(() => inboxStore.takeInbox(owner, holder))).added) {}
    const { actionId: id } = await propose(); loseResponse = true; const before = writes
    const first = await (await call('/decide', { id, approve: true })).json(); assert.equal(first.status, 'running')
    assert.ok((await scope.run(() => listPendingActions(owner))).some(row => row.id === id))
    assert.equal((await pool.query('SELECT count(*) FROM coordinator_events WHERE "dedupeKey"=$1', [`action_uncertain:${id}`])).rows[0].count, '1')
    const uncertain = (await pool.query('SELECT * FROM coordinator_events WHERE "dedupeKey"=$1', [`action_uncertain:${id}`])).rows[0]
    assert.deepEqual(uncertain.payload.input, input, 'new event retains the originally approved input')
    await pool.query(historicalInput === 'missing'
      ? `UPDATE coordinator_events SET payload=payload-'input' WHERE id=$1`
      : `UPDATE coordinator_events SET payload=jsonb_set(payload, '{input}', 'null'::jsonb) WHERE id=$1`, [uncertain.id])
    const ledgerBeforeConsume = (await pool.query('SELECT status FROM operation_ledger WHERE "operationId"=$1', [id])).rows[0].status
    await scope.run(() => recordUserSubmission(owner, 'Continue the next unrelated task', randomUUID()))
    const firstInbox = await scope.run(() => inboxStore.takeInbox(owner, holder))
    assert.equal(firstInbox.added, 1)
    assert.ok((await pool.query('SELECT "deliveredAt" FROM coordinator_events WHERE id=$1', [uncertain.id])).rows[0].deliveredAt)
    const text = (await pool.query('SELECT message FROM coordinator_messages WHERE "userId"=$1 ORDER BY position DESC LIMIT 1', [owner])).rows[0].message.content
    assert.match(text, /outcome.*unknown/); assert.match(text, /may already have happened/)
    assert.doesNotMatch(text, /person declined|It did not happen/)
    const nextInbox = await scope.run(() => inboxStore.takeInbox(owner, holder))
    assert.equal(nextInbox.added, 1)
    await scope.run(() => inboxStore.appendMessages(owner, holder, [], null, nextInbox.actionContext))
    assert.equal((await pool.query('SELECT message FROM coordinator_messages WHERE "userId"=$1 ORDER BY position DESC LIMIT 1', [owner])).rows[0].message.content, 'Continue the next unrelated task')
    assert.equal((await pool.query('SELECT status FROM operation_ledger WHERE "operationId"=$1', [id])).rows[0].status, ledgerBeforeConsume)
    assert.equal(writes, before + 1, 'consuming uncertainty never resends')
    lookupMissing = true
    assert.equal((await (await call('/decide', { id, approve: true })).json()).status, 'running')
    assert.equal(writes, before + 1, 'lookup null is not permission to resend')
    assert.equal((await pool.query('SELECT count(*) FROM coordinator_events WHERE "dedupeKey"=$1', [`action_uncertain:${id}`])).rows[0].count, '1')
    lookupMissing = false
    await pool.query('UPDATE pending_actions SET "createdAt"=clock_timestamp()-interval \'8 days\' WHERE id=$1', [id])
    const second = await (await call('/decide', { id, approve: true })).json(); assert.equal(second.status, 'done'); assert.equal(writes, before + 1)
    assert.equal((await pool.query('SELECT count(*) FROM coordinator_events WHERE "dedupeKey" IN ($1,$2)', [`action_uncertain:${id}`, `action_decided:${id}`])).rows[0].count, '2')
    assert.equal((await scope.run(() => inboxStore.takeInbox(owner, holder))).added, 1)
    const confirmed = (await pool.query('SELECT message FROM coordinator_messages WHERE "userId"=$1 ORDER BY position DESC LIMIT 1', [owner])).rows[0].message.content
    assert.match(confirmed, /and it is done/)
    assert.equal(writes, before + 1)
    await scope.run(() => inboxStore.releaseLease(owner, holder))

  })
  await t.test('revocation committed after invocation reservation fences the actual send', async () => {
    const { actionId: id } = await propose(), before = writes
    await pool.query(`CREATE FUNCTION revoke_before_send() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."operationId"='${id}'::uuid AND OLD."invokedAt" IS NULL AND NEW."invokedAt" IS NOT NULL THEN UPDATE pending_actions SET status='declined' WHERE id=NEW."operationId"; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER calendar_revoke BEFORE UPDATE ON operation_ledger FOR EACH ROW EXECUTE FUNCTION revoke_before_send()')
    const result = await (await call('/decide', { id, approve: true })).json()
    assert.equal(result.status, 'running'); assert.equal(writes, before)
    assert.equal((await call('/decide', { id, approve: true })).status, 403)
    await pool.query('ALTER TABLE operation_ledger DISABLE TRIGGER calendar_revoke')
  })
  await t.test('provider succeeds then real SQL writeback fails; retry only reads back', async () => {
    const { actionId: id } = await propose(), before = writes
    await pool.query(`CREATE FUNCTION fail_calendar_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."operationId"='${id}'::uuid AND NEW.status='succeeded' THEN RAISE EXCEPTION 'fixture receipt fault'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER calendar_receipt_fault BEFORE UPDATE ON operation_ledger FOR EACH ROW EXECUTE FUNCTION fail_calendar_receipt()')
    assert.equal((await (await call('/decide', { id, approve: true })).json()).status, 'running')
    assert.equal(writes, before + 1)
    await pool.query('ALTER TABLE operation_ledger DISABLE TRIGGER calendar_receipt_fault')
    assert.equal((await (await call('/decide', { id, approve: true })).json()).status, 'done'); assert.equal(writes, before + 1)
  })
  await t.test('legacy unbound proposal cannot execute but can be safely declined', async () => {
    const id = randomUUID(), before = writes
    await pool.query('INSERT INTO pending_actions (id,"userId",action,input) VALUES ($1,$2,\'create_calendar_event\',$3)', [id, owner, input])
    assert.equal((await call('/decide', { id, approve: true })).status, 403)
    assert.equal((await (await call('/decide', { id, approve: false })).json()).status, 'declined')
    assert.equal(writes, before)
  })
  await t.test('session expiry during provider preflight prevents the actual HTTP write', async () => {
    const { actionId: id } = await propose(), before = writes
    await pool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE "userId"=$1', [owner])
    preflightDelay = 1100
    try {
      assert.equal((await (await call('/decide', { id, approve: true })).json()).status, 'running')
      assert.equal(writes, before)
    } finally {
      preflightDelay = 0
      await pool.query('UPDATE "session" SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE "userId"=$1', [owner])
    }
  })
  await t.test('decline, expiry, wrong owner and changed pinned account do not invoke provider', async () => {
    const before = writes
    const a = await propose(); assert.equal((await call('/decide', { id: a.actionId, approve: false })).status, 200); assert.equal((await call('/decide', { id: a.actionId, approve: true })).status, 403)
    const b = await propose(); await pool.query('UPDATE pending_actions SET "createdAt"=clock_timestamp()-interval \'8 days\' WHERE id=$1', [b.actionId]); assert.equal((await call('/decide', { id: b.actionId, approve: true })).status, 403)
    const c = await propose(); await pool.query('UPDATE pending_actions SET "userId"=$2 WHERE id=$1', [c.actionId, randomUUID()]); assert.equal((await call('/decide', { id: c.actionId, approve: true })).status, 403)
    const d = await propose(); account = 'replacement-account'; assert.equal((await (await call('/decide', { id: d.actionId, approve: true })).json()).status, 'running'); assert.equal(writes, before)
  })
})
