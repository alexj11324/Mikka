// Explicit local PostgreSQL 17 container drill. It creates new databases and retains them and its evidence.
// Run: OPS_POSTGRES_URL=postgresql://postgres@127.0.0.1:55599/postgres node --conditions=react-server --import ./tests/support/server-only-loader.mjs --import tsx scripts/ops/drill.mjs
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Pool } from 'pg'
import { backupIsolated, isolatedTarget, restoreIsolated } from './isolated-recovery.mjs'
import { actionableAlerts, databaseSignals, notifyAlerts } from './monitor.mjs'
import { repairDrillFaults } from './drill-state.mjs'

const container = process.env.OPS_POSTGRES_CONTAINER ?? 'mikka-aggregate-number-postgres'
if (!process.env.OPS_POSTGRES_URL) throw Error('opsExplicitPostgresRequired')
const base = new URL(process.env.OPS_POSTGRES_URL), suffix = randomBytes(4).toString('hex')
const url = name => { const value = new URL(base); value.pathname = `/${name}`; return value.toString() }
const targets = await Promise.all(['main', 'workspace'].map(role => isolatedTarget(url(`mikka_ops_${role}_${suffix}_e2e`), container)))
const restored = await Promise.all(['main', 'workspace'].map(role => isolatedTarget(url(`mikka_ops_restored_${role}_${suffix}_e2e`), container)))
const root = await mkdtemp(join(tmpdir(), 'mikka-ops-drill-')), admin = new Pool({ connectionString: url('postgres'), max: 1 })
for (const target of targets) await admin.query(`CREATE DATABASE "${target.database}"`)
await admin.end()
process.env.MIKKA_DATABASE_URL = targets[0].url; process.env.DATABASE_URL = targets[1].url
process.env.MIGRATE = '1'; process.env.VERCEL_ENV = 'development'
const migrationLog = execFileSync(process.execPath, ['scripts/migrate.mjs'], { env: process.env, maxBuffer: 2_000_000 })
await writeFile(join(root, 'migrations.log'), migrationLog, { mode: 0o600 })
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const toolSourcesSha256 = createHash('sha256').update(Buffer.concat(await Promise.all(['scripts/ops/drill.mjs', 'scripts/ops/drill-state.mjs', 'scripts/ops/isolated-recovery.mjs', 'scripts/ops/monitor.mjs', 'lib/request-log.ts'].map(file => readFile(file))))).digest('hex')
const sourcePatchSha256 = createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'])).digest('hex')
const { applyAccountDeletionManifest, exportAccountDeletionManifest, requestAccountDeletion, resumeAccountDeletion } = await import('../../lib/account/deletion-jobs.ts')
const main = new Pool({ connectionString: targets[0].url, max: 5 }), workspace = new Pool({ connectionString: targets[1].url, max: 5 })
const survivor = `ops-survivor-${suffix}`, deleted = `ops-deleted-${suffix}`, ws = randomUUID(), deletedWs = randomUUID(), issue = randomUUID(), agent = randomUUID(), run = randomUUID(), approval = randomUUID(), token = randomUUID(), effect = randomUUID()
const objectsDirectory = join(root, 'source-objects'), backupDirectory = join(root, 'backup'), restoredObjects = join(root, 'restored-objects')
await mkdir(objectsDirectory, { mode: 0o700 }); await mkdir(join(objectsDirectory, deleted), { mode: 0o700 })
const evidenceBytes = Buffer.from('Mikka controlled run evidence\n'), deletedKey = `${deleted}/deleted-evidence.txt`
await writeFile(join(objectsDirectory, 'run-evidence.txt'), evidenceBytes, { mode: 0o600 })
await writeFile(join(objectsDirectory, deletedKey), 'deleted account file', { mode: 0o600 })
const key = randomBytes(32), failures = [], objectives = { localRpoMs: 60_000, localRtoMs: 120_000 }
const options = { mainPool: main, workspacePool: workspace, externalCleanup: async () => [], deleteObject: async () => {} }
let sinkRefuse = false; const receivedAlerts = []
const server = createServer(async (request, response) => { let body = ''; for await (const chunk of request) body += chunk
  receivedAlerts.push({ receivedAt: new Date().toISOString(), event: JSON.parse(body) }); response.writeHead(sinkRefuse ? 503 : 204); response.end() }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
const sink = `http://127.0.0.1:${server.address().port}/internal-alerts`
const onFailure = async notice => (await notifyAlerts([notice], { sink })).healthy
try {
  for (const user of [survivor, deleted]) await main.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
  for (const [id, owner] of [[ws, survivor], [deletedWs, deleted]]) {
    await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,$3)', [id, owner, 'Controlled recovery workspace'])
    await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,\'admin\')', [id, owner, `${owner}@example.invalid`])
  }
  await main.query('INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,\'Original backup task\',\'{}\',\'todo\',\'normal\')', [issue, survivor])
  await main.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',\'Recovery fixture\')', [agent, survivor])
  await main.query('INSERT INTO agent_runs(id,"userId","agentId","issueId",status,"createdAt","leaseExpiresAt") VALUES($1,$2,$3,$4,\'running\',now()-interval \'10 minutes\',now()-interval \'5 minutes\')', [run, survivor, agent, issue])
  await main.query('INSERT INTO pending_actions(id,"userId",action,input) VALUES($1,$2,\'controlled.noop\',\'{}\')', [approval, survivor])
  await main.query('INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)', [token, survivor, createHash('sha256').update(randomBytes(32)).digest('hex')])
  await main.query('INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey",status,"attemptToken","updatedAt") VALUES($1::uuid,$2,$3,\'{}\',$1::text,\'executing\',$4,now()-interval \'10 minutes\')', [effect, survivor, ws, randomUUID()])
  await main.query('INSERT INTO account_storage_retirements("userId","storageKey") VALUES($1,$2)', [deleted, deletedKey])
  await main.query('INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,"createdAt") VALUES($1::uuid,$2,\'user_message\',$1::text,\'{}\',now()-interval \'10 minutes\')', [randomUUID(), survivor])
  const metrics = await databaseSignals(main)
  assert.equal(metrics.databaseAvailable, 1); assert.equal(metrics.staleWake, 1); assert.equal(metrics.expiredRunLease, 1); assert.equal(metrics.staleEffect, 1)
  const fired = await notifyAlerts(actionableAlerts({ requests: {}, database: metrics }), { sink })
  assert.equal(fired.healthy, true)
  const deliveredBeforeRepeat = receivedAlerts.length
  assert.equal((await notifyAlerts(actionableAlerts({ requests: {}, database: metrics }), { sink, state: fired.state })).healthy, true)
  assert.equal(receivedAlerts.length, deliveredBeforeRepeat)
  const backup = await backupIsolated({ targets, objectsDirectory, outputDirectory: backupDirectory, key, sourceSha, migrationsDirectory: 'drizzle', vaultProbe: async () => true, quiesced: { writersStopped: true, workersStopped: true }, onFailure })
  await main.query('UPDATE issues SET title=\'Committed after backup\' WHERE id=$1', [issue])
  await main.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [token])
  const requested = await requestAccountDeletion(deleted, `${deleted}@example.invalid`, randomUUID(), options); assert.equal(requested.ok, true)
  const pending = await exportAccountDeletionManifest(options)
  assert.equal((await resumeAccountDeletion(requested.id, options)).stage, 'completed')
  const deletionManifest = await exportAccountDeletionManifest(options), deletionObservedAt = new Date().toISOString()
  const deletionManifestSha256 = createHash('sha256').update(JSON.stringify(deletionManifest)).digest('hex')
  const failureAt = new Date(), input = { targets: restored, backupDirectory, objectsDirectory: restoredObjects, key,
    expectedManifestSha256: backup.manifestSha256, migrationsDirectory: 'drizzle', deletionManifest, deletionManifestSha256,
    deletionObservedAt, applyDeletions: applyAccountDeletionManifest, vaultProbe: async () => true, onFailure }
  async function denied(name, changed, pattern) { await assert.rejects(restoreIsolated({ ...input, ...changed }), pattern); failures.push(name) }
  await denied('wrong-independent-manifest-anchor', { expectedManifestSha256: '0'.repeat(64) }, /recoveryManifestMismatch/)
  await denied('wrong-migration-inventory', { migrationsDirectory: objectsDirectory }, /recoverySchemaMismatch/)
  await denied('vault-unavailable', { vaultProbe: async () => false }, /recoveryVaultUnavailable/)
  await denied('stale-current-deletion-journal', { deletionObservedAt: new Date(Date.now() - 600_000).toISOString() }, /recoveryCurrentDeletionJournalRequired/)
  const payload = join(backupDirectory, 'objects.enc'), original = await readFile(payload)
  await writeFile(payload, Buffer.from('corrupt')); await denied('corrupt-object-bundle', {}, /recoveryPayloadMismatch/); await writeFile(payload, original)
  await rename(payload, `${payload}.missing`); await denied('missing-object-bundle', {}, /ENOENT/); await rename(`${payload}.missing`, payload)
  await assert.rejects(applyAccountDeletionManifest(pending, { mainPool: main, workspacePool: workspace }), /accountDeletionManifestHasPendingJobs/); failures.push('pending-deletion-journal')
  const restoredResult = await restoreIsolated(input)
  const checkMain = new Pool({ connectionString: restored[0].url }), checkWorkspace = new Pool({ connectionString: restored[1].url })
  try {
    assert.equal((await checkMain.query('SELECT title FROM issues WHERE id=$1', [issue])).rows[0].title, 'Original backup task')
    assert.equal((await checkMain.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [deleted])).rows[0].n, 0)
    assert.equal((await checkWorkspace.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [deletedWs])).rows[0].n, 0)
    assert.equal((await checkMain.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [survivor])).rows[0].n, 1)
    assert.equal((await checkWorkspace.query('SELECT count(*)::int n FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [ws, survivor])).rows[0].n, 1)
    assert.ok((await checkMain.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [token])).rows[0].revokedAt)
    assert.equal((await checkMain.query('SELECT status FROM pending_actions WHERE id=$1', [approval])).rows[0].status, 'declined')
    assert.equal((await checkMain.query('SELECT status FROM operation_ledger WHERE "operationId"=$1', [effect])).rows[0].status, 'uncertain')
    assert.deepEqual(await readFile(join(restoredObjects, 'run-evidence.txt')), evidenceBytes)
    await assert.rejects(readFile(join(restoredObjects, deletedKey)), /ENOENT/)
  } finally { await checkMain.end(); await checkWorkspace.end() }
  await denied('existing-target-database', {}, /recoveryTargetExists/)
  const unreachable = new Pool({ connectionString: 'postgresql://postgres@127.0.0.1:1/no_e2e', connectionTimeoutMillis: 500 })
  let dbFailure
  try { dbFailure = await databaseSignals(unreachable) } catch { dbFailure = { databaseAvailable: 0 } } finally { await unreachable.end() }
  assert.equal(dbFailure.databaseAvailable, 0)
  sinkRefuse = true
  const sinkFailure = await notifyAlerts(actionableAlerts({ requests: {}, database: dbFailure }), { sink }); assert.equal(sinkFailure.healthy, false)
  sinkRefuse = false
  const dbAlert = await notifyAlerts(actionableAlerts({ requests: {}, database: dbFailure }), { sink, state: sinkFailure.state }); assert.equal(dbAlert.healthy, true)
  // Repair only this run's controlled fault fixtures. No provider was ever called for this injected operation,
  // so failed is definitive no-effect evidence here; this is not a recipe for clearing a real uncertain action.
  await repairDrillFaults(main, { ownerId: survivor, runId: run, effectIds: [effect] })
  const recoveredMetrics = await databaseSignals(main)
  assert.equal(recoveredMetrics.databaseAvailable, 1)
  assert.equal(recoveredMetrics.staleWake, 0); assert.equal(recoveredMetrics.expiredRunLease, 0); assert.equal(recoveredMetrics.staleEffect, 0)
  const recoveredAlerts = actionableAlerts({ requests: {}, database: recoveredMetrics })
  assert.deepEqual(recoveredAlerts.map(alert => alert.id), ['dispatch-start'], 'the live faults recover, but the failed dispatch remains in its SLO window')
  const recovery = await notifyAlerts(recoveredAlerts, { sink, state: { ...fired.state, ...dbAlert.state } }); assert.equal(recovery.healthy, true)
  const report = { version: 1, sourceSha, sourcePatchSha256, toolSourcesSha256, environment: 'Linux, local PostgreSQL 17 existing Docker loopback; no application or worker connected',
    databaseNames: [...targets, ...restored].map(target => target.database), objectives, backupManifestSha256: backup.manifestSha256,
    deletionManifestSha256, failureAt: failureAt.toISOString(), rpoObservedMs: failureAt.getTime() - Date.parse(backup.manifest.capturedAt),
    ...restoredResult, deniedFailures: failures, monitorSignals: metrics, monitorFiringDelivered: fired.deliveries.length,
    monitorRecoveryDelivered: recovery.deliveries.length, recoveredMonitorSignals: recoveredMetrics, retainedWindowedAlerts: recoveredAlerts.map(alert => alert.id), restoreFailureNotices: receivedAlerts.filter(row => row.event.id.startsWith('restore-blocked:')).length, sinkFailureVisibleAndRetried: true, receivedAlerts, limitations: ['No cloud PITR/cross-region/storage-vendor or production KMS test', 'No full login-chat-provider end-to-end or hosted alert schedule evidence', 'Targets remain quarantined; no external effects replayed', 'Test encryption key exists in process memory only; retained encrypted bundle is not a reusable production backup'] }
  assert.ok(report.rpoObservedMs <= objectives.localRpoMs); assert.ok(report.restoreDurationMs <= objectives.localRtoMs)
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ evidenceDirectory: root, ...report }))
} finally {
  key.fill(0); await Promise.all([main.end(), workspace.end()]); await new Promise(resolve => server.close(resolve))
  // Ambient module pools were constructed but never queried; explicit pools performed every deletion.
}
