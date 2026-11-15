import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { seedTeam } from '../../tests/support/workspace-admin-db'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import { issueThreadTargets, runChangeTargets } from './panels'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('an issue thread list key reaches every member who can see the issue, after the run writer commits', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const nextServer = await import('next/server')
  mock.module('next/server', { namedExports: { ...nextServer, after: (work: () => Promise<void>) => { pending.push(work) } } })
  // The same writers refresh owner lists; lists.db.test.ts covers those keys.
  for (const file of ['./lists.ts']) {
    const actual = await import(file)
    mock.module(new URL(file, import.meta.url).href, { namedExports: Object.fromEntries(Object.entries(actual).map(([name, value]) =>
      [name, name.endsWith('ScopesBeforeChange') ? async () => [] : name.endsWith('Changed') ? async () => {} : value])) })
  }
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-issue-threads-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpected.push(target.pathname)
    const events: LiveInvalidation[] = wireKeys(JSON.parse(String(options?.body)), 'a key carries a kind and an id only')
    sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `issue_threads_live_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, name, 'template0')
  const target = new URL(url!); target.pathname = `/${name}`
  const database = new Pool({ connectionString: target.toString(), max: 6 })
  observePoolCommits(database)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = database
  const { db, createRequestDatabaseScope, withDatabaseTransaction } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(target.toString())
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0).map(work => work())) }
  const byOwner = () => Object.fromEntries([...sent].sort((a, b) => a.scope.ownerId.localeCompare(b.scope.ownerId)).map(value => [`${value.scope.ownerId}@${value.scope.workspaceId}`, value.events]))
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer', 'suspended', 'outsider']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@threads.example.invalid',true,now(),now())`, [userId])
    }
    const home = randomUUID(), peerHome = randomUUID(), team = randomUUID(), outsiderHome = randomUUID()
    for (const ownerId of ['owner', 'peer', 'suspended', 'outsider']) for (const workspaceId of [home, peerHome, team, outsiderHome]) {
      const value = { ownerId, workspaceId }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value)
    }
    for (const [id, owner, kind] of [[home, 'owner', 'personal'], [peerHome, 'peer', 'personal'], [team, 'owner', 'team'], [outsiderHome, 'outsider', 'personal']]) {
      await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,$2,'Fixture',$3)`, [id, owner, kind])
    }
    for (const [workspace, userId, status] of [[home, 'owner', 'active'], [peerHome, 'peer', 'active'], [team, 'owner', 'active'], [team, 'peer', 'active'], [team, 'suspended', 'suspended'], [outsiderHome, 'outsider', 'active']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member',$3)`, [workspace, userId, status])
    }
    const agents = new Map<string, string>()
    for (const owner of ['owner', 'peer']) {
      const id = randomUUID(); agents.set(owner, id)
      await database.query(`INSERT INTO agents(id,"userId",name,harness) VALUES ($1,$2,'Fixture','codex')`, [id, owner])
    }
    const issue = async (workspace: string | null) => {
      const id = randomUUID()
      await database.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope,"workspaceId") VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal',$2,$3)`, [id, workspace ? 'workspace' : 'personal', workspace ?? home])
      if (workspace) {
        const grouping = await seedTeam(database, workspace, 'owner')
        await database.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,'owner')`, [id, grouping.id, workspace])
      }
      return id
    }
    const run = async (issueId: string | null, owner = 'owner') => {
      const id = randomUUID()
      await database.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId",status,prompt,"workspaceId") VALUES ($1,$2,$3,$4,'running','Fixture',$5)`, [id, owner, issueId, agents.get(owner), issueId ? null : home])
      return id
    }
    const teamIssue = await issue(team), personalIssue = await issue(null)
    const peerRun = await run(teamIssue, 'peer'), freeRun = await run(null)

    await t.test('targets follow the issue’s visibility: active workspace members, or the owner of a personal issue', async () => {
      const teamTargets = await issueThreadTargets(database, database, teamIssue)
      assert.deepEqual(new Set(teamTargets.map(value => value.scope.ownerId)), new Set(['owner', 'peer']), 'a suspended member and an outsider get nothing')
      assert.ok(teamTargets.every(value => value.scope.workspaceId === team && value.events.length === 1 && value.events[0].kind === 'issue_threads' && value.events[0].id === teamIssue))
      assert.deepEqual(await issueThreadTargets(database, database, personalIssue), [{ scope: { ownerId: 'owner', workspaceId: home }, events: [{ kind: 'issue_threads', id: personalIssue }] }])
      await database.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"deletedAt":"2026-11-05"}}}' WHERE id=$1`, [personalIssue])
      assert.deepEqual(await issueThreadTargets(database, database, personalIssue), [], 'a deleted issue notifies nobody')
      await database.query(`UPDATE issues SET content='{"type":"doc","content":[]}' WHERE id=$1`, [personalIssue])
    })

    await t.test('a teammate’s run change reaches the owner’s thread list without its run ID', async () => {
      const targets = await runChangeTargets(database, database, peerRun)
      const merged = Object.fromEntries(targets.map(value => [value.scope.ownerId, value]))
      assert.deepEqual(Object.keys(merged).sort(), ['owner', 'peer'])
      assert.deepEqual(merged.owner.events, [{ kind: 'issue_threads', id: teamIssue }], 'only the run’s owner learns its run ID')
      assert.deepEqual(merged.peer, { scope: { ownerId: 'peer', workspaceId: team }, events: [{ kind: 'run', id: peerRun }, { kind: 'issue_threads', id: teamIssue }] })
      assert.ok(!(await runChangeTargets(database, database, freeRun)).some(value => value.events.some(event => event.kind === 'issue_threads')), 'a task-free run has no issue list')
    })

    await t.test('the actual stop writer publishes after COMMIT, nothing on rollback, and rechecks membership when sent', async () => {
      const { stopOwnedRun } = await import('../run-control')
      sent.length = 0
      await assert.rejects(scope.run(() => db.transaction(outer => withDatabaseTransaction(outer, async () => {
        await stopOwnedRun(db, 'peer', peerRun)
        assert.equal(pending.length, 0, 'nothing is scheduled before COMMIT')
        throw new Error('stop rollback')
      }))), /stop rollback/)
      await drain(); assert.deepEqual(sent, [])
      await scope.run(() => stopOwnedRun(db, 'peer', peerRun))
      await drain()
      assert.deepEqual(byOwner(), {
        [`owner@${team}`]: [{ kind: 'issue_threads', id: teamIssue }],
        [`peer@${team}`]: [{ kind: 'run', id: peerRun }, { kind: 'issue_threads', id: teamIssue }],
      })
      sent.length = 0
      await database.query(`UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1`, [peerRun])
      await scope.run(() => stopOwnedRun(db, 'peer', peerRun))
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team])
      await drain()
      assert.deepEqual(Object.keys(byOwner()), [`peer@${team}`], 'a member removed between COMMIT and delivery receives nothing')
      await database.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team])
    })

    await t.test('a newly covered writer (unclaimed startup failure) wakes the thread list once', async () => {
      const { failUnclaimedCloudStart } = await import('../run-leases')
      const { coordinatorEnabled } = await import('../coordinator/wake')
      assert.equal(await coordinatorEnabled(), false, 'this isolated writer regression must not start model work')
      const bot = randomUUID(), id = randomUUID(), definition = { schemaVersion: 1, harness: 'codex', model: 'gpt-6-luna' }
      await database.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,'Startup fixture')`, [bot, home])
      await database.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","botId",status,prompt,"agentDefinition") VALUES($1,'owner',$2,$3,$4,'queued','Startup fixture',$5)`, [id, personalIssue, agents.get('owner'), bot, definition])
      await database.query(`INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES($1,'owner',$2,$3)`, [id, home, bot])
      sent.length = 0
      assert.equal(await scope.run(() => failUnclaimedCloudStart({ userId: 'owner', workspaceId: home }, id, new Error('Isolated startup fixture'))), true)
      await drain()
      const lists = sent.filter(value => value.events.some(event => event.kind === 'issue_threads'))
      assert.equal(lists.length, 1)
      assert.deepEqual(lists[0].scope, { ownerId: 'owner', workspaceId: home })
      assert.equal((await database.query('SELECT status FROM agent_runs WHERE id=$1', [id])).rows[0].status, 'failed')
      assert.deepEqual(unexpected, [])
    })
  } finally {
    await drain().catch(() => {})
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    globalDb.workspacePool = previousWorkspace
    await scope.close(); await database.end()
    await dropTestDatabase(admin, name); await admin.end()
    mock.restoreAll()
  }
})
