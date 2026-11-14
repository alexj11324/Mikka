import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import { liveChannelId } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('legacy pending producers invalidate only their committed owner-personal list', { skip: !url, timeout: 180_000 }, async t => {
  const queued: (() => Promise<void>)[] = []
  const next = await import('next/server')
  const scheduler = mock.module('next/server', { namedExports: { ...next, after: (work: () => Promise<void>) => { queued.push(work) } } })
  const ownerWakes: string[] = []
  const wake = mock.module(new URL('../coordinator/wake.ts', import.meta.url).href, { namedExports: { wakeCoordinator: async (userId: string) => { ownerWakes.push(userId) } } })
  const sent: { path: string; events: unknown }[] = []
  const receiver = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part
    sent.push({ path: request.url!, events: wireKeys(JSON.parse(body)) }); response.writeHead(204); response.end()
  })
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening')
  const address = receiver.address(); assert.ok(address && typeof address !== 'string')
  const priorConfig = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-legacy-pending-live-fixture'
  const admin = new Pool({ connectionString: url, max: 1 })
  const names = ['default', 'request'].map(part => `pending_live_${part}_${randomUUID().replaceAll('-', '')}_e2e`)
  const pools: Pool[] = []
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previousPools = { app: globals.mikkaPool, workspace: globals.workspacePool }
  let requestScope: ReturnType<typeof import('../db/request-scope')['createRequestDatabaseScope']> | undefined
  let composio: ReturnType<typeof mock.module> | undefined
  try {
    for (const name of names) {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
      const target = new URL(url!); target.pathname = `/${name}`
      const pool = new Pool({ connectionString: target.toString(), max: 6 })
      observePoolCommits(pool); pools.push(pool)
      const directory = new URL('../../drizzle/', import.meta.url)
      for (const file of orderMigrations((await readdir(directory)).filter(file => file.endsWith('.sql')))) await pool.query(await readFile(new URL(file, directory), 'utf8'))
    }
    const [database, requestDatabase] = pools
    globals.mikkaPool = database; globals.workspacePool = database
    const app = await import('../db/request-scope')
    const requestURL = new URL(url!); requestURL.pathname = `/${names[1]}`
    const scoped = requestScope = app.createRequestDatabaseScope(requestURL.toString())
    const realComposio = await import('../composio')
    let externalCalls = 0
    composio = mock.module(new URL('../composio.ts', import.meta.url).href, { namedExports: { ...realComposio,
      resolveActionAccount: async () => ({ accountId: 'isolated-account', accounts: [] }),
      runComposioAction: async () => { externalCalls++; throw Error('external execution forbidden') },
    } })
    const { proposeAppToolCall, proposeAction, listPendingActions } = await import('../pending-action-store')
    const { decidePendingAction } = await import('../pending-actions')
    const { proposeCredentialOperation } = await import('../cloud-computer/credential-reviews')
    const { sweepBrowserMutations } = await import('../cloud-computer/action-reviews')
    const owner = `pending-live-${randomUUID()}`, other = `pending-other-${randomUUID()}`
    const homes = new Map([[owner, randomUUID()], [other, randomUUID()]])
    for (const pool of pools) for (const userId of [owner, other]) {
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Pending live fixture\',$2,true,now(),now())', [userId, `${userId}@example.invalid`])
      const workspaceId = homes.get(userId)!
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Pending live fixture\',\'personal\')', [workspaceId, userId])
      await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,\'Pending live fixture\',$3,\'admin\',\'active\')', [workspaceId, userId, `${userId}@example.invalid`])
    }
    const call = () => ({ toolkit: 'slack', tool: 'SLACK_SEND_MESSAGE', name: 'Isolated proposal', version: 'fixture-v1', arguments: { message: randomUUID() } })
    const propose = async (userId = owner) => {
      const result = await proposeAppToolCall(userId, call(), null)
      assert.ok('actionId' in result && typeof result.actionId === 'string'); return result.actionId
    }
    const drain = async () => { await Promise.all(queued.splice(0).map(work => work())) }
    const expected = (userId: string) => ({ path: `/v1/live/${liveChannelId({ ownerId: userId, workspaceId: homes.get(userId)! })}/push`, events: [{ kind: 'pending_actions', id: homes.get(userId)! }] })

    await t.test('actual Drizzle proposal waits for the held outer COMMIT and reads are silent', async () => {
      const client = await database.connect()
      let id = ''
      try {
        await client.query('BEGIN')
        id = await app.withDatabaseClient(client, () => propose())
        assert.equal((await database.query('SELECT id FROM pending_actions WHERE id=$1', [id])).rowCount, 0)
        assert.equal(queued.length, 0); assert.equal(sent.length, 0)
        await client.query('COMMIT') // Outside the registration context.
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      assert.equal(queued.length, 1, 'actual INSERT must register one post-COMMIT effect')
      await drain(); assert.deepEqual(sent, [expected(owner)])
      const before = sent.length
      assert.ok((await listPendingActions(owner)).some(item => item.id === id))
      await drain(); assert.equal(sent.length, before)
    })

    await t.test('the actual Drizzle nested savepoint rollback discards only its notification; outer rollback discards all', async () => {
      const before = sent.length
      let retained = '', rolled = ''
      await app.db.transaction(async outer => {
        retained = await app.withDatabaseTransaction(outer, () => propose())
        await assert.rejects(outer.transaction(async inner => app.withDatabaseTransaction(inner, async () => {
          rolled = await propose(); throw Error('fixture savepoint rollback')
        })), /fixture savepoint rollback/)
        assert.equal(queued.length, 0)
      })
      await drain(); assert.deepEqual(sent.slice(before), [expected(owner)])
      assert.equal((await database.query('SELECT id FROM pending_actions WHERE id=$1', [retained])).rowCount, 1)
      assert.equal((await database.query('SELECT id FROM pending_actions WHERE id=$1', [rolled])).rowCount, 0)
      const committed = sent.length
      await assert.rejects(app.db.transaction(async tx => app.withDatabaseTransaction(tx, async () => { await propose(); throw Error('fixture outer rollback') })), /fixture outer rollback/)
      await drain(); assert.equal(sent.length, committed)
    })

    await t.test('a declined account card stays pending when its decision notice cannot commit', async () => {
      const proposal = await proposeAction(owner, 'send_email', { to: ['fixture@example.invalid'], subject: 'Atomic decline', body: 'Never sent.' })
      assert.ok('actionId' in proposal && typeof proposal.actionId === 'string')
      const id = proposal.actionId
      const row = () => database.query('SELECT status,"decidedAt" FROM pending_actions WHERE id=$1', [id]).then(r => r.rows[0])
      const notice = () => database.query('SELECT payload FROM coordinator_events WHERE "dedupeKey"=$1', [`action_decided:${id}`])
      await database.query(`CREATE FUNCTION reject_decline_notice() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."dedupeKey"='action_decided:${id}' THEN RAISE EXCEPTION 'fixture rejected decline notice'; END IF; RETURN NEW; END $$`)
      try {
        await database.query(`CREATE CONSTRAINT TRIGGER reject_decline_notice AFTER INSERT ON coordinator_events
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_decline_notice()`)
        await assert.rejects(decidePendingAction(owner, id, false), (error: unknown) => String((error as { cause?: unknown }).cause ?? error).includes('fixture rejected decline notice'))
        assert.deepEqual(await row(), { status: 'pending', decidedAt: null })
        assert.equal((await notice()).rowCount, 0)
      } finally {
        await database.query('DROP TRIGGER IF EXISTS reject_decline_notice ON coordinator_events')
        await database.query('DROP FUNCTION reject_decline_notice()')
      }
      await assert.rejects(decidePendingAction(other, id, false), /pendingActionUnavailable/)
      const attempts = await Promise.allSettled([decidePendingAction(owner, id, false), decidePendingAction(owner, id, false)])
      assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1)
      assert.equal((await row()).status, 'declined')
      const event = await notice()
      assert.equal(event.rowCount, 1)
      assert.equal(event.rows[0].payload.status, 'declined')
      assert.equal(externalCalls, 0)
      await drain()
    })

    await t.test('actual account proposal and owner decline invalidate; repeated/foreign decisions execute nothing', async () => {
      ownerWakes.length = 0
      const result = await proposeAction(owner, 'send_email', { to: ['fixture@example.invalid'], subject: 'Pending fixture', body: 'Never sent.' })
      assert.ok('actionId' in result && typeof result.actionId === 'string'); await drain(); const before = sent.length
      await assert.rejects(decidePendingAction(other, result.actionId, false), /pendingActionUnavailable/)
      assert.equal((await decidePendingAction(owner, result.actionId, false)).status, 'declined')
      // A legacy account event without a Bot cannot fabricate a Bot tenant or
      // send a chat key. The committed owner-personal pending list still updates.
      await drain(); assert.deepEqual(sent.slice(before), [expected(owner)])
      await assert.rejects(decidePendingAction(owner, result.actionId, false), /pendingActionUnavailable/)
      await drain()
      assert.deepEqual(ownerWakes, [owner], 'the persisted decision wakes the owner once, including across a rejected replay')
      await drain(); assert.equal(sent.length, before + 1); assert.equal(externalCalls, 0)
      assert.equal((await listPendingActions(owner)).some(item => item.id === result.actionId), false)
    })

    await t.test('another owner gets only its personal key and membership is rechecked after scheduling', async () => {
      const before = sent.length; await propose(other); await drain()
      assert.deepEqual(sent.slice(before), [expected(other)])
      await propose(other)
      await database.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [homes.get(other), other])
      const prior = sent.length; await drain(); assert.equal(sent.length, prior)
      await database.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [homes.get(other), other])
    })

    await t.test('delayed scheduling and COMMIT outside a request keep the source DB even for the same UUID', async () => {
      const before = sent.length, client = await requestDatabase.connect()
      let id = ''
      try {
        await client.query('BEGIN')
        id = await scoped.run(() => app.withDatabaseClient(client, () => propose()))
        const record = (await client.query('SELECT to_jsonb(p) AS value FROM pending_actions p WHERE id=$1', [id])).rows[0].value
        record.userId = other
        await database.query('INSERT INTO pending_actions SELECT * FROM jsonb_populate_record(NULL::pending_actions,$1)', [record])
        assert.equal(queued.length, 0)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      await drain()
      assert.deepEqual(sent.slice(before), [expected(owner)])
      assert.equal((await database.query('SELECT "userId" FROM pending_actions WHERE id=$1', [id])).rows[0].userId, other)
    })

    await t.test('actual credential proposal commits once, replay is silent, and a later failed event rolls everything back', async () => {
      const botId = randomUUID(), workspaceId = homes.get(owner)!
      await database.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Pending fixture\')', [botId, owner, workspaceId])
      await database.query('INSERT INTO workspace_computer_policies("workspaceId") VALUES($1)', [workspaceId])
      const target = { targetId: 'fixture-target', origin: 'https://example.invalid', endpoint: 'https://fixture.invalid', expiresAt: Date.now() + 60000,
        observedInputs: [{ backendNodeId: 12, credentialRole: 'password' as const, loaderId: 'fixture-document', epoch: 1, permissionVersion: 0 }] }
      const subagent = async (task: string) => {
        const id = randomUUID()
        await database.query('INSERT INTO bot_subagents(id,"ownerId","workspaceId","botId",task,status,epoch,"targetId") VALUES($1,$2,$3,$4,$5,\'running\',1,$6)', [id, owner, workspaceId, botId, task, target.targetId])
        return id
      }
      const subagentId = await subagent('Pending approval fixture'), caller = { userId: owner, workspaceId, botId, subagentId }
      const before = sent.length
      assert.equal((await proposeCredentialOperation(database, caller, target, 'fill')).status, 'needs_approval')
      const subagentEvents = { path: expected(owner).path, events: [{ kind: 'subagent_events', id: workspaceId }] }
      const byKind = (items: typeof sent) => [...items].sort((a, b) => JSON.stringify(a.events).localeCompare(JSON.stringify(b.events)))
      // One committed credential proposal changes both the pending list and its subagent event stream.
      await drain(); assert.deepEqual(byKind(sent.slice(before)), byKind([expected(owner), subagentEvents]))
      assert.equal((await proposeCredentialOperation(database, caller, target, 'fill')).status, 'needs_approval')
      await drain(); assert.equal(sent.length, before + 2)
      await database.query(`CREATE FUNCTION reject_pending_live_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event->'data'->>'task'='pending-live-must-rollback' THEN RAISE EXCEPTION 'fixture event write rejected'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_pending_live_fixture BEFORE INSERT ON subagent_events FOR EACH ROW EXECUTE FUNCTION reject_pending_live_fixture()`)
      const rejected = await subagent('pending-live-must-rollback')
      const count = (await database.query('SELECT count(*) FROM pending_actions')).rows[0].count
      await assert.rejects(proposeCredentialOperation(database, { ...caller, subagentId: rejected }, target, 'fill'), /fixture event write rejected/)
      await drain(); assert.equal(sent.length, before + 2)
      assert.equal((await database.query('SELECT count(*) FROM pending_actions')).rows[0].count, count)
      assert.equal((await database.query('SELECT status FROM bot_subagents WHERE id=$1', [rejected])).rows[0].status, 'running')
    })

    await t.test('the historical browser pending sweep invalidates only rows that actually leave pending', async () => {
      const id = randomUUID()
      await database.query('INSERT INTO pending_actions(id,"userId",action,input,"createdAt") VALUES($1,$2,\'browser_operation\',$3,now()-interval \'6 minutes\')', [id, owner, { summary: 'Expired browser proposal', origin: 'https://example.invalid' }])
      const before = sent.length
      await sweepBrowserMutations(database, owner); await drain()
      assert.deepEqual(sent.slice(before), [expected(owner)])
      assert.equal((await database.query('SELECT status FROM pending_actions WHERE id=$1', [id])).rows[0].status, 'failed')
      await sweepBrowserMutations(database, owner); await drain(); assert.equal(sent.length, before + 1)
      assert.equal(externalCalls, 0)
    })
  } finally {
    queued.splice(0); composio?.restore(); wake.restore()
    await requestScope?.close()
    globals.mikkaPool = previousPools.app; globals.workspacePool = previousPools.workspace
    for (let index = 0; index < pools.length; index++) await dropTestDatabase(admin, names[index], pools[index])
    await admin.end(); scheduler.restore()
    if (priorConfig.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = priorConfig.url
    if (priorConfig.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = priorConfig.secret
    receiver.close(); await once(receiver, 'close')
  }
})
