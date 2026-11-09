import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { after, before, mock, test } from 'node:test'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { captureDatabaseQuery, observePoolCommits } from '../db/commit-effects'
import { groupListTargets, issueListTargets, issueListScopesBeforeChange, issueListScopeChanged, ownerListTargets, ownerSettingsTargets, runListChanged, runListTargets, workspaceListTargets } from './lists'
import { liveChannelId, type LiveScope } from './scope'
import type { LiveInvalidation } from './events'
import { isolateCoordinatorWakes } from '../../tests/support/coordinator-wake'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'actual isolated PostgreSQL required')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')
const scheduled: (() => Promise<void>)[] = []
mock.module('next/server', { namedExports: { after: (work: () => Promise<void>) => { scheduled.push(work) } } })
// The same writers also wake task/thread detail panels with their run, thread
// or document IDs, bot chats with their bot IDs and group pages with their group
// IDs; panels.db.test.ts, chats.db.test.ts and groups.db.test.ts cover those keys.
// Here count list keys only.
before(async () => {
  for (const file of ['./panels.ts', './chats.ts', './groups.ts']) {
    const actual = await import(file)
    mock.module(new URL(file, import.meta.url).href, { namedExports: Object.fromEntries(Object.entries(actual).map(([name, value]) =>
      [name, name.endsWith('ScopesBeforeChange') ? async () => [] : name.endsWith('Changed') ? async () => {} : value])) })
  }
})
after(() => mock.restoreAll())

test('real PG: lists retain their reader scope and publish only the originating committed writes', { skip: !url, timeout: 180_000 }, async t => {
  // Observe the writer's notifications only. A Coordinator wake can otherwise
  // create its personal Bot and backfill old rows, producing unrelated lists.
  const coordinator = await isolateCoordinatorWakes(t)
  const admin = new Pool({ connectionString: url, max: 1 })
  const names = [0, 1].map(() => `list_live_${randomUUID().replaceAll('-', '')}_e2e`)
  for (const name of names) await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
  const urls = names.map(name => { const value = new URL(url!); value.pathname = `/${name}`; return value.toString() })
  const database = new Pool({ connectionString: urls[0], max: 6 })
  const foreign = new Pool({ connectionString: urls[1], max: 4 })
  observePoolCommits(database); observePoolCommits(foreign)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = database
  const { pool, db, createRequestDatabaseScope, withDatabaseClient, withDatabaseTransaction } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(urls[0]), wrongScope = createRequestDatabaseScope(urls[1])
  const home = randomUUID(), team = randomUUID(), foreignHome = randomUUID(), inactiveHome = randomUUID()
  const issueId = randomUUID(), runId = randomUUID(), foreignRunId = randomUUID(), groupId = randomUUID()
  const personalIssueId = randomUUID(), unlinkedIssueId = randomUUID(), policyIssueId = randomUUID()
  const channels = new Map<string, LiveScope>()
  for (const ownerId of ['owner', 'peer', 'foreign', 'inactive', 'no-home']) for (const workspaceId of [home, team, foreignHome, inactiveHome]) {
    const value = { ownerId, workspaceId }; channels.set(`/v1/live/${liveChannelId(value)}/push`, value)
  }
  let observedRunId = runId
  const received: { scope: LiveScope; events: LiveInvalidation[]; committedStatus: string | null }[] = []
  const errors: unknown[] = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer fixture-only-list-live')
      const target = channels.get(request.url!); assert.ok(target, 'only a known fixture scope may receive a key')
      let body = ''; for await (const chunk of request) body += chunk.toString()
      const events: LiveInvalidation[] = wireKeys(JSON.parse(body))
      for (const event of events) {
        assert.equal(event.id, target.workspaceId, 'list events never expose a run, Bot, issue or group ID')
      }
      const row = await database.query('SELECT status FROM agent_runs WHERE id=$1', [observedRunId])
      received.push({ scope: target, events, committedStatus: row.rows[0]?.status ?? null })
      response.writeHead(204).end()
    } catch (error) { errors.push(error); response.writeHead(500).end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'fixture-only-list-live'
  const drain = async () => { await coordinator.flush(); while (scheduled.length) await scheduled.shift()!(); assert.deepEqual(errors, []) }
  const clear = async () => { await drain(); received.length = 0 }
  try {
    const directory = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) {
      const migration = await readFile(new URL(name, directory), 'utf8')
      await database.query(migration); await foreign.query(migration)
    }
    for (const target of [database, foreign]) for (const owner of ['owner', 'peer', 'foreign', 'inactive', 'no-home']) {
      await target.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||'@list.example.invalid',true,now(),now())`, [owner])
    }
    for (const [id, owner, kind] of [[home, 'owner', 'personal'], [team, 'owner', 'team'], [foreignHome, 'foreign', 'personal'], [inactiveHome, 'inactive', 'personal']]) {
      await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,'Fixture',$3)`, [id, owner, kind])
    }
    for (const [workspace, owner, status] of [[home, 'owner', 'active'], [home, 'peer', 'active'], [team, 'owner', 'active'], [team, 'peer', 'active'], [team, 'foreign', 'active'], [team, 'inactive', 'suspended'], [team, 'no-home', 'active'], [foreignHome, 'foreign', 'active'], [inactiveHome, 'inactive', 'suspended']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member',$3)`, [workspace, owner, status])
    }
    const ownerAgent = randomUUID(), foreignAgent = randomUUID()
    await database.query(`INSERT INTO agents(id,"userId",name,harness) VALUES($1,'owner','Fixture','codex'),($2,'foreign','Fixture','codex')`, [ownerAgent, foreignAgent])
    await foreign.query(`INSERT INTO agents(id,"userId",name,harness) VALUES($1,'foreign','Other source','codex')`, [foreignAgent])
    for (const target of [database, foreign]) await target.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",title,content,status,priority,scope) VALUES($1,'owner',$2,'bound','Fixture','{"type":"doc","content":[]}','todo','normal','workspace')`, [issueId, team])
    await database.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,'owner')`, [issueId, randomUUID(), team])
    await database.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",title,content,status,priority,scope) VALUES
      ($1,'owner',$4,'bound','Personal','{"type":"doc","content":[]}','todo','normal','personal'),
      ($2,'owner',$5,'bound','Unlinked','{"type":"doc","content":[]}','todo','normal','workspace'),
      ($3,'owner',$5,'bound','Sync policy','{"type":"doc","content":[]}','todo','normal','workspace')`, [personalIssueId, unlinkedIssueId, policyIssueId, home, team])
    await database.query(`UPDATE issues SET "linearSyncPolicy"='explicit',"linearSyncBlocked"=false WHERE id=$1`, [policyIssueId])
    await database.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,'owner')`, [policyIssueId, randomUUID(), team])
    await database.query(`INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId",status,prompt) VALUES($1,'owner',$6,$2,$3,'running','Fixture'),($4,'foreign',$6,$2,$5,'running','Fixture')`, [runId, issueId, ownerAgent, foreignRunId, foreignAgent, team])
    // Same UUID, different owner in an actual second database: losing the
    // originating request would publish to a different valid channel.
    await foreign.query(`INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId",status,prompt) VALUES($1,'foreign',$4,$2,$3,'running','Other database')`, [runId, issueId, foreignAgent, team])
    await database.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy") VALUES($1,$2,'group','Private fixture','owner')`, [groupId, team])
    await database.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,'user','owner','owner'),($1,'user','peer','member')`, [groupId])

    await t.test('run lists use their persisted tenant; account-wide lists retain the verified home', async () => {
      assert.deepEqual(await runListTargets(database, database, runId), [{ scope: { ownerId: 'owner', workspaceId: team }, events: [{ kind: 'thread_list', id: team }, { kind: 'task_run_list', id: team }] }])
      assert.deepEqual(await runListTargets(database, database, foreignRunId), [{ scope: { ownerId: 'foreign', workspaceId: team }, events: [{ kind: 'thread_list', id: team }, { kind: 'task_run_list', id: team }] }])
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team])
      try { assert.deepEqual(await runListTargets(database, database, runId), [], 'revoked membership never falls back to the owner personal channel') }
      finally { await database.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team]) }
      const before = (await database.query('SELECT count(*)::integer AS n FROM mikka_workspaces')).rows[0].n
      assert.deepEqual(await ownerListTargets(database, 'no-home', ['thread_list']), [])
      assert.deepEqual(await ownerListTargets(database, 'inactive', ['bot_chat_list']), [])
      assert.deepEqual(await ownerListTargets(database, 'peer', ['thread_list']), [], 'membership in another owner home never substitutes for an owned home')
      assert.equal((await database.query('SELECT count(*)::integer AS n FROM mikka_workspaces')).rows[0].n, before, 'notifications never create a workspace')
    })

    await t.test('workspace lists use active members; a private group does not notify unrelated members', async () => {
      const workspace = await workspaceListTargets(database, team, ['workspace_settings'])
      assert.deepEqual(new Set(workspace.map(value => value.scope.ownerId)), new Set(['owner', 'peer', 'foreign', 'no-home']))
      assert.deepEqual(new Set((await groupListTargets(database, database, groupId)).map(value => value.scope.ownerId)), new Set(['owner', 'peer']))
      await database.query(`UPDATE conversation_members SET "leftAt"=now() WHERE "conversationId"=$1 AND "memberId"='peer'`, [groupId])
      assert.deepEqual((await groupListTargets(database, database, groupId)).map(value => value.scope.ownerId), ['owner'])
      const clearing = await groupListTargets(database, database, groupId, 'peer')
      assert.deepEqual(new Set(clearing.map(value => value.scope.ownerId)), new Set(['owner', 'peer']))
      assert.ok(clearing.every(value => value.events.every(event => event.kind === 'group_list' && event.id === team)))
      assert.deepEqual((await groupListTargets(database, database, groupId, 'foreign')).map(value => value.scope.ownerId), ['owner'], 'a caller cannot invent prior group membership')
    })

    await t.test('模型与订阅 pushes model_settings to the account in its workspaces, and to teammates only where it shares', async () => {
      const audience = async () => (await ownerSettingsTargets(database, database, 'owner')).map(value => `${value.scope.ownerId}@${value.scope.workspaceId === home ? 'home' : 'team'}:${value.events.map(event => event.kind).join(',')}`).sort()
      // Not shared: only the account itself, in each workspace it is an active member of; never the app-wide workspace_settings.
      assert.deepEqual(await audience(), ['owner@home:model_settings', 'owner@team:model_settings'])
      // 分享我的订阅给团队成员 on in the team: its active members too (not the suspended one, not the home's peer).
      await database.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ('owner',$1,true)`, [team])
      assert.deepEqual(await audience(), ['foreign@team:model_settings', 'no-home@team:model_settings', 'owner@home:model_settings', 'owner@team:model_settings', 'peer@team:model_settings'])
      // An admin who does not allow sharing subscriptions: back to the account alone.
      await database.query(`INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)`, [team])
      assert.deepEqual(await audience(), ['owner@home:model_settings', 'owner@team:model_settings'])
      await database.query('DELETE FROM workspace_personal_policies WHERE "workspaceId"=$1', [team])
      await database.query('DELETE FROM workspace_subscription_shares WHERE "ownerId"=\'owner\'')
      assert.deepEqual(await ownerSettingsTargets(database, database, 'no-such-account'), [])
    })

    await t.test('issue lists follow the task tenant without a Team link; body saves do not invalidate unrelated chat/run summaries', async () => {
      const linked = await issueListTargets(database, database, issueId)
      assert.deepEqual(new Set(linked.filter(value => value.events.some(event => event.kind === 'issue_list')).map(value => value.scope.ownerId)), new Set(['owner', 'peer', 'foreign', 'no-home']))
      assert.ok(linked.every(value => value.events.every(event => event.kind === 'issue_list')))
      assert.deepEqual(await issueListTargets(database, database, personalIssueId), [
        { scope: { ownerId: 'owner', workspaceId: home }, events: [{ kind: 'issue_list', id: home }] },
      ])
      const unlinked = await issueListTargets(database, database, unlinkedIssueId)
      assert.deepEqual(new Set(unlinked.map(value => value.scope.ownerId)), new Set(['owner', 'peer', 'foreign', 'no-home']))
      assert.ok(unlinked.every(value => value.scope.workspaceId === team && value.events.every(event => event.kind === 'issue_list' && event.id === team)))
      const renamed = await issueListTargets(database, database, issueId, true)
      assert.deepEqual(new Set(renamed.filter(value => value.events.some(event => event.kind === 'task_run_list')).map(value => value.scope.ownerId)), new Set(['owner', 'foreign']))
      assert.deepEqual(new Set(renamed.filter(value => value.events.some(event => event.kind === 'bot_chat_list')).map(value => value.scope.ownerId)), new Set(['owner', 'foreign']), 'only actual owned personal scopes route the derived previews')
    })

    await t.test('sync-policy changes retain the task tenant and recheck members at delivery, while former members clear only their own previews', async () => {
      await clear()
      const beforeTransfer = (await database.query('SELECT * FROM issues WHERE id=$1', [policyIssueId])).rows[0]
      await assert.rejects(database.query('UPDATE issues SET "workspaceId"=$2 WHERE id=$1', [policyIssueId, home]), /taskWorkspaceTransferDenied/)
      assert.deepEqual((await database.query('SELECT * FROM issues WHERE id=$1', [policyIssueId])).rows[0], beforeTransfer)
      assert.equal(scheduled.length, 0)
      const client = await scope.run(() => pool.connect())
      try {
        await client.query('BEGIN')
        await scope.run(() => withDatabaseClient(client, async () => {
          const { rows: [locked] } = await client.query('SELECT id,"userId",scope,"workspaceId" FROM issues WHERE id=$1 FOR UPDATE', [policyIssueId])
          const previousLists = await issueListScopesBeforeChange(locked)
          await client.query(`UPDATE issues SET "linearSyncPolicy"='disabled',"linearSyncBlocked"=true,"scopeSetBy"='user' WHERE id=$1`, [policyIssueId])
          await issueListScopeChanged(client, policyIssueId, previousLists)
        }))
        assert.equal(scheduled.length, 0)
        // The former member retains their own home but loses this workspace.
        await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='foreign'`, [team])
        await wrongScope.run(() => client.query('COMMIT'))
        assert.deepEqual((await database.query('SELECT "workspaceId",scope,"linearSyncPolicy" FROM issues WHERE id=$1', [policyIssueId])).rows, [{ workspaceId: team, scope: 'workspace', linearSyncPolicy: 'disabled' }])
        await wrongScope.run(drain)
        const oldLists = received.filter(value => value.scope.workspaceId === team && value.events.some(event => event.kind === 'issue_list'))
        assert.deepEqual(new Set(oldLists.map(value => value.scope.ownerId)), new Set(['owner', 'peer', 'no-home']))
        assert.ok(received.every(value => !value.events.some(event => event.kind === 'issue_list') || value.scope.workspaceId === team), 'disabling provider sync never moves issue-list invalidations to a personal tenant')
        assert.ok(received.some(value => value.scope.ownerId === 'owner' && value.scope.workspaceId === home && value.events.some(event => event.kind === 'bot_chat_list')))
        assert.deepEqual(received.filter(value => value.scope.ownerId === 'foreign'), [
          { scope: { ownerId: 'foreign', workspaceId: foreignHome }, events: [{ kind: 'bot_chat_list', id: foreignHome }], committedStatus: 'running' },
        ], 'clearing a former citation carries only the former member’s own list key')
      } finally {
        await client.query('ROLLBACK'); client.release()
        await database.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='foreign'`, [team])
      }
    })

    await t.test('a held client publishes after COMMIT even when commit and delivery run in another database context', async () => {
      await clear()
      const client = await scope.run(() => pool.connect())
      try {
        await client.query('BEGIN')
        const retained = scope.run(() => withDatabaseClient(client, () => captureDatabaseQuery(pool)))
        await retained.query(`UPDATE agent_runs SET status='waiting_input' WHERE id=$1`, [runId])
        await runListChanged(retained, runId)
        assert.equal(scheduled.length, 0)
        assert.equal((await database.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status, 'running')
        await wrongScope.run(() => client.query('COMMIT'))
        assert.equal(scheduled.length, 2, 'list and project-map invalidations each defer until COMMIT')
      } finally { client.release() }
      await wrongScope.run(drain)
      assert.equal(received.length, 1)
      assert.deepEqual(received[0].scope, { ownerId: 'owner', workspaceId: team })
      assert.equal(received[0].committedStatus, 'waiting_input', 'a different PG connection observes the committed change before HTTP delivery')
    })

    await t.test('outer rollback and rolled-back nested savepoints never publish a list key', async () => {
      await clear()
      await assert.rejects(scope.run(() => db.transaction(outer => withDatabaseTransaction(outer, async () => {
        await outer.execute(sql`UPDATE agent_runs SET status='stopped' WHERE id=${runId}`)
        await runListChanged(outer, runId)
        throw new Error('outer rollback')
      }))), /outer rollback/)
      await drain(); assert.equal(received.length, 0)
      await scope.run(() => db.transaction(outer => withDatabaseTransaction(outer, async () => {
        await assert.rejects(db.transaction(inner => withDatabaseTransaction(inner, async () => {
          await runListChanged(inner, runId)
          throw new Error('savepoint rollback')
        })), /savepoint rollback/)
      })))
      await drain(); assert.equal(received.length, 0)
      assert.equal((await database.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status, 'waiting_input')
    })

    await t.test('actual stream batches notify on a completed preview, not tokens or duplicate outbox delivery', async () => {
      await clear()
      const { persistRunEventBatch } = await import('../secrets/run-events')
      const { identityMasker } = await import('../secrets/mask')
      await scope.run(async () => {
        await persistRunEventBatch(runId, 1, [{ type: 'text-start', id: 'preview' }, { type: 'text-delta', id: 'preview', delta: 'First' }], identityMasker)
        for (let seq = 3; seq < 13; seq++) await persistRunEventBatch(runId, seq, [{ type: 'text-delta', id: 'preview', delta: ` ${seq}` }], identityMasker)
        assert.equal(scheduled.length, 0, 'stream token batches do not become whole-list reads')
        await db.transaction(outer => withDatabaseTransaction(outer, async () => {
          await persistRunEventBatch(runId, 13, [{ type: 'text-end', id: 'preview' }], identityMasker)
          assert.equal(scheduled.length, 0)
          assert.equal((await database.query('SELECT id FROM run_chunks WHERE "runId"=$1 AND seq=13', [runId])).rowCount, 0)
        }))
        assert.equal(scheduled.length, 1)
        await persistRunEventBatch(runId, 13, [{ type: 'text-end', id: 'preview' }], identityMasker)
        assert.equal(scheduled.length, 1)
      })
      await drain()
      assert.equal(received.length, 1)
      assert.deepEqual(received[0].events, [{ kind: 'thread_list', id: team }])
      assert.ok((await database.query('SELECT "lastReply" FROM agent_runs WHERE id=$1', [runId])).rows[0].lastReply.startsWith('First'))
    })

    await t.test('the actual Owner stop writer publishes once after commit, and an enclosing rollback or foreign Owner publishes nothing', async () => {
      await clear()
      const { stopOwnedRun } = await import('../run-control')
      await assert.rejects(scope.run(() => db.transaction(outer => withDatabaseTransaction(outer, async () => {
        await stopOwnedRun(db, 'owner', runId)
        assert.equal(scheduled.length, 0)
        throw new Error('stop rollback')
      }))), /stop rollback/)
      await drain(); assert.equal(received.length, 0)
      assert.equal((await database.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0].stopRequestedAt, null)
      await assert.rejects(scope.run(() => stopOwnedRun(db, 'peer', runId)), /runNotFound/)
      await drain(); assert.equal(received.length, 0)
      await scope.run(() => stopOwnedRun(db, 'owner', runId))
      assert.equal(scheduled.length, 2, 'list and project-map invalidations retain independent after-COMMIT work')
      assert.ok((await database.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0].stopRequestedAt)
      await drain()
      assert.deepEqual(received.map(value => ({ scope: value.scope, events: value.events })), [{
        scope: { ownerId: 'owner', workspaceId: team }, events: [{ kind: 'thread_list', id: team }, { kind: 'task_run_list', id: team }],
      }])
      await clear(); await scope.run(() => stopOwnedRun(db, 'owner', runId)); await drain()
      assert.equal(received.length, 0, 'an already-recorded stop is not a new list mutation')
    })

    await t.test('an actual unclaimed startup failure publishes its terminal lists once even when the completion event is already present', async () => {
      const { failUnclaimedCloudStart } = await import('../run-leases')
      const botId = randomUUID()
      await database.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,'Startup list fixture')`, [botId, home])
      const makeRun = async (deduped: boolean) => {
        const id = randomUUID(), definition = { schemaVersion: 1, harness: 'codex', model: 'gpt-6-luna' }
        await database.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId",status,prompt,"agentDefinition")
          VALUES($1,'owner',$2,$3,$4,'queued','Startup list fixture',$5)`, [id, personalIssueId, ownerAgent, botId, definition])
        await database.query(`INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES($1,'owner',$2,$3)`, [id, home, botId])
        if (deduped) await database.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey","issueId","runId",payload)
          VALUES($1,'owner',$2,'run_finished',$3,$4,$5,'{"status":"failed","stopReason":"device_lost"}')`, [randomUUID(), botId, `run_finished:${id}`, personalIssueId, id])
        return { id, definition }
      }
      const fail = (id: string, userId = 'owner', workspaceId = home) => scope.run(() => failUnclaimedCloudStart({ userId, workspaceId }, id, new Error('Isolated startup fixture')))
      try {
        for (const deduped of [false, true]) {
          const run = await makeRun(deduped)
          await clear(); observedRunId = run.id
          assert.equal(await fail(run.id), true)
          await wrongScope.run(drain)
          const listReads = received.filter(value => value.events.some(event => event.kind === 'thread_list' || event.kind === 'task_run_list'))
          assert.deepEqual(listReads, [{ scope: { ownerId: 'owner', workspaceId: home },
            events: [{ kind: 'thread_list', id: home }, { kind: 'task_run_list', id: home }], committedStatus: 'failed' }],
          `the actual committed row needs exactly one list update, completion event deduped=${deduped}`)
          assert.ok(received.every(value => value.scope.ownerId === 'owner' && value.scope.workspaceId === home))
          const row = (await database.query('SELECT status,"stopReason","stopRequestedAt","agentDefinition" FROM agent_runs WHERE id=$1', [run.id])).rows[0]
          assert.deepEqual(row, { status: 'failed', stopReason: 'device_lost', stopRequestedAt: null, agentDefinition: run.definition })
          assert.equal((await database.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE "dedupeKey"=$1`, [`run_finished:${run.id}`])).rows[0].n, 1)
          await clear(); assert.equal(await fail(run.id), false); await drain()
          assert.equal(received.length, 0, 'terminal replay is not a new write')
        }
        const rollback = await makeRun(true)
        await clear(); observedRunId = rollback.id
        await database.query(`CREATE FUNCTION reject_startup_list_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.id='${rollback.id}'::uuid AND NEW.status='failed' THEN RAISE EXCEPTION 'startup list commit rejected'; END IF; RETURN NEW; END $$`)
        await database.query(`CREATE CONSTRAINT TRIGGER reject_startup_list_commit AFTER UPDATE ON agent_runs
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_startup_list_commit()`)
        try {
          await assert.rejects(fail(rollback.id), error => {
            const cause = (error as { cause?: unknown }).cause ?? error
            return (cause as { code?: string }).code === 'P0001' && String(cause).includes('startup list commit rejected')
          })
          await drain(); assert.equal(received.length, 0, 'a real PostgreSQL COMMIT failure discards the registered invalidation')
          assert.equal((await database.query('SELECT status FROM agent_runs WHERE id=$1', [rollback.id])).rows[0].status, 'queued')
          assert.equal((await database.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE "dedupeKey"=$1`, [`run_finished:${rollback.id}`])).rows[0].n, 1, 'the previously committed event is unchanged')
        } finally {
          await database.query('DROP TRIGGER reject_startup_list_commit ON agent_runs')
          await database.query('DROP FUNCTION reject_startup_list_commit()')
        }
        for (const guard of ['owner', 'workspace', 'claim', 'lease', 'stop', 'session_resume'] as const) {
          const run = await makeRun(false)
          if (guard === 'claim') await database.query(`UPDATE agent_runs SET status='running',"startedAt"=now(),"sessionId"='fixture-native-session' WHERE id=$1`, [run.id])
          if (guard === 'lease') await database.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [run.id])
          if (guard === 'stop') await database.query(`UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1`, [run.id])
          if (guard === 'session_resume') await database.query(`UPDATE agent_runs SET "questionContinuation"='{"requireSessionResume":true}' WHERE id=$1`, [run.id])
          const before = (await database.query('SELECT * FROM agent_runs WHERE id=$1', [run.id])).rows[0]
          await clear(); observedRunId = run.id
          assert.equal(await fail(run.id, guard === 'owner' ? 'peer' : 'owner', guard === 'workspace' ? team : home), false, guard)
          await drain(); assert.equal(received.length, 0, guard)
          assert.deepEqual((await database.query('SELECT * FROM agent_runs WHERE id=$1', [run.id])).rows[0], before, guard)
          assert.equal((await database.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE "runId"=$1`, [run.id])).rows[0].n, 0, guard)
        }
      } finally { observedRunId = runId }
    })

    await t.test('actual private group message, read receipt and member removal update only their authorized list audiences', async () => {
      await clear()
      const { handleGroup } = await import('../group-conversations-store')
      await database.query(`UPDATE conversation_members SET "leftAt"=NULL WHERE "conversationId"=$1 AND "memberId"='peer'`, [groupId])
      const directory = async (workspaceId: string, userId: string, members: { memberType: string; memberId: string }[]) => {
        if (workspaceId !== team || members.some(member => member.memberType !== 'user')) return false
        const ids = [...new Set([userId, ...members.map(member => member.memberId)])]
        const rows = await database.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [workspaceId, ids])
        return rows.rowCount === ids.length
      }
      const base = { userId: 'owner', id: groupId, origin: 'https://list.example.invalid', host: 'list.example.invalid', workspaceId: team }
      const listing = await scope.run(() => handleGroup(database, directory, { ...base, method: 'GET', resource: 'conversations' }))
      assert.equal(listing.status, 200)
      assert.equal((listing.body as { viewerId: string }).viewerId, 'owner')
      assert.equal((listing.body as { workspaceId: string }).workspaceId, team)
      assert.equal(scheduled.length, 0, 'a list GET does not become a write invalidation')
      const sent = await scope.run(() => handleGroup(database, directory, { ...base, userId: 'peer', method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'Committed private group message' }) }))
      assert.equal(sent.status, 201)
      const messageId = (sent.body as { id: string }).id
      assert.equal((await database.query('SELECT id FROM conversation_messages WHERE id=$1', [messageId])).rowCount, 1)
      await drain()
      assert.deepEqual(new Set(received.map(value => value.scope.ownerId)), new Set(['owner', 'peer']))
      assert.ok(received.every(value => value.events.every(event => event.kind === 'group_list' && event.id === team)))
      await clear()
      const markRead = () => scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'read', body: JSON.stringify({ messageId }) }))
      assert.equal((await markRead()).status, 200); await drain()
      assert.deepEqual(received.map(value => value.scope), [{ ownerId: 'owner', workspaceId: team }])
      await clear(); await markRead(); await drain(); assert.equal(received.length, 0, 'the same read position is not a new summary')
      const removed = await scope.run(() => handleGroup(database, directory, { ...base, method: 'DELETE', resource: 'members', body: JSON.stringify({ memberType: 'user', memberId: 'peer' }) }))
      assert.equal(removed.status, 200); await drain()
      assert.deepEqual(new Set(received.map(value => value.scope.ownerId)), new Set(['owner', 'peer']), 'the removed actual participant receives only the known list key')
      await clear()
      const denied = await scope.run(() => handleGroup(database, directory, { ...base, userId: 'peer', method: 'GET', resource: 'messages' }))
      assert.equal(denied.status, 404); await drain(); assert.equal(received.length, 0)
    })

    await t.test('the actual workspace member removal rolls back without notification and clears only previously known scopes after commit', async () => {
      await clear()
      const { removeMember } = await import('../workspace-admin/members')
      await database.query(`UPDATE mikka_workspace_members SET role='admin' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team])
      await database.query(`CREATE FUNCTION reject_list_fixture_removal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD."userId"='foreign' THEN RAISE EXCEPTION 'list fixture deferred rollback'; END IF; RETURN OLD; END $$`)
      await database.query(`CREATE CONSTRAINT TRIGGER reject_list_fixture_removal AFTER DELETE ON mikka_workspace_members
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_list_fixture_removal()`)
      try {
        await assert.rejects(scope.run(() => removeMember('owner', team, 'foreign')), error => {
          const pg = (error as { cause?: unknown }).cause ?? error
          return (pg as { code?: string }).code === 'P0001' && String(pg).includes('list fixture deferred rollback')
        })
        await drain(); assert.equal(received.length, 0)
        assert.equal((await database.query(`SELECT status FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"='foreign'`, [team])).rows[0].status, 'active')
      } finally {
        await database.query('DROP TRIGGER reject_list_fixture_removal ON mikka_workspace_members')
        await database.query('DROP FUNCTION reject_list_fixture_removal()')
      }
      const removed = await scope.run(() => removeMember('owner', team, 'foreign'))
      assert.equal(removed.removed, true)
      assert.equal(removed.transferred.bots, 0, 'this fixture does not claim cross-database Bot-transfer atomicity')
      assert.equal((await database.query(`SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"='foreign'`, [team])).rowCount, 0)
      await wrongScope.run(drain)
      const old = received.filter(value => value.scope.ownerId === 'foreign')
      assert.equal(old.length, 2)
      assert.deepEqual(new Set(old.map(value => value.scope.workspaceId)), new Set([team, foreignHome]))
      assert.ok(old.every(value => value.events.every(event => event.id === value.scope.workspaceId)))
      assert.ok(old.find(value => value.scope.workspaceId === foreignHome)!.events.some(event => event.kind === 'workspace_settings'))
      assert.ok(!received.some(value => value.scope.ownerId === 'inactive'))
    })
  } finally {
    await drain().catch(() => {})
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    globalDb.workspacePool = previousWorkspace
    await scope.close(); await wrongScope.close()
    await database.end(); await foreign.end()
    server.close(); await once(server, 'close')
    for (const name of names) await dropTestDatabase(admin, name)
    await admin.end()
  }
})
