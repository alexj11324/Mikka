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
import { issueMemberTargets, issueRelationTargets } from './issue-detail'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'
import { tokenWorkspace } from '../tokens/principal'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('issue members and relations keys reach only the task audience, after the actual writer commits', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const nextServer = await import('next/server')
  mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((code: string) => code, { has: () => true }) } })
  mock.module('next/server', { namedExports: { ...nextServer, after: (work: () => Promise<void>) => { pending.push(work) } } })
  // The same writers refresh lists and documents; lists.db.test.ts and panels.db.test.ts cover those keys.
  for (const file of ['./lists.ts']) {
    const actual = await import(file)
    mock.module(new URL(file, import.meta.url).href, { namedExports: Object.fromEntries(Object.entries(actual).map(([name, value]) =>
      [name, name.endsWith('ScopesBeforeChange') ? async () => [] : name.endsWith('Changed') ? async () => {} : value])) })
  }
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-issue-detail-secret'
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
  const name = `issue_detail_live_${randomUUID().replaceAll('-', '')}_e2e`
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
  const keys = (kind: string) => sent.flatMap(value => value.events.filter(event => event.kind === kind).map(event => `${value.scope.ownerId}@${value.scope.workspaceId}:${event.id}`)).sort()
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer', 'suspended', 'outsider']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@detail.example.invalid',true,now(),now())`, [userId])
    }
    const home = randomUUID(), team = randomUUID(), outsiderHome = randomUUID()
    for (const ownerId of ['owner', 'peer', 'suspended', 'outsider']) for (const workspaceId of [home, team, outsiderHome]) {
      const value = { ownerId, workspaceId }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value)
    }
    for (const [id, owner, kind] of [[home, 'owner', 'personal'], [team, 'owner', 'team'], [outsiderHome, 'outsider', 'personal']]) {
      await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,$2,'Fixture',$3)`, [id, owner, kind])
    }
    for (const [workspace, userId, status] of [[home, 'owner', 'active'], [team, 'owner', 'active'], [team, 'peer', 'active'], [team, 'suspended', 'suspended'], [outsiderHome, 'outsider', 'active']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member',$3)`, [workspace, userId, status])
    }
    const issue = async (workspace: string | null, metadata: Record<string, unknown> = {}) => {
      const id = randomUUID()
      await database.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope,"workspaceId") VALUES ($1,'owner','Fixture',$2,'todo','normal',$3,$4)`,
        [id, JSON.stringify({ type: 'doc', attrs: { mikka: metadata }, content: [] }), workspace ? 'workspace' : 'personal', workspace ?? home])
      if (workspace) {
        const grouping = await seedTeam(database, workspace, 'owner')
        await database.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,'owner')`, [id, grouping.id, workspace])
      }
      return id
    }
    const parent = await issue(team), unrelated = await issue(team)
    const child = await issue(team, { parentId: parent })
    const personal = await issue(null, { relatedIds: [child] })

    await t.test('members go to the task’s own audience only', async () => {
      const targets = await issueMemberTargets(database, database, parent)
      assert.deepEqual(new Set(targets.map(value => value.scope.ownerId)), new Set(['owner', 'peer']), 'a suspended member and an outsider get nothing')
      assert.ok(targets.every(value => value.scope.workspaceId === team && value.events.every(event => event.kind === 'issue_members' && event.id === parent)))
      assert.deepEqual(await issueMemberTargets(database, database, personal), [{ scope: { ownerId: 'owner', workspaceId: home }, events: [{ kind: 'issue_members', id: personal }] }])
    })

    await t.test('a task change reaches every connected task’s panel, each on its own audience', async () => {
      const targets = await issueRelationTargets(database, database, [child])
      const delivered = targets.flatMap(value => value.events.map(event => `${value.scope.ownerId}@${value.scope.workspaceId}:${event.id}`)).sort()
      assert.deepEqual(delivered, [
        `owner@${home}:${personal}`, `owner@${team}:${child}`, `owner@${team}:${parent}`, `peer@${team}:${child}`, `peer@${team}:${parent}`,
      ].sort(), 'the parent, the child and the personal task that names it; never the unrelated task, and the peer never sees the personal one')
      assert.ok(!delivered.some(key => key.endsWith(unrelated)))
      const fromParent = (await issueRelationTargets(database, database, [parent])).flatMap(value => value.events.map(event => event.id))
      assert.ok(fromParent.includes(child), 'a task that names the changed one is found from the other direction')
    })

    await t.test('a duplicate target change reaches the referencing task, including legacy metadata and deletion', async () => {
      const target = await issue(team)
      const duplicate = await issue(null, { duplicateOfId: target })
      const legacyDuplicate = await issue(team)
      await database.query(`UPDATE issues SET content=$2 WHERE id=$1`, [legacyDuplicate,
        JSON.stringify({ type: 'doc', attrs: { orvilo: { duplicateOfId: target } }, content: [] })])
      const expected = [`owner@${home}:${duplicate}`, `owner@${team}:${legacyDuplicate}`, `peer@${team}:${legacyDuplicate}`].sort()
      const references = async () => (await issueRelationTargets(database, database, [target]))
        .flatMap(value => value.events.filter(event => event.id !== target).map(event => `${value.scope.ownerId}@${value.scope.workspaceId}:${event.id}`)).sort()
      await database.query(`UPDATE issues SET title='Renamed duplicate target',status='done' WHERE id=$1`, [target])
      assert.deepEqual(await references(), expected, 'each duplicate panel is notified on its own authorized channel')
      await database.query(`UPDATE issues SET content=$2 WHERE id=$1`, [target,
        JSON.stringify({ type: 'doc', attrs: { mikka: { deletedAt: new Date().toISOString() } }, content: [] })])
      assert.deepEqual(await references(), expected, 'removing the target still refreshes the surviving duplicate panels')
      assert.ok((await issueRelationTargets(database, database, [target])).every(value => value.events.every(event => event.id !== target)), 'the deleted task gets no body-channel notification')
    })

    await t.test('the actual relation writer publishes after COMMIT, nothing on rollback, and reaches a disconnected parent', async () => {
      const { actAs } = await import('../acting-user')
      const { updateIssueRelation } = await import('../../app/actions/issue-operations')
      const revision = async (id: string) => (await database.query('SELECT revision FROM issues WHERE id=$1', [id])).rows[0].revision as number
      sent.length = 0
      await assert.rejects(scope.run(() => db.transaction(outer => withDatabaseTransaction(outer, async () => {
        const result = await actAs({ id: 'owner', [tokenWorkspace]: team }, async () => updateIssueRelation({ id: child, revision: await revision(child), targetId: null, kind: 'parent', remove: true }))
        assert.ok('issue' in result, JSON.stringify(result))
        throw new Error('relation rollback')
      }))), /relation rollback/)
      await drain(); assert.deepEqual(sent, [])
      const result = await scope.run(async () => actAs({ id: 'owner', [tokenWorkspace]: team }, async () => updateIssueRelation({ id: child, revision: await revision(child), targetId: null, kind: 'parent', remove: true })))
      assert.ok('issue' in result, JSON.stringify(result))
      await drain()
      const delivered = keys('issue_relations')
      for (const expected of [`owner@${team}:${child}`, `owner@${team}:${parent}`, `peer@${team}:${parent}`]) assert.ok(delivered.includes(expected), `${expected} in ${delivered}`)
      assert.ok(!delivered.some(key => key.startsWith('suspended') || key.startsWith('outsider') || key.endsWith(unrelated)))
    })

    await t.test('the actual member writers publish once after COMMIT and recheck membership when sent', async () => {
      const { actAs } = await import('../acting-user')
      const { inviteMember, removeMember } = await import('../../app/actions/collaboration')
      sent.length = 0
      const invited = await scope.run(() => actAs({ id: 'owner', [tokenWorkspace]: team }, () => inviteMember(parent, 'outsider@detail.example.invalid')))
      assert.ok('success' in invited, JSON.stringify(invited))
      await drain()
      assert.deepEqual(keys('issue_members'), [`owner@${team}:${parent}`, `peer@${team}:${parent}`], 'an invite to a team task never opens the team channel to the invitee')
      sent.length = 0
      assert.ok('success' in await scope.run(() => actAs({ id: 'owner', [tokenWorkspace]: team }, () => removeMember(parent, 'outsider'))))
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='peer'`, [team])
      await drain()
      assert.deepEqual(keys('issue_members'), [`owner@${team}:${parent}`], 'a member removed between COMMIT and delivery receives nothing')
      sent.length = 0
      assert.ok('success' in await scope.run(() => actAs({ id: 'owner', [tokenWorkspace]: team }, () => removeMember(parent, 'outsider'))))
      await drain(); assert.deepEqual(keys('issue_members'), [], 'removing someone who is not a member is not a change')
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
