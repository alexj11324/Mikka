// Prepared only. Requires a separately reviewed, enabled job with its own PG17 service.
// No URL argument, production configuration, auth, OIDC, model or business API.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('../../', import.meta.url))
const config = JSON.parse(readFileSync(new URL('./group-audit-offline-proof.json', import.meta.url), 'utf8'))
const auditSql = readFileSync(new URL('./group-stop-audit.sql', import.meta.url), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const run = promisify(execFile)
const BASE_URL = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_e2e'
const ADMIN_URL = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/postgres'
const CLONE_URL = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/orvilo_mvp'
const owner = 'OFtPbAHifGBAOYiek9hd3w', workspace = '0a700222-137b-4bca-b86d-a74b8fdffc21'
const botIds = ['9df34d90-6db6-407e-a2d2-bfd4ac616c58', '8ff8b30e-2eb9-48bd-987f-4cbf048944d7']
const CANARY = 'GROUP_AUDIT_SYNTHETIC_CONTENT_NEVER_IN_REPORT'
const report = { schemaVersion: 1, kind: 'isolated_pg17_original_group_audit', status: 'failed',
  sourceCommit: config.sourceCommit, sourceTree: config.sourceTree, auditSqlSha256: hash(auditSql),
  startedAt: new Date().toISOString(), cases: [], auditSqlCalls: 0,
  syntheticDataOnly: true, productionAcceptance: false, productionRequests: 0, modelRequests: 0, oidc: false,
  terminalSemantics: 'Existing product contract is source-pinned; this helper does not fabricate production host terminal evidence.',
  cleanup: { seedPoolClosedBeforeClone: false, workerSessionClosed: false, clonePoolClosed: false,
    ownedCloneCreated: false, ownedCloneDropped: false, adminClosed: false, failures: [] } }
let stage = 'guards', output, seedPool, clonePool, admin, worker
const safeFailure = error => ({ name: ['Error', 'AssertionError', 'TypeError'].includes(error?.name) ? error.name : 'Error',
  ...(typeof error?.code === 'string' && /^(?:[0-9A-Z]{5}|ERR_ASSERTION)$/.test(error.code) ? { code: error.code } : {}),
  ...(typeof error?.position === 'string' && /^\d{1,8}$/.test(error.position) ? { sqlPosition: Number(error.position) } : {}) })
const persist = () => { if (output) writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
const parents = sha => [...git(['cat-file', '-p', sha]).matchAll(/^parent ([0-9a-f]{40})$/gm)].map(row => row[1])

async function identity(pool, database) {
  const row = (await pool.query("SELECT current_database() AS database, current_schema() AS schema, session_user AS role, current_setting('server_version_num')::int AS version")).rows[0]
  assert.deepEqual({ database: row.database, schema: row.schema, role: row.role }, { database, schema: 'public', role: 'e2e' })
  assert(row.version >= 170000 && row.version < 180000, 'pg17_required')
  return row
}

async function audit(pool, fixture, name, args = [owner, workspace, fixture.group, fixture.message, fixture.title]) {
  stage = name; report.auditSqlCalls++; persist()
  const client = await pool.connect()
  let value
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await client.query(auditSql, args)
    assert.equal(result.rowCount, 1, 'one_audit_row_required')
    value = result.rows[0].audit
    assert.equal(JSON.stringify(value).includes(CANARY), false, 'audit_must_not_return_content')
  } finally {
    try { await client.query('ROLLBACK') } finally { client.release() }
  }
  const row = { case: name, audit: value, status: 'assertions_pending' }
  report.cases.push(row); persist()
  return row
}
const pass = row => { row.status = 'passed'; persist() }
function stoppedSnapshot(audit, scenario) {
  assert.equal(audit.scopeMatched, true)
  assert.equal(audit.membership.intact, true)
  assert.equal(audit.turn.status, 'failed'); assert.equal(audit.turn.isStopped, true)
  assert.equal(audit.turn.hasOtherError, false); assert.equal(audit.turn.traceStatus, 'stopped')
  assert.equal(audit.turn.agentActive, false); assert.equal(audit.turn.botActive, false)
  assert.equal(audit.turn.activeRunId, null); assert.equal(audit.turn.nextDecisionAt, null)
  assert.deepEqual([audit.activeSession.locks, audit.activeSession.held, audit.activeSession.waiters], [0, 0, 0])
  assert.equal(audit.cancellationFeedbackCount, 1)
  assert.deepEqual([audit.trace.generateCount, audit.trace.delegateCount, audit.trace.taskEventCount, audit.trace.unknownEvents], [2, 0, 0, 0])
  assert.deepEqual([audit.delegation.bindings, audit.delegation.receipts], [0, 0])
  assert.deepEqual([audit.private.foreignScopeLinks, audit.private.invalidMemberships, audit.private.unexpectedAuthors], [0, 0, 0])
  assert.deepEqual([audit.public.otherUserRoots, audit.public.unexpectedAuthors, audit.private.otherAnchorLinks], [0, 0, 0])
  if (scenario === 'public') {
    assert.deepEqual([audit.public.replyCount, audit.trace.publicPublishCount, audit.public.totalGroupMessages], [1, 1, 2])
    assert.deepEqual([audit.private.linkCount, audit.private.actualMessages, audit.private.declaredMessages, audit.trace.privatePublishCount], [0, 0, 0, 0])
    assert.equal(audit.public.rows[0].authorFixture, 'haiku')
  } else {
    assert.deepEqual([audit.public.replyCount, audit.trace.publicPublishCount, audit.public.totalGroupMessages], [0, 0, 1])
    assert.deepEqual([audit.private.linkCount, audit.private.actualMessages, audit.private.declaredMessages, audit.trace.privatePublishCount], [1, 1, 1, 1])
    assert.equal(audit.private.links[0].ownedScope, true); assert.equal(audit.private.rows[0].authorFixture, 'haiku')
  }
}

async function seedGroup(pool, scenario) {
  const fixture = { group: randomUUID(), message: randomUUID(), title: `Synthetic group audit ${scenario}`, privateId: null }
  await pool.query('INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy","lastPosition","leadBotId") VALUES($1,$2,\'group\',$3,$4,$5,$6)',
    [fixture.group, workspace, fixture.title, owner, scenario === 'public' ? 2 : 1, botIds[0]])
  await pool.query('INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,\'user\',$2,\'owner\'),($1,\'bot\',$3,\'member\'),($1,\'bot\',$4,\'member\')', [fixture.group, owner, ...botIds])
  await pool.query('INSERT INTO conversation_messages(id,"conversationId",position,"authorType","authorId",body) VALUES($1,$2,1,\'user\',$3,$4)', [fixture.message, fixture.group, owner, CANARY])
  const publishType = scenario === 'public' ? 'publish' : 'private_publish'
  const trace = { status: 'stopped', finishedAt: new Date().toISOString(), events: [
    { type: 'generate', memberId: botIds[0] }, { type: publishType, memberId: botIds[0] }, { type: 'generate', memberId: botIds[1] }], privateText: CANARY }
  await pool.query('INSERT INTO group_turns("messageId","conversationId","userId",status,error,trace) VALUES($1,$2,$3,\'failed\',\'stopped\',$4)', [fixture.message, fixture.group, owner, trace])
  await pool.query('INSERT INTO group_decision_feedback(id,"conversationId","messageId","userId",source,kind) VALUES($1,$2,$3,$4,\'human_cancellation\',\'cancelled_turn\')', [randomUUID(), fixture.group, fixture.message, owner])
  if (scenario === 'public') {
    await pool.query('INSERT INTO conversation_messages(id,"conversationId",position,"authorType","authorId",body,"replyToId") VALUES($1,$2,2,\'bot\',$3,$4,$5)', [randomUUID(), fixture.group, botIds[0], CANARY, fixture.message])
  } else {
    fixture.privateId = randomUUID()
    await pool.query('INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy","lastPosition") VALUES($1,$2,\'agent_dm\',\'Synthetic private exchange\',$3,1)', [fixture.privateId, workspace, owner])
    await pool.query('INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,\'bot\',$2,\'member\'),($1,\'bot\',$3,\'member\')', [fixture.privateId, ...botIds])
    await pool.query('INSERT INTO conversation_messages(id,"conversationId",position,"authorType","authorId",body) VALUES($1,$2,1,\'bot\',$3,$4)', [randomUUID(), fixture.privateId, botIds[0], CANARY])
    await pool.query('INSERT INTO conversation_links(id,"sourceConversationId","linkedConversationId","anchorPosition","firstPosition","lastPosition","messageCount") VALUES($1,$2,$3,1,1,1,1)', [randomUUID(), fixture.group, fixture.privateId])
  }
  return fixture
}

async function main() {
  assert.equal(process.argv.length, 2, 'no_connection_arguments')
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.GROUP_AUDIT_OFFLINE_EXECUTE, '1', 'offline_helper_disabled')
  assert.equal(process.env.GITHUB_REF, `refs/heads/${config.branch}`)
  for (const name of ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL']) assert.equal(process.env[name], BASE_URL, 'fixed_ephemeral_target_required')
  for (const name of ['VERCEL', 'VERCEL_ENV', 'ORVILO_DATABASE_URL']) assert(!process.env[name], 'unexpected_database_environment')
  assert.equal(config.schemaVersion, 1); assert.equal(hash(auditSql), config.auditSqlSha256)
  const head = git(['rev-parse', 'HEAD'])
  assert.equal(process.env.GITHUB_SHA, head)
  assert.deepEqual(parents(head), [config.sourceCommit], 'exact_helper_parent_required')
  assert.equal(git(['rev-parse', `${config.sourceCommit}^{tree}`]), config.sourceTree)
  assert.deepEqual(git(['diff', '--name-only', config.sourceCommit, head]).split('\n').sort(), [...config.helperPaths].sort())
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'tracked_source_must_be_unchanged')
  assert(process.env.RUNNER_TEMP?.startsWith('/'), 'runner_temp_required')
  output = join(process.env.RUNNER_TEMP, 'group-audit-offline-proof'); mkdirSync(output, { recursive: true })
  report.helperCommit = head; report.helperTree = git(['rev-parse', 'HEAD^{tree}']); persist()
  const { assertE2eTarget, disposableDatabase } = await import('../../tests/helpers/e2e-target.mjs')
  assertE2eTarget(BASE_URL); assert(disposableDatabase(process.env), 'existing_e2e_guard_required')
  const { Pool } = await import('pg')
  const options = connectionString => ({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000 })
  seedPool = new Pool(options(BASE_URL)); stage = 'fresh_service'
  report.service = await identity(seedPool, 'mikka_e2e')
  assert.equal((await seedPool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0, 'requires_fresh_job_service')
  assert.equal((await seedPool.query("SELECT count(*)::int AS n FROM pg_database WHERE datname='orvilo_mvp'")).rows[0].n, 0, 'clone_must_not_exist')
  await seedPool.end(); seedPool = null
  stage = 'tracked_migrations'
  try {
    const migration = await run(process.execPath, ['scripts/migrate.mjs'], { cwd: root, timeout: 180000, maxBuffer: 2_000_000,
      env: { ...process.env, MIGRATE: '1', MIKKA_RUN_MIGRATIONS: '1', VERCEL: '', VERCEL_ENV: '' } })
    writeFileSync(join(output, 'migrations.log'), migration.stdout + migration.stderr, { mode: 0o600 })
    report.migrationsExitCode = 0
  } catch (error) {
    writeFileSync(join(output, 'migrations.log'), String(error.stdout ?? '') + String(error.stderr ?? ''), { mode: 0o600 })
    report.migrationsExitCode = Number.isInteger(error.code) ? error.code : null
    throw error
  }
  seedPool = new Pool(options(BASE_URL)); stage = 'synthetic_seed'
  const { seedUser, seedWorkspace, seedBot } = await import('../../tests/support/workspace-admin-db.ts')
  const generatedOwner = await seedUser(seedPool, 'group-audit-owner')
  await seedPool.query('UPDATE "user" SET id=$1 WHERE id=$2', [owner, generatedOwner])
  const generatedWorkspace = await seedWorkspace(seedPool, owner, [], 'Synthetic group audit workspace')
  await seedPool.query('UPDATE mikka_workspaces SET id=$1 WHERE id=$2', [workspace, generatedWorkspace.id])
  await seedPool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,\'Synthetic owner\',\'synthetic-owner@example.invalid\',\'admin\',\'active\')', [workspace, owner])
  for (const [index, id] of botIds.entries()) {
    const created = await seedBot(seedPool, workspace, owner, `Synthetic bot ${index}`)
    await seedPool.query('UPDATE bots SET id=$1 WHERE id=$2', [id, created])
  }
  const foreignOwner = await seedUser(seedPool, 'group-audit-foreign')
  const foreignWorkspace = await seedWorkspace(seedPool, foreignOwner, [], 'Synthetic foreign workspace')
  const pub = await seedGroup(seedPool, 'public'), priv = await seedGroup(seedPool, 'private')
  const deniedDatabase = await audit(seedPool, pub, 'database_name_fence')
  assert.equal(deniedDatabase.audit.scopeMatched, false); assert.equal(deniedDatabase.audit.scope, null); pass(deniedDatabase)
  await seedPool.end(); seedPool = null; report.cleanup.seedPoolClosedBeforeClone = true
  stage = 'clone_exact_database_name'
  admin = new Pool(options(ADMIN_URL)); await identity(admin, 'postgres')
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='mikka_e2e'")).rows[0].n, 0, 'all_seed_connections_must_close')
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname='orvilo_mvp'")).rows[0].n, 0, 'clone_must_not_exist')
  await admin.query('CREATE DATABASE orvilo_mvp TEMPLATE mikka_e2e'); report.cleanup.ownedCloneCreated = true; persist()
  clonePool = new Pool(options(CLONE_URL)); report.clone = await identity(clonePool, 'orvilo_mvp')
  const publicCase = await audit(clonePool, pub, 'normal_public'); stoppedSnapshot(publicCase.audit, 'public'); pass(publicCase)
  const privateCase = await audit(clonePool, priv, 'normal_private'); stoppedSnapshot(privateCase.audit, 'private'); pass(privateCase)
  await clonePool.query('UPDATE group_turns SET status=\'running\',error=NULL,"botId"=$2 WHERE "messageId"=$1', [pub.message, botIds[0]])
  const active = await audit(clonePool, pub, 'active_turn_rejected')
  assert.equal(active.audit.scopeMatched, true); assert.equal(active.audit.turn.status, 'running'); assert.equal(active.audit.turn.botActive, true)
  assert.throws(() => stoppedSnapshot(active.audit, 'public')); pass(active)
  await clonePool.query('UPDATE group_turns SET status=\'failed\',error=\'stopped\',"botId"=NULL WHERE "messageId"=$1', [pub.message])
  const { openGroupTurnSession } = await import('../../lib/coordinator/group-turn-session.ts')
  worker = await openGroupTurnSession(clonePool)
  assert.equal((await worker.client.query("SELECT pg_try_advisory_lock(hashtextextended(current_database() || '.' || current_schema() || '.group-turn.' || $1,0)) AS acquired", [pub.group])).rows[0].acquired, true)
  const held = await audit(clonePool, pub, 'active_session_rejected')
  assert.deepEqual([held.audit.activeSession.locks, held.audit.activeSession.held, held.audit.activeSession.waiters], [1, 1, 0])
  assert.equal(held.audit.activeSession.rows[0].groupWorker, true); assert.throws(() => stoppedSnapshot(held.audit, 'public')); pass(held)
  await worker.close(); worker = null; report.cleanup.workerSessionClosed = true
  const closed = await audit(clonePool, pub, 'physical_session_closed'); stoppedSnapshot(closed.audit, 'public'); pass(closed)
  const foreign = await audit(clonePool, pub, 'foreign_owner_rejected', [foreignOwner, workspace, pub.group, pub.message, pub.title])
  assert.equal(foreign.audit.scopeMatched, false); assert.equal(foreign.audit.scope, null); assert.equal(foreign.audit.public.replyCount, 0)
  assert.throws(() => stoppedSnapshot(foreign.audit, 'public')); pass(foreign)
  await clonePool.query('UPDATE conversations SET "workspaceId"=$2,"createdBy"=$3 WHERE id=$1', [priv.privateId, foreignWorkspace.id, foreignOwner])
  const foreignPrivate = await audit(clonePool, priv, 'foreign_private_scope_rejected')
  assert.equal(foreignPrivate.audit.scopeMatched, true); assert.equal(foreignPrivate.audit.private.foreignScopeLinks, 1)
  assert.equal(foreignPrivate.audit.private.actualMessages, 0); assert.equal(foreignPrivate.audit.private.links[0].privateConversationId, null)
  assert.equal(JSON.stringify(foreignPrivate.audit).includes(priv.privateId), false)
  assert.throws(() => stoppedSnapshot(foreignPrivate.audit, 'private')); pass(foreignPrivate)
  assert.equal(report.auditSqlCalls, 8); assert.equal(report.cases.length, 8)
  report.status = 'passed_synthetic_sql_proof_only'
}

try { await main() }
catch (error) { report.failure = { stage, ...safeFailure(error) }; process.exitCode = 1 }
finally {
  for (const [label, resource] of [['workerSessionClosed', worker], ['clonePoolClosed', clonePool], ['seedPoolClosed', seedPool]]) {
    if (!resource) continue
    try { if (label === 'workerSessionClosed') await resource.close(); else await resource.end(); report.cleanup[label] = true }
    catch (error) { report.cleanup.failures.push({ resource: label, ...safeFailure(error) }); process.exitCode = 1 }
  }
  if (admin && report.cleanup.ownedCloneCreated) {
    try {
      // No FORCE, backend termination or removal of an existing/unacknowledged database.
      await admin.query('DROP DATABASE orvilo_mvp'); report.cleanup.ownedCloneDropped = true
    } catch (error) { report.cleanup.failures.push({ resource: 'ownedClone', ...safeFailure(error) }); process.exitCode = 1 }
  }
  if (admin) try { await admin.end(); report.cleanup.adminClosed = true } catch (error) { report.cleanup.failures.push({ resource: 'admin', ...safeFailure(error) }); process.exitCode = 1 }
  if (report.cleanup.failures.length) report.status = 'cleanup_failed'
  report.finishedAt = new Date().toISOString(); persist()
  console.log(JSON.stringify({ status: report.status, stage, cases: report.cases.length, auditSqlCalls: report.auditSqlCalls,
    sourceCommit: config.sourceCommit, cleanupFailures: report.cleanup.failures.length, productionAcceptance: false }))
}
