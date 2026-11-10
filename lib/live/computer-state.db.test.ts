import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { isolatedPostgresURL } from '../../tests/helpers/isolated-postgres.mjs'
import { observePoolCommits } from '../db/commit-effects'
import { liveChannelId } from './scope'
import type { LocalComputerRequest } from '@mikka/protocol/computer'
import type * as Provider from '../computer/e2b-provider'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'actual isolated PostgreSQL required')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')
const scheduled: (() => Promise<void>)[] = []
mock.module('next/server', { namedExports: { after: (work: () => Promise<void>) => { scheduled.push(work) } } })
let ComputerStore: typeof import('../computer/store')['ComputerStore']
let syncComputerReviews: typeof import('../computer/reviews')['syncComputerReviews']
let decideComputerReview: typeof import('../computer/reviews')['decideComputerReview']
let reconcileCloudMachines: typeof import('../computer/reconcile')['reconcileCloudMachines']
let computerChanged: typeof import('./computer-state')['computerChanged']
let computerLiveTargets: typeof import('./computer-state')['computerLiveTargets']

async function loadRuntime() {
  ;({ ComputerStore } = await import('../computer/store'))
  ;({ syncComputerReviews, decideComputerReview } = await import('../computer/reviews'))
  ;({ reconcileCloudMachines } = await import('../computer/reconcile'))
  ;({ computerChanged, computerLiveTargets } = await import('./computer-state'))
}

after(() => mock.restoreAll())

test('real PG: computer changes publish committed owner state without heartbeat polling', { skip: !url, timeout: 120_000 }, async t => {
  const connectionString = await isolatedPostgresURL(url!)
  const admin = new Pool({ connectionString })
  const schema = `computer_live_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const database = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 })
  const reader = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 })
  // P2 notification authority uses the canonical APP and Workspace modules.
  // Both real pools must target this isolated schema before any runtime opens them.
  const [{ pool: applicationPool }, { workspacePool }] = await Promise.all([import('../db'), import('../workspace-db')])
  assert.equal(applicationPool.totalCount, 0)
  assert.equal(workspacePool.totalCount, 0)
  const previousPools = [applicationPool, workspacePool].map(pool => ({ connectionString: pool.options.connectionString, options: pool.options.options, max: pool.options.max }))
  for (const pool of [applicationPool, workspacePool]) Object.assign(pool.options, { connectionString, options: `-c search_path=${schema}`, max: 1 })
  await loadRuntime()
  observePoolCommits(database)
  const received: { channel: string; events: { kind: string; id: string }[] }[] = []
  const errors: unknown[] = []
  // The same gateway also receives device wakes (#1212): a decided review wakes its daemon.
  const deviceWakes: string[] = []
  const server = createServer(async (request, response) => {
    try {
      let text = ''
      for await (const chunk of request) text += chunk.toString()
      assert.equal(request.headers.authorization, 'Bearer fixture-only-live-secret')
      const wake = /^\/v1\/devices\/([^/]+)\/push$/.exec(request.url ?? '')
      if (wake) { assert.equal(text, ''); deviceWakes.push(wake[1]); response.writeHead(204).end(); return }
      const events = JSON.parse(text)
      for (const event of events) {
        assert.deepEqual(Object.keys(event).sort(), ['id', 'kind'])
        assert.equal(event.kind, 'computer_state')
        assert.ok((await reader.query('SELECT id FROM bots WHERE id=$1', [event.id])).rowCount, 'another connection observes the committed Bot')
      }
      received.push({ channel: request.url!, events })
      response.writeHead(204).end()
    } catch (error) { errors.push(error); response.writeHead(500).end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'fixture-only-live-secret'
  const drain = async () => { while (scheduled.length) await scheduled.shift()!(); assert.deepEqual(errors, []) }
  const clear = async () => { await drain(); received.length = 0 }
  const actor = { userId: 'computer-owner', workspaceId: randomUUID() }
  const peer = { ...actor, userId: 'computer-peer' }
  const other = { ...actor, workspaceId: randomUUID() }
  const botId = randomUUID(), peerBot = randomUUID(), otherBot = randomUUID(), deviceId = randomUUID(), runId = randomUUID()
  let providerState: 'running' | 'sleeping' = 'running', failSync = false
  let providerExpires = new Date(Date.now() + 900_000)
  let providerReads = 0
  const runtime = {
    async createComputer() { return { sandboxId: 'fixture-computer' } },
    async connectComputer(_workspace: string, sandboxId: string) { return { sandboxId } },
    async computerState(_workspace: string, _sandbox: string, observed?: (expiresAt: Date) => void) {
      providerReads++; if (providerState === 'running') observed?.(providerExpires); return providerState
    },
    async installComputerRuntime() {}, async startDesktop() {},
    async syncDesktopLease() { if (failSync) throw new Error('fixture sync failed') },
    async viewerGrant() { return { url: 'wss://fixture.invalid', expiresAt: new Date(Date.now() + 90_000).toISOString() } },
  } as unknown as typeof Provider
  const store = new ComputerStore(database, runtime)
  const snapshot = (id = randomUUID(), selectedRun = runId): LocalComputerRequest => {
    const value = { id, runId: selectedRun, target: 'a'.repeat(64), display: ':1', call: { name: 'click' as const, arguments: { x: 12, y: 20 } }, expiresAt: Date.now() + 120_000 }
    return { ...value, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
  }
  try {
    await database.query('CREATE TABLE "user" (id text PRIMARY KEY)')
    await database.query('INSERT INTO "user" VALUES ($1),($2)', [actor.userId, peer.userId])
    for (const name of ['20261027164501_cloud_computers.sql', '20261029080001_owner_cloud_machines.sql']) {
      await database.query(await readFile(new URL('../../drizzle/' + name, import.meta.url), 'utf8'))
    }
    await database.query(`CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,"userId" text NOT NULL REFERENCES "user"(id),kind text NOT NULL CHECK (kind IN ('personal','team')));
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,status text,PRIMARY KEY("workspaceId","userId"));
      CREATE TABLE session (id text PRIMARY KEY,"userId" text NOT NULL REFERENCES "user"(id),"expiresAt" timestamptz NOT NULL,
        "enterpriseOrganizationId" uuid,"enterpriseProviderId" text,"enterpriseDirectoryUserId" text,"enterpriseIdentityId" text);
      CREATE TABLE workspace_computer_policies ("workspaceId" uuid PRIMARY KEY,permission text,version integer NOT NULL DEFAULT 0,"updatedAt" timestamptz);
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,enabled boolean NOT NULL DEFAULT true);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,status text,"leaseExpiresAt" timestamptz,
        "stopRequestedAt" timestamptz,"updatedAt" timestamptz,"finishedAt" timestamptz,"resumeStatus" text,"pauseReason" text,
        "botId" uuid,"machineAuthority" boolean NOT NULL DEFAULT false,cli_policy_hierarchy jsonb,"workspaceId" uuid);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY REFERENCES agent_runs(id),"botId" uuid,"ownerId" text,"workspaceId" uuid,
        "approvedForRun" boolean NOT NULL DEFAULT false,FOREIGN KEY ("botId","workspaceId","ownerId") REFERENCES bots(id,"workspaceId","ownerId"));
      CREATE TABLE thread_machines ("runId" uuid PRIMARY KEY,"botId" uuid,"ownerId" text,"workspaceId" uuid,"deviceId" uuid,state text,"sandboxId" text,epoch integer);`)
    await database.query(await readFile(new URL('../../drizzle/20261027164510_local_computer_reviews.sql', import.meta.url), 'utf8'))
    for (const name of ['20261109035020_organization_governance.sql', '20261109035023_enterprise_live_session_authority.sql']) {
      await database.query(await readFile(new URL('../../drizzle/' + name, import.meta.url), 'utf8'))
    }
    await database.query('INSERT INTO mikka_workspaces(id,"userId",kind) VALUES ($1,$2,\'team\'),($3,$2,\'team\')', [actor.workspaceId, actor.userId, other.workspaceId])
    await database.query('INSERT INTO mikka_workspace_members VALUES ($1,$2,\'active\'),($1,$3,\'active\'),($4,$2,\'active\')',
      [actor.workspaceId, actor.userId, peer.userId, other.workspaceId])
    await database.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,\'Owner\'),($4,$2,$5,\'Peer\'),($6,$7,$3,\'Other\')',
      [botId, actor.workspaceId, actor.userId, peerBot, peer.userId, otherBot, other.workspaceId])
    await database.query('INSERT INTO devices(id,"ownerId") VALUES ($1,$2)', [deviceId, actor.userId])
    await database.query('INSERT INTO agent_runs(id,"userId","deviceId",status,"leaseExpiresAt","workspaceId") VALUES($1,$2,$3,\'running\',now()+interval \'1 hour\',$4)', [runId, actor.userId, deviceId, actor.workspaceId])
    await database.query('INSERT INTO computer_run_bindings("runId","botId","ownerId","workspaceId") VALUES($1,$2,$3,$4)', [runId, botId, actor.userId, actor.workspaceId])

    await t.test('cold wake and takeover notify only the owned machine after real commits', async () => {
      await store.operate(actor, botId, 'takeover')
      await drain()
      assert.ok(received.length > 0)
      assert.ok(received.every(item => item.channel === `/v1/live/${liveChannelId({ ownerId: actor.userId, workspaceId: actor.workspaceId })}/push`))
      assert.ok(received.flatMap(item => item.events).every(event => event.id === botId))
      assert.equal((await reader.query('SELECT control FROM bot_desktops WHERE "botId"=$1', [botId])).rows[0].control, 'user')
      const state = await store.state(actor, botId)
      assert.equal(state.control, 'user')
      assert.equal(state.live?.workspaceId, actor.workspaceId)
      const until = (await reader.query('SELECT "controlUntil" FROM bot_desktops WHERE "botId"=$1', [botId])).rows[0].controlUntil
      assert.equal(state.live?.deadline?.at, until.toISOString())
      assert.ok(state.live!.deadline!.afterMs > 290_000 && state.live!.deadline!.afterMs <= 300_000)
    })

    await t.test('outer rollback and rolled-back savepoints publish nothing', async () => {
      await clear()
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        await client.query('UPDATE bot_desktops SET control=\'agent\' WHERE "botId"=$1', [botId])
        await computerChanged(client, database, botId)
        assert.equal(scheduled.length, 0)
        assert.equal((await reader.query('SELECT control FROM bot_desktops WHERE "botId"=$1', [botId])).rows[0].control, 'user')
        await client.query('ROLLBACK')
        await drain(); assert.equal(received.length, 0)
        await client.query('BEGIN'); await client.query('SAVEPOINT discarded')
        await computerChanged(client, database, botId)
        await client.query('ROLLBACK TO SAVEPOINT discarded'); await client.query('COMMIT')
        await drain(); assert.equal(received.length, 0)
      } finally { client.release() }
    })

    await t.test('a policy provider failure rolls back the write and produces no invalidation', async () => {
      await clear(); failSync = true
      try { await assert.rejects(store.setPolicy(actor.workspaceId, 'deny'), /fixture sync failed/) }
      finally { failSync = false }
      await drain()
      assert.equal(received.length, 0)
      assert.equal((await database.query('SELECT permission FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rowCount, 0)
    })

    await t.test('new and reappearing cloud approvals notify; unchanged seenAt heartbeats do not', async () => {
      await clear()
      const request = snapshot()
      await syncComputerReviews(database, deviceId, actor.userId, [request]); await drain()
      assert.equal(received.length, 1); assert.equal(received[0].events[0].id, botId)
      const state = await store.state(actor, botId)
      assert.equal(state.pendingApproval?.id, request.id)
      const observed = (await database.query('SELECT "seenAt"+interval \'10 seconds\' AS expires FROM local_computer_reviews WHERE id=$1', [request.id])).rows[0].expires
      assert.equal(state.live?.deadline?.at, observed.toISOString())
      assert.ok(state.live!.deadline!.afterMs > 8_000 && state.live!.deadline!.afterMs <= 10_000)
      await clear()
      await syncComputerReviews(database, deviceId, actor.userId, [request]); await drain()
      assert.equal(received.length, 0, 'a one-second freshness heartbeat does not cause a page read')
      await database.query('UPDATE local_computer_reviews SET "seenAt"=now()-interval \'11 seconds\' WHERE id=$1', [request.id])
      await syncComputerReviews(database, deviceId, actor.userId, [request]); await drain()
      assert.equal(received.length, 1)
    })

    await t.test('a later invalid snapshot rolls back the earlier pending approval and its effect', async () => {
      await clear()
      const first = snapshot(), invalid = snapshot(randomUUID(), randomUUID())
      await assert.rejects(syncComputerReviews(database, deviceId, actor.userId, [first, invalid]), /Run or desktop unavailable/)
      await drain()
      assert.equal(received.length, 0)
      assert.equal((await database.query('SELECT id FROM local_computer_reviews WHERE id=$1', [first.id])).rowCount, 0)
    })

    await t.test('decisions and withdrawal refresh the matching Bot; replay and foreign owners do not', async () => {
      await clear()
      const request = snapshot()
      await syncComputerReviews(database, deviceId, actor.userId, [request]); await clear()
      deviceWakes.length = 0
      assert.equal(await decideComputerReview(database, peer, request.id, request.digest, false), false)
      assert.equal(await decideComputerReview(database, other, request.id, request.digest, false), false)
      await drain(); assert.equal(received.length, 0)
      assert.deepEqual(deviceWakes, [], 'a refused decision wakes no device')
      assert.equal(await decideComputerReview(database, actor, request.id, request.digest, false), true)
      await drain(); assert.equal(received.length, 1)
      for (let i = 0; i < 100 && !deviceWakes.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
      assert.deepEqual(deviceWakes, [deviceId], 'the decision wakes the daemon showing the review')
      assert.equal((await store.state(actor, botId)).pendingApproval, undefined)
      await clear()
      assert.equal(await decideComputerReview(database, actor, request.id, request.digest, true), false)
      await drain(); assert.equal(received.length, 0)
      const next = snapshot()
      await syncComputerReviews(database, deviceId, actor.userId, [next]); await clear()
      await syncComputerReviews(database, deviceId, actor.userId, []); await drain()
      assert.equal(received.length, 1)
      assert.equal((await store.state(actor, botId)).pendingApproval, undefined)
    })

    await t.test('the earliest actual approval expiry and run lease bound the server projection', async () => {
      await clear()
      const request = snapshot()
      await syncComputerReviews(database, deviceId, actor.userId, [request]); await clear()
      const lease = new Date(Date.now() + 3_000)
      await database.query('UPDATE agent_runs SET "leaseExpiresAt"=$2 WHERE id=$1', [runId, lease])
      assert.equal((await store.state(actor, botId)).live?.deadline?.at, lease.toISOString())
      await database.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1', [runId])
      assert.equal((await store.state(actor, botId)).pendingApproval, undefined)
      await database.query('UPDATE agent_runs SET "leaseExpiresAt"=now()+interval \'1 hour\' WHERE id=$1', [runId])
      await database.query('UPDATE local_computer_reviews SET "expiresAt"=$2 WHERE id=$1', [request.id, lease])
      assert.equal((await store.state(actor, botId)).live?.deadline?.at, lease.toISOString())
      await database.query('UPDATE local_computer_reviews SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [request.id])
      assert.equal((await store.state(actor, botId)).pendingApproval, undefined)
      await syncComputerReviews(database, deviceId, actor.userId, []); await clear()
    })

    await t.test('handback and server-observed provider expiry refresh without guessing a local state', async () => {
      await clear()
      await store.operate(actor, botId, 'handback'); await drain()
      assert.ok(received.length > 0)
      providerExpires = new Date(Date.now() + 60_000)
      const beforeReads = providerReads
      const running = await store.state(actor, botId)
      assert.equal(running.machine, 'running')
      assert.equal(running.control, 'agent')
      assert.equal(running.live?.deadline?.at, providerExpires.toISOString())
      assert.equal(providerReads, beforeReads + 1, 'the deadline comes from an actual provider observation')
      providerState = 'sleeping'
      const sleeping = await store.state(actor, botId)
      assert.equal(sleeping.machine, 'sleeping')
      assert.equal(sleeping.live?.deadline, undefined, 'a sleeping computer has no periodic read deadline')
      providerState = 'running'
    })

    await t.test('actual reconciliation and provider failure publish durable machine changes', async () => {
      await clear()
      await database.query('UPDATE cloud_machines SET "lastActiveAt"=now()-interval \'2 hours\' WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId, actor.userId])
      assert.equal(await reconcileCloudMachines(database, async () => 'sleeping'), 1)
      await drain(); assert.equal(received.length, 1)
      assert.equal((await reader.query('SELECT state FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId, actor.userId])).rows[0].state, 'sleeping')
      await clear(); failSync = true
      try { await assert.rejects(store.operate(actor, botId, 'takeover'), /fixture sync failed/) }
      finally { failSync = false }
      await drain(); assert.ok(received.length > 0)
      assert.equal((await reader.query('SELECT state FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId, actor.userId])).rows[0].state, 'error')
    })

    await t.test('active membership and persisted owner/workspace partition notifications', async () => {
      await clear()
      assert.deepEqual((await computerLiveTargets(database, database, { botId: botId }))[0].scope, { ownerId: actor.userId, workspaceId: actor.workspaceId })
      assert.deepEqual(await computerLiveTargets(database, database, { ownerId: peer.userId, workspaceId: other.workspaceId }), [])
      await database.query('UPDATE mikka_workspace_members SET status=\'removed\' WHERE "workspaceId"=$1 AND "userId"=$2', [actor.workspaceId, actor.userId])
      const client = await database.connect()
      try { await client.query('BEGIN'); await computerChanged(client, database, botId); await client.query('COMMIT') } finally { client.release() }
      await drain(); assert.equal(received.length, 0)
      const otherTarget = await computerLiveTargets(database, database, { ownerId: actor.userId, workspaceId: other.workspaceId })
      assert.equal(otherTarget.length, 1); assert.deepEqual(otherTarget[0].events, [{ kind: 'computer_state', id: otherBot }])
    })
  } finally {
    scheduled.length = 0
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.all([applicationPool.end(), workspacePool.end()])
    for (const [index, pool] of [applicationPool, workspacePool].entries()) Object.assign(pool.options, previousPools[index])
    await database.end(); await reader.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end()
  }
})
