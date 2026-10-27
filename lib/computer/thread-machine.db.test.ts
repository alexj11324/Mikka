import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { ThreadMachines, type ThreadMachineProvider } from './thread-machine'
import { SubagentQueue } from './subagent-queue'
import { SubagentStore } from './subagent-store'
import { coordinatorWebBot } from './coordinator-bot'
import { SubagentApprovals } from './subagent-approval'
import { startSuggestion, attachSuggestionRun, attachSuggestionSubagent, failUnattachedSuggestions } from '@/lib/suggestions/execution'
import { claimThreadWorkerLease, provisionThreadDevice, releaseThreadWorkerLease } from './thread-device'
import { renewCloudDeviceToken } from './cloud-device'
import { startThreadWorker } from './thread-worker'
import { cloudDeviceIsActive } from './device-scope'
import { ThreadDesktopStore } from './thread-desktop'
import { renewThreadLifetime } from './thread-heartbeat'
import type * as e2bProvider from './e2b-provider'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer database test URL required')

test('thread lifecycle serializes creation and respects owner, idle and terminal boundaries', { skip: !databaseURL }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseURL!).hostname))
  const schema = `thread_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const actor = { userId: 'alice', workspaceId: randomUUID() }
  const botId = randomUUID(), runId = randomUUID()
  let creates = 0, resumes = 0, pauses = 0, kills = 0, loseCreateResponse = true
  const operationIds: string[] = []
  const provider: ThreadMachineProvider = {
    async create(snapshot, id, operationId) {
      creates++; operationIds.push(operationId)
      assert.equal(snapshot, 'snapshot-fixture'); assert.equal(id, runId)
      if (loseCreateResponse) { loseCreateResponse = false; throw new Error('response lost') }
      return { sandboxId: 'sandbox-fixture' }
    },
    async resume() { resumes++ }, async pause() { pauses++ }, async kill() { kills++ },
  }
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice'), ('bob');
      CREATE TABLE bots (id uuid, "workspaceId" uuid, "ownerId" text, name text, UNIQUE(id,"workspaceId","ownerId"));
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text NOT NULL,status text NOT NULL,"startedAt" timestamptz,"deviceId" uuid,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY REFERENCES agent_runs(id),"botId" uuid NOT NULL,"workspaceId" uuid NOT NULL,"ownerId" text NOT NULL);
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,name text,kind text,enabled boolean NOT NULL DEFAULT true,"lastSeenAt" timestamptz);
      CREATE TABLE device_tokens (id uuid PRIMARY KEY,"userId" text,name text,"tokenHash" text,"boundDeviceId" uuid,"boundWorkspaceId" uuid,"expiresAt" timestamptz,"revokedAt" timestamptz,"lastUsedAt" timestamptz,"createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE cloud_machines ("workspaceId" uuid,"ownerId" text,"deviceId" uuid,"sandboxId" text);
      CREATE TABLE workspace_computer_policies ("workspaceId" uuid,permission text,version integer);
      CREATE TABLE local_computer_reviews (id uuid,"userId" text,"runId" uuid,"deviceId" uuid,digest text,call jsonb,decision boolean,"expiresAt" timestamptz,"seenAt" timestamptz);
      CREATE TABLE suggestions (id uuid PRIMARY KEY,"userId" text NOT NULL,source text,action text,title text,"actionTitle" text,url text,actor text,shown boolean,"dismissedAt" timestamptz);
      CREATE TABLE coordinator_events (id uuid PRIMARY KEY,"userId" text,"botId" uuid,kind text,"dedupeKey" text UNIQUE,payload jsonb,tier text)`)
    const sql = await readFile(new URL('../../drizzle/20261027180000_thread_machines_and_bot_subagents.sql', import.meta.url), 'utf8')
    await pool.query(sql); await pool.query(sql)
    await pool.query(await readFile(new URL('../../drizzle/20261027180002_thread_worker_leases.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027180004_thread_results.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027180005_thread_desktops.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027180006_subagent_runtime.sql', import.meta.url), 'utf8'))
    const coordinatorBotSql = await readFile(new URL('../../drizzle/20261027180007_coordinator_web_bots.sql', import.meta.url), 'utf8')
    await pool.query(coordinatorBotSql); await pool.query(coordinatorBotSql)
    const approvalSql = await readFile(new URL('../../drizzle/20261027180008_subagent_approvals.sql', import.meta.url), 'utf8')
    await pool.query(approvalSql); await pool.query(approvalSql)
    await pool.query(await readFile(new URL('../../drizzle/20261027180009_subagent_worker.sql', import.meta.url), 'utf8'))
    const suggestionSql = await readFile(new URL('../../drizzle/20261027180001_suggestion_execution.sql', import.meta.url), 'utf8')
    await pool.query(suggestionSql); await pool.query(suggestionSql)
    await pool.query('INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,$4)', [botId, actor.workspaceId, actor.userId, 'Test Bot'])
    const identities = await Promise.all(Array.from({ length: 4 }, () => coordinatorWebBot(pool, actor)))
    assert.equal(new Set(identities).size, 1)
    assert.notEqual(identities[0], await coordinatorWebBot(pool, { ...actor, userId: 'bob' }))
    await pool.query('INSERT INTO agent_runs (id,"userId",status) VALUES ($1,$2,$3)', [runId, actor.userId, 'queued'])
    await pool.query('INSERT INTO computer_run_bindings VALUES ($1,$2,$3,$4)', [runId, botId, actor.workspaceId, actor.userId])
    await pool.query('INSERT INTO workspace_snapshots ("workspaceId","ownerId","snapshotId","dependencyFingerprint","sourceRevision") VALUES ($1,$2,$3,$4,$5)', [actor.workspaceId, actor.userId, 'snapshot-fixture', 'fingerprint', 'revision'])
    const machines = new ThreadMachines(pool, provider)
    await assert.rejects(machines.wake({ ...actor, userId: 'bob' }, runId), /unavailable/)
    await assert.rejects(machines.wake(actor, runId), /response lost/)
    assert.deepEqual(await Promise.all([machines.wake(actor, runId), machines.wake(actor, runId)]), ['sandbox-fixture', 'sandbox-fixture'])
    assert.equal(creates, 2); assert.equal(operationIds[0], operationIds[1]); assert.equal(resumes, 1)
    const leaseId = randomUUID()
    assert.equal(await claimThreadWorkerLease(pool, { ...actor, userId: 'bob' }, runId, 'sandbox-fixture', leaseId), false)
    assert.equal(await claimThreadWorkerLease(pool, actor, runId, 'sandbox-fixture', leaseId), true)
    assert.equal(await claimThreadWorkerLease(pool, actor, runId, 'sandbox-fixture', randomUUID()), false)
    await assert.rejects(provisionThreadDevice(pool, { ...actor, userId: 'bob' }, runId, new Date(Date.now() + 60_000), leaseId), /unavailable/)
    const credential = await provisionThreadDevice(pool, actor, runId, new Date(Date.now() + 30 * 60_000), leaseId)
    assert.equal(await cloudDeviceIsActive(pool, credential.deviceId, actor.workspaceId, actor.userId), true)
    assert.equal(await cloudDeviceIsActive(pool, credential.deviceId, actor.workspaceId, 'bob'), false)
    assert.equal(await cloudDeviceIsActive(pool, credential.deviceId, randomUUID(), actor.userId), false)
    const tokenId = (await pool.query('SELECT id FROM device_tokens WHERE "boundDeviceId"=$1', [credential.deviceId])).rows[0].id
    assert.ok(await renewCloudDeviceToken(pool, { ...actor, deviceId: credential.deviceId, tokenId }))
    assert.equal(await renewCloudDeviceToken(pool, { ...actor, userId: 'bob', deviceId: credential.deviceId, tokenId }), null)
    await releaseThreadWorkerLease(pool, actor, runId, leaseId)
    const sha = 'a'.repeat(40)
    let handoff: { deviceId: string; credential: string } | undefined
    const sandbox = { sandboxId: 'sandbox-fixture', files: {
      read: async () => sha,
      write: async (_path: string, data: string) => { handoff = JSON.parse(data) },
    }, commands: { run: async (command: string) => {
      assert.ok(!command.includes('orv_'), 'credential must not enter a command')
      if (command.includes('bin/cloud-worker.ts')) {
        assert.ok(handoff)
        await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [handoff.deviceId])
        await pool.query('UPDATE device_tokens SET "lastUsedAt"=now() WHERE "boundDeviceId"=$1 AND "revokedAt" IS NULL', [handoff.deviceId])
      }
    } } } as unknown as Parameters<typeof startThreadWorker>[3]
    const workerRuntime = { ensureHostedRunnerImage: async () => {} } as unknown as typeof e2bProvider
    await assert.rejects(startThreadWorker(pool, { ...actor, userId: 'bob' }, runId, sandbox, 'https://mikka.example', sha, workerRuntime), /busy or unavailable/)
    const worker = await startThreadWorker(pool, actor, runId, sandbox, 'https://mikka.example', sha, workerRuntime)
    assert.equal(worker.deviceId, credential.deviceId)
    assert.equal((await startThreadWorker(pool, actor, runId, sandbox, 'https://mikka.example', sha, workerRuntime)).deviceId, credential.deviceId)
    await pool.query(`UPDATE agent_runs SET status='running',"deviceId"=$2,"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [runId, credential.deviceId])
    await pool.query(`UPDATE thread_machines SET "lastActiveAt"=now()-interval '3 minutes' WHERE "runId"=$1`, [runId])
    const renewed: string[] = []
    const renew = async (id: string) => { renewed.push(id) }
    await renewThreadLifetime(pool, credential.deviceId, 'bob', [runId], renew)
    await renewThreadLifetime(pool, credential.deviceId, actor.userId, [randomUUID()], renew)
    await renewThreadLifetime(pool, credential.deviceId, actor.userId, [runId], renew)
    await renewThreadLifetime(pool, credential.deviceId, actor.userId, [runId], renew)
    assert.deepEqual(renewed, ['sandbox-fixture'])
    await assert.rejects(machines.pause(actor, runId), /not idle/)
    await assert.rejects(machines.end(actor, runId), /still active/)
    await pool.query('UPDATE agent_runs SET status=$2 WHERE id=$1', [runId, 'waiting_input'])
    await machines.pause(actor, runId); await machines.pause(actor, runId)
    assert.equal(pauses, 1)
    await machines.wake(actor, runId); assert.equal(resumes, 2)
    let installs = 0, displays = 0, syncedEpoch = -1
    const desktopRuntime = { threadMachineProvider: provider, connectComputer: async () => sandbox, computerState: async () => 'running',
      installComputerRuntime: async () => { installs++ }, startDesktop: async () => { displays++ },
      syncDesktopLease: async (_box: unknown, lease: { epoch: number }) => { syncedEpoch = lease.epoch },
      viewerGrant: async (_box: unknown, _lease: unknown, _userId: string, mode: string) => ({ url: `wss://fixture.invalid/${mode}`, expiresAt: new Date().toISOString() }),
    } as unknown as typeof e2bProvider
    const desktop = new ThreadDesktopStore(pool, desktopRuntime)
    await assert.rejects(desktop.operate({ ...actor, userId: 'bob' }, runId, 'wake'), { status: 404 })
    assert.equal((await desktop.state(actor, runId)).control, 'idle')
    await desktop.operate(actor, runId, 'wake')
    assert.equal(installs, 1); assert.equal(displays, 1)
    assert.equal((await desktop.operate(actor, runId, 'viewer', 'view'))?.url, 'wss://fixture.invalid/view')
    await assert.rejects(desktop.operate(actor, runId, 'viewer', 'control'), { status: 403 })
    assert.equal((await desktop.operate(actor, runId, 'takeover'))?.url, 'wss://fixture.invalid/control')
    assert.equal((await desktop.state(actor, runId)).control, 'user')
    await desktop.operate(actor, runId, 'handback')
    assert.equal((await desktop.state(actor, runId)).control, 'agent')
    assert.equal(syncedEpoch, 2); assert.equal(installs, 1); assert.equal(displays, 1)
    await pool.query('INSERT INTO workspace_computer_policies VALUES ($1,$2,$3)', [actor.workspaceId, 'deny', 1])
    await assert.rejects(desktop.operate(actor, runId, 'wake'), { status: 404 })
    await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])
    await pool.query('UPDATE agent_runs SET status=$2 WHERE id=$1', [runId, 'succeeded'])
    assert.equal(await cloudDeviceIsActive(pool, credential.deviceId, actor.workspaceId, actor.userId), false, 'a finished thread credential is no longer valid')
    await pool.query('UPDATE agent_runs SET "startedAt"=now() WHERE id=$1', [runId])
    await assert.rejects(machines.end(actor, runId), /not been preserved/)
    await pool.query('UPDATE thread_machines SET "resultSnapshotId"=$2 WHERE "runId"=$1', [runId, 'result-fixture'])
    await machines.end(actor, runId); await machines.end(actor, runId)
    assert.equal(kills, 1)
    await assert.rejects(machines.wake(actor, runId), /ended/)
    assert.equal((await pool.query('SELECT state FROM thread_machines')).rows[0].state, 'ended')
    await assert.rejects(pool.query('DELETE FROM computer_run_bindings WHERE "runId"=$1', [runId]), { code: '23503' }, 'provider identifiers cannot disappear through a cascade')

    const queue = new SubagentQueue(pool)
    await assert.rejects(queue.enqueue({ ...actor, userId: 'bob' }, botId, 'Open a page'), /unavailable/)
    const retryKey = randomUUID()
    const retried = await Promise.all([queue.enqueue(actor, botId, 'Stable task', retryKey), queue.enqueue(actor, botId, 'Stable task', retryKey)])
    assert.equal(retried[0].id, retried[1].id)
    await assert.rejects(queue.enqueue(actor, botId, 'Different task', retryKey), /unavailable/)
    await queue.stop(actor, botId, retried[0].id)
    const tasks = await Promise.all(Array.from({ length: 8 }, (_, i) => queue.enqueue(actor, botId, `Task ${i + 1}`)))
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => queue.claimNext(actor, `worker-${i}`)))
    assert.equal(claims.filter(Boolean).length, 6)
    const claimedIndex = claims.findIndex(Boolean)
    assert.equal((await queue.claimNext(actor, `worker-${claimedIndex}`))?.id, claims[claimedIndex]?.id, 'a retried workflow reclaims its own task')
    const running = claims.find(Boolean)!
    assert.equal(await queue.stop({ ...actor, userId: 'bob' }, botId, running.id), false)
    assert.equal(await queue.stop(actor, botId, running.id), true)
    assert.equal(await queue.claimNext(actor), null, 'stop request keeps a slot until browser cleanup')
    assert.equal((await queue.finish(actor, botId, running.id, 'done'))?.state, 'stopped', 'stop wins a completion race')
    assert.ok(await queue.claimNext(actor))
    const queued = tasks.find(task => !claims.some(claim => claim?.id === task.id) && task.id !== running.id)!
    // Exactly one of the original queued tasks may have been claimed above.
    const remaining = (await pool.query("SELECT id FROM bot_subagents WHERE state='queued' LIMIT 1")).rows[0]
    assert.ok(queued && remaining)
    assert.equal(await queue.stop(actor, botId, remaining.id), true)
    assert.equal((await pool.query('SELECT state FROM bot_subagents WHERE id=$1', [remaining.id])).rows[0].state, 'stopped')
    const browser = claims.filter(Boolean).find(task => task!.id !== running.id)!
    const approvals = new SubagentApprovals(pool)
    const action = { action: 'navigate', url: 'https://example.com/' } as const
    const requested = await approvals.request(actor, botId, browser.id, 'fixture-tool-call', action)
    assert.equal((await approvals.request(actor, botId, browser.id, 'fixture-tool-call', action)).id, requested.id)
    await assert.rejects(approvals.request(actor, botId, browser.id, 'fixture-tool-call', { ...action, url: 'https://other.example/' }), /changed/)
    assert.equal(await approvals.pending({ ...actor, userId: 'bob' }, botId, browser.id), null)
    assert.equal(await approvals.decide(actor, botId, browser.id, requested.id, 'wrong-digest', true), false)
    assert.equal(await approvals.decide(actor, botId, browser.id, requested.id, requested.digest, true), true)
    assert.equal(await approvals.decide(actor, botId, browser.id, requested.id, requested.digest, true), false)
    const consumed = await Promise.all([approvals.consume(actor, botId, browser.id, requested.id, requested.digest), approvals.consume(actor, botId, browser.id, requested.id, requested.digest)])
    assert.deepEqual(consumed.filter(Boolean), [action], 'an approved browser action executes at most once')
    assert.equal(await approvals.complete(actor, botId, browser.id, requested.id, requested.digest, { ok: true }), true)
    assert.equal(await approvals.consume(actor, botId, browser.id, requested.id, requested.digest), undefined)
    await pool.query('INSERT INTO cloud_machines ("workspaceId","ownerId","sandboxId") VALUES ($1,$2,$3)', [actor.workspaceId, actor.userId, 'browser-fixture'])
    const browserLeases: { controlledBy: string | null; stopRequested: boolean }[] = []
    let browserClosed = 0
    const browserRuntime = {
      async connectComputer() { return {} },
      async syncSubagentLease(_box: unknown, lease: { controlledBy: string | null; stopRequested: boolean }) { browserLeases.push(lease) },
      async subagentViewerGrant(_box: unknown, _lease: unknown, _userId: string, mode: string) { return { url: `wss://fixture.invalid/${mode}` } },
      async stopSubagentBrowser() { browserClosed++ },
    } as unknown as typeof e2bProvider
    const browserStore = new SubagentStore(pool, browserRuntime)
    await assert.rejects(browserStore.operate({ ...actor, userId: 'bob' }, botId, browser.id, 'viewer'), { status: 404 })
    await assert.rejects(browserStore.operate(actor, botId, browser.id, 'viewer', 'control'), { status: 403 })
    assert.deepEqual(await browserStore.operate(actor, botId, browser.id, 'viewer'), { url: 'wss://fixture.invalid/view' })
    assert.deepEqual(await browserStore.operate(actor, botId, browser.id, 'takeover'), { url: 'wss://fixture.invalid/control' })
    await browserStore.operate(actor, botId, browser.id, 'handback')
    assert.deepEqual(await browserStore.operate(actor, botId, browser.id, 'stop'), { stopped: true })
    assert.equal(browserClosed, 1)
    assert.deepEqual(browserLeases.map(lease => [lease.controlledBy, lease.stopRequested]), [[null, false], ['alice', false], [null, false], [null, true]])
    assert.equal((await pool.query('SELECT state FROM bot_subagents WHERE id=$1', [browser.id])).rows[0].state, 'stopped')
    await assert.rejects(pool.query('DELETE FROM bots WHERE id=$1', [botId]), { code: '23503' }, 'browser records cannot disappear through a Bot cascade')

    const suggestionId = randomUUID()
    await pool.query('INSERT INTO suggestions (id,"userId",source,action,title,shown) VALUES ($1,$2,$3,$4,$5,true)', [suggestionId, actor.userId, 'github', 'review', 'Review fixture'])
    assert.equal(await startSuggestion(pool, 'bob', suggestionId), null)
    const starts = await Promise.all([startSuggestion(pool, actor.userId, suggestionId), startSuggestion(pool, actor.userId, suggestionId)])
    assert.equal(starts.filter(start => start?.created).length, 1)
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM coordinator_events WHERE kind='suggestion_start'")).rows[0].n, 1)
    assert.equal(await attachSuggestionRun(pool, 'bob', suggestionId, runId), false)
    assert.equal(await attachSuggestionRun(pool, actor.userId, suggestionId, runId), true)
    const finished = (await pool.query('SELECT "executionState","dismissedAt" FROM suggestions WHERE id=$1', [suggestionId])).rows[0]
    assert.equal(finished.executionState, 'completed'); assert.ok(finished.dismissedAt)

    const secondSuggestion = randomUUID()
    await pool.query('INSERT INTO suggestions (id,"userId",source,action,title,shown) VALUES ($1,$2,$3,$4,$5,true)', [secondSuggestion, actor.userId, 'gmail', 'reply', 'Reply fixture'])
    await startSuggestion(pool, actor.userId, secondSuggestion)
    assert.equal(await attachSuggestionSubagent(pool, actor.userId, secondSuggestion, remaining.id), true)
    assert.equal((await pool.query('SELECT "executionState" FROM suggestions WHERE id=$1', [secondSuggestion])).rows[0].executionState, 'failed')
    assert.equal((await startSuggestion(pool, actor.userId, secondSuggestion))?.created, true, 'failed work may be retried')
    await failUnattachedSuggestions(pool, 'bob', [secondSuggestion])
    assert.equal((await pool.query('SELECT "executionState" FROM suggestions WHERE id=$1', [secondSuggestion])).rows[0].executionState, 'running')
    await failUnattachedSuggestions(pool, actor.userId, [secondSuggestion])
    assert.equal((await pool.query('SELECT "executionState" FROM suggestions WHERE id=$1', [secondSuggestion])).rows[0].executionState, 'failed')
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
