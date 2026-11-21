import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from './support/drop-test-database'
import { measured } from './helpers/read-metrics'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Task identity regression requires disposable loopback databases')
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Task identity database regression cannot skip in required CI')

test('task identity: split DB migration, immutable issuance, historical aliases and collision refusal', { skip: !url, timeout: 120_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const suffix = randomUUID().replaceAll('-', '')
  const names = [`identity_app_${suffix}_e2e`, `identity_ws_${suffix}_e2e`]
  for (const name of names) await createTestDatabase(admin, name, 'template0')
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
        "ownershipState" text GENERATED ALWAYS AS (CASE WHEN "workspaceId" IS NULL THEN 'pending' ELSE 'bound' END) STORED,
        scope text NOT NULL, content jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE run_publications ("runId" uuid PRIMARY KEY, "issueId" uuid NOT NULL, "userId" text NOT NULL,
        identifier text, branch text, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE bots (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, "issueId" uuid, "userId" text NOT NULL,
        "workspaceId" uuid, "botId" uuid, "agentDefinition" jsonb, "baseBranch" text);
      CREATE TABLE factory_tasks (id uuid PRIMARY KEY, "issueId" uuid, "workspaceId" uuid, "botId" uuid);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY, "ownerId" text, "workspaceId" uuid);
      CREATE TABLE artifacts (id uuid PRIMARY KEY, "issueId" uuid, "runId" uuid, "userId" text, "workspaceId" uuid);
      CREATE TABLE issue_workspace_repairs ("issueId" uuid PRIMARY KEY, reason text, evidence jsonb,
        "checkedAt" timestamptz NOT NULL DEFAULT now());
      INSERT INTO "user"(id,email) VALUES ('owner','owner@example.invalid'), ('peer','peer@example.invalid');
      INSERT INTO issue_prefixes VALUES ('owner','SAME'), ('peer','SAME');
    `)
    await ws.query(`
      CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY, "userId" text NOT NULL DEFAULT 'owner', kind text NOT NULL DEFAULT 'team');
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid NOT NULL, "userId" text NOT NULL, status text NOT NULL, PRIMARY KEY ("workspaceId","userId"));
      CREATE TABLE mikka_teams (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, identifier varchar(12) NOT NULL);
      CREATE TABLE mikka_team_issues ("issueId" uuid PRIMARY KEY, "teamId" uuid NOT NULL,
        "workspaceId" uuid NOT NULL, "userId" text NOT NULL, number bigint NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE workspace_projects (id uuid PRIMARY KEY, "userId" text, "issueIds" jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE mikka_team_projects ("projectId" uuid, "teamId" uuid, "workspaceId" uuid, "userId" text);
    `)
    const alpha = randomUUID(), beta = randomUUID(), team = randomUUID()
    const personal = randomUUID(), grouped = randomUUID(), publication = randomUUID(), legacyOwner = randomUUID(), legacyPeer = randomUUID(), otherWorkspace = randomUUID(), pendingBackfill = randomUUID(), quarantined = randomUUID()
    const upgraded = randomUUID(), upgradeTeam = randomUUID(), peerRun = randomUUID(), ownerRun = randomUUID()
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
    await app.query('INSERT INTO agent_runs(id,"issueId","userId","workspaceId") VALUES($1,$2,\'owner\',$3)', [runId, publication, alpha])
    await app.query('INSERT INTO run_publications("runId","issueId","userId",identifier,branch) VALUES($1,$2,\'owner\',\'FROZEN-7\',\'mikka/FROZEN-7\')', [runId, publication])
    const publicationBefore = (await app.query('SELECT * FROM run_publications WHERE "runId"=$1', [runId])).rows[0]
    // Normal deployment starts with identity DDL before cross-database P0
    // reconciliation. A personal legacy scope is not tenant evidence and must
    // not freeze the owner spelling before the peer's earlier receipt is read.
    await app.query('INSERT INTO issues(id,"userId",scope,content) VALUES($1,\'owner\',\'personal\',$2)', [upgraded, content(71)])
    await ws.query('INSERT INTO mikka_teams VALUES($1,$2,\'UPGR\')', [upgradeTeam, alpha])
    await ws.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId",number) VALUES($1,$2,$3,\'owner\',71)', [upgraded, upgradeTeam, alpha])
    await app.query('INSERT INTO linear_issue_links VALUES($1,\'owner\',\'LINEAR-71\')', [upgraded])
    const frozen = { executionIdentity: { workspaceId: alpha }, traceContext: { taskNumber: 'PEER-71' }, taskEnv: { MODE: 'historical' } }
    await app.query('INSERT INTO agent_runs(id,"issueId","userId","agentDefinition","baseBranch") VALUES($1,$2,\'peer\',$3,\'release/old\'),($4,$2,\'owner\',$3,\'main\')', [peerRun, upgraded, frozen, ownerRun])
    await app.query(`INSERT INTO run_publications("runId","issueId","userId",identifier,branch,"createdAt")
      VALUES($1,$2,'peer','PEER-71','mikka/peer-71','2020-01-01'),($3,$2,'owner','OWNER-71','mikka/owner-71','2020-02-01')`, [peerRun, upgraded, ownerRun])
    const upgradePublicationsBefore = (await app.query('SELECT * FROM run_publications WHERE "issueId"=$1 ORDER BY "runId"', [upgraded])).rows
    const upgradeRunsBefore = (await app.query('SELECT id,"issueId","userId","agentDefinition","baseBranch" FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [upgraded])).rows
    const appMigration = await readFile(new URL('../drizzle/20261111030001_task_identity.sql', import.meta.url), 'utf8')
    const wsMigration = await readFile(new URL('../drizzle/20261111030002_task_identity_aliases.sql', import.meta.url), 'utf8')
    const aliasMigration = await readFile(new URL('../drizzle/20261111030007_task_alias_tenant.sql', import.meta.url), 'utf8')
    await app.query(appMigration); await app.query(aliasMigration); await ws.query(wsMigration)
    await app.query('SELECT * FROM reconcile_bound_task_identifier_aliases($1::uuid[])', [[publication]])
    moduleApp = (await import('../lib/db')).pool
    moduleWS = (await import('../lib/workspace-db')).workspacePool
    const { ensureTaskIdentifiers, resolveTaskIdentifierAlias } = await import('../lib/task-identity-store')

    await t.test('legacy metadata separates delegation without changing body or publication history', async () => {
      await ensureTaskIdentifiers([{ id: personal, ownerId: 'owner' }])
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

    await t.test('authorized issued projections avoid another read while legacy inputs retain owner checks', async () => {
      const { taskIdentifiers } = await import('../lib/task-identifier-server')
      const { db } = await import('../lib/db')
      // These values come from the current APP rows, after the earlier Team
      // rename/removal and personal prefix change, never from client metadata.
      const { rows } = await app.query<{ id: string; ownerId: string; scope: 'personal' | 'workspace'; issuedIdentifier: string }>(
        'SELECT id,"userId" AS "ownerId",scope,"issuedIdentifier" FROM issues WHERE id=ANY($1::uuid[]) AND "userId"=\'owner\'',
        [[personal, grouped, publication]])
      assert.equal(rows.length, 3)
      assert.ok(rows.every(row => row.issuedIdentifier))
      const direct = await measured(() => taskIdentifiers(rows, db))
      assert.deepEqual(direct.value, new Map(rows.map(row => [row.id, row.issuedIdentifier])))
      assert.equal(direct.statements, 0, 'a fully issued authorized projection requires no second APP/WS read')
      assert.equal(direct.resultBytes, 0)

      const legacy = await measured(() => taskIdentifiers([
        { id: grouped, ownerId: 'owner', scope: 'personal', issuedIdentifier: '' },
        { id: personal, ownerId: 'owner', scope: 'personal', issuedIdentifier: null },
        { id: publication, ownerId: 'peer', scope: 'workspace' },
        { id: randomUUID(), ownerId: 'owner', scope: 'workspace' },
      ], db))
      assert.equal(legacy.value.get(grouped), 'OLD-12')
      assert.equal(legacy.value.get(personal), 'SAME-1')
      assert.equal(legacy.value.has(publication), false, 'missing projections still check the stored creator')
      assert.equal(legacy.value.size, 2, 'missing UUIDs do not acquire an identifier')
      assert.equal(legacy.statements, 1, 'already issued legacy inputs retain the bounded APP lookup')
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

    await t.test('DDL then P0 then identity backfill preserves every trusted alias and the earliest peer publication', async () => {
      const { backfillTaskWorkspaces } = await import('../scripts/task-workspace-backfill.mjs')
      const { backfillTaskIdentifiers } = await import('../scripts/task-identity-backfill.mjs')
      assert.equal((await app.query('SELECT "issuedIdentifier" FROM issues WHERE id=$1', [upgraded])).rows[0].issuedIdentifier, null)
      await app.query('UPDATE linear_issue_links SET "linearIdentifier"=\'LINEAR-72\' WHERE "issueId"=$1', [upgraded])
      // Neither NULL-tenant aliases nor stale creator/tenant claims grant a
      // lookup. A bogus earlier publication must not win canonical issuance.
      await app.query(`INSERT INTO task_identifier_aliases("issueId","workspaceId","ownerId",identifier,kind,"createdAt") VALUES
        ($1,NULL,'peer','WRONGOWNER-71','publication','1900-01-01'),
        ($1,$2,'owner','WRONGTENANT-71','publication','1900-01-01')`, [upgraded, beta])
      for (const identifier of ['SAME-71', 'OWNER-71', 'LINEAR-71', 'LINEAR-72', 'PEER-71', 'WRONGOWNER-71', 'WRONGTENANT-71']) {
        assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier }), { kind: 'missing' })
      }
      assert.equal((await backfillTaskWorkspaces(app, ws)).bound, 1)
      const bound = (await app.query('SELECT "workspaceId","ownershipState","issuedIdentifier" FROM issues WHERE id=$1', [upgraded])).rows[0]
      assert.deepEqual(bound, { workspaceId: alpha, ownershipState: 'bound', issuedIdentifier: null })
      assert.deepEqual(await backfillTaskIdentifiers(app, ws, { batchSize: 1 }), { issued: 1 })
      assert.equal((await app.query('SELECT "issuedIdentifier" FROM issues WHERE id=$1', [upgraded])).rows[0].issuedIdentifier, 'PEER-71', 'the first trusted publication wins before an owner spelling is frozen')
      for (const identifier of ['SAME-71', 'OWNER-71', 'LINEAR-71', 'LINEAR-72', 'PEER-71', 'UPGR-71']) {
        assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier }), { kind: 'found', issueId: upgraded })
        assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: beta, identifier }), { kind: 'missing' })
      }
      for (const identifier of ['WRONGOWNER-71', 'WRONGTENANT-71']) {
        assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier }), { kind: 'missing' })
      }
      const conflicting = (await app.query('SELECT identifier,"workspaceId","ownerId" FROM task_identifier_aliases WHERE "issueId"=$1 AND identifier LIKE \'WRONG%\' ORDER BY identifier', [upgraded])).rows
      assert.deepEqual(conflicting, [
        { identifier: 'WRONGOWNER-71', workspaceId: null, ownerId: 'peer' },
        { identifier: 'WRONGTENANT-71', workspaceId: beta, ownerId: 'owner' },
      ])
      assert.deepEqual((await app.query('SELECT * FROM run_publications WHERE "issueId"=$1 ORDER BY "runId"', [upgraded])).rows, upgradePublicationsBefore)
      assert.deepEqual((await app.query('SELECT id,"issueId","userId","agentDefinition","baseBranch" FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [upgraded])).rows, upgradeRunsBefore)
      assert.deepEqual(await backfillTaskIdentifiers(app, ws, { batchSize: 1 }), { issued: 0 })
      assert.equal((await app.query('SELECT "workspaceId","issuedIdentifier" FROM issues WHERE id=$1', [quarantined])).rows[0].workspaceId, null)
      assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier: 'SAME-99' }), { kind: 'missing' })
    })

    await t.test('an installed schema repairs aliases on issued tasks without adopting foreign publication evidence or changing the ID', async () => {
      const { backfillTaskIdentifiers } = await import('../scripts/task-identity-backfill.mjs')
      const current = (await app.query('SELECT "issuedIdentifier" FROM issues WHERE id=$1', [upgraded])).rows[0].issuedIdentifier
      await app.query(`INSERT INTO task_identifier_aliases("issueId","ownerId",identifier,kind) VALUES
        ($1,'owner','PREVIOUS-71','owner'),($1,'peer','FOREIGNOWNER-71','owner')`, [upgraded])
      const good = randomUUID(), wrongOwner = randomUUID(), wrongTask = randomUUID(), wrongWorkspace = randomUUID()
      await app.query(`INSERT INTO agent_runs(id,"issueId","userId","workspaceId","agentDefinition") VALUES
        ($1,$5,'peer',$6,'{}'),($2,$5,'owner',$6,'{}'),($3,$7,'peer',$6,'{}'),($4,$5,'peer',$8,'{}')`,
      [good, wrongOwner, wrongTask, wrongWorkspace, upgraded, alpha, legacyOwner, beta])
      await app.query(`INSERT INTO run_publications("runId","issueId","userId",identifier,branch,"createdAt") VALUES
        ($1,$5,'peer','EARLIER-71','mikka/earlier-71','1900-01-01'),
        ($2,$5,'peer','BADOWNER-71','mikka/badowner-71','1900-01-01'),
        ($3,$5,'peer','BADTASK-71','mikka/badtask-71','1900-01-01'),
        ($4,$5,'peer','BADTENANT-71','mikka/badtenant-71','1900-01-01')`, [good, wrongOwner, wrongTask, wrongWorkspace, upgraded])
      const runsBefore = (await app.query('SELECT * FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [[good, wrongOwner, wrongTask, wrongWorkspace]])).rows
      const receiptsBefore = (await app.query('SELECT * FROM run_publications WHERE "runId"=ANY($1::uuid[]) ORDER BY "runId"', [[good, wrongOwner, wrongTask, wrongWorkspace]])).rows
      await app.query(aliasMigration)
      assert.deepEqual(await backfillTaskIdentifiers(app, ws, { batchSize: 1 }), { issued: 0 })
      assert.equal((await app.query('SELECT "issuedIdentifier" FROM issues WHERE id=$1', [upgraded])).rows[0].issuedIdentifier, current, 'a newly recovered older receipt is an alias, never a renumbering')
      for (const identifier of ['PREVIOUS-71', 'EARLIER-71']) assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier }), { kind: 'found', issueId: upgraded })
      for (const identifier of ['FOREIGNOWNER-71', 'BADOWNER-71', 'BADTASK-71', 'BADTENANT-71']) assert.deepEqual(await resolveTaskIdentifierAlias({ workspaceId: alpha, identifier }), { kind: 'missing' })
      const aliasesBefore = (await app.query('SELECT * FROM task_identifier_aliases WHERE "issueId"=$1 ORDER BY identifier,kind', [upgraded])).rows
      assert.deepEqual(await backfillTaskIdentifiers(app, ws, { batchSize: 1 }), { issued: 0 })
      assert.deepEqual((await app.query('SELECT * FROM task_identifier_aliases WHERE "issueId"=$1 ORDER BY identifier,kind', [upgraded])).rows, aliasesBefore)
      assert.deepEqual((await app.query('SELECT * FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [[good, wrongOwner, wrongTask, wrongWorkspace]])).rows, runsBefore)
      assert.deepEqual((await app.query('SELECT * FROM run_publications WHERE "runId"=ANY($1::uuid[]) ORDER BY "runId"', [[good, wrongOwner, wrongTask, wrongWorkspace]])).rows, receiptsBefore)
    })

    await t.test('a stale WS alias cannot resolve a deleted task, and migrations are replay safe', async () => {
      await app.query(appMigration); await app.query(aliasMigration); await ws.query(wsMigration)
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
