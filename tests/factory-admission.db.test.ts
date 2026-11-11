import { wireKeys } from '../lib/live/wire-keys.test-support'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { remoteKey } from '@mikka/protocol/repository'
import type { FactoryTask } from '../lib/factory/store'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { ALLOWED_MODEL, seedAllowedModel } from './support/allowed-model'
import { liveChannelId } from '../lib/live/scope'
import { isolateCoordinatorWakes } from './support/coordinator-wake'

const connection = process.env.E2E_DATABASE_URL
const enabled = disposableDatabase()
if (connection) {
  if (!enabled) throw new Error('Factory admission DB tests require a loopback *_e2e database')
  if (process.env.MIKKA_DATABASE_URL !== connection || process.env.DATABASE_URL !== connection || (process.env.ORVILO_DATABASE_URL && process.env.ORVILO_DATABASE_URL !== connection)) throw new Error('All admission database paths must use the ephemeral E2E_DATABASE_URL')
}
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Factory admission DB tests cannot skip in required CI')

type Fixture = {
  userId: string; workspaceId: string; issueId: string; deviceId: string; agentId: string; repoId: string
  remoteUrl: string; remoteKey: string; eventId: string; task: FactoryTask
}

test('real Factory admission preserves host scope, policy and transaction ownership', { skip: !enabled, timeout: 120_000 }, async t => {
  // A Factory run is frozen with a model from 优先使用的模型 like any run: the fixture person has a subscription model.
  const priorByos = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  t.after(() => { if (priorByos === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = priorByos })
  // Admission owns these deliberately bot-less historical fixtures. Its inbox
  // writes still commit, but a separate Coordinator runtime must not backfill
  // their Bot identity or acquire Factory locks while this suite measures them.
  // wake-event-driven.db.test.ts covers the real after-COMMIT wake contract.
  const coordinator = await isolateCoordinatorWakes(t)
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { withProjectResourceLease } = await import('../lib/project-resources/store')
  const { readOrder } = await import('../lib/model-order')
  const { queueRun, queueFactoryRun } = await import('../lib/agent-runs')
  const { acceptedEventStillMatches } = await import('../lib/run-admission-store')
  const { lockCliAgentPolicy, readCliAgentPolicy } = await import('../lib/agent-tool-approval/policy-store')
  const { setCliAgentPolicy } = await import('../lib/agent-tool-approval/policy-settings')
  const { factoryStore, dispatchFactoryRun, factoryQuestions } = await import('../lib/factory/server')
  const { factoryBinding } = await import('../lib/factory/dispatch')
  const { beginFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction } = await import('../lib/factory/transaction')
  const { questionReference } = await import('../lib/factory/questions/store')
  const { recordPushGrant } = await import('./support/github-app-stub')
  const { promoteExistingIssueForUser } = await import('../lib/team-issue-promotion')
  const { previewPersonalScope, changeIssueScopeLocally } = await import('../lib/issue-scope-store')
  const fixtures: Fixture[] = []

  async function transaction<T>(f: Fixture, work: (tx: PoolClient) => Promise<T>) {
    return withProjectResourceLease(f.userId, f.workspaceId, async () => {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const value = await work(tx); await tx.query('COMMIT'); return value }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
    })
  }
  async function policy(f: Fixture, permission: 'allow' | 'ask' | 'deny') {
    const current = await readCliAgentPolicy(pool, f.userId, f.agentId, null)
    await setCliAgentPolicy(pool, f.userId, f.agentId, null, 'agent', current.revision, { permissions: { git_push: permission } })
  }
  async function addEvent(f: Pick<Fixture, 'userId' | 'issueId' | 'deviceId'>, options: { destination?: unknown; bound?: boolean; delivered?: boolean; botId?: string } = {}) {
    const id = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey","issueId",payload,"deliveredAt")
      VALUES ($1::uuid,$2,$3,'user_message','admission:'||$1::text,$4,$5,$6)`, [id, f.userId, options.botId ?? null, options.bound ? f.issueId : null,
      JSON.stringify({ text: 'Synthetic owner request; no provider invocation', ...(options.destination === undefined ? {} : { taskDestination: options.destination }) }),
      options.delivered === false ? null : new Date()])
    return id
  }
  // By default the fixture keeps the installation row an earlier build recorded
  // (lock-order evidence only; admission no longer reads it). `approved: false` leaves none.
  async function fixture(options: { permission?: 'allow' | 'ask' | 'deny'; destination?: unknown | 'selected'; delivered?: boolean; approved?: boolean } = {}): Promise<Fixture> {
    const id = randomUUID(), userId = `factory-admission-${id}`
    const remoteUrl = `https://github.com/mikka-ci/admission-${id}.git`
    const identity = { userId, issueId: randomUUID(), deviceId: randomUUID(), agentId: randomUUID(), repoId: randomUUID(), remoteUrl, remoteKey: remoteKey(remoteUrl) }
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
    await pool.query('INSERT INTO issue_prefixes ("userId",prefix) VALUES ($1,\'FADM\')', [userId])
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,harnesses,"protocolVersion") VALUES ($1,$2,\'Admission CI computer\',\'local\',$3,3)', [identity.deviceId, userId, JSON.stringify([{ harness: 'codex', installed: true }])])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Admission CI worker\')', [identity.agentId, userId, identity.deviceId])
    const { workspaceId } = await seedAllowedModel(pool, userId, { deviceIds: [identity.deviceId] })
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") VALUES ($1,$2,$3,$4,$5,null)', [identity.repoId, identity.deviceId, userId, identity.remoteKey, remoteUrl])
    await pool.query('INSERT INTO issues (id,"userId","workspaceId","ownershipState",title,content,status,priority,scope,"linearSyncPolicy","linearSyncBlocked") VALUES ($1,$2,$4,\'bound\',\'Synthetic admission task\',$3,\'todo\',\'normal\',\'workspace\',\'disabled\',true)', [identity.issueId, userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1 } }, content: [] }), workspaceId])
    const eventId = await addEvent(identity, { destination: options.destination === 'selected' ? { kind: 'device', deviceId: identity.deviceId } : options.destination, delivered: options.delivered })
    const routed = await factoryStore.route(userId, { issueId: identity.issueId, eventId: randomUUID(), sourceEventId: eventId, rationale: 'Synthetic requested implementation' })
    const f = { ...identity, workspaceId, eventId, task: routed.task }
    fixtures.push(f)
    await policy(f, options.permission ?? 'allow')
    if (options.approved !== false) await recordPushGrant(pool, userId, identity.remoteKey)
    return f
  }
  const dispatch = (f: Fixture, tx?: PoolClient) => dispatchFactoryRun(f.userId, { binding: factoryBinding(f.task), agentId: f.agentId, deviceRepoId: f.repoId }, tx)
  const publicInput = (f: Fixture, requestKey: string) => ({ issueId: f.issueId, agentId: f.agentId, repo: f.remoteUrl, requestKey, model: ALLOWED_MODEL })
  const internalInput = (f: Fixture, requestKey?: string) => ({ issueId: f.issueId, agentId: f.agentId, deviceRepoId: f.repoId, ...(requestKey ? { requestKey } : {}) })
  const rowsFor = async (f: Fixture) => (await pool.query(`SELECT
    (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1 AND "issueId"=$2) AS runs,
    (SELECT count(*)::int FROM run_publications WHERE "userId"=$1 AND "issueId"=$2) AS publications,
    (SELECT count(*)::int FROM factory_events WHERE "taskId"=$3) AS events`, [f.userId, f.issueId, f.task.id])).rows[0]
  async function waitBlockedBy(pid: number) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await pool.query('SELECT exists(SELECT 1 FROM pg_stat_activity WHERE $1::int=any(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('the real competing transaction must wait on the held policy lock')
  }
  async function changePublicationGeneration(f: Fixture) {
    const workspaceId = randomUUID(), teamId = randomUUID()
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,\'Synthetic admission workspace\')', [workspaceId, f.userId])
    await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,\'Synthetic owner\',$3,\'member\',\'active\')', [workspaceId, f.userId, `${f.userId}@example.invalid`])
    await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,\'Admission team\',\'FADM\')', [teamId, workspaceId, f.userId])
    const current = (await pool.query('SELECT revision FROM issues WHERE id=$1', [f.issueId])).rows[0]
    const promoted = await promoteExistingIssueForUser(f.userId, { requestId: randomUUID(), issueId: f.issueId, revision: current.revision, teamId, expectedTeamId: null })
    assert.ok('error' in promoted)
    assert.equal(promoted.error, 'teamIssueAccessDenied', 'a Team in another workspace cannot move the task')
    // A historical explicit publication policy is a separate generation from
    // task tenancy. Keep publication blocked, then use the real local disable
    // action; the test performs no provider I/O and never moves the tenant.
    await pool.query('UPDATE issues SET "linearSyncPolicy"=\'explicit\',"linearSyncBlocked"=true WHERE id=$1', [f.issueId])
    const preview = await previewPersonalScope(f.userId, f.issueId)
    assert.ok('preview' in preview && preview.preview)
    assert.equal(preview.preview.externalCopyPossible, false, 'no external publication was recorded')
    // Use the exact store contract behind confirmIssuePersonalScope, including
    // its preview digest and linked-publication rejection. No trigger override.
    const retired = await changeIssueScopeLocally(f.userId, { id: f.issueId, revision: preview.preview.revision, scope: 'personal' }, { allowLinkedPersonal: false, confirmation: preview.preview.confirmation })
    assert.ok('issue' in retired && retired.issue?.linearSyncPolicy === 'disabled', JSON.stringify(retired))
    assert.deepEqual((await pool.query('SELECT "workspaceId",scope FROM issues WHERE id=$1', [f.issueId])).rows,
      [{ workspaceId: f.workspaceId, scope: 'workspace' }], 'publication policy changes retain the task tenant')
  }

  try {
    assert.equal(String((await pool.query('SHOW server_version_num')).rows[0].server_version_num).slice(0, 2), '17')

    await t.test('a Factory dispatch queues a NULL-issue source through the real public admission store, with no grant or approval', async () => {
      const f = await fixture()
      assert.equal((await pool.query('SELECT "issueId" FROM coordinator_events WHERE id=$1', [f.eventId])).rows[0].issueId, null)
      const admitted = await dispatch(f)
      const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [admitted.runId])).rows[0]
      const publication = (await pool.query('SELECT * FROM run_publications WHERE "runId"=$1', [admitted.runId])).rows[0]
      const defaultOrder = await readOrder(pool, { ownerId: f.userId, workspaceId: f.workspaceId })
      assert.equal(defaultOrder.customized, false, 'ordinary Factory admission uses the untouched default order')
      assert.equal(defaultOrder.entries[0].source.kind, 'subscription')
      assert.ok(defaultOrder.entries[0].id.startsWith('default:'))
      assert.ok(!defaultOrder.entries[0].id.includes('\u0000'), 'the default row id is safe to freeze in JSONB')
      assert.deepEqual(run.agentDefinition.modelDispatch.entry, defaultOrder.entries[0], 'admission preserves the chosen model and credential identity')
      assert.equal(run.agentDefinition.repositoryAdmission.authority, 'owner_credential')
      assert.equal(run.agentDefinition.repositoryAdmission.approvedAt, undefined)
      assert.equal(run.agentDefinition.repositoryAdmission.remoteKey, f.remoteKey)
      assert.equal(run.dispatchKey, `factory:${f.task.attemptId}`)
      assert.equal(publication.scopeVersion, 1)
      assert.equal(publication.identifier, (await pool.query('SELECT "issuedIdentifier" FROM issues WHERE id=$1', [f.issueId])).rows[0].issuedIdentifier)
      assert.equal(publication.branch, `mikka/${publication.identifier.toLowerCase()}`)
      assert.equal((await pool.query('SELECT "runId" FROM factory_attempts WHERE id=$1', [f.task.attemptId])).rows[0].runId, admitted.runId)
      const before = await rowsFor(f)
      assert.equal((await dispatch(f)).runId, admitted.runId)
      assert.deepEqual(await rowsFor(f), before)
      await assert.rejects(queueRun(f.userId, publicInput(f, `another:${randomUUID()}`)), /runAlreadyActive/, 'an internal Factory run still participates in the ordinary active-task gate')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_actions WHERE "userId"=$1', [f.userId])).rows[0].n, 0, 'no approval card')
    })

    async function lostAdmission(options: { destination?: 'selected'; revoke?: boolean; legacyEpoch?: boolean; workerPolicy?: unknown } = {}) {
      const f = await fixture(options)
      const admitted = await dispatch(f)
      const deviceB = randomUUID(), agentB = randomUUID()
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,harnesses,"protocolVersion",enabled,"lastSeenAt")
        SELECT $1,"ownerId",'Admission recovery B','local',harnesses,"protocolVersion",true,now() FROM devices WHERE id=$2`, [deviceB, f.deviceId])
      await pool.query(`INSERT INTO agents(id,"userId","deviceId",harness,name) VALUES($1,$2,$3,'codex','Admission recovery B')`, [agentB, f.userId, deviceB])
      const now = new Date()
      await pool.query(`UPDATE devices SET "lastSeenAt"=$2 WHERE id=$1`, [f.deviceId, new Date(now.getTime() - 120_000)])
      await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=$2,"leaseExpiresAt"=$3,"sessionId"='admission-recovery-A' WHERE id=$1`, [admitted.runId, new Date(now.getTime() - 180_000), new Date(now.getTime() - 1_000)])
      await pool.query(`INSERT INTO run_checkpoints("runId","baseCommit",patch,files,"updatedAt","userId","takenAt") VALUES($1,$2,$3,1,$4,$5,$4)`, [admitted.runId, 'a'.repeat(40), gzipSync('diff --git a/target.txt b/target.txt\n'), now, f.userId])
      const before = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [admitted.runId])).rows[0]
      if (options.revoke) await pool.query(`UPDATE byos_connections SET paused=true WHERE "ownerId"=$1`, [f.userId])
      if (options.legacyEpoch) await pool.query(`UPDATE factory_attempts SET output=output-'requestEpoch' WHERE id=$1`, [f.task.attemptId])
      if (options.workerPolicy) {
        const current = await readCliAgentPolicy(pool, f.userId, f.agentId, null)
        await setCliAgentPolicy(pool, f.userId, f.agentId, null, 'worker', current.revision, options.workerPolicy)
      }
      return { f, admitted, deviceB, agentB, now, before }
    }
    const reclaim = async (userId: string, now: Date) => {
      const { reclaimLostRuns } = await import('../lib/run-leases')
      try { await reclaimLostRuns(userId, now) }
      catch (error) {
        // The real ending/reconciler ran; this Node test has no Next response to
        // schedule the optional Coordinator wake after. No authority is mocked.
        if (!(error instanceof Error) || !error.message.includes('`after` was called outside a request scope')) throw error
      }
    }

    await t.test('a real repository admission transfers once to B through fresh admission, publication and current Factory claim', async () => {
      const { f, admitted, deviceB, agentB, now, before } = await lostAdmission()
      await Promise.all(Array.from({ length: 3 }, () => reclaim(f.userId, now)))
      const { rows: children } = await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [admitted.runId])
      assert.equal(children.length, 1, 'an admitted native run must have one actual B retry, not an auto-repair queued on offline A')
      const child = children[0]
      assert.equal(child.botId, before.botId, 'recovery preserves the admitted Bot scope')
      assert.equal(child.deviceId, deviceB)
      assert.equal(child.agentId, agentB)
      assert.equal(child.attempt, 2)
      assert.equal(child.agentDefinition.model, before.agentDefinition.model)
      assert.equal(child.agentDefinition.definitionDigest, before.agentDefinition.definitionDigest)
      assert.deepEqual(child.agentDefinition.subscription, before.agentDefinition.subscription)
      assert.deepEqual(child.agentDefinition.executionIdentity.billingAccount.model, before.agentDefinition.executionIdentity.billingAccount.model)
      assert.deepEqual(child.agentDefinition.executionIdentity.resourceBindings.filter((r: { kind: string }) => r.kind !== 'device'), before.agentDefinition.executionIdentity.resourceBindings.filter((r: { kind: string }) => r.kind !== 'device'))
      assert.equal(child.agentDefinition.repositoryAdmission.deviceId, deviceB)
      assert.equal(child.agentDefinition.repositoryAdmission.agentId, agentB)
      assert.equal(child.agentDefinition.repositoryAdmission.authority, 'owner_credential')
      assert.equal(child.agentDefinition.repositoryAdmission.remoteKey, f.remoteKey)
      assert.equal(child.agentDefinition.repositoryAdmission.targetBranch, before.agentDefinition.repositoryAdmission.targetBranch)
      assert.notEqual(child.agentDefinition.repositoryAdmission.acceptedAt, before.agentDefinition.repositoryAdmission.acceptedAt)
      const publication = (await pool.query('SELECT * FROM run_publications WHERE "runId"=$1', [child.id])).rows[0]
      assert.equal(publication.branch, before.agentDefinition.repositoryAdmission.targetBranch)
      assert.equal(publication.remoteKey, f.remoteKey)
      assert.equal(publication.scopeVersion, 1)
      const current = (await pool.query(`SELECT t.*,a."runId",a.output FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE t.id=$1`, [f.task.id])).rows[0]
      assert.equal(current.sourceEventId, f.eventId)
      assert.equal(current.output.requestEpoch, f.eventId)
      assert.equal(current.runId, child.id, 'the real completion consumer must adopt the re-admitted Agent')
      const { rows: handoffs } = await pool.query(`SELECT result FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_handoff' AND result->'checkpoint'->>'runId'=$2`, [f.task.id, admitted.runId])
      assert.ok(handoffs.some(h => h.result.requestEpoch === f.eventId && h.result.checkpoint.files === 1))
      const { claimExecutionRun } = await import('../lib/factory/server')
      assert.equal((await claimExecutionRun(f.userId, deviceB, child.id, new Date(now.getTime() + 90_000).toISOString())).length, 1)
      await reclaim(f.userId, now)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows[0].n, 2)
    })

    await t.test('an idle gateway B receives fresh admission and its still-online queued retry stays on B', async () => {
      const { f, admitted, deviceB, now } = await lostAdmission()
      const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
      let recheckingQueued = false, queuedPresenceReads = 0
      const server = createServer((request, response) => {
        const device = request.url?.split('/')[3]
        if (request.url?.endsWith('/status')) {
          // The first queued scan misses B; its socket is back by admission's
          // locked recheck. This exercises the inner fence as well as selection.
          const online = device === deviceB && (!recheckingQueued || ++queuedPresenceReads > 1)
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ online, lastSeenAt: online ? now.toISOString() : null }))
        } else { response.writeHead(204); response.end() }
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
      process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-handoff-presence-secret'
      try {
        await pool.query('UPDATE devices SET "lastSeenAt"=$2 WHERE id=$1', [deviceB, new Date(now.getTime() - 600_000)])
        await reclaim(f.userId, now)
        const { rows: retries } = await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [admitted.runId])
        assert.equal(retries.length, 1, 'a real gateway status must admit B despite its intentionally idle HTTP heartbeat')
        assert.equal(retries[0].deviceId, deviceB)
        assert.equal(retries[0].agentDefinition.repositoryAdmission.deviceId, deviceB)
        await pool.query('UPDATE devices SET "lastSeenAt"=$2 WHERE id=$1', [f.deviceId, now])
        recheckingQueued = true
        await reclaim(f.userId, now)
        assert.ok(queuedPresenceReads >= 3, 'availability is rechecked after the queued scan and target selection')
        const current = (await pool.query('SELECT status,"deviceId" FROM agent_runs WHERE id=$1', [retries[0].id])).rows[0]
        assert.deepEqual(current, { status: 'queued', deviceId: deviceB }, 'a queued gateway-online B is not stranded when A returns')
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows[0].n, 2)
      } finally {
        if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL
        else process.env.DEVICE_GATEWAY_URL = previous.url
        if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET
        else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    await t.test('an admitted queued retry losing B creates a bounded fresh receipt instead of rewriting B placement', async () => {
      const { f, admitted, deviceB, now } = await lostAdmission()
      await reclaim(f.userId, now)
      const first = (await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [admitted.runId])).rows[0]
      assert.ok(first, 'B retry must exist through real admission')
      assert.equal(first.status, 'queued')
      await pool.query('UPDATE devices SET "lastSeenAt"=$2 WHERE id=$1', [deviceB, new Date(now.getTime() - 120_000)])
      await pool.query('UPDATE devices SET "lastSeenAt"=$2 WHERE id=$1', [f.deviceId, now])
      await Promise.all(Array.from({ length: 3 }, () => reclaim(f.userId, now)))
      const { rows: descendants } = await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [first.id])
      assert.equal(descendants.length, 1)
      const third = descendants[0]
      assert.equal(third.attempt, 3)
      assert.equal(third.deviceId, f.deviceId)
      assert.equal(third.agentId, f.agentId)
      assert.equal(third.agentDefinition.repositoryAdmission.deviceId, f.deviceId)
      assert.equal(third.agentDefinition.repositoryAdmission.targetBranch, first.agentDefinition.repositoryAdmission.targetBranch)
      const unchanged = (await pool.query('SELECT "deviceId","agentDefinition",status FROM agent_runs WHERE id=$1', [first.id])).rows[0]
      assert.equal(unchanged.deviceId, deviceB)
      assert.deepEqual(unchanged.agentDefinition, first.agentDefinition, 'B immutable receipt cannot be patched to pretend it authorized A')
      assert.equal(unchanged.status, 'failed')
      const current = (await pool.query('SELECT t."sourceEventId",a."runId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE t.id=$1', [f.task.id])).rows[0]
      assert.deepEqual(current, { sourceEventId: f.eventId, runId: third.id })
      await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=$2 WHERE id=$1`, [third.id, new Date(now.getTime() - 1_000)])
      await reclaim(f.userId, now)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows[0].n, 3)
      assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0].status, 'blocked')
    })

    for (const options of [
      { label: 'owner pinned A', destination: 'selected' as const },
      { label: 'the frozen model grant was revoked', revoke: true },
      { label: 'a legacy attempt has no epoch', legacyEpoch: true },
      { label: 'B would drop an A worker deny', workerPolicy: { permissions: { install_dependency: 'deny' } } },
      { label: 'B would drop A read-only mode', workerPolicy: { approvalMode: 'read_only' } },
      { label: 'B would widen A network ceiling', workerPolicy: { networkAllow: ['allowed.example.com'] } },
    ]) await t.test(`admitted recovery blocks without replaying offline A when ${options.label}`, async () => {
      const { f, admitted, now } = await lostAdmission(options)
      await reclaim(f.userId, now)
      await reclaim(f.userId, now)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows[0].n, 1, 'no child and no generic Factory auto-repair on A')
      const run = (await pool.query('SELECT status,"stopReason" FROM agent_runs WHERE id=$1', [admitted.runId])).rows[0]
      assert.deepEqual(run, { status: 'failed', stopReason: 'device_lost' })
      const task = (await pool.query('SELECT status,"sourceEventId" FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0]
      assert.deepEqual(task, { status: 'blocked', sourceEventId: f.eventId })
      assert.equal((await pool.query('SELECT payload FROM coordinator_events WHERE id=$1', [f.eventId])).rows[0].payload.taskDestination?.deviceId, options.destination ? f.deviceId : undefined)
    })

    await t.test('no recorded GitHub App grant is needed to admit', async () => {
      const f = await fixture({ approved: false })
      const admitted = await dispatch(f)
      assert.equal((await rowsFor(f)).runs, 1)
      assert.equal((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [admitted.runId])).rows[0].agentDefinition.repositoryAdmission.authority, 'owner_credential')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_repository_installations WHERE "userId"=$1', [f.userId])).rows[0].n, 0, 'nothing records a grant on the owner\'s behalf')
    })

    await t.test('self-improvement owns real fresh Profile admission and the baseline assignment in one transaction', async () => {
      const f = await fixture({ destination: 'selected' })
      const { improvementFactory } = await import('../lib/self-improvement/server')
      const admitted = await improvementFactory.rehearse(f.userId, {
        action: 'rehearse', binding: factoryBinding(f.task), agentId: f.agentId, deviceRepoId: f.repoId,
      })
      const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [admitted.runId])).rows[0]
      assert.equal(admitted.replayed, false)
      assert.equal(run.status, 'queued')
      assert.equal(run.sessionId, null)
      assert.equal(run.agentDefinition.agentProfile.source, 'default')
      assert.deepEqual(run.agentDefinition.agentProfile.targetEntry, run.agentDefinition.modelDispatch.entry)
      assert.deepEqual(run.agentDefinition.agentProfile.scope, { ownerId: f.userId, workspaceId: f.workspaceId })
      assert.equal(run.botId, null)
      assert.equal(admitted.selection.runId, admitted.runId)
      assert.equal(admitted.selection.status, 'selection_persisted')
      const selected = (await pool.query('SELECT "versionId" FROM improvement_skill_selections WHERE "runId"=$1 AND "userId"=$2', [admitted.runId, f.userId])).rows[0]
      assert.equal(selected.versionId, admitted.selection.artifact.versionId)
      assert.equal((await pool.query('SELECT "runId" FROM factory_attempts WHERE id=$1', [f.task.attemptId])).rows[0].runId, admitted.runId)
      assert.equal((await rowsFor(f)).publications, 1, 'the real caller commits its queue, assignment and publication together')
    })

    await t.test('caller-owned rollback removes queue, publication, binding and dispatch receipt together', async () => {
      const f = await fixture({ destination: 'selected' })
      const before = await rowsFor(f)
      let runId: string | undefined
      // The caller owns both leases: Workspace first, then its APP transaction.
      await withProjectResourceLease(f.userId, f.workspaceId, async () => {
        const tx = await pool.connect()
        try {
          await beginFactoryTransaction(tx)
          const admitted = await dispatch(f, tx)
          runId = admitted.runId
          assert.equal((await tx.query('SELECT count(*)::int AS n FROM agent_runs WHERE id=$1', [runId])).rows[0].n, 1)
          assert.deepEqual(await rowsFor(f), before, 'the host adapter must not commit the caller transaction')
          await rollbackFactoryTransaction(tx)
        } finally { try { await rollbackFactoryTransaction(tx) } finally { forgetFactoryTransaction(tx); tx.release() } }
      })
      assert.deepEqual(await rowsFor(f), before)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE id=$1', [runId])).rows[0].n, 0)
      const committed = await dispatch(f)
      const admission = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [committed.runId])).rows[0].agentDefinition.repositoryAdmission
      assert.equal(admission.requestEventId, f.eventId)
      assert.equal(await acceptedEventStillMatches(admission, null), true, 'the claim path retains the NULL-issue Factory host binding')
    })

    await t.test('gateway wake belongs to the outer commit, including a host that starts lifecycle work immediately', async () => {
      const f = await fixture({ destination: 'selected' })
      // The botless task keeps its explicit workspace for browser updates.
      const pending: Promise<unknown>[] = []
      const received: string[] = []
      const browserReceived: { kind: string; id: string }[][] = []
      const contextKey = Symbol.for('@vercel/request-context')
      const globals = globalThis as unknown as Record<symbol, unknown>
      const previousContext = globals[contextKey]
      const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
      const server = createServer(async (request, response) => {
        try {
          assert.equal(request.headers.authorization, 'Bearer isolated-factory-wake-secret')
          if (request.method === 'GET') {
            response.end(JSON.stringify({ online: true, lastSeenAt: new Date().toISOString() }))
            return
          }
          // This separate connection cannot see the admission transaction until
          // its run, publication, Factory binding and receipt have all committed.
          const { rows } = await pool.query(`SELECT r.id FROM agent_runs r
            JOIN run_publications p ON p."runId"=r.id
            JOIN factory_attempts a ON a."runId"=r.id
            JOIN factory_events e ON e."taskId"=a."taskId" AND e.result->>'runId'=r.id::text
            WHERE r."deviceId"=$1 AND r."userId"=$2 AND r.status='queued'`, [f.deviceId, f.userId])
          assert.equal(rows.length, 1, 'the signal cannot outrun the complete Factory commit')
          if (request.url === `/v1/devices/${f.deviceId}/push`) received.push(rows[0].id)
          else {
            assert.equal(request.url, `/v1/live/${liveChannelId({ ownerId: f.userId, workspaceId: f.workspaceId })}/push`)
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            browserReceived.push(wireKeys(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
          }
          response.writeHead(204).end()
        } catch (error) {
          received.push(`invalid:${error instanceof Error ? error.message : 'unknown'}`)
          response.writeHead(400).end()
        }
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
      process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-factory-wake-secret'
      // Plain Node has no Next request scope; the actual Vercel helper starts
      // each supplied promise now, as nested after callbacks may do in production.
      globals[contextKey] = { get: () => ({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) }) }
      try {
        await withProjectResourceLease(f.userId, f.workspaceId, async () => {
          const tx = await pool.connect()
          try {
            await beginFactoryTransaction(tx)
            await dispatch(f, tx)
            assert.equal(pending.length, 0, 'joining admission must not schedule a premature wake')
            assert.equal((await rowsFor(f)).runs, 0)
            await rollbackFactoryTransaction(tx)
            assert.equal(pending.length, 0, 'rolled-back work produces no wake')
          } finally { try { await rollbackFactoryTransaction(tx) } finally { forgetFactoryTransaction(tx); tx.release() } }
        })
        // Both caller leases have ended before a separate admission and its effects.
        const result = await dispatch(f)
        await Promise.all(pending)
        assert.deepEqual(received, [result.runId], 'the transaction owner wakes the daemon exactly once after commit')
        const keyOrder = (a: { kind: string; id: string }, b: { kind: string; id: string }) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
        assert.deepEqual(browserReceived.flat().toSorted(keyOrder), [
          { kind: 'factory_task', id: f.task.id }, { kind: 'factory_issue', id: f.issueId },
          { kind: 'thread_list', id: f.workspaceId }, { kind: 'task_run_list', id: f.workspaceId },
          { kind: 'run', id: result.runId }, { kind: 'issue_threads', id: f.issueId },
        ].toSorted(keyOrder), 'the browser receives each exact committed entity/list invalidation once, regardless of HTTP delivery order')
        const scheduled = pending.length
        await dispatch(f)
        assert.equal(pending.length, scheduled, 'strict dispatch replay does not duplicate either notification')
      } finally {
        await Promise.allSettled(pending)
        globals[contextKey] = previousContext
        if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL
        else process.env.DEVICE_GATEWAY_URL = previous.url
        if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET
        else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })

    await t.test('destination, delivery and source identity cannot be discarded by an internal dispatch', async () => {
      for (const options of [
        { destination: { kind: 'device', deviceId: randomUUID() } },
        { destination: { kind: 'cloud' } },
        { destination: { kind: 'device' } },
        { destination: 'selected', delivered: false },
      ]) {
        const f = await fixture(options)
        const before = await rowsFor(f)
        await assert.rejects(dispatch(f), /runInvalid/)
        assert.deepEqual(await rowsFor(f), before)
      }
      const f = await fixture()
      await assert.rejects(transaction(f, tx => queueFactoryRun(tx, f.userId, internalInput(f), null, { sourceEventId: f.eventId, attemptId: randomUUID() })), /runInvalid/)
      await assert.rejects(transaction(f, tx => queueFactoryRun(tx, f.userId, internalInput(f))), /runInvalid/, 'the host must supply exactly one existing Factory or Skill origin')
      assert.equal((await rowsFor(f)).runs, 0)
    })

    await t.test('a stored git_push deny or ask withholds nothing and never shows a card', async () => {
      for (const permission of ['deny', 'ask'] as const) {
        const f = await fixture({ permission, approved: false })
        const admitted = await dispatch(f)
        assert.equal((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [admitted.runId])).rows[0].agentDefinition.repositoryAdmission.authority, 'owner_credential', permission)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_actions WHERE "userId"=$1', [f.userId])).rows[0].n, 0)
      }
    })

    await t.test('policy contention precedes Factory task and worker locks', async () => {
      const f = await fixture()
      const locker = await pool.connect()
      let pending: Promise<{ accepted: boolean; error?: unknown }> | undefined
      try {
        await locker.query('BEGIN')
        const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await lockCliAgentPolicy(locker, f.userId, f.agentId, null)
        pending = dispatch(f).then(() => ({ accepted: true }), error => ({ accepted: false, error }))
        await waitBlockedBy(pid)
        await locker.query('SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE NOWAIT', [f.task.id])
        // The ordinary worker-policy setter holds the same policy locks before
        // it updates this row. No source run/worker lock may precede them.
        await locker.query('UPDATE agents SET cli_run_policy=$2 WHERE id=$1', [f.agentId, { permissions: { git_push: 'deny' } }])
        await locker.query('COMMIT')
        const result = await pending
        assert.equal(result.accepted, true, String(result.error))
      } finally { await locker.query('ROLLBACK'); locker.release(); await pending }
      assert.equal((await rowsFor(f)).runs, 1)
    })

    await t.test('real question continuations acquire policy before Factory and origin locks, with or without a Team hierarchy', async () => {
      for (const grouped of [false, true]) {
        const f = await fixture({ destination: 'selected' })
        if (grouped) {
          const { seedTeam } = await import('./support/workspace-admin-db')
          const team = await seedTeam(pool, f.workspaceId, f.userId)
          await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)',
            [f.issueId, team.id, f.workspaceId, f.userId])
        }
        const origin = await dispatch(f)
        const questionId = randomUUID(), originSessionId = `synthetic-question:${origin.runId}`
        await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,"startedAt"=now(),"finishedAt"=now(),report=$3 WHERE id=$1`,
          [origin.runId, originSessionId, JSON.stringify({ summary: 'Synthetic stopped execution', openQuestions: ['Which task?'], question: { questionId, kind: 'context', question: 'Which task?', options: [] } })])
        const question = await factoryQuestions.record(f.userId, origin.runId)
        const input = { reference: questionReference(question), answerId: randomUUID(), facts: [{ kind: 'issue' as const, quote: 'Synthetic admission task' }] }
        const locker = await pool.connect()
        let pending: Promise<Awaited<ReturnType<typeof factoryQuestions.answer>>> | undefined
        let settled: Promise<{ accepted: boolean; error?: unknown }> | undefined
        try {
          await locker.query('BEGIN')
          const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          await lockCliAgentPolicy(locker, f.userId, f.agentId, null)
          pending = factoryQuestions.answer({ source: 'orchestrator', userId: f.userId }, input)
          settled = pending.then(() => ({ accepted: true }), error => ({ accepted: false, error }))
          await waitBlockedBy(pid)
          await locker.query('SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE NOWAIT', [f.task.id])
          await locker.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT', [origin.runId])
          await locker.query('COMMIT')
          const outcome = await settled
          assert.equal(outcome.accepted, true, String(outcome.error))
          const resumed = await pending
          const continuation = (await pool.query('SELECT "questionContinuation","agentDefinition" FROM agent_runs WHERE id=$1', [resumed.continuationRunId])).rows[0]
          assert.equal(continuation.questionContinuation.originRunId, origin.runId)
          assert.equal(continuation.questionContinuation.originSessionId, originSessionId)
          assert.equal(continuation.questionContinuation.requireSessionResume, true)
          assert.equal(continuation.agentDefinition.repositoryAdmission.requestEventId, f.eventId)
          assert.equal((await rowsFor(f)).runs, 2)
        } finally { await locker.query('ROLLBACK'); locker.release(); await settled }
      }
    })

    await t.test('key replay is immutable after a policy change and rejects a new host event', async () => {
      const f = await fixture()
      const destination = { kind: 'device', deviceId: f.deviceId }
      const firstEvent = await addEvent(f, { bound: true, destination })
      const input = publicInput(f, `host:${randomUUID()}`)
      const first = await queueRun(f.userId, input, null, undefined, firstEvent)
      const before = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].agentDefinition
      const secondEvent = await addEvent(f, { bound: true, destination })
      await assert.rejects(queueRun(f.userId, input, null, undefined, secondEvent), /runDispatchKeyConflict/)
      await policy(f, 'deny')
      assert.deepEqual(await queueRun(f.userId, input, null, undefined, firstEvent), { runId: first.runId, status: 'queued', replayed: true })
      assert.deepEqual((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].agentDefinition, before)
      await assert.rejects(queueRun(f.userId, { ...input, requestKey: `fresh:${randomUUID()}` }, null, undefined, secondEvent), /runAlreadyActive/)
      assert.equal((await rowsFor(f)).runs, 1)
    })

    await t.test('replay cannot change Bot scope; a Linear publication generation change preserves its task tenant and receipt', async () => {
      const f = await fixture()
      const input = publicInput(f, `scope:${randomUUID()}`)
      const first = await queueRun(f.userId, input)
      const botId = randomUUID(), workspaceId = f.workspaceId
      await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Synthetic scoped Bot\')', [botId, f.userId, workspaceId])
      await assert.rejects(queueRun(f.userId, input, botId), /runDispatchKeyConflict/)
      const oldScope = (await pool.query('SELECT "scopeVersion" FROM run_publications WHERE "runId"=$1', [first.runId])).rows[0].scopeVersion
      await changePublicationGeneration(f)
      assert.ok((await pool.query('SELECT "scopeVersion" FROM issues WHERE id=$1', [f.issueId])).rows[0].scopeVersion > oldScope)
      assert.deepEqual(await queueRun(f.userId, input), { runId: first.runId, status: 'queued', replayed: true })
      assert.equal((await rowsFor(f)).runs, 1)
      assert.equal((await pool.query('SELECT "scopeVersion" FROM run_publications WHERE "runId"=$1', [first.runId])).rows[0].scopeVersion, oldScope)
      const persisted = (await pool.query('SELECT "workspaceId","agentDefinition" FROM agent_runs WHERE id=$1', [first.runId])).rows[0]
      assert.equal(persisted.workspaceId, f.workspaceId)
      assert.equal(persisted.agentDefinition.executionIdentity.workspaceId, f.workspaceId)
    })

    await t.test('Skill continuations retain the admitted tenant and origin when Linear publication is disabled', async () => {
      const f = await fixture({ destination: 'selected' })
      const origin = await dispatch(f)
      await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now(),"sessionId"=\'synthetic-completed-source\' WHERE id=$1', [origin.runId])
      const next = await transaction(f, tx => queueFactoryRun(tx, f.userId, internalInput(f, `skill:${randomUUID()}`), null, undefined, origin.runId))
      const child = (await pool.query('SELECT "botId","agentDefinition" FROM agent_runs WHERE id=$1', [next.runId])).rows[0]
      assert.equal(child.botId, null)
      assert.equal(child.agentDefinition.repositoryAdmission.requestEventId, f.eventId)
      assert.equal(await acceptedEventStillMatches(child.agentDefinition.repositoryAdmission, null), true)
      await changePublicationGeneration(f)
      await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now() WHERE id=$1', [next.runId])
      const continued = await transaction(f, tx => queueFactoryRun(tx, f.userId, internalInput(f, `skill:${randomUUID()}`), null, undefined, origin.runId))
      const persisted = (await pool.query('SELECT "workspaceId","agentDefinition" FROM agent_runs WHERE id=$1', [continued.runId])).rows[0]
      assert.equal(persisted.workspaceId, f.workspaceId)
      assert.equal(persisted.agentDefinition.executionIdentity.workspaceId, f.workspaceId)
      assert.equal(persisted.agentDefinition.repositoryAdmission.requestEventId, f.eventId)
      assert.equal((await rowsFor(f)).runs, 3)
    })
  } finally {
    await coordinator.flush()
    // Keep immutable audit fixtures, but leave no queued execution authority.
    if (fixtures.length) await pool.query('UPDATE agent_runs SET "stopRequestedAt"=coalesce("stopRequestedAt",now()) WHERE "userId"=any($1::text[])', [fixtures.map(f => f.userId)])
    await pool.end()
    await workspacePool.end()
  }
})
