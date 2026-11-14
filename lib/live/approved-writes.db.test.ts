import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test, { mock } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import { liveChannelId } from './scope'
import { createApprovedWrites } from '../operations/approved-writes'
import type { WriteProvider } from '../operations/write-contract'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')
const action = 'append_notion_paragraph'

test('approved writes publish only committed owner-personal invalidations through the real service', { skip: !url, timeout: 180_000 }, async t => {
  const queued: (() => Promise<void>)[] = []
  const next = await import('next/server')
  const scheduler = mock.module('next/server', { namedExports: { ...next, after: (work: () => Promise<void>) => { queued.push(work) } } })
  const sent: { path: string; events: unknown }[] = []
  const receiver = createServer(async (request, response) => {
    let body = ''
    for await (const part of request) body += part
    sent.push({ path: request.url!, events: JSON.parse(body) })
    response.writeHead(204); response.end()
  })
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening')
  const address = receiver.address(); assert.ok(address && typeof address !== 'string')
  const priorConfig = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-approved-write-live-fixture'
  const admin = new Pool({ connectionString: url, max: 1 })
  const names = ['default', 'request'].map(part => `approved_live_${part}_${randomUUID().replaceAll('-', '')}_e2e`)
  const pools: Pool[] = []
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previousPools = { app: globals.mikkaPool, workspace: globals.workspacePool }
  let requestScope: ReturnType<typeof import('../db/request-scope')['createRequestDatabaseScope']> | undefined
  try {
    for (const name of names) {
      await createTestDatabase(admin, name, 'template0')
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
    const owner = `approved-live-${randomUUID()}`, other = `approved-other-${randomUUID()}`
    const homes = new Map([[owner, randomUUID()], [other, randomUUID()]])
    const session = `${owner}-session`, otherSession = `${other}-session`
    let executions = 0, lookups = 0, uncertain = false
    const provider: WriteProvider = {
      name: 'isolated-approved-write',
      prepare: async () => ({ accountId: 'fixture-account', version: 'fixture-version', context: null }),
      execute: async input => { await input.beforeSend(); executions++; if (uncertain) throw Error('isolated response lost'); return { providerObjectId: 'fixture-receipt', evidenceDigest: 'a'.repeat(64) } },
      lookup: async () => { lookups++; return { providerObjectId: 'fixture-receipt', evidenceDigest: 'a'.repeat(64) } },
    }
    const payload = () => ({ page_id: randomUUID(), text: 'Isolated database regression; no external effect.' })
    const actor = { userId: owner, sessionId: session }
    const drain = async () => { await Promise.all(queued.splice(0).map(work => work())) }
    const expected = (userId: string, id: string) => ({
      path: `/v1/live/${liveChannelId({ ownerId: userId, workspaceId: homes.get(userId)! })}/push`,
      events: [{ kind: 'approved_writes', id: homes.get(userId)! }, { kind: 'approved_write', id }],
    })
    for (const pool of pools) for (const [userId, sid] of [[owner, session], [other, otherSession]]) {
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Approved live fixture\',$2,true,now(),now())', [userId, `${userId}@example.invalid`])
      await pool.query('INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sid, userId, randomUUID()])
    }
    for (const [userId, workspaceId] of homes) {
      await database.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Approved live fixture\',\'personal\')', [workspaceId, userId])
      await database.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,\'Approved live fixture\',$3,\'admin\',\'active\')', [workspaceId, userId, `${userId}@example.invalid`])
    }

    await t.test('an actual proposal is invisible and silent until its authorized COMMIT; replay and reads are silent', async () => {
      const intent = randomUUID(), input = payload()
      let arrived!: () => void, release!: () => void, proposalId = ''
      const inserted = new Promise<void>(resolve => { arrived = resolve })
      const permitted = new Promise<void>(resolve => { release = resolve })
      const service = createApprovedWrites(database, provider, action, { actor, guard: async (tx: PoolClient, signal) => {
        const row = (await tx.query('SELECT id FROM pending_actions WHERE "intentKey"=$1', [intent])).rows[0]
        if (row) { proposalId = row.id; arrived(); await permitted }
        return { signal, async check() {}, async close() {} }
      } })
      const pending = service.propose(owner, input, intent)
      await inserted
      assert.equal((await database.query('SELECT id FROM pending_actions WHERE id=$1', [proposalId])).rowCount, 0)
      assert.equal(queued.length, 0); assert.equal(sent.length, 0)
      release(); const result = await pending
      assert.equal((await database.query('SELECT status FROM pending_actions WHERE id=$1', [proposalId])).rows[0].status, 'pending')
      assert.equal(queued.length, 1, 'real INSERT must schedule after COMMIT')
      await drain(); assert.deepEqual(sent, [expected(owner, result.actionId)])
      const before = sent.length
      await service.propose(owner, input, intent); await service.view(actor, result.actionId); await drain()
      assert.equal(sent.length, before)
    })

    await t.test('the actual authorization rollback discards the inserted proposal and its notification', async () => {
      const intent = randomUUID(), before = sent.length
      const service = createApprovedWrites(database, provider, action, { actor, guard: async (tx: PoolClient) => {
        if ((await tx.query('SELECT id FROM pending_actions WHERE "intentKey"=$1', [intent])).rowCount) throw Error('fixture authorization refused')
        return { async check() {}, async close() {} }
      } })
      await assert.rejects(service.propose(owner, payload(), intent), /fixture authorization refused/)
      assert.equal((await database.query('SELECT id FROM pending_actions WHERE "intentKey"=$1', [intent])).rowCount, 0)
      assert.equal(queued.length, 0); await drain(); assert.equal(sent.length, before)
    })

    await t.test('decline and ledger completion wake the same proposal without resending an uncertain external operation', async () => {
      const service = createApprovedWrites(database, provider, action, { actor })
      const declined = await service.propose(owner, payload(), randomUUID()); await drain()
      const beforeDecline = sent.length
      assert.equal((await service.decide(actor, declined.actionId, false)).status, 'declined')
      await drain(); assert.deepEqual(sent.slice(beforeDecline), [expected(owner, declined.actionId)])
      const active = await service.propose(owner, payload(), randomUUID()); await drain()
      uncertain = true
      assert.equal((await service.decide(actor, active.actionId, true)).status, 'running')
      await drain(); const beforeRecovery = sent.length
      assert.equal((await service.view(actor, active.actionId)).status, 'running')
      assert.equal((await service.decide(actor, active.actionId, true)).status, 'done')
      await drain(); assert.deepEqual(sent.slice(beforeRecovery), [expected(owner, active.actionId)])
      assert.equal(executions, 1); assert.equal(lookups, 1)
      assert.equal((await service.view(actor, active.actionId)).status, 'done')
      uncertain = false
    })

    await t.test('another owner receives only their own personal key; revoked membership is rechecked after scheduling', async () => {
      await drain()
      const otherActor = { userId: other, sessionId: otherSession }, service = createApprovedWrites(database, provider, action, { actor: otherActor })
      const before = sent.length, result = await service.propose(other, payload(), randomUUID())
      await drain(); assert.deepEqual(sent.slice(before), [expected(other, result.actionId)])
      await assert.rejects(service.view(actor, result.actionId), /pendingActionUnavailable/)
      const suspended = await service.propose(other, payload(), randomUUID())
      await database.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [homes.get(other), other])
      const beforeDrain = sent.length; await drain(); assert.equal(sent.length, beforeDrain)
      assert.ok(suspended.actionId)
      await database.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [homes.get(other), other])
    })

    await t.test('a delayed callback retains its request database even when the default DB has the same proposal ID for another owner', async () => {
      await drain()
      const intent = randomUUID(), before = sent.length
      const service = createApprovedWrites(requestDatabase, provider, action, { actor, guard: async (tx: PoolClient) => {
        const row = (await tx.query('SELECT to_jsonb(p) AS value FROM pending_actions p WHERE "intentKey"=$1', [intent])).rows[0]?.value
        if (row) { row.userId = other; await database.query('INSERT INTO pending_actions SELECT * FROM jsonb_populate_record(NULL::pending_actions,$1) ON CONFLICT DO NOTHING', [row]) }
        return { async check() {}, async close() {} }
      } })
      const result = await scoped.run(() => service.propose(owner, payload(), intent))
      assert.equal(queued.length, 1)
      await drain() // Deliberately outside the originating request context.
      assert.deepEqual(sent.slice(before), [expected(owner, result.actionId)])
      assert.equal((await database.query('SELECT "userId" FROM pending_actions WHERE id=$1', [result.actionId])).rows[0].userId, other)
    })
  } finally {
    queued.splice(0)
    await requestScope?.close()
    globals.mikkaPool = previousPools.app; globals.workspacePool = previousPools.workspace
    for (let index = 0; index < pools.length; index++) await dropTestDatabase(admin, names[index], pools[index])
    await admin.end(); scheduler.restore()
    if (priorConfig.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = priorConfig.url
    if (priorConfig.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = priorConfig.secret
    receiver.close(); await once(receiver, 'close')
  }
})
