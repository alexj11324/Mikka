/** Required synthetic PG17 gate, before any production Infisical read.
 * Its only write target is the disposable loopback service declared by this
 * workflow. The production collector still uses READ ONLY + ROLLBACK. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { EPIC_MIGRATIONS, snapshot, SQL } from './domain-history-before-1782.mjs'

const FIXTURE_URL = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_domain_history_1782_fixture'
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const digest = value => createHash('sha256').update(value).digest('hex')
const workspaceId = id(900), foreignWorkspace = id(901)
const owner = n => 'synthetic-creator-' + n
const scopeFor = (count = 2) => {
  const candidateTaskIds = Array.from({ length: count }, (_, index) => id(index + 1))
  return { ownerId: 'synthetic-reader', workspaceId, candidateTaskIds,
    taskOwners: Object.fromEntries(candidateTaskIds.map((value, index) => [value, owner(index + 1)])) }
}
const pairsFor = scope => [scope.candidateTaskIds, scope.candidateTaskIds.map(value => scope.taskOwners[value]), scope.workspaceId]

test('real PG17 validates paired creators, verified publication, tenant-safe history and actual rollback', async t => {
  // Never inherit DATABASE_URL/MIKKA_DATABASE_URL or accept a supplied hostname,
  // credentials, database name, query option or alternative loopback spelling.
  if (process.env.DOMAIN_HISTORY_TEST_DATABASE_URL !== FIXTURE_URL
    || process.env.MIKKA_DATABASE_URL !== undefined || process.env.DATABASE_URL !== undefined) {
    throw Error('fixture_target_refused')
  }
  assert.ok(process.env.DOMAIN_HISTORY_DEPENDENCIES, 'fixture_driver_missing')
  const { Client } = createRequire(resolve(process.env.DOMAIN_HISTORY_DEPENDENCIES, 'package.json'))('pg')
  const db = new Client({ connectionString: FIXTURE_URL, connectionTimeoutMillis: 10000,
    query_timeout: 25000, application_name: 'mikka-1782-domain-history-synthetic-gate' })
  await db.connect()
  let schemaCreated = false
  try {
    const version = Number((await db.query('SHOW server_version_num')).rows[0].server_version_num)
    assert.ok(version >= 170000 && version < 180000, 'fixture_requires_pg17')
    await db.query('CREATE SCHEMA domain_history_fixture_1782'); schemaCreated = true
    await db.query('SET search_path = domain_history_fixture_1782, pg_catalog')
    await db.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY);
      CREATE TABLE issues (id uuid PRIMARY KEY, "userId" text NOT NULL, "workspaceId" uuid,
        "ownershipState" text NOT NULL, scope text NOT NULL, "issuedIdentifier" text);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, "issueId" uuid NOT NULL, "userId" text NOT NULL,
        "workspaceId" uuid, status text NOT NULL, "agentDefinition" jsonb NOT NULL, "baseBranch" text);
      CREATE TABLE run_publications ("runId" uuid PRIMARY KEY, "issueId" uuid NOT NULL, "userId" text NOT NULL,
        status text NOT NULL, identifier text, branch text, "baseBranch" text, "remoteKey" text)`)
    const seed = async (count = 2) => {
      await db.query('TRUNCATE run_publications, agent_runs, issues, schema_migrations')
      await db.query("INSERT INTO schema_migrations VALUES ('synthetic_before_epic')")
      for (let n = 1; n <= count; n++) {
        await db.query(`INSERT INTO issues VALUES ($1,$2,$3,'bound',$4,$5)`,
          [id(n), owner(n), workspaceId, n % 2 ? 'personal' : 'workspace', 'SYNTHETIC-' + n])
        // The executor need not be the Task creator. Publication is bound to
        // its actual Run executor, while Task creator identity stays immutable.
        await db.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,'succeeded',$5::jsonb,'main')`,
          [id(100 + n), id(n), 'synthetic-executor-' + n, workspaceId,
            JSON.stringify({ privateFixturePrompt: 'never-transport-this-definition', ...(n === 1 ? { projectExecution: { version: 1 } } : {}) })])
        await db.query(`INSERT INTO run_publications VALUES ($1,$2,$3,'published',$4,'synthetic-private-branch','main','synthetic-private-repo')`,
          [id(100 + n), id(n), 'synthetic-executor-' + n, 'SYNTHETIC-' + n])
      }
    }
    await t.test('two ordinary-API-authorized creators retain separate hashes and complete closed history', async () => {
      await seed(); const observations = []
      const result = await snapshot(db, scopeFor(), value => observations.push(value))
      assert.deepEqual(result.rows.task.map(row => row.creatorSha256), [digest(owner(1)), digest(owner(2))])
      assert.equal(result.rows.publication.length, 2); assert.equal(result.rows.run.length, 2)
      assert.equal(observations.find(value => value.readOnly)?.readOnly, true)
      assert.equal(observations.at(-1).transactionRolledBack, true)
      assert.equal((await db.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value, 'off')
      const output = JSON.stringify(result)
      for (const raw of [owner(1), owner(2), 'never-transport-this-definition', 'synthetic-private-branch', 'synthetic-private-repo']) assert.ok(!output.includes(raw))
    })
    for (const kind of ['canonical', 'legacy']) await t.test('an applied ' + kind + ' Epic migration invalidates before and receives a real rollback ACK', async () => {
      await seed(); await db.query('INSERT INTO schema_migrations VALUES ($1)', [EPIC_MIGRATIONS[kind][0]])
      const observed = []
      await assert.rejects(snapshot(db, scopeFor(), value => observed.push(value)), error => error.code === 'migration_already_applied')
      const ledger = observed.find(value => value.lastReadStage === 'ledger_refused')
      assert.equal(ledger.canonicalEpicMigrations, kind === 'canonical' ? 1 : 0)
      assert.equal(ledger.legacyEpicMigrations, kind === 'legacy' ? 1 : 0)
      assert.equal(observed.at(-1).transactionRolledBack, true)
      assert.equal((await db.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value, 'off')
    })
    await t.test('separate P0, Coding and unrecognized prefix names are not substituted for an exact Epic identity', async () => {
      await seed()
      for (const name of ['20261108120200_task_workspace_ownership.sql', '20261109035000_task_workspace_ownership.sql',
        '20261109143100_coding_review_sessions.sql', '20261108230400_coding_review_sessions.sql', '20261109143099_not_an_epic_identity.sql']) {
        await db.query('INSERT INTO schema_migrations VALUES ($1)', [name])
      }
      const observed = []
      await snapshot(db, scopeFor(), value => observed.push(value))
      const ledger = observed.find(value => value.lastReadStage === 'ledger_verified')
      assert.equal(ledger.canonicalEpicMigrations, 0); assert.equal(ledger.legacyEpicMigrations, 0)
    })
    await t.test('swapping creators between two allowed IDs is refused instead of matching independent ANY sets', async () => {
      await seed(); const scope = scopeFor()
      scope.taskOwners[id(1)] = owner(2); scope.taskOwners[id(2)] = owner(1)
      const binding = (await db.query(SQL.binding, pairsFor(scope))).rows[0]
      assert.equal(binding.present, 2); assert.equal(binding.bound, 0)
      await assert.rejects(snapshot(db, scope), error => error.code === 'database_binding')
      for (const kind of ['select', 'task', 'publication', 'run']) assert.equal((await db.query(SQL[kind], pairsFor(scope))).rows.length, 0)
    })
    for (const [name, mutation, args] of [
      ['publication executor conflict', 'UPDATE run_publications SET "userId"=$1 WHERE "runId"=$2', ['wrong-executor', id(101)]],
      ['publication Task conflict', 'UPDATE run_publications SET "issueId"=$1 WHERE "runId"=$2', [id(2), id(101)]],
      ['Run tenant absent', 'UPDATE agent_runs SET "workspaceId"=$1 WHERE id=$2', [null, id(101)]],
      ['Run tenant foreign', 'UPDATE agent_runs SET "workspaceId"=$1 WHERE id=$2', [foreignWorkspace, id(101)]],
      ['Run absent', 'DELETE FROM agent_runs WHERE id=$1', [id(101)]],
    ]) await t.test(name + ' cannot satisfy or enter published history', async () => {
      await seed(); await db.query(mutation, args)
      const scope = scopeFor(), binding = (await db.query(SQL.binding, pairsFor(scope))).rows[0]
      assert.equal(binding.published, 1); assert.equal(binding.historical, 1)
      assert.deepEqual((await db.query(SQL.select, pairsFor(scope))).rows.map(row => row.id), [id(2)])
      assert.deepEqual((await db.query(SQL.publication, pairsFor(scope))).rows.map(row => row.id), [id(102)])
      const result = await snapshot(db, scope)
      assert.deepEqual(result.taskIds, [id(2)])
    })
    await t.test('a valid publication plus only foreign ended Run still cannot qualify as historical', async () => {
      await seed()
      await db.query('UPDATE agent_runs SET "workspaceId"=$1 WHERE id=$2', [foreignWorkspace, id(101)])
      await db.query(`INSERT INTO agent_runs VALUES ($1,$2,'synthetic-active-executor',$3,'running','{}','main')`, [id(201), id(1), workspaceId])
      await db.query(`UPDATE run_publications SET "runId"=$1,"userId"='synthetic-active-executor' WHERE "runId"=$2`, [id(201), id(101)])
      const scope = scopeFor(), binding = (await db.query(SQL.binding, pairsFor(scope))).rows[0]
      assert.equal(binding.published, 2); assert.equal(binding.ended, 1); assert.equal(binding.historical, 1)
      assert.deepEqual((await db.query(SQL.run, pairsFor(scope))).rows.map(row => row.id), [id(102)])
      assert.deepEqual((await snapshot(db, scope)).taskIds, [id(2)])
    })
    for (const [name, mutation, value] of [
      ['changed creator', 'UPDATE issues SET "userId"=$1 WHERE id=$2', 'changed-creator'],
      ['different Workspace', 'UPDATE issues SET "workspaceId"=$1 WHERE id=$2', foreignWorkspace],
      ['pending ownership', 'UPDATE issues SET "ownershipState"=$1 WHERE id=$2', 'pending'],
      ['unknown compatibility label', 'UPDATE issues SET scope=$1 WHERE id=$2', 'unknown'],
    ]) await t.test(name + ' is refused in the transaction and every final projection', async () => {
      await seed(); await db.query(mutation, [value, id(1)])
      const scope = scopeFor()
      await assert.rejects(snapshot(db, scope), error => error.code === 'database_binding')
      for (const kind of ['task', 'publication', 'run']) {
        const rows = (await db.query(SQL[kind], pairsFor(scope))).rows
        assert.equal(rows.length, 1); assert.equal(kind === 'task' ? rows[0].id : rows[0].issueId, id(2))
      }
    })
    await t.test('no verified publication is a real history_missing failure with actual rollback', async () => {
      await seed(); await db.query("UPDATE run_publications SET status='failed'")
      const observed = []
      await assert.rejects(snapshot(db, scopeFor(), value => observed.push(value)), error => error.code === 'history_missing')
      assert.deepEqual(observed.find(value => value.candidateCounts)?.candidateCounts,
        { present: 2, bound: 2, published: 0, ended: 2, historical: 0 })
      assert.equal(observed.at(-1).transactionRolledBack, true)
    })
    await t.test('twelve eligible Tasks still freeze at most ten and every history row belongs to that exact set', async () => {
      await seed(12); const result = await snapshot(db, scopeFor(12))
      assert.equal(result.candidateCount, 12); assert.equal(result.taskIds.length, 10)
      for (const kind of ['publication', 'run']) {
        assert.equal(result.rows[kind].length, 10)
        assert.ok(result.rows[kind].every(row => result.taskIds.includes(row.issueId)))
      }
    })
  } finally {
    try { if (schemaCreated) await db.query('DROP SCHEMA domain_history_fixture_1782 CASCADE') }
    finally { await db.end() }
  }
})
