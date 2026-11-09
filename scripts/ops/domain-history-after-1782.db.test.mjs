/** Required isolated PG17 proof. Every ID below is a disposable synthetic
 * fixture; production BINDING stays null until real before bytes exist. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { EPIC_MIGRATIONS, snapshot as snapshotBefore } from './domain-history-before-1782.mjs'
import { snapshotAfter, SQL } from './domain-history-after-1782.mjs'

const FIXTURE_URL = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_domain_history_1782_fixture'
const id = value => '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
const hash = value => createHash('sha256').update(value).digest('hex')
const taskIds = [id(1), id(2)], workspaceId = id(900), foreignWorkspace = id(901)
const scope = { ownerId: 'synthetic-reader', adminId: 'synthetic-policy-admin', workspaceKind: 'team', workspaceId,
  candidateTaskIds: taskIds, taskIds, taskOwners: { [id(1)]: 'synthetic-creator-1', [id(2)]: 'synthetic-creator-2' },
  taskAccess: Object.fromEntries(taskIds.map(value => [value, { mode: 'live', deletedAt: null }])) }
const pairs = [taskIds, taskIds.map(value => scope.taskOwners[value]), workspaceId]
const deletedAt = '2026-11-08T11:22:33.444Z'

test('PG17 preserves exact old rows while rejecting changed bindings and immutable data', async t => {
  if (process.env.DOMAIN_HISTORY_TEST_DATABASE_URL !== FIXTURE_URL
    || process.env.MIKKA_DATABASE_URL !== undefined || process.env.DATABASE_URL !== undefined) throw Error('fixture_target_refused')
  assert.ok(process.env.DOMAIN_HISTORY_DEPENDENCIES, 'fixture_driver_missing')
  const { Client } = createRequire(resolve(process.env.DOMAIN_HISTORY_DEPENDENCIES, 'package.json'))('pg')
  const db = new Client({ connectionString: FIXTURE_URL, connectionTimeoutMillis: 10000, query_timeout: 25000,
    application_name: 'mikka-1782-domain-history-after-synthetic-gate' })
  await db.connect()
  let created = false
  try {
    const version = Number((await db.query('SHOW server_version_num')).rows[0].server_version_num)
    assert.ok(version >= 170000 && version < 180000, 'fixture_requires_pg17')
    await db.query('CREATE SCHEMA domain_history_after_fixture_1782'); created = true
    await db.query('SET search_path = domain_history_after_fixture_1782, pg_catalog')
    await db.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY);
      CREATE TABLE issues (id uuid PRIMARY KEY, "userId" text NOT NULL, "workspaceId" uuid,
        "ownershipState" text NOT NULL, scope text NOT NULL, "issuedIdentifier" text, content jsonb NOT NULL);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, "issueId" uuid NOT NULL, "userId" text NOT NULL,
        "workspaceId" uuid, status text NOT NULL, "agentDefinition" jsonb NOT NULL, "baseBranch" text);
      CREATE TABLE run_publications ("runId" uuid PRIMARY KEY, "issueId" uuid NOT NULL, "userId" text NOT NULL,
        status text NOT NULL, identifier text, branch text, "baseBranch" text, "remoteKey" text);
      CREATE TABLE task_identifier_aliases ("issueId" uuid NOT NULL, "ownerId" text NOT NULL,
        "workspaceId" uuid NOT NULL, identifier text NOT NULL, kind text NOT NULL)`)
    const seed = async ({ deleted = false, legacy = false, splitHistory = false } = {}) => {
      const fixtureScope = { ...scope, taskOwners: { ...scope.taskOwners },
        taskAccess: structuredClone(scope.taskAccess) }
      if (deleted) {
        fixtureScope.taskOwners[id(1)] = scope.ownerId
        fixtureScope.taskAccess[id(1)] = { mode: 'owned_deleted', deletedAt }
      }
      await db.query('TRUNCATE task_identifier_aliases, run_publications, agent_runs, issues, schema_migrations')
      await db.query("INSERT INTO schema_migrations VALUES ('synthetic_before_epic')")
      for (let n = 1; n <= 2; n++) {
        const metadata = n === 1 && deleted ? { deletedAt } : {}
        const content = { type: 'doc', attrs: legacy && n === 1 ? { mikka: null, orvilo: metadata } : { mikka: metadata } }
        await db.query('INSERT INTO issues (id,"userId","workspaceId","ownershipState",scope,"issuedIdentifier",content) VALUES ($1,$2,$3,\'bound\',$4,$5,$6::jsonb)',
          [id(n), fixtureScope.taskOwners[id(n)], workspaceId, n === 1 ? 'personal' : 'workspace', n === 1 ? '' : 'OLD-2', JSON.stringify(content)])
        await db.query('INSERT INTO agent_runs VALUES ($1,$2,$3,$4,\'succeeded\',$5::jsonb,\'main\')',
          [id(100 + n), id(n), 'synthetic-executor-' + n, workspaceId,
            JSON.stringify({ privateDefinition: 'never-transport-this-definition', ...(n === 1 ? { projectExecution: { version: 1 } } : {}) })])
        await db.query('INSERT INTO run_publications VALUES ($1,$2,$3,\'published\',$4,\'private-branch\',\'main\',\'private-repo\')',
          [id(100 + n), id(n), 'synthetic-executor-' + n, 'PUB-' + n])
      }
      // Extra ended Run without a publication proves the two frozen ID sets
      // remain independent throughout the after comparison.
      await db.query('INSERT INTO agent_runs VALUES ($1,$2,\'synthetic-extra-executor\',$3,\'stopped\',\'{}\',\'main\')',
        [id(201), id(1), workspaceId])
      if (splitHistory) {
        await db.query('DELETE FROM agent_runs WHERE id=$1', [id(201)])
        await db.query("UPDATE agent_runs SET status='running' WHERE id=$1", [id(101)])
        await db.query('DELETE FROM run_publications WHERE "runId"=$1', [id(102)])
      }
      const beforeObserved = []
      const snapshot = await snapshotBefore(db, fixtureScope, value => beforeObserved.push(value))
      assert.deepEqual(beforeObserved.find(value => value.normalApiAccessRechecked), {
        normalApiAccessRechecked: true, authorizedLive: deleted ? 1 : 2, authorizedOwnedDeleted: deleted ? 1 : 0,
      })
      assert.deepEqual(beforeObserved.find(value => value.publicationCounts), {
        publicationCounts: { receipts: splitHistory ? 1 : 2, published: splitHistory ? 1 : 2,
          runMissing: 0, issueMismatch: 0, executorMismatch: 0,
          workspaceNull: 0, workspaceDifferent: 0, verified: splitHistory ? 1 : 2 },
        publicationClassification: 'published_receipts_first_failed_guard',
      })
      assert.deepEqual(beforeObserved.find(value => value.selectedCoverage), {
        historySelectionPolicy: 'collection_published_and_ended_with_coverage_anchors',
        selectedCoverage: { tasks: 2, publishedTasks: splitHistory ? 1 : 2,
          endedTasks: splitHistory ? 1 : 2, projectSnapshotRuns: splitHistory ? 0 : 1 },
      })
      const before = { version: 2, readerSha256: hash(scope.ownerId), policyAdminSha256: hash(scope.adminId),
        workspaceId, workspaceKind: 'team', taskIds, snapshot }
      const binding = { applicationSha: 'b'.repeat(40), beforeMainSha: 'a'.repeat(40), beforeOpsSource: 'c'.repeat(40),
        beforeCollectorSha256: 'd'.repeat(64), beforeRunId: 1234, beforeRunAttempt: 1, beforeWorkflowId: 4321,
        artifactId: 6789, artifactSizeBytes: 1, archiveSha256: 'e'.repeat(64), beforeSha256: 'f'.repeat(64), receiptSha256: '0'.repeat(64),
        workspaceId, workspaceKind: 'team', readerSha256: before.readerSha256, policyAdminSha256: before.policyAdminSha256,
        taskCreatorSha256: Object.fromEntries(taskIds.map(value => [value, hash(fixtureScope.taskOwners[value])])),
        taskIds, publicationIds: snapshot.rows.publication.map(row => row.id), runIds: snapshot.rows.run.map(row => row.id) }
      for (const name of EPIC_MIGRATIONS.canonical) await db.query('INSERT INTO schema_migrations VALUES ($1)', [name])
      await db.query('UPDATE issues SET "issuedIdentifier"=\'PUB-1\' WHERE id=$1', [id(1)])
      for (let n = 1; n <= 2; n++) for (const [kind, identifier] of [['issued', n === 1 ? 'PUB-1' : 'OLD-2'], ['publication', 'PUB-' + n]])
        await db.query('INSERT INTO task_identifier_aliases VALUES ($1,$2,$3,$4,$5)', [id(n), fixtureScope.taskOwners[id(n)], workspaceId, identifier, kind])
      return { before, binding, scope: fixtureScope }
    }
    await t.test('shared creators, first issuance, private digests and real rollback match', async () => {
      const { before, binding } = await seed(), observed = []
      const result = await snapshotAfter(db, scope, before, binding, value => observed.push(value))
      assert.deepEqual(result.comparison.preserved, { task: 2, publication: 2, run: 3 })
      assert.equal(result.comparison.firstIdentifiersVerified, 1)
      assert.equal(result.comparison.existingIdentifiersPreserved, 1)
      assert.deepEqual(result.rows.task.map(row => row.creatorSha256), taskIds.map(value => hash(scope.taskOwners[value])))
      assert.equal(observed.at(-1).transactionRolledBack, true)
      assert.equal((await db.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value, 'off')
      for (const value of ['private-branch', 'private-repo', 'never-transport-this-definition', ...Object.values(scope.taskOwners)])
        assert.ok(!JSON.stringify(result).includes(value))
    })
    await t.test('old publication and Run status changes never hide their frozen IDs', async () => {
      const { before, binding } = await seed()
      await db.query("UPDATE run_publications SET status='blocked'")
      await db.query("UPDATE agent_runs SET status='running'")
      const result = await snapshotAfter(db, scope, before, binding)
      assert.deepEqual(result.comparison.preserved, { task: 2, publication: 2, run: 3 })
    })
    await t.test('separate published and ended Tasks preserve the exact independent old ID sets after status changes', async () => {
      const { before, binding } = await seed({ splitHistory: true }), observed = []
      assert.deepEqual(binding.publicationIds, [id(101)])
      assert.deepEqual(binding.runIds, [id(102)])
      assert.notEqual(before.snapshot.rows.publication[0].issueId, before.snapshot.rows.run[0].issueId)
      await db.query("UPDATE run_publications SET status='blocked'")
      await db.query("UPDATE agent_runs SET status='running'")
      const result = await snapshotAfter(db, scope, before, binding, value => observed.push(value))
      assert.deepEqual(result.comparison.preserved, { task: 2, publication: 1, run: 1 })
      assert.deepEqual(result.rows.publication, before.snapshot.rows.publication)
      assert.deepEqual(result.rows.run, before.snapshot.rows.run)
      assert.deepEqual(result.addedHistory, { publications: 0, runs: 0 })
      assert.equal(observed.at(-1).transactionRolledBack, true)
    })
    await t.test('new same-Workspace history is counted separately and foreign additions are excluded', async () => {
      const { before, binding } = await seed()
      for (const [runId, tenant] of [[id(301), workspaceId], [id(302), foreignWorkspace]]) {
        await db.query('INSERT INTO agent_runs VALUES ($1,$2,\'synthetic-new-executor\',$3,\'succeeded\',\'{}\',\'main\')', [runId, id(1), tenant])
        await db.query('INSERT INTO run_publications VALUES ($1,$2,\'synthetic-new-executor\',\'published\',\'NEW\',\'new-branch\',\'main\',\'private-repo\')', [runId, id(1)])
      }
      const result = await snapshotAfter(db, scope, before, binding)
      assert.deepEqual(result.comparison.preserved, { task: 2, publication: 2, run: 3 })
      assert.deepEqual(result.addedHistory, { publications: 1, runs: 1 })
    })
    for (const [name, mutation, args, kind] of [
      ['Run tenant changed', 'UPDATE agent_runs SET "workspaceId"=$1 WHERE id=$2', [foreignWorkspace, id(201)], 'run'],
      ['Run tenant removed', 'UPDATE agent_runs SET "workspaceId"=NULL WHERE id=$1', [id(201)], 'run'],
      ['publication executor changed', 'UPDATE run_publications SET "userId"=$1 WHERE "runId"=$2', ['wrong-executor', id(101)], 'publication'],
      ['publication Task changed', 'UPDATE run_publications SET "issueId"=$1 WHERE "runId"=$2', [id(2), id(101)], 'publication'],
      ['Task creator changed', 'UPDATE issues SET "userId"=$1 WHERE id=$2', ['changed-creator', id(1)], 'run'],
      ['Task tenant changed', 'UPDATE issues SET "workspaceId"=$1 WHERE id=$2', [foreignWorkspace, id(1)], 'run'],
    ]) await t.test(name + ' remains a returned old ID and explicitly fails binding', async () => {
      const { before, binding } = await seed(); await db.query(mutation, args)
      const frozen = kind === 'run' ? binding.runIds : binding.publicationIds
      const rows = (await db.query(SQL[kind], [frozen, ...pairs])).rows
      assert.deepEqual(rows.map(row => row.id), frozen)
      assert.ok(rows.some(row => row.bindingValid === false))
      await assert.rejects(snapshotAfter(db, scope, before, binding), error => error.code === 'database_binding')
    })
    for (const [name, mutation, args] of [
      ['publication missing', 'DELETE FROM run_publications WHERE "runId"=$1', [id(101)]],
      ['unpublished old Run missing', 'DELETE FROM agent_runs WHERE id=$1', [id(201)]],
      ['publication branch rewritten', 'UPDATE run_publications SET branch=\'rewritten\' WHERE "runId"=$1', [id(101)]],
      ['frozen execution rewritten', 'UPDATE agent_runs SET "agentDefinition"=\'{"changed":true}\' WHERE id=$1', [id(201)]],
      ['old Run moved between authorized Tasks', 'UPDATE agent_runs SET "issueId"=$1 WHERE id=$2', [id(2), id(201)]],
      ['issued alias wrong creator', 'UPDATE task_identifier_aliases SET "ownerId"=\'wrong\' WHERE kind=\'issued\'', []],
      ['publication alias missing', 'DELETE FROM task_identifier_aliases WHERE kind=\'publication\'', []],
      ['canonical migration missing', 'DELETE FROM schema_migrations WHERE name=$1', [EPIC_MIGRATIONS.canonical[0]]],
      ['legacy migration unexpectedly recorded', 'INSERT INTO schema_migrations VALUES ($1)', [EPIC_MIGRATIONS.legacy[0]]],
    ]) await t.test(name + ' is rejected with actual rollback', async () => {
      const { before, binding } = await seed(); await db.query(mutation, args)
      const observed = []
      await assert.rejects(snapshotAfter(db, scope, before, binding, value => observed.push(value)))
      assert.equal(observed.at(-1).transactionRolledBack, true)
    })
    await t.test('swapping two frozen creators never cross-matches independent allowed sets', async () => {
      const { before, binding } = await seed(), wrongPairs = [taskIds, [...pairs[1]].reverse(), workspaceId]
      assert.equal((await db.query(SQL.task, wrongPairs)).rows.length, 0)
      const rows = (await db.query(SQL.run, [binding.runIds, ...wrongPairs])).rows
      assert.equal(rows.length, 3); assert.ok(rows.every(row => row.bindingValid === false))
      const changed = { ...scope, taskOwners: { [id(1)]: scope.taskOwners[id(2)], [id(2)]: scope.taskOwners[id(1)] } }
      await assert.rejects(snapshotAfter(db, changed, before, binding), error => error.code === 'database_binding')
    })
    await t.test('owner-deleted Task retains complete published and ended history with a hashed access proof', async () => {
      const { before, binding, scope: authorized } = await seed({ deleted: true }), observed = []
      const result = await snapshotAfter(db, authorized, before, binding, row => observed.push(row))
      assert.deepEqual(result.comparison.preserved, { task: 2, publication: 2, run: 3 })
      assert.equal(result.rows.task[0].accessMode, 'owned_deleted')
      assert.equal(result.rows.task[0].deletedAtSha256, hash(deletedAt))
      assert.equal(result.rows.task[0].creatorSha256, hash(scope.ownerId))
      assert.ok(observed.some(row => row.normalApiAccessRechecked && row.authorizedOwnedDeleted === 1))
      assert.ok(!JSON.stringify(result).includes(deletedAt))
    })
    await t.test('a fresh live proof after owner restoration preserves all original Run and publication digests', async () => {
      const { before, binding, scope: authorized } = await seed({ deleted: true }), frozen = structuredClone(before)
      await db.query('UPDATE issues SET content=$1::jsonb WHERE id=$2',
        [JSON.stringify({ type: 'doc', attrs: { mikka: {} } }), id(1)])
      authorized.taskAccess[id(1)] = { mode: 'live', deletedAt: null }
      const result = await snapshotAfter(db, authorized, before, binding)
      assert.equal(result.rows.task[0].accessMode, 'live'); assert.equal(result.rows.task[0].deletedAtSha256, null)
      assert.deepEqual(result.rows.run, before.snapshot.rows.run)
      assert.deepEqual(result.rows.publication, before.snapshot.rows.publication)
      assert.deepEqual(before, frozen)
    })
    await t.test('JSONB null modern metadata preserves the owner-deleted legacy proof', async () => {
      const { before, binding, scope: authorized } = await seed({ deleted: true, legacy: true })
      const result = await snapshotAfter(db, authorized, before, binding)
      assert.equal(result.rows.task[0].deletedAtSha256, hash(deletedAt))
      assert.deepEqual(result.comparison.preserved, { task: 2, publication: 2, run: 3 })
    })
    await t.test('a modern live metadata object takes precedence over an old legacy deletion marker', async () => {
      const { before, binding, scope: authorized } = await seed({ deleted: true })
      await db.query('UPDATE issues SET content=$1::jsonb WHERE id=$2',
        [JSON.stringify({ type: 'doc', attrs: { mikka: { deletedAt: null }, orvilo: { deletedAt } } }), id(1)])
      authorized.taskAccess[id(1)] = { mode: 'live', deletedAt: null }
      const result = await snapshotAfter(db, authorized, before, binding)
      assert.equal(result.rows.task[0].accessMode, 'live')
    })
    await t.test('JSONB null cannot make a still-deleted legacy Task satisfy a live API proof', async () => {
      const { before, binding, scope: authorized } = await seed({ deleted: true, legacy: true }), observed = []
      authorized.taskAccess[id(1)] = { mode: 'live', deletedAt: null }
      await assert.rejects(snapshotAfter(db, authorized, before, binding, row => observed.push(row)), /database_binding/)
      assert.equal(observed.at(-1).transactionRolledBack, true)
    })
    for (const [name, statement, args] of [
      ['creator no longer matches the API owner', 'UPDATE issues SET "userId"=\'changed-owner\' WHERE id=$1', [id(1)]],
      ['Workspace no longer matches the authorized target', 'UPDATE issues SET "workspaceId"=$1 WHERE id=$2', [foreignWorkspace, id(1)]],
      ['deletion timestamp changed since API authorization', 'UPDATE issues SET content=$1::jsonb WHERE id=$2',
        [JSON.stringify({ type: 'doc', attrs: { mikka: { deletedAt: '2026-11-08T11:22:34.444Z' } } }), id(1)]],
      ['restoration occurred without a fresh live proof', 'UPDATE issues SET content=$1::jsonb WHERE id=$2',
        [JSON.stringify({ type: 'doc', attrs: { mikka: {} } }), id(1)]],
    ]) await t.test('owner-deleted evidence fails when ' + name, async () => {
      const { before, binding, scope: authorized } = await seed({ deleted: true }), observed = []
      await db.query(statement, args)
      await assert.rejects(snapshotAfter(db, authorized, before, binding, row => observed.push(row)), /database_binding/)
      assert.equal(observed.at(-1).transactionRolledBack, true)
    })
    await t.test('owner-deleted authorization cannot replace the required real published history', async () => {
      const { scope: authorized } = await seed({ deleted: true })
      await db.query('DELETE FROM schema_migrations WHERE name=ANY($1::text[])', [EPIC_MIGRATIONS.canonical])
      await db.query("UPDATE run_publications SET status='blocked'")
      const observed = []
      await assert.rejects(snapshotBefore(db, authorized, row => observed.push(row)), /history_missing/)
      assert.ok(observed.some(row => row.normalApiAccessRechecked && row.authorizedOwnedDeleted === 1))
      assert.equal(observed.at(-1).transactionRolledBack, true)
    })
  } finally {
    try { if (created) await db.query('DROP SCHEMA domain_history_after_fixture_1782 CASCADE') }
    finally { await db.end() }
  }
})
