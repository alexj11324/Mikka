import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Task identity regression requires disposable loopback databases')
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Task identity database regression cannot skip in required CI')

test('task identity: split DB migration, immutable issuance, historical aliases and collision refusal', { skip: !url, timeout: 120_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const suffix = randomUUID().replaceAll('-', '')
  const names = [`identity_app_${suffix}_e2e`, `identity_ws_${suffix}_e2e`]
  for (const name of names) await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
  const appUrl = new URL(url!), wsUrl = new URL(url!)
  appUrl.pathname = `/${names[0]}`; wsUrl.pathname = `/${names[1]}`
  const app = new Pool({ connectionString: appUrl.toString(), max: 8 })
  const ws = new Pool({ connectionString: wsUrl.toString(), max: 2 })
  const previous = { app: process.env.MIKKA_DATABASE_URL, ws: process.env.DATABASE_URL }
  process.env.MIKKA_DATABASE_URL = appUrl.toString(); process.env.DATABASE_URL = wsUrl.toString()
  let moduleApp: Pool | undefined, moduleWS: Pool | undefined
  try {
    await app.query(`
      CREATE TABLE "user" (id text PRIMARY KEY, email text NOT NULL, name text NOT NULL DEFAULT 'Current name', image text);
      CREATE TABLE issue_prefixes ("userId" text PRIMARY KEY, prefix text NOT NULL);
      CREATE TABLE linear_team_syncs ("ownerId" text, "linearTeamKey" text);
      CREATE TABLE linear_issue_links ("issueId" uuid, "ownerId" text, "linearIdentifier" text);
      CREATE TABLE issues (id uuid PRIMARY KEY, "userId" text NOT NULL, "workspaceId" uuid,
        scope text NOT NULL, content jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE run_publications ("runId" uuid PRIMARY KEY, "issueId" uuid NOT NULL, "userId" text NOT NULL,
        identifier text, branch text, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE bots (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL);
      INSERT INTO "user"(id,email) VALUES ('owner','owner@example.invalid'), ('peer','peer@example.invalid');
      INSERT INTO issue_prefixes VALUES ('owner','SAME'), ('peer','SAME');
    `)
    await ws.query(`
      CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY, "userId" text NOT NULL DEFAULT 'owner', kind text NOT NULL DEFAULT 'team');
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid NOT NULL, "userId" text NOT NULL, status text NOT NULL, PRIMARY KEY ("workspaceId","userId"));
      CREATE TABLE mikka_teams (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, identifier varchar(12) NOT NULL);
      CREATE TABLE mikka_team_issues ("issueId" uuid PRIMARY KEY, "teamId" uuid NOT NULL,
        "workspaceId" uuid NOT NULL, "userId" text NOT NULL, number bigint NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
    `)
    const alpha = randomUUID(), beta = randomUUID(), team = randomUUID()
    const personal = randomUUID(), grouped = randomUUID(), publication = randomUUID(), legacyOwner = randomUUID(), legacyPeer = randomUUID(), otherWorkspace = randomUUID(), pendingBackfill = randomUUID(), quarantined = randomUUID()
    const legacyAgent = { kind: 'agent', id: randomUUID(), name: 'Worker', image: null }
    const content = (number: number, assignee: unknown = null) => ({ type: 'doc', attrs: { mikka: { number, assignee } }, content: [{ type: 'paragraph' }] })
    const insert = (id: string, owner: string, workspaceId: string, number: number, scope = 'workspace', assignee: unknown = null) =>
      app.query('INSERT INTO issues(id,"userId","workspaceId",scope,content) VALUES($1,$2,$3,$4,$5) RETURNING *', [id, owner, workspaceId, scope, content(number, assignee)])
    await ws.query('INSERT INTO mikka_workspaces(id) VALUES($1),($2)', [alpha, beta])
    await ws.query('INSERT INTO mikka_workspace_members VALUES($1,\'owner\',\'active\'),($1,\'peer\',\'active\'),($2,\'owner\',\'active\')', [alpha, beta])
    await ws.query('INSERT INTO mikka_teams VALUES($1,$2,\'OLD\')', [team, alpha])
    await insert(personal, 'owner', beta, 1, 'personal', legacyAgent)
    await insert(grouped, 'owner', alpha, 2)
    await app.query('INSERT INTO linear_issue_links VALUES($1,\'owner\',\'EXT-37\')', [grouped])
    await insert(publication, 'owner', alpha, 3)
    await insert(legacyOwner, 'owner', alpha, 4)
    await insert(legacyPeer, 'peer', alpha, 4)
    await insert(otherWorkspace, 'owner', beta, 4)
    await insert(pendingBackfill, 'owner', alpha, 6)
    await app.query('INSERT INTO issues(id,"userId","workspaceId",scope,content) VALUES($1,\'owner\',NULL,\'workspace\',$2)', [quarantined, content(99)])
    await ws.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId",number) VALUES($1,$2,$3,\'owner\',12),($4,$2,$3,\'owner\',13)', [grouped, team, alpha, publication])
    const runId = randomUUID()
    await app.query('INSERT INTO run_publications("runId","issueId","userId",identifier,branch) VALUES($1,$2,\'owner\',\'FROZEN-7\',\'mikka/FROZEN-7\')', [runId, publication])
    const publicationBefore = (await app.query('SELECT * FROM run_publications WHERE "runId"=$1', [runId])).rows[0]
    const appMigration = await readFile(new URL('../drizzle/20261107230001_task_identity.sql', import.meta.url), 'utf8')
    const wsMigration = await readFile(new URL('../drizzle/20261107230002_task_identity_aliases.sql', import.meta.url), 'utf8')
    await app.query(appMigration); await ws.query(wsMigration)
    moduleApp = (await import('../lib/db')).pool
    moduleWS = (await import('../lib/workspace-db')).workspacePool
    const { ensureTaskIdentifiers, resolveTaskIdentifierAlias } = await import('../lib/task-identity-store')

    await t.test('legacy metadata separates delegation without changing body or publication history', async () => {
      const row = (await app.query('SELECT content,"issuedIdentifier" FROM issues WHERE id=$1', [personal])).rows[0]
      assert.equal(row.issuedIdentifier, 'SAME-1')
      assert.equal(row.content.attrs.mikka.assignee, null)
      assert.deepEqual(row.content.attrs.mikka.delegate, legacyAgent)
      assert.deepEqual(row.content.content, [{ type: 'paragraph' }])
      assert.deepEqual((await app.query('SELECT * FROM run_publications WHERE "runId"=$1', [runId])).rows[0], publicationBefore)
    })

    await t.test('Team rename and removal preserve an unopened historical identifier and all aliases', async () => {
      await ws.query('UPDATE mikka_teams SET identifier=\'NEW\' WHERE id=$1', [team])
      await ws.query('DELETE FROM mikka_team_issues WHERE "teamId"=$1', [team])
      await ws.query('DELETE FROM mikka_teams WHERE id=$1', [team])
      await app.query('UPDATE issues SET scope=\'personal\' WHERE id=$1', [grouped])
      await app.query('UPDATE linear_issue_links SET "linearIdentifier"=\'EXT-38\' WHERE "issueId"=$1', [grouped])
      await app.query('DELETE FROM linear_issue_links WHERE "issueId"=$1', [grouped])
      const identifiers = await ensureTaskIdentifiers([{ id: grouped, ownerId: 'owner' }, { id: publication, ownerId: 'owner' }])
      assert.equal(identifiers.get(grouped), 'OLD-12')
      assert.equal(identifiers.get(publication), 'FROZEN-7')
      for (const identifier of ['OLD-12', 'NEW-12', 'EXT-37', 'EXT-38']) assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier }), { kind: 'found', issueId: grouped })
      await app.query('UPDATE issue_prefixes SET prefix=\'NEXT\' WHERE "userId"=\'owner\'')
      assert.equal((await ensureTaskIdentifiers([{ id: personal, ownerId: 'owner' }])).get(personal), 'SAME-1')
      await assert.rejects(app.query('UPDATE issues SET "issuedIdentifier"=\'NEW-99\' WHERE id=$1', [grouped]), /immutable/)
    })

    await t.test('responsibility projects only an active human in the exact task Workspace', async () => {
      const { taskAssignees } = await import('../lib/task-identifier-server')
      const assignee = { kind: 'member' as const, id: 'peer', name: 'Old name', image: 'old.png' }
      const input = [{ id: legacyOwner, workspaceId: alpha, assignee }, { id: otherWorkspace, workspaceId: beta, assignee }]
      assert.deepEqual((await taskAssignees(input)).get(legacyOwner), { ...assignee, name: 'Current name', image: null })
      assert.equal((await taskAssignees(input)).get(otherWorkspace), null)
      await ws.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=\'peer\'', [alpha])
      assert.equal((await taskAssignees(input)).get(legacyOwner), null)
      await ws.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=\'peer\'', [alpha])
      assert.ok((await taskAssignees(input)).get(legacyOwner))
      await ws.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=\'peer\'', [alpha])
      assert.equal((await taskAssignees(input)).get(legacyOwner), null)
    })

    await t.test('alias lookup rejects cross-owner ambiguity and respects the explicit workspace', async () => {
      await ensureTaskIdentifiers([{ id: legacyOwner, ownerId: 'owner' }, { id: legacyPeer, ownerId: 'peer' }, { id: otherWorkspace, ownerId: 'owner' }])
      assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier: 'SAME-4' }), { kind: 'ambiguous' })
      assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier: 'SAME-4', ownerId: 'peer' }), { kind: 'found', issueId: legacyPeer })
      assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: beta, identifier: 'SAME-4' }), { kind: 'found', issueId: otherWorkspace })
      assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: randomUUID(), identifier: 'SAME-4' }), { kind: 'missing' })
      assert.equal((await ensureTaskIdentifiers([{ id: grouped, ownerId: 'peer' }])).has(grouped), false)
      await app.query('INSERT INTO task_identifier_aliases("issueId","workspaceId","ownerId",identifier,kind) VALUES($1,$2,\'peer\',\'WRONG-1\',\'team\')', [legacyOwner, alpha])
      await ws.query('INSERT INTO mikka_task_identifier_aliases("issueId","workspaceId","ownerId",identifier) VALUES($1,$2,\'peer\',\'WRONG-2\')', [legacyOwner, alpha])
      for (const identifier of ['WRONG-1', 'WRONG-2']) {
        assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier, ownerId: 'peer' }), { kind: 'missing' })
        assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier }), { kind: 'missing' })
      }
    })

    await t.test('new shared tasks use one transactional Workspace counter across creators', async () => {
      const rows = await Promise.all(Array.from({ length: 12 }, (_, index) => insert(randomUUID(), index % 2 ? 'owner' : 'peer', alpha, index + 100)))
      const identifiers = rows.map(result => result.rows[0].issuedIdentifier as string)
      assert.equal(new Set(identifiers).size, 12)
      assert.ok(identifiers.every(identifier => /^W[0-9A-F]{12}-[1-9]\d*$/.test(identifier)))
      assert.deepEqual(identifiers.map(identifier => Number(identifier.split('-').at(-1))).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1))
      const reader = await app.connect()
      try {
        await reader.query('BEGIN READ ONLY')
        const { drizzle } = await import('drizzle-orm/node-postgres')
        const observed = await ensureTaskIdentifiers(rows.map(result => ({ id: result.rows[0].id as string, ownerId: result.rows[0].userId as string })), drizzle(reader))
        assert.deepEqual(new Set(observed.values()), new Set(identifiers), 'fully issued list projections are read-only')
        await reader.query('ROLLBACK')
      } finally { reader.release() }
      const client = await app.connect()
      try {
        await client.query('BEGIN')
        await client.query('INSERT INTO issues(id,"userId","workspaceId",scope,content) VALUES($1,\'owner\',$2,\'workspace\',$3)', [randomUUID(), alpha, content(500)])
        await client.query('ROLLBACK')
      } finally { client.release() }
      assert.match((await insert(randomUUID(), 'peer', alpha, 501)).rows[0].issuedIdentifier, /-13$/)
    })

    await t.test('a Workspace prefix collision gets an independent guarded namespace', async () => {
      const nextWorkspace = randomUUID(), occupiedBy = randomUUID()
      const short = 'W' + nextWorkspace.replaceAll('-', '').slice(0, 12).toUpperCase()
      await ws.query('INSERT INTO mikka_workspaces(id) VALUES($1),($2)', [nextWorkspace, occupiedBy])
      await app.query('INSERT INTO workspace_task_identifier_counters("workspaceId",prefix) VALUES($1,$2)', [occupiedBy, short])
      const created = (await insert(randomUUID(), 'owner', nextWorkspace, 502)).rows[0]
      assert.equal(created.issuedIdentifier, 'W' + nextWorkspace.replaceAll('-', '').toUpperCase() + '-1')
    })

    await t.test('deployment backfill resumes, is idempotent, and never assigns a quarantined tenant', async () => {
      const { backfillTaskIdentifiers } = await import('../scripts/task-identity-backfill.mjs')
      assert.deepEqual(await backfillTaskIdentifiers(app, ws, { batchSize: 1 }), { issued: 1 })
      assert.deepEqual(await backfillTaskIdentifiers(app, ws, { batchSize: 1 }), { issued: 0 })
      assert.equal((await app.query('SELECT "issuedIdentifier" FROM issues WHERE id=$1', [pendingBackfill])).rows[0].issuedIdentifier, 'SAME-6')
      assert.equal((await ensureTaskIdentifiers([{ id: quarantined, ownerId: 'owner' }])).get(quarantined), null)
      assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier: 'SAME-99' }), { kind: 'missing' })
    })

    await t.test('a stale WS alias cannot resolve a deleted task, and migrations are replay safe', async () => {
      await app.query(appMigration); await ws.query(wsMigration)
      assert.equal((await ensureTaskIdentifiers([{ id: grouped, ownerId: 'owner' }])).get(grouped), 'OLD-12')
      await app.query('DELETE FROM issues WHERE id=$1', [grouped])
      assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier: 'OLD-12' }), { kind: 'missing' })
      assert.equal((await app.query('SELECT count(*)::int AS n FROM task_identifier_aliases WHERE "issueId"=$1', [grouped])).rows[0].n, 0)
      assert.deepEqual((await app.query('SELECT * FROM run_publications WHERE "runId"=$1', [runId])).rows[0], publicationBefore)
    })
  } finally {
    if (previous.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previous.app
    if (previous.ws === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.ws
    await Promise.all([app.end(), ws.end(), moduleApp?.end(), moduleWS?.end()])
    for (const name of names) await dropTestDatabase(admin, name)
    await admin.end()
  }
})
