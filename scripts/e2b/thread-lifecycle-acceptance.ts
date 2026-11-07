/** Real E2B provider integration + disposable PostgreSQL, with injected transport
 * faults. No model, subscription, API-server or daemon acceptance is implied.
 *
 * NODE_ENV=test node --import ./scripts/server-test.mjs --import tsx \
 *   scripts/e2b/thread-lifecycle-acceptance.ts [--check]
 * E2B_API_KEY is supplied only in this process's environment. --check performs
 * the same local target/source/template guards without allocating resources.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { NotFoundError, Sandbox, SandboxNotFoundError } from 'e2b'
import { APPLICATION_DATABASE_URLS, assertE2eTarget, disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { assertDevLocal } from '../dev-local/guard.mjs'
import { cloudAcceptanceRelease } from './cloud-acceptance-release.mjs'
import { orderMigrations } from '../migration-order.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { taskTemplate } from '../../lib/secrets/e2b-runtime'
import type { ThreadProviderInfo } from '../../lib/cloud-computer/thread-lifecycle-provider'
import type { ThreadMachineFence } from '../../lib/cloud-computer/thread-machines'

type Env = Record<string, string | undefined>
const PURPOSE = 'thread-lifecycle-provider-acceptance'
const owns = (metadata: Record<string, string>, acceptance: string, revision: string) =>
  metadata.purpose === PURPOSE && metadata.acceptance === acceptance && metadata.sourceCommit === revision

type AcceptanceSandbox = { sandboxId: string; metadata: Record<string, string> }
type AcceptancePages = { readonly hasNext: boolean; nextItems(): Promise<AcceptanceSandbox[]> }

/** An empty discovery result cannot acknowledge an allocation whose response
 * was lost. Keep that outcome unconfirmed rather than authorizing more work. */
export async function discoverAcceptanceSandboxes({ ownedIds, acceptance, sourceCommit, list }: {
  ownedIds: Set<string>; acceptance: string; sourceCommit: string; list(): AcceptancePages
}) {
  const pages = list()
  while (pages.hasNext) for (const found of await pages.nextItems()) {
    assert.ok(owns(found.metadata, acceptance, sourceCommit), 'Cleanup metadata mismatch')
    ownedIds.add(found.sandboxId)
  }
  assert.ok(ownedIds.size > 0, 'acceptance_creation_cleanup_unconfirmed')
}

/** Fail before DB connections or provider calls; never return a credential. */
export function validateThreadLifecycleTarget(env: Env, checkOnly = false) {
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

function missing(error: unknown) {
  return error instanceof NotFoundError || error instanceof SandboxNotFoundError
    || Boolean(error && typeof error === 'object' && 'status' in error && error.status === 404)
}

export async function runThreadLifecycleAcceptance({ checkOnly = false } = {}) {
  const { database: base, template } = validateThreadLifecycleTarget(process.env, checkOnly)
  // Also rejects dirty/untracked runtime source and mismatched worker digests.
  const release = cloudAcceptanceRelease()
  assert.equal(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', 'workflows'],
    { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' }).trim(), '', 'Lifecycle Workflow source must also be committed and clean')
  if (checkOnly) return { kind: PURPOSE, status: 'preflight_passed', ...release, template,
    allocated: false, subscriptionAcceptance: false }

  const acceptance = randomUUID(), database = `thread_lifecycle_${acceptance.replaceAll('-', '')}_e2e`
  const target = new URL(base); target.pathname = `/${database}`
  const savedEnv = new Map(APPLICATION_DATABASE_URLS.map(name => [name, process.env[name]]))
  const { E2B_API_KEY: apiKey } = process.env
  assert.ok(apiKey, 'E2B_API_KEY is required for provider acceptance')
  const connection = {
    apiKey,
    proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
    requestTimeoutMs: 15_000,
  }
  const metadata = { purpose: PURPOSE, acceptance, sourceCommit: release.sourceCommit }
  const admin = new Pool({ connectionString: base.toString(), max: 1, connectionTimeoutMillis: 10_000 })
  const ownedIds = new Set<string>(), passed: string[] = []
  const counters = { info: 0, keepAlive: 0, pause: 0, kill: 0 }
  const cancelled = new AbortController()
  const cancel = () => cancelled.abort(new Error('acceptance_interrupted'))
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  let pool: Pool | undefined, appPool: Pool | undefined, databaseCreated = false, createAttempted = false
  let restoreProvider: (() => void) | undefined, failure: unknown, failed = false, stage = 'database'
  let result: Record<string, unknown> | undefined
  const cleanupErrors: unknown[] = []
  const cleanupVM = async (id: string) => {
    try { await Sandbox.kill(id, connection) } catch (error) { if (!missing(error)) throw error }
    try { await Sandbox.getInfo(id, connection); assert.fail('cleanup_vm_still_present') }
    catch (error) { if (!missing(error)) throw error }
  }
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`); databaseCreated = true
    pool = new Pool({ connectionString: target.toString(), max: 4, statement_timeout: 20_000, connectionTimeoutMillis: 10_000 })
    const migrations = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(migrations)).filter(name => name.endsWith('.sql')))) {
      cancelled.signal.throwIfAborted()
      await pool.query(await readFile(new URL(name, migrations), 'utf8'))
    }
    for (const name of APPLICATION_DATABASE_URLS) process.env[name] = target.toString()
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, database)
    appPool = (await import('../../lib/db')).pool
    const { reconcileThreadMachine } = await import('../../lib/cloud-computer/thread-lifecycle')
    const { parkThreadMachine, threadMachineAction, threadMachineProvider } = await import('../../lib/cloud-computer/thread-machines')
    const owned = (id: string) => { assert.ok(ownedIds.has(id), 'Provider operations are restricted to this acceptance VM'); cancelled.signal.throwIfAborted() }
    const info = async (id: string): Promise<ThreadProviderInfo> => {
      owned(id); counters.info++
      try {
        const observed = await Sandbox.getInfo(id, connection)
        return { state: observed.state === 'paused' ? 'paused' : 'running', endAt: observed.state === 'paused' ? null : observed.endAt.getTime() }
      } catch (error) { if (missing(error)) return { state: 'missing', endAt: null }; throw error }
    }
    const provider = { info, keepAlive: async (id: string, _owner: string, timeoutMs: number) => {
      owned(id); counters.keepAlive++; await Sandbox.setTimeout(id, timeoutMs, connection)
    } }
    const kill = async (id: string) => { owned(id); counters.kill++; await Sandbox.kill(id, connection) }
    const originalKill = threadMachineProvider.kill, originalPrepareKill = threadMachineProvider.prepareKill
    threadMachineProvider.kill = kill
    threadMachineProvider.prepareKill = async () => kill
    restoreProvider = () => { threadMachineProvider.kill = originalKill; threadMachineProvider.prepareKill = originalPrepareKill }

    stage = 'create'; cancelled.signal.throwIfAborted()
    // This closed receipt precedes provider I/O, so even a lost create response
    // leaves the exact invocation metadata available for cleanup reconciliation.
    console.info(JSON.stringify({ kind: 'thread-lifecycle-provider-intent', acceptance,
      sourceCommit: release.sourceCommit, purpose: PURPOSE, observedAt: new Date().toISOString() }))
    createAttempted = true
    let sandbox = await Sandbox.create(template, { ...connection, metadata, idempotencyKey: acceptance,
      timeoutMs: 600_000, lifecycle: { onTimeout: 'kill', autoResume: false } })
    const sandboxId = sandbox.sandboxId; ownedIds.add(sandboxId)
    const markerPath = `/tmp/mikka-lifecycle-${acceptance}`, marker = `disposable-${acceptance}`
    await sandbox.files.write(markerPath, marker)
    const actor = { userId: `lifecycle-${acceptance}`, workspaceId: randomUUID() }
    const runId = randomUUID(), issueId = randomUUID(), botId = randomUUID(), deviceId = randomUUID(), agentId = randomUUID(), tokenId = randomUUID()
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Lifecycle acceptance',$2,true,now(),now())`, [actor.userId, `${acceptance}@example.invalid`])
    await pool.query(`INSERT INTO devices(id,"ownerId",name,kind) VALUES ($1,$2,'Disposable lifecycle VM','cloud')`, [deviceId, actor.userId])
    await pool.query(`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES ($1,$2,'codex','Unstarted fixture',$3)`, [agentId, actor.userId, deviceId])
    await pool.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Lifecycle fixture')`, [botId, actor.workspaceId, actor.userId])
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Lifecycle fixture','{"type":"doc","content":[]}','doing','normal','personal')`, [issueId, actor.userId])
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","botId","issueId","deviceId",status,prompt,"leaseExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,'running','No model execution',now()+interval '5 minutes')`, [runId, actor.userId, agentId, botId, issueId, deviceId])
    await pool.query(`INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`, [runId, botId, actor.workspaceId, actor.userId])
    await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","runningSince") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now())`, [runId, actor.workspaceId, actor.userId, botId, issueId, sandboxId, template, randomUUID(), deviceId])
    await pool.query(`INSERT INTO device_tokens(id,"userId",name,"tokenHash","boundDeviceId","expiresAt") VALUES ($1,$2,'Unusable synthetic token',$3,$4,now()+interval '1 hour')`, [tokenId, actor.userId, randomUUID(), deviceId])
    const row = async () => (await pool!.query('SELECT * FROM thread_machines WHERE "runId"=$1', [runId])).rows[0]
    const fence = async (): Promise<ThreadMachineFence> => { const machine = await row(); return { epoch: machine.epoch, sandboxId: machine.sandboxId } }
    let fault: 'none' | 'refuse' | 'lose-response' = 'none'
    const park: NonNullable<Parameters<typeof reconcileThreadMachine>[3]>['park'] = (p, a, id, expected) =>
      parkThreadMachine(p, a, id, async id => {
        owned(id)
        if (fault === 'refuse') throw Object.assign(new Error('injected_provider_refusal'), { status: 503 })
        counters.pause++; await Sandbox.pause(id, connection)
        if (fault === 'lose-response') throw new Error('injected_lost_pause_response')
      }, async () => null, undefined, expected)
    const dependencies = { provider, park }
    const reconcile = () => { cancelled.signal.throwIfAborted(); return reconcileThreadMachine(pool!, actor, runId, dependencies) }
    // Simulate the durable timer becoming due in this disposable DB fixture.
    // Deliberate retries advance only this row's deadline; no sleep loop is
    // needed and ordinary early replays still exercise production backoff.
    const makeDue = () => pool!.query('UPDATE thread_machines SET "lifecycleAt"=now() WHERE "runId"=$1', [runId])

    stage = 'active-monitor'
    assert.equal(typeof await reconcile(), 'number')
    assert.equal((await row()).lifecycle.phase, 'active')
    assert.ok((await row()).lifecycleAt && (await info(sandboxId)).endAt! > Date.now())
    passed.push(stage)

    // Synthetic terminal receipt: no native model/session was ever started.
    await pool.query(`UPDATE agent_runs SET status='succeeded',"leaseExpiresAt"=NULL,report=$2 WHERE id=$1`,
      [runId, JSON.stringify({ safePoint: { session: 'exited', checkpoint: 'unavailable', observedAt: new Date().toISOString() } })])
    stage = 'provider-refusal'; fault = 'refuse'
    assert.equal(typeof await reconcile(), 'number')
    assert.equal((await row()).state, 'running'); assert.equal((await row()).lifecycle.phase, 'pause_failed')
    assert.ok((await row()).lifecycleAt); assert.equal((await info(sandboxId)).state, 'running')
    const beforeEarlyReplay = { ...counters }
    assert.equal(await reconcile(), new Date((await row()).lifecycleAt).getTime())
    assert.deepEqual(counters, beforeEarlyReplay)
    passed.push(stage)

    stage = 'lost-pause-response'; fault = 'lose-response'
    await makeDue()
    assert.equal(typeof await reconcile(), 'number')
    assert.equal((await row()).state, 'running'); assert.equal((await info(sandboxId)).state, 'paused')
    const pauses = counters.pause; fault = 'none'; await makeDue(); await reconcile()
    assert.equal((await row()).state, 'paused'); assert.equal(counters.pause, pauses)
    assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [tokenId])).rows[0].revokedAt)
    passed.push(stage)

    // Resume the actual provider, then reconcile its durable task ledger. This
    // checks monitor reacquisition, not ensureThreadMachine's daemon bootstrap.
    stage = 'resume-monitor'
    sandbox = await Sandbox.connect(sandboxId, { ...connection, timeoutMs: 600_000 })
    assert.equal(await sandbox.files.read(markerPath), marker)
    await pool.query(`UPDATE agent_runs SET status='running',report=NULL,"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [runId])
    await pool.query(`UPDATE thread_machines SET epoch=epoch+1,lifecycle='{}',"lifecycleAt"=now() WHERE "runId"=$1`, [runId])
    const renewals = counters.keepAlive; await reconcile()
    assert.equal((await row()).state, 'running'); assert.equal((await row()).lifecycle.phase, 'active')
    assert.equal((await row()).lifecycle.owner, 'run-recovery'); assert.ok((await row()).lifecycleAt)
    assert.equal(counters.keepAlive, renewals + 1); passed.push(stage)

    stage = 'stale-epoch'
    const stale = await fence(), before = { ...counters }
    await makeDue()
    await reconcileThreadMachine(pool, actor, runId, { ...dependencies, provider: { ...provider, info: async id => {
      const observation = await info(id)
      await pool!.query(`UPDATE thread_machines SET epoch=epoch+1,lifecycle=lifecycle-'reconcileId'-'reconcileUntil',"lifecycleAt"=now() WHERE "runId"=$1`, [runId])
      return observation
    } } })
    await park(pool, actor, runId, stale)
    await threadMachineAction(pool, actor, runId, 'end', stale)
    assert.equal(counters.keepAlive, before.keepAlive); assert.equal(counters.pause, before.pause); assert.equal(counters.kill, before.kill)
    assert.equal((await info(sandboxId)).state, 'running'); assert.equal((await row()).epoch, stale.epoch + 1)
    passed.push(stage)

    stage = 'stop-idempotence'
    await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=now()-interval '31 seconds' WHERE id=$1`, [runId])
    await reconcile(); const stops = counters.pause; await reconcile()
    assert.equal((await row()).state, 'paused'); assert.equal(counters.pause, stops)
    assert.equal((await row()).sandboxId, sandboxId); assert.equal((await info(sandboxId)).state, 'paused')
    passed.push(stage)

    stage = 'end-idempotence'
    // Explicit end of this disposable task may discard its fixture marker.
    await threadMachineAction(pool, actor, runId, 'end', await fence())
    const kills = counters.kill
    await threadMachineAction(pool, actor, runId, 'end')
    assert.equal(counters.kill, kills); assert.equal(kills, 1)
    assert.equal((await row()).state, 'ended'); assert.equal((await row()).sandboxId, null)
    assert.equal((await info(sandboxId)).state, 'missing'); assert.equal(await reconcile(), false)
    passed.push(stage)
    result = { kind: PURPOSE, status: 'passed', acceptance, ...release, template, sandboxId, runId, cases: passed,
      subscriptionAcceptance: false, modelCalls: 0, resumeScope: 'provider-resume-to-controller-monitor', counters }
  } catch (error) { failed = true; failure = error }
  finally {
    restoreProvider?.()
    // Metadata recovers an allocation whose create response was lost. Only
    // this invocation's random ID + exact source can authorize its cleanup.
    if (createAttempted) {
      try {
        await discoverAcceptanceSandboxes({ ownedIds, acceptance, sourceCommit: release.sourceCommit,
          list: () => Sandbox.list({ ...connection, query: { metadata, state: ['running', 'paused'] } }) })
      } catch (error) { cleanupErrors.push(error) }
    }
    for (const id of ownedIds) {
      try { await cleanupVM(id) } catch (error) { cleanupErrors.push(error) }
    }
    try { if (databaseCreated) await dropTestDatabase(admin, database, pool, appPool); else await pool?.end() }
    catch (error) { cleanupErrors.push(error) }
    finally {
      try { await admin.end() } catch (error) { cleanupErrors.push(error) }
      for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
    }
  }
  if (cleanupErrors.length) throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], 'thread_lifecycle_acceptance_cleanup_failed')
  if (failed) throw new Error(`thread_lifecycle_acceptance_failed:${stage}`, { cause: failure })
  return { ...result, cleanup: { provider: 'confirmed_missing', database: 'dropped' } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv.slice(2).every(value => value === '--check'), 'Only --check is supported')
  void runThreadLifecycleAcceptance({ checkOnly: process.argv.includes('--check') }).then(report => console.log(JSON.stringify(report))).catch(error => {
    // Provider bodies, DB URLs and nested error messages never enter evidence.
    console.error(JSON.stringify({ kind: PURPOSE, status: 'failed', name: error instanceof AggregateError ? 'cleanup_failed' : 'acceptance_failed',
      subscriptionAcceptance: false }))
    process.exitCode = 1
  })
}
