/** Real E2B filesystem snapshot + one database restore transition.
 *
 * NODE_ENV=test node --import ./scripts/server-test.mjs --import tsx \
 *   scripts/e2b/thread-snapshot-acceptance.ts [--check]
 * E2B_API_KEY is supplied only in this process's environment. `--check`
 * performs the same local target/source/template guards without allocating.
 *
 * This script proves provider-level semantics: a task's marker file survives
 * create-snapshot -> kill -> create-from-snapshot. It then drives the real
 * `restoreThreadMachineFromSnapshot` transition against a disposable
 * PostgreSQL database with the real restored sandbox, recording the new
 * sandbox and the real `restore -> running` finish write. It does not start a
 * daemon, a model or a worker registration; the fake-worker registration path
 * is covered by lib/cloud-computer/thread-machine-snapshot.db.test.ts.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { Sandbox } from 'e2b'
import { APPLICATION_DATABASE_URLS, assertE2eTarget, disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { assertDevLocal } from '../dev-local/guard.mjs'
import { cloudAcceptanceRelease } from './cloud-acceptance-release.mjs'
import { orderMigrations } from '../migration-order.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import { taskTemplate } from '../../lib/secrets/e2b-runtime'

type Env = Record<string, string | undefined>
const PURPOSE = 'thread-snapshot-restore-acceptance'

/** Fail before DB connections or provider calls; never return a credential. */
export function validateThreadSnapshotTarget(env: Env, checkOnly = false) {
  assertDevLocal(env)
  assert.ok(disposableDatabase(env), 'Every application database must be a disposable loopback _e2e target')
  const database = assertE2eTarget(env.E2E_DATABASE_URL)
  assert.equal(env.NODE_ENV, 'test', 'Run the isolated integration driver with NODE_ENV=test')
  assert.ok(!env.WORKFLOW_TARGET_WORLD, 'The integration driver cannot target a deployed Workflow world')
  const template = taskTemplate('codex', env)
  if (!checkOnly) assert.ok(typeof env.E2B_API_KEY === 'string' && env.E2B_API_KEY.trim()
    && !/[\r\n\0]/.test(env.E2B_API_KEY), 'E2B_API_KEY is required in process memory')
  return { database, template }
}

const missing = (error: unknown) => Boolean(error && typeof error === 'object'
  && ((error as { status?: unknown }).status === 404 || (error as { statusCode?: unknown }).statusCode === 404))

export async function runThreadSnapshotAcceptance({ checkOnly = false } = {}) {
  const { database: base, template } = validateThreadSnapshotTarget(process.env, checkOnly)
  // Also rejects dirty/untracked runtime source and mismatched worker digests.
  const release = cloudAcceptanceRelease()
  if (checkOnly) return { kind: PURPOSE, status: 'preflight_passed', ...release, template, allocated: false }
  const acceptance = randomUUID(), database = `thread_snapshot_${acceptance.replaceAll('-', '')}_e2e`
  const target = new URL(base); target.pathname = `/${database}`
  const savedEnv = new Map(APPLICATION_DATABASE_URLS.map(name => [name, process.env[name]]))
  const { E2B_API_KEY: apiKey } = process.env
  assert.ok(apiKey, 'E2B_API_KEY is required for provider acceptance')
  const connection = { apiKey, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy, requestTimeoutMs: 15_000 }
  const admin = new Pool({ connectionString: base.toString(), max: 1, connectionTimeoutMillis: 10_000 })
  const ownedSandboxes = new Set<string>()
  let pool: Pool | undefined, appPool: Pool | undefined
  let databaseCreated = false, snapshot: { snapshotId: string } | undefined, restoreProvider: (() => void) | undefined
  const cleanupErrors: unknown[] = []
  let failure: unknown, failed = false, stage = 'database', result: Record<string, unknown> | undefined

  const cleanupSandbox = async (id: string) => {
    try { await Sandbox.kill(id, connection) } catch (error) { if (!missing(error)) throw error }
    try { await Sandbox.getInfo(id, connection); assert.fail('cleanup_sandbox_still_present') }
    catch (error) { if (!missing(error)) throw error }
  }

  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`); databaseCreated = true
    pool = new Pool({ connectionString: target.toString(), max: 4, statement_timeout: 20_000, connectionTimeoutMillis: 10_000 })
    const migrations = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(migrations)).filter(file => file.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name, migrations), 'utf8'))
    for (const name of APPLICATION_DATABASE_URLS) process.env[name] = target.toString()
    process.env.MIKKA_THREAD_SNAPSHOTS = '1'
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, database)
    appPool = (await import('../../lib/db')).pool

    const { restoreThreadMachineFromSnapshot, recordThreadSandbox } = await import('../../lib/cloud-computer/thread-machines')
    const { threadLifecycleProvider } = await import('../../lib/cloud-computer/thread-lifecycle-provider')
    const { finishThreadRegistration } = await import('../../lib/cloud-computer/thread-registration')

    stage = 'provider-create'
    const metadata = { purpose: PURPOSE, acceptance, sourceCommit: release.sourceCommit }
    const markerPath = `/tmp/mikka-snapshot-${acceptance}`, marker = `disposable-${acceptance}`
    let source = await Sandbox.create(template, { ...connection, metadata, idempotencyKey: acceptance,
      timeoutMs: 600_000, lifecycle: { onTimeout: 'kill', autoResume: false } })
    const sourceId = source.sandboxId
    ownedSandboxes.add(sourceId)
    await source.files.write(markerPath, marker)
    stage = 'provider-snapshot'
    const name = `mikka-thread-${acceptance.replaceAll('-', '')}`
    let snapshotMode: 'filesystem' | 'full' = 'filesystem'
    try { snapshot = await Sandbox.createSnapshot(sourceId, { ...connection, name, mode: 'filesystem' }) }
    catch (error) {
      if (!/snapshot_filesystem_only_(disabled|unsupported_node)/.test(error instanceof Error ? error.message : '')) throw error
      snapshotMode = 'full'
      snapshot = await Sandbox.createSnapshot(sourceId, { ...connection, name })
    }
    stage = 'provider-list'
    const pages = Sandbox.listSnapshots({ ...connection, sandboxId: sourceId, name }), listed: string[] = []
    while (pages.hasNext) listed.push(...(await pages.nextItems(connection)).map(row => row.snapshotId))
    assert.ok(listed.includes(snapshot.snapshotId), 'snapshot_identity_not_listed')
    stage = 'provider-source-kill'
    await cleanupSandbox(sourceId); ownedSandboxes.delete(sourceId)
    stage = 'database'
    const owner = `snapshot-${acceptance}`, workspaceId = randomUUID(), botId = randomUUID(), botDevice = randomUUID()
    const agentId = randomUUID(), runRepoId = randomUUID(), machineDevice = randomUUID(), machineRepoId = randomUUID()
    const issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID()
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Snapshot acceptance',$2,true,now(),now())`, [owner, `${acceptance}@example.invalid`])
    await seedFixtureWorkspace(pool, owner, 'team', workspaceId)
    await pool.query(`INSERT INTO devices(id,"ownerId",name,kind) VALUES ($1,$2,'Snapshot bot','cloud')`, [botDevice, owner])
    await pool.query(`INSERT INTO devices(id,"ownerId",name,kind) VALUES ($1,$2,'Task machine','cloud')`, [machineDevice, owner])
    await pool.query(`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES ($1,$2,'codex','Snapshot fixture',$3)`, [agentId, owner, botDevice])
    await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'v2/github.com/acme/app','https://github.com/acme/app.git')`, [runRepoId, botDevice, owner])
    await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'v2/github.com/acme/app','https://github.com/acme/app.git')`, [machineRepoId, machineDevice, owner])
    await pool.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Snapshot fixture')`, [botId, workspaceId, owner])
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Snapshot fixture','{"type":"doc","content":[]}','doing','normal','personal')`, [issueId, owner])
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","botId","issueId","deviceId","deviceRepoId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','No model execution')`, [runId, owner, agentId, botId, issueId, botDevice, runRepoId])
    await pool.query(`INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`, [runId, botId, workspaceId, owner])
    await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId","templateKind","filesystemSnapshotId","snapshotTakenAt","snapshotState","workerLeaseId","workerLeaseUntil")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paused',$9,$10,'codex',$11,now(),'ready',$12,now()+interval '15 minutes')`,
    [runId, workspaceId, owner, botId, issueId, sourceId, template, randomUUID(), machineDevice, machineRepoId, snapshot.snapshotId, leaseId])
    const before = (await pool.query('SELECT epoch FROM thread_machines WHERE "runId"=$1', [runId])).rows[0]
    stage = 'restore'
    const originalCreateFromSnapshot = threadLifecycleProvider.createFromSnapshot
    threadLifecycleProvider.createFromSnapshot = async (snapshotId, operationId, createMetadata) => {
      assert.equal(snapshotId, snapshot!.snapshotId)
      assert.equal(createMetadata.operationId, operationId)
      const restored = await Sandbox.create(snapshotId, { ...connection, metadata: createMetadata, idempotencyKey: operationId,
        timeoutMs: 15 * 60_000, lifecycle: { onTimeout: 'kill', autoResume: false } })
      ownedSandboxes.add(restored.sandboxId)
      return restored
    }
    restoreProvider = () => { threadLifecycleProvider.createFromSnapshot = originalCreateFromSnapshot }
    const actor = { userId: owner, workspaceId }
    const restored = await restoreThreadMachineFromSnapshot(pool, actor, runId, leaseId, { sandboxId: sourceId, kind: 'codex' }, template,
      { create: async () => { throw new Error('snapshot restore must not fall back to the template') } })
    assert.ok(restored, 'restore_transition_refused')
    assert.equal(await restored.sandbox.files.read(markerPath), marker, 'restored_filesystem_lost_marker')
    const transitioned = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [runId])).rows[0]
    assert.equal(transitioned.state, 'restore'); assert.equal(transitioned.sandboxId, null)
    assert.equal(transitioned.epoch, before.epoch + 1); assert.notEqual(transitioned.operationId, null)
    assert.equal(transitioned.filesystemSnapshotId, snapshot.snapshotId)
    stage = 'record-and-finish'
    assert.equal(await recordThreadSandbox(pool, runId, restored.sandbox.sandboxId, leaseId), true)
    const token = randomUUID().replaceAll('-', '').padEnd(64, 'a')
    await pool.query(`INSERT INTO device_tokens(id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt","lastUsedAt")
      VALUES ($1,$2,'Snapshot acceptance',$3,$4,$5,now()+interval '1 hour',now())`, [randomUUID(), owner, token, machineDevice, workspaceId])
    await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [machineDevice])
    const finishClient = await pool.connect()
    let finished: { rowCount: number | null } = { rowCount: 0 }
    try { finished = await finishThreadRegistration(finishClient, runId, leaseId, machineDevice, token, new Date(Date.now() - 1_000)) }
    finally { finishClient.release() }
    assert.equal(finished.rowCount, 1, 'restore_finish_not_recorded')
    const running = (await pool.query('SELECT state,"sandboxId","workerLeaseId","restoreStartedAt" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0]
    assert.deepEqual(running, { state: 'running', sandboxId: restored.sandbox.sandboxId, workerLeaseId: null, restoreStartedAt: null })
    stage = 'snapshot-delete'
    assert.equal(await Sandbox.deleteSnapshot(snapshot.snapshotId, connection), true)
    assert.equal(await Sandbox.deleteSnapshot(snapshot.snapshotId, connection), false, 'snapshot_delete_not_idempotent')
    result = { kind: PURPOSE, status: 'passed', acceptance, ...release, template, snapshotMode,
      sourceSandboxId: sourceId, restoredSandboxId: restored.sandbox.sandboxId, runId,
      cases: ['provider-create', 'provider-snapshot', 'provider-list', 'provider-source-kill', 'restore', 'record-and-finish', 'snapshot-delete'],
      workerAcceptance: false, subscriptionAcceptance: false, modelCalls: 0 }
    // The restored sandbox is owned by this acceptance; its kill is part of cleanup.
  } catch (error) { failed = true; failure = error }
  finally {
    restoreProvider?.()
    if (snapshot) {
      try { await Sandbox.deleteSnapshot(snapshot.snapshotId, connection) }
      catch (error) { if (!missing(error)) cleanupErrors.push(error) }
    }
    for (const id of ownedSandboxes) {
      try { await cleanupSandbox(id) } catch (error) { cleanupErrors.push(error) }
    }
    try { if (databaseCreated) await dropTestDatabase(admin, database, pool, appPool); else await pool?.end() }
    catch (error) { cleanupErrors.push(error) }
    finally {
      try { await admin.end() } catch (error) { cleanupErrors.push(error) }
      for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
      delete process.env.MIKKA_THREAD_SNAPSHOTS
    }
  }
  if (cleanupErrors.length) throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], 'thread_snapshot_acceptance_cleanup_failed')
  if (failed) throw new Error(`thread_snapshot_acceptance_failed:${stage}`, { cause: failure })
  return { ...result, cleanup: { provider: 'confirmed_missing', database: 'dropped' } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv.slice(2).every(value => value === '--check'), 'Only --check is supported')
  void runThreadSnapshotAcceptance({ checkOnly: process.argv.includes('--check') }).then(report => console.log(JSON.stringify(report))).catch(error => {
    // Provider bodies, DB URLs and nested error messages never enter evidence.
    console.error(JSON.stringify({ kind: PURPOSE, status: 'failed', name: error instanceof AggregateError ? 'cleanup_failed' : 'acceptance_failed',
      workerAcceptance: false, subscriptionAcceptance: false }))
    process.exitCode = 1
  })
}
