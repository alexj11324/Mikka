import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { CredentialStore, hashNonce, type BrowserTarget } from '../credentials/store'
import { CredentialError, type EncryptionContext } from '../credentials/contracts'
import { credentialFailure } from '../credentials/http'
import { sealSession, type Kms } from '../credentials/kms'
import type { Cdp, BrowserGuard } from '../credentials/browser'
import type { LiveScope } from '../live/scope'
import type { LiveInvalidation } from '../live/events'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

/** Every statement and result is real PostgreSQL. Recording only completed
 * transaction statements makes an early notification fail deterministically,
 * even if an asynchronous reader would otherwise happen to arrive after COMMIT. */
function observeTransactions(pool: Pool, completed: string[]): Pool {
  return {
    query: (sql: string, values?: unknown[]) => pool.query(sql, values),
    async connect() {
      const client = await pool.connect()
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values)
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) completed.push(sql)
          return result
        },
        release: () => client.release(),
      }
    },
  } as unknown as Pool
}

test('credential broker publishes only the committed session-resume event and cannot replay a consumed lease', { skip: !url, timeout: 120_000 }, async t => {
  const schema = `computer_broker_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })
  const reader = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 2 })
  const previousSecret = process.env.BETTER_AUTH_SECRET
  const previousBroker = process.env.CREDENTIAL_BROKER_URL
  const previousEdition = process.env.MIKKA_EDITION
  process.env.MIKKA_EDITION = 'cloud'
  process.env.CREDENTIAL_BROKER_URL = 'https://fixture-broker.vercel.app'
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex')
  const keys = new Map<string, { key: Buffer; context: EncryptionContext }>()
  let decrypts = 0
  const kms: Kms = {
    async generate(context) {
      const key = randomBytes(32), wrapped = `synthetic-${randomUUID()}`
      keys.set(wrapped, { key, context: { ...context } })
      return { plaintext: Buffer.from(key), wrapped }
    },
    async decrypt(wrapped, context) {
      const saved = keys.get(wrapped)
      assert.ok(saved)
      assert.deepEqual(context, saved.context, 'the fake KMS still checks the real envelope context')
      decrypts++
      return Buffer.from(saved.key)
    },
  }
  let onNotify: (scope: LiveScope, events: LiveInvalidation[]) => void = () => { assert.fail('unexpected notification') }
  const boundary = mock.module(new URL('../live/notify.ts', import.meta.url).href, {
    namedExports: { notifyLive: (scope: LiveScope, events: LiveInvalidation[]) => onNotify(scope, events) },
  })
  const runtimeBoundaries = [
    mock.module('@vercel/oidc', { namedExports: { getVercelOidcToken: async () => 'synthetic-oidc' } }),
    mock.module(new URL('../api-auth.ts', import.meta.url).href, { namedExports: { auth: {} } }),
    mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool } }),
    mock.module(new URL('../workspace-access.ts', import.meta.url).href, { namedExports: { loadWorkspaceContext: () => { throw Error('unexpected actor lookup') } } }),
    mock.module(new URL('../cloud-computer/subagent-browser.ts', import.meta.url).href, {
      namedExports: {
        resolveSubagentBrowserTarget: () => { throw Error('unexpected target lookup') },
        resolveThreadBrowserTarget: () => { throw Error('unexpected target lookup') },
      },
    }),
  ]
  let brokerReply: (lease: string) => Promise<Response> = async () => { throw Error('unexpected broker request') }
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://fixture-broker.vercel.app/api/fill')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-oidc')
    const payload = JSON.parse(String(init?.body))
    assert.deepEqual(Object.keys(payload), ['lease'])
    return brokerReply(payload.lease)
  })
  try {
    const { fillCredential } = await import('../credentials/broker')
    const { executeCredentialLease } = await import('../credentials/runtime')
    await pool.query(`
      CREATE TABLE "user"(id text PRIMARY KEY);
      CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text NOT NULL,"workspaceId" uuid NOT NULL);
      CREATE TABLE bot_subagents(id uuid PRIMARY KEY,"ownerId" text NOT NULL,"workspaceId" uuid NOT NULL,"botId" uuid NOT NULL,
        task text NOT NULL,status text NOT NULL,needs jsonb,step text NOT NULL,"targetId" text,epoch integer NOT NULL);
      CREATE TABLE workspace_computer_policies("workspaceId" uuid PRIMARY KEY,permission text NOT NULL,version integer NOT NULL);
      CREATE TABLE subagent_events(seq bigserial PRIMARY KEY,"ownerId" text NOT NULL,"workspaceId" uuid NOT NULL,
        "botId" uuid NOT NULL,"subagentId" uuid NOT NULL REFERENCES bot_subagents(id),event jsonb NOT NULL);
    `)
    for (const migration of ['20261029012027_account_credential_vault.sql', '20261030204833_workspace_audit_events.sql']) {
      await pool.query(await readFile(new URL(`../../drizzle/${migration}`, import.meta.url), 'utf8'))
    }
    const fixture = async () => {
      const actor = { userId: `broker-${randomUUID()}`, workspaceId: randomUUID(), botId: randomUUID(), subagentId: randomUUID() }
      const origin = 'https://example.com', needs = { kind: 'login', origin }
      await pool.query('INSERT INTO "user" VALUES($1)', [actor.userId])
      await pool.query('INSERT INTO bots VALUES($1,$2,$3)', [actor.botId, actor.userId, actor.workspaceId])
      await pool.query(`INSERT INTO bot_subagents VALUES($1,$2,$3,$4,'Read fixture source','needs_you',$5,'Waiting for fixture','fixture-target',1)`,
        [actor.subagentId, actor.userId, actor.workspaceId, actor.botId, needs])
      await pool.query(`INSERT INTO workspace_computer_policies VALUES($1,'allow',1)`, [actor.workspaceId])
      const store = new CredentialStore(pool, kms)
      const challenge = await store.challenge(actor, origin)
      await store.save(actor, { nonce: challenge.nonce, origin, username: 'fixture-user', password: randomBytes(24).toString('base64url') })
      const credential = (await pool.query(`SELECT c.id,s.wrapped_dek,s.nonce FROM credentials c
        JOIN credential_secrets s ON s.credential_id=c.id WHERE c.user_id=$1`, [actor.userId])).rows[0]
      const state = { cookies: [{ name: 'fixture', value: 'synthetic-session', domain: 'example.com', path: '/' }], localStorage: [['fixture', 'synthetic-value']] }
      const plaintext = Buffer.from(JSON.stringify(state))
      const envelope = await sealSession(kms, { userId: actor.userId, credentialId: credential.id, origin }, credential.wrapped_dek, plaintext)
      assert.ok(plaintext.every(byte => byte === 0), 'real encryption clears its input buffer')
      assert.notEqual(envelope.nonce, credential.nonce, 'session encryption has a fresh nonce')
      assert.equal(envelope.ciphertext.includes('synthetic-session'), false)
      await pool.query(`INSERT INTO browser_sessions(credential_id,wrapped_dek,nonce,ciphertext,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '1 hour')`, [credential.id, envelope.wrappedDek, envelope.nonce, envelope.ciphertext])
      const target: BrowserTarget = {
        targetId: 'fixture-target', origin, endpoint: 'https://fixture.e2b.app/', expiresAt: Date.now() + 60_000,
        observedInput: { loaderId: 'fixture-loader', backendNodeId: 7, credentialRole: 'password', epoch: 1, permissionVersion: 1 },
      }
      const lease = await store.lease(actor, origin, target)
      assert.equal(lease.status, 'ready')
      if (lease.status !== 'ready') throw new Error('fixture lease missing')
      const completed: string[] = [], calls: string[] = []
      const snapshot = async () => ({
        row: (await reader.query('SELECT status,needs,step FROM bot_subagents WHERE id=$1', [actor.subagentId])).rows[0],
        events: (await reader.query('SELECT event FROM subagent_events WHERE "subagentId"=$1 ORDER BY seq', [actor.subagentId])).rows.map(row => row.event),
      })
      const cdp = {
        async attach(id: string) { assert.equal(id, target.targetId); calls.push('attach') },
        async origin(value: string) { assert.equal(value, origin) },
        async safeToResume() { calls.push('safeToResume'); return true },
        async insertAtObservedInput() { assert.fail('a saved session must not fall back to password insertion') },
        async call(method: string, params?: Record<string, unknown>) {
          calls.push(method)
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { url: origin, loaderId: 'fixture-loader' } } }
          if (method === 'Network.setCookies') { assert.deepEqual(params?.cookies, state.cookies); return {} }
          if (method === 'Runtime.evaluate') return { result: { objectId: 'fixture-root' } }
          if (method === 'Runtime.callFunctionOn') { assert.deepEqual(params?.arguments, [{ value: state.localStorage }]); return {} }
          if (method === 'Page.reload') return {}
          throw new Error(`Unexpected CDP fixture call: ${method}`)
        },
        close() { calls.push('close') },
      }
      const guard: BrowserGuard = {
        async begin() {
          const claim = (await reader.query('SELECT consumed_at,input_envelope FROM credential_fill_leases WHERE nonce_hash=$1', [hashNonce(lease.lease)])).rows[0]
          assert.ok(claim.consumed_at, 'external effects start only after durable consumption')
          assert.equal(claim.input_envelope, null)
          calls.push('guard.begin')
          return { cdpUrl: 'wss://fixture.e2b.app/', targetId: target.targetId, guardToken: 'synthetic-guard' }
        },
        async end() {
          assert.deepEqual(completed, ['BEGIN', 'COMMIT'], 'the first transaction commits before ending the guard')
          assert.deepEqual(await snapshot(), { row: { status: 'needs_you', needs, step: 'Waiting for fixture' }, events: [] })
          calls.push('guard.end')
        },
      }
      const options = { kms, guard, connect: (async () => cdp) as unknown as typeof Cdp.connect }
      return { actor, origin, needs, credentialId: credential.id, lease: lease.lease, calls, completed, options, snapshot }
    }

    await t.test('a session application publishes once after both real transactions commit', async () => {
      const item = await fixture()
      const observations: Promise<Awaited<ReturnType<typeof item.snapshot>>>[] = []
      onNotify = (scope, events) => {
        assert.deepEqual(item.completed, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
        assert.deepEqual(scope, { ownerId: item.actor.userId, workspaceId: item.actor.workspaceId })
        assert.deepEqual(events, [{ kind: 'subagent_events', id: item.actor.workspaceId }])
        observations.push(item.snapshot())
      }
      brokerReply = async lease => Response.json(await fillCredential(observeTransactions(pool, item.completed), lease, item.options))
      assert.deepEqual(await executeCredentialLease(item.lease, item.origin, { ownerId: item.actor.userId, workspaceId: item.actor.workspaceId }), { status: 'session_applied', origin: item.origin })
      assert.equal(observations.length, 1)
      const expected = { botId: item.actor.botId, subagentId: item.actor.subagentId, task: 'Read fixture source', state: 'running', step: 'running', needs: null }
      assert.deepEqual(await observations[0], { row: { status: 'running', needs: null, step: 'running' }, events: [{ type: 'data-subagent', data: expected }] })
      assert.equal(item.calls.filter(call => call === 'Network.setCookies').length, 1)
      assert.equal(item.calls.filter(call => call === 'Page.reload').length, 1)
      assert.ok(item.calls.includes('guard.end'))
      assert.equal(item.calls.at(-1), 'close')
      const beforeReplay = { calls: item.calls.length, decrypts }
      await assert.rejects(fillCredential(pool, item.lease, item.options), (error: unknown) => error instanceof CredentialError && error.code === 'credential_denied' && error.status === 404)
      assert.deepEqual({ calls: item.calls.length, decrypts }, beforeReplay)
      assert.equal(observations.length, 1)
    })
    await t.test('failed event insertion rolls back only the second transaction and never notifies or replays', async () => {
      const item = await fixture()
      let notifications = 0
      onNotify = () => { notifications++ }
      await pool.query(`CREATE FUNCTION reject_broker_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture rejects event'; END; $$;
        CREATE TRIGGER reject_broker_event BEFORE INSERT ON subagent_events FOR EACH ROW EXECUTE FUNCTION reject_broker_event();`)
      brokerReply = async lease => {
        try { return Response.json(await fillCredential(observeTransactions(pool, item.completed), lease, item.options)) }
        catch (error) { return credentialFailure(error) }
      }
      await assert.rejects(executeCredentialLease(item.lease, item.origin, { ownerId: item.actor.userId, workspaceId: item.actor.workspaceId }),
        (error: unknown) => error instanceof CredentialError && error.code === 'credential_outcome_unknown' && error.status === 409)
      assert.deepEqual(item.completed, ['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK'])
      assert.deepEqual(await item.snapshot(), { row: { status: 'needs_you', needs: item.needs, step: 'Waiting for fixture' }, events: [] })
      assert.equal(notifications, 0)
      const persisted = (await reader.query(`SELECT l.consumed_at,c.last_used_at FROM credential_fill_leases l
        JOIN credentials c ON c.id=l.credential_id WHERE l.nonce_hash=$1`, [hashNonce(item.lease)])).rows[0]
      assert.ok(persisted.consumed_at, 'the one-use lease remains durably consumed')
      assert.ok(persisted.last_used_at, 'the first transaction remains committed')
      const decisions = (await reader.query('SELECT decision FROM credential_access_events WHERE user_id=$1 ORDER BY id', [item.actor.userId])).rows.map(row => row.decision)
      assert.deepEqual(decisions, ['session_applied', 'denied_or_failed'])
      assert.equal(item.calls.filter(call => call === 'Network.setCookies').length, 1)
      assert.ok(item.calls.includes('guard.end'), 'the synthetic browser boundary already completed before the database failure')
      const beforeReplay = { calls: item.calls.length, decrypts }
      await assert.rejects(fillCredential(pool, item.lease, item.options), (error: unknown) => error instanceof CredentialError && error.code === 'credential_denied' && error.status === 404)
      assert.deepEqual({ calls: item.calls.length, decrypts }, beforeReplay)
      assert.equal(notifications, 0)
    })
    for (const failure of ['wrong-origin', 'lost-response'] as const) {
      await t.test(`a committed event with ${failure} keeps its durable state without an unvalidated app notification`, async () => {
        // The earlier rollback fixture's trigger is deliberately removed only in this disposable schema.
        await pool.query('DROP TRIGGER IF EXISTS reject_broker_event ON subagent_events')
        const item = await fixture()
        let notifications = 0
        onNotify = () => { notifications++ }
        brokerReply = async lease => {
          const result = await fillCredential(observeTransactions(pool, item.completed), lease, item.options)
          if (failure === 'lost-response') throw Error('synthetic response loss')
          return Response.json({ ...result, origin: 'https://different.example' })
        }
        await assert.rejects(executeCredentialLease(item.lease, item.origin, { ownerId: item.actor.userId, workspaceId: item.actor.workspaceId }),
          (error: unknown) => error instanceof CredentialError && error.code === 'credential_outcome_unknown' && error.status === 409)
        assert.deepEqual(item.completed, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
        const persisted = await item.snapshot()
        assert.equal(persisted.row.status, 'running')
        assert.equal(persisted.events.length, 1, 'reconnect can still read the committed event')
        assert.equal(notifications, 0, 'an app invalidation requires the validated broker acknowledgement')
        const beforeReplay = { calls: item.calls.length, decrypts }
        await assert.rejects(fillCredential(pool, item.lease, item.options), (error: unknown) => error instanceof CredentialError && error.code === 'credential_denied')
        assert.deepEqual({ calls: item.calls.length, decrypts }, beforeReplay)
      })
    }
    await t.test('guarded broker responses do not announce resumed subagents', async () => {
      const item = await fixture()
      let notifications = 0
      onNotify = () => { notifications++ }
      brokerReply = async () => Response.json({ status: 'guarded', origin: item.origin })
      assert.deepEqual(await executeCredentialLease(item.lease, item.origin, { ownerId: item.actor.userId, workspaceId: item.actor.workspaceId }),
        { status: 'guarded', origin: item.origin })
      assert.equal(notifications, 0)
      assert.equal((await item.snapshot()).events.length, 0)
    })
  } finally {
    for (const mocked of runtimeBoundaries.reverse()) mocked.restore()
    boundary.restore()
    if (previousBroker === undefined) delete process.env.CREDENTIAL_BROKER_URL; else process.env.CREDENTIAL_BROKER_URL = previousBroker
    if (previousEdition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = previousEdition
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previousSecret
    for (const { key } of keys.values()) key.fill(0)
    await reader.end(); await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
