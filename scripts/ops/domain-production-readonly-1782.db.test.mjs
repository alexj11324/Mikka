/** Required PG17 fixture gate, before any production credential is read.
 * The only writes are to two newly-created disposable loopback databases.
 * The production SQL is imported unchanged and runs in READ ONLY transactions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { compareDatabases, readDatabase } from './domain-production-readonly-1782.mjs'
import { LEDGER, REQUIRED_ZERO, SQL } from './domain-production-readonly-1782-sql.mjs'

const FIXTURE_URL = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_domain_metadata_1782_fixture'
const DATABASES = Object.freeze({ app: 'mikka_domain_metadata_1782_app_fixture', ws: 'mikka_domain_metadata_1782_ws_fixture' })
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const hash = value => createHash('sha256').update(value).digest('hex')
const ownerId = 'synthetic-reader', workspaceId = id(900), foreignWorkspace = id(901)
const selection = { projectId: id(100), environmentId: id(200), projectRevision: 2, policyRevision: 1, environmentRevision: 3,
  repositoryKey: 'v2/github.com/synthetic/repository', baseBranch: 'main', runtime: 'any', harness: 'any' }
const cases = ['claude', 'codex'].map((value, index) => ({ case: value, taskId: id(index + 1), runIds: [id(index + 11)], selection }))
const scope = { ownerId, workspaceId, taskIds: cases.map(item => item.taskId), cases }
const binding = { applicationSha: 'a'.repeat(40), readerSha256: hash(ownerId), policyAdminSha256: hash('synthetic-admin'), workspaceId,
  activeRunId: 1234, activeRunAttempt: 1, activeWorkflowId: 5678, activeActor: { login: 'github-actions[bot]', id: 41898282 },
  activeTriggeringActor: { login: 'github-actions[bot]', id: 41898282 }, artifactId: 12345, artifactSizeBytes: 100,
  archiveSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), cases: cases.map(item => ({ case: item.case, taskId: item.taskId,
    runIds: item.runIds, selection: { projectId: selection.projectId, environmentId: selection.environmentId,
      projectRevision: 2, policyRevision: 1, environmentRevision: 3, repositorySha256: hash(selection.repositoryKey),
      baseBranchSha256: hash(JSON.stringify(selection.baseBranch)), runtime: 'any', harness: 'any' } })) }
const TABLES = Object.freeze({
  app: `CREATE TABLE schema_migrations (name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL);
    CREATE TABLE issues (id uuid PRIMARY KEY,"userId" text NOT NULL,"workspaceId" uuid,"ownershipState" text,"issuedIdentifier" text);
    CREATE TABLE issue_workspace_repairs ("issueId" uuid PRIMARY KEY,reason text);
    CREATE TABLE task_identifier_aliases ("issueId" uuid,"workspaceId" uuid,"ownerId" text,identifier text);
    CREATE TABLE agent_runs (id uuid PRIMARY KEY,"issueId" uuid,"userId" text,"workspaceId" uuid,status text,"agentDefinition" jsonb,"baseBranch" text);
    CREATE TABLE run_publications ("runId" uuid PRIMARY KEY,"issueId" uuid,"userId" text,identifier text);
    CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"workspaceId" uuid);
    CREATE TABLE artifacts (id uuid PRIMARY KEY,"workspaceId" uuid)`,
  ws: `CREATE TABLE schema_migrations (name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL);
    CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,kind text);
    CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,status text,role text);
    CREATE TABLE workspace_projects (id uuid PRIMARY KEY,"workspaceId" uuid,revision integer,"archivedAt" timestamptz);
    CREATE TABLE workspace_project_repairs ("projectId" uuid PRIMARY KEY,reason text);
    CREATE TABLE workspace_project_v2_migrations ("projectId" uuid PRIMARY KEY);
    CREATE TABLE workspace_project_tasks ("issueId" uuid,"projectId" uuid,"workspaceId" uuid);
    CREATE TABLE workspace_repository_policies ("workspaceId" uuid PRIMARY KEY,mode text,"repositoryKeys" jsonb,revision integer);
    CREATE TABLE workspace_project_repositories ("projectId" uuid,"workspaceId" uuid,"repositoryKey" text,"baseBranch" text,"environmentId" uuid);
    CREATE TABLE workspace_environments (id uuid PRIMARY KEY,"workspaceId" uuid,name text,configuration jsonb,revision integer,"archivedAt" timestamptz);
    CREATE TABLE workspace_project_environments ("projectId" uuid,"workspaceId" uuid,"environmentId" uuid,"isDefault" boolean)`,
})
const RESET = Object.freeze({
  app: 'TRUNCATE schema_migrations,issues,issue_workspace_repairs,task_identifier_aliases,agent_runs,run_publications,factory_tasks,artifacts',
  ws: 'TRUNCATE schema_migrations,mikka_workspaces,mikka_workspace_members,workspace_projects,workspace_project_repairs,workspace_project_v2_migrations,workspace_project_tasks,workspace_repository_policies,workspace_project_repositories,workspace_environments,workspace_project_environments',
})

test('real PG17 validates independent APP/WS metadata, frozen projections and actual readonly rollback', async t => {
  // Never accept another host, DB, spelling, query string or production env.
  // This check runs before importing pg, opening a connection or executing DDL.
  if (process.env.DOMAIN_READONLY_TEST_DATABASE_URL !== FIXTURE_URL
    || process.env.MIKKA_DATABASE_URL !== undefined || process.env.DATABASE_URL !== undefined) throw Error('fixture_target_refused')
  assert.ok(process.env.DOMAIN_READONLY_DEPENDENCIES, 'fixture_driver_missing')
  const { Client } = createRequire(resolve(process.env.DOMAIN_READONLY_DEPENDENCIES, 'package.json'))('pg')
  const make = connectionString => new Client({ connectionString, connectionTimeoutMillis: 10000,
    query_timeout: 25000, application_name: 'mikka-1782-domain-metadata-synthetic-gate' })
  const admin = make(FIXTURE_URL), clients = {}, created = []
  await admin.connect()
  try {
    const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
    assert.ok(version >= 170000 && version < 180000, 'fixture_requires_pg17')
    for (const kind of ['app', 'ws']) {
      // Literal allowlisted names only; an existing DB makes CREATE fail and is
      // never added to cleanup's owned-created set.
      await admin.query('CREATE DATABASE ' + DATABASES[kind]); created.push(kind)
      const target = new URL(FIXTURE_URL); target.pathname = '/' + DATABASES[kind]
      const db = clients[kind] = make(target.href); await db.connect(); await db.query(TABLES[kind])
    }
    const seed = async () => {
      for (const kind of ['app', 'ws']) {
        await clients[kind].query(RESET[kind])
        for (const pair of LEDGER[kind]) await clients[kind].query('INSERT INTO schema_migrations VALUES ($1,$2)', [pair[0], '2026-11-09T00:00:00Z'])
      }
      const { app, ws } = clients
      for (const item of cases) {
        await app.query(`INSERT INTO issues VALUES ($1,$2,$3,'bound',$4)`, [item.taskId, ownerId, workspaceId, 'SYNTHETIC-' + item.case])
        await app.query('INSERT INTO task_identifier_aliases VALUES ($1,$2,$3,$4)', [item.taskId, workspaceId, ownerId, 'SYNTHETIC-' + item.case])
        const pe = { version: 1, workspaceId, projectId: selection.projectId, projectRevision: 2, policyRevision: 1,
          repositoryKey: selection.repositoryKey, baseBranch: 'main', environment: { id: selection.environmentId,
            name: 'synthetic-private-environment', revision: 3, runtime: 'any', harness: 'any', variables: {}, secretIds: [], repositoryKeys: [] } }
        await app.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,'succeeded',$5::jsonb,'main')`,
          [item.runIds[0], item.taskId, ownerId, workspaceId, JSON.stringify({ privatePrompt: 'never-transport-this-definition', projectExecution: pe })])
        await app.query('INSERT INTO run_publications VALUES ($1,$2,$3,$4)', [item.runIds[0], item.taskId, ownerId, 'SYNTHETIC-' + item.case])
        await ws.query('INSERT INTO workspace_project_tasks VALUES ($1,$2,$3)', [item.taskId, selection.projectId, workspaceId])
      }
      await ws.query("INSERT INTO mikka_workspaces VALUES ($1,'team')", [workspaceId])
      await ws.query("INSERT INTO mikka_workspace_members VALUES ($1,$2,'active','member')", [workspaceId, ownerId])
      await ws.query('INSERT INTO workspace_projects VALUES ($1,$2,2,NULL)', [selection.projectId, workspaceId])
      await ws.query('INSERT INTO workspace_project_v2_migrations VALUES ($1)', [selection.projectId])
      await ws.query("INSERT INTO workspace_repository_policies VALUES ($1,'inherit','[]',1)", [workspaceId])
      await ws.query("INSERT INTO workspace_project_repositories VALUES ($1,$2,$3,'main',$4)",
        [selection.projectId, workspaceId, selection.repositoryKey, selection.environmentId])
      // Empty configuration proves real PostgreSQL normalization to Zod defaults.
      await ws.query("INSERT INTO workspace_environments VALUES ($1,$2,'synthetic-private-environment','{}',3,NULL)", [selection.environmentId, workspaceId])
      await ws.query('INSERT INTO workspace_project_environments VALUES ($1,$2,$3,true)', [selection.projectId, workspaceId, selection.environmentId])
    }
    const read = async kind => {
      const events = [], commands = []
      const db = { query: async (...args) => { const result = await clients[kind].query(...args); commands.push(result.command); return result } }
      const result = await readDatabase(kind, db, scope, binding, event => events.push(event))
      assert.equal(events[0].readOnly, true); assert.equal(events[0].isolation, 'repeatable read')
      assert.equal(events.at(-1).transactionRolledBack, true); assert.equal(commands.at(-1), 'ROLLBACK')
      assert.equal((await clients[kind].query("SELECT current_setting('transaction_read_only') AS v")).rows[0].v, 'off')
      return result
    }
    const rejected = async (kind, code) => {
      const observed = []
      await assert.rejects(readDatabase(kind, clients[kind], scope, binding, event => observed.push(event)), error => error.code === code)
      assert.equal(observed.at(-1).transactionRolledBack, true)
      assert.equal((await clients[kind].query("SELECT current_setting('transaction_read_only') AS v")).rows[0].v, 'off')
    }
    await t.test('all fixed SQL executes in genuinely separate DBs with zero integrity anomalies and private values stay in PG', async () => {
      await seed()
      const app = await read('app'), ws = await read('ws'), result = compareDatabases(app, ws)
      assert.equal(result.status, 'metadata_and_active_snapshot_verified')
      for (const kind of ['app', 'ws']) for (const key of REQUIRED_ZERO[kind]) assert.equal(({ app, ws })[kind].metadata.counts[key], '0')
      assert.equal(app.metadata.counts.publicationVerified, '2')
      const output = JSON.stringify({ app, ws, result })
      for (const privateValue of ['never-transport-this-definition', 'synthetic-private-environment', selection.repositoryKey, ownerId]) assert.ok(!output.includes(privateValue))
      assert.notEqual((await clients.app.query('SELECT current_database() AS db')).rows[0].db, (await clients.ws.query('SELECT current_database() AS db')).rows[0].db)
      await assert.rejects(clients.app.query('SELECT * FROM workspace_projects'), error => error.code === '42P01')
      await assert.rejects(clients.ws.query('SELECT * FROM issues'), error => error.code === '42P01')
    })
    await t.test('exact legacy ledger aliases are accepted, a missing logical migration fails and still rolls back', async () => {
      await seed()
      for (const kind of ['app', 'ws']) {
        await clients[kind].query('UPDATE schema_migrations SET name=$1 WHERE name=$2', [LEDGER[kind][0][1], LEDGER[kind][0][0]])
        assert.ok((await read(kind)).metadata.migrations.some(row => row.name === LEDGER[kind][0][1]))
        await clients[kind].query('DELETE FROM schema_migrations WHERE name=$1', [LEDGER[kind][0][1]])
        await rejected(kind, 'migration_missing')
      }
    })
    await t.test('a write attempted inside the actual collector transaction is refused by PostgreSQL, with no row changed', async () => {
      await seed(); const observed = [], db = { query: async (...args) => {
        const result = await clients.app.query(...args)
        if (args[0] === SQL.settings) await clients.app.query('DELETE FROM issues')
        return result
      } }
      await assert.rejects(readDatabase('app', db, scope, binding, event => observed.push(event)), error => error.code === '25006')
      assert.equal(observed.at(-1).transactionRolledBack, true)
      assert.equal((await clients.app.query('SELECT count(*)::int AS n FROM issues')).rows[0].n, 2)
    })
    for (const [name, sql, args] of [
      ['foreign Task tenant', 'UPDATE issues SET "workspaceId"=$1 WHERE id=$2', [foreignWorkspace, id(1)]],
      ['different Task creator', 'UPDATE issues SET "userId"=$1 WHERE id=$2', ['foreign-reader', id(1)]],
      ['unbound Task', 'UPDATE issues SET "ownershipState"=$1 WHERE id=$2', ['pending', id(1)]],
    ]) await t.test(name + ' fails the real APP projection', async () => { await seed(); await clients.app.query(sql, args); await rejected('app', 'database_binding') })
    for (const [name, sql, args] of [
      ['wrong Run Task', 'UPDATE agent_runs SET "issueId"=$1 WHERE id=$2', [id(2), id(11)]],
      ['foreign Run tenant', 'UPDATE agent_runs SET "workspaceId"=$1 WHERE id=$2', [foreignWorkspace, id(11)]],
      ['wrong frozen Environment', `UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{projectExecution,environment,id}',to_jsonb($1::text)) WHERE id=$2`, [id(201), id(11)]],
    ]) await t.test(name + ' fails the real frozen-snapshot projection', async () => { await seed(); await clients.app.query(sql, args); await rejected('app', 'active_snapshot') })
    for (const [name, sql, args] of [
      ['revoked membership', "UPDATE mikka_workspace_members SET status='removed'", []],
      ['foreign canonical relation', 'UPDATE workspace_project_tasks SET "workspaceId"=$1 WHERE "issueId"=$2', [foreignWorkspace, id(1)]],
    ]) await t.test(name + ' fails the real WS projection', async () => { await seed(); await clients.ws.query(sql, args); await rejected('ws', 'database_binding') })
    await t.test('same-revision configuration mutation fails but a later Environment revision is retained as visible drift', async () => {
      await seed(); const app = await read('app')
      await clients.ws.query(`UPDATE workspace_environments SET configuration='{"variables":{"SYNTHETIC":"private-value-never-output"}}'`)
      const changed = await read('ws')
      assert.throws(() => compareDatabases(app, changed), error => error.code === 'active_snapshot')
      await clients.ws.query('UPDATE workspace_environments SET revision=revision+1')
      const drift = compareDatabases(app, await read('ws'))
      assert.equal(drift.status, 'collected_with_findings')
      assert.deepEqual(drift.findings, ['active.claude.revision_drift', 'active.codex.revision_drift'])
      assert.ok(!JSON.stringify(drift).includes('private-value-never-output'))
    })
    await t.test('every required APP integrity counter stays nonzero and unknown reasons are represented only by count and digest', async () => {
      await seed(); const db = clients.app
      await db.query('UPDATE task_identifier_aliases SET "workspaceId"=NULL WHERE "issueId"=$1', [id(1)])
      await db.query('DELETE FROM task_identifier_aliases WHERE "issueId"=$1', [id(2)])
      await db.query('INSERT INTO task_identifier_aliases VALUES ($1,$2,$3,$4)', [id(2), foreignWorkspace, 'foreign-reader', 'SYNTHETIC-codex'])
      await db.query(`INSERT INTO issues VALUES ($1,$2,$3,'bound',NULL),($4,$2,NULL,'pending',NULL),($5,$2,NULL,'unknown',NULL)`,
        [id(3), ownerId, workspaceId, id(4), id(5)])
      await db.query('INSERT INTO issue_workspace_repairs VALUES ($1,$2)', [id(6), 'private-unrecognized-reason'])
      const result = await read('app')
      assert.deepEqual(result.metadata.findings, REQUIRED_ZERO.app.map(key => 'app.' + key))
      assert.equal(result.metadata.counts.boundWithoutIdentifier, '1')
      assert.equal(result.metadata.counts.issuedWithoutAlias, '2'); assert.equal(result.metadata.counts.publishedWithoutAlias, '2')
      for (const key of ['boundAliasWithoutTenant', 'conflictingAliasProjection', 'pendingWithoutRepair', 'unknownOwnership', 'unknownRepair']) assert.equal(result.metadata.counts[key], '1')
      assert.ok(!JSON.stringify(result).includes('private-unrecognized-reason'))
    })
    await t.test('every required WS anomaly is observable without reading another tenant Project contents', async () => {
      await seed(); const db = clients.ws
      await db.query('DELETE FROM workspace_project_v2_migrations')
      await db.query('INSERT INTO workspace_projects VALUES ($1,NULL,1,NULL)', [id(300)])
      await db.query('INSERT INTO workspace_project_repairs VALUES ($1,$2)', [id(301), 'private-unrecognized-reason'])
      await db.query('INSERT INTO workspace_project_tasks VALUES ($1,$2,$3),($1,$4,$5)', [id(3), selection.projectId, workspaceId, id(302), foreignWorkspace])
      const result = await read('ws')
      assert.deepEqual(result.metadata.findings, REQUIRED_ZERO.ws.map(key => 'ws.' + key))
      for (const key of REQUIRED_ZERO.ws) assert.equal(result.metadata.counts[key], '1')
      assert.ok(!JSON.stringify(result).includes('private-unrecognized-reason'))
    })
    await t.test('all publication provenance buckets are distinct from trusted alias visibility', async () => {
      await seed(); const db = clients.app
      await db.query(`INSERT INTO issues VALUES ($1,$2,NULL,'pending',NULL)`, [id(6), ownerId])
      await db.query('INSERT INTO issue_workspace_repairs VALUES ($1,$2)', [id(6), 'missing_evidence'])
      await db.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,'succeeded','{}','main'),($5,$2,$6,NULL,'succeeded','{}','main'),($7,$2,$6,$8,'succeeded','{}','main')`,
        [id(13), id(1), 'different-executor', workspaceId, id(14), ownerId, id(15), foreignWorkspace])
      for (const [runId, issueId] of [[id(60), id(6)], [id(61), id(1)], [id(13), id(1)], [id(14), id(1)], [id(15), id(1)]]) {
        await db.query('INSERT INTO run_publications VALUES ($1,$2,$3,$4)', [runId, issueId, ownerId, 'SYNTHETIC-' + runId])
      }
      const result = await read('app')
      for (const key of ['publicationUnresolvedTask', 'publicationMismatchedRun', 'publicationUnresolvedRun', 'publicationConflictingWorkspace']) {
        assert.equal(result.metadata.counts[key], key === 'publicationMismatchedRun' ? '2' : '1')
      }
      assert.equal(result.metadata.counts.publicationVerified, '2')
    })
  } finally {
    const closed = await Promise.allSettled(Object.values(clients).map(db => db.end()))
    try {
      for (const kind of created.reverse()) await admin.query('DROP DATABASE ' + DATABASES[kind])
      assert.ok(closed.every(result => result.status === 'fulfilled'), 'fixture_connection_cleanup_failed')
    } finally { await admin.end() }
  }
})
