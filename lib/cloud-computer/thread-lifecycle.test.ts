import assert from 'node:assert/strict'
import { after, beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'
import { CLOSED_TASK_RETENTION_MS, THREAD_MACHINE_BUDGET_MS, THREAD_MACHINE_IDLE_MS, THREAD_MACHINE_RETENTION_MS,
  reconcileThreadMachine, threadMachineExecutionDeadline, threadMachineLifecycleDecision, type ThreadLifecycleRow } from './thread-lifecycle'
import { threadLifecycleErrorKind, threadLifecycleLogFields } from './thread-lifecycle-log'

// This suite simulates the SQL store, so it cannot inherit a configured live
// transport. Real COMMIT/ROLLBACK invalidation is exercised by the PG suites.
const liveEnvironment = { DEVICE_GATEWAY_URL:process.env.DEVICE_GATEWAY_URL, DEVICE_GATEWAY_PUSH_SECRET:process.env.DEVICE_GATEWAY_PUSH_SECRET }
process.env.DEVICE_GATEWAY_URL = 'https://unused-lifecycle-fixture.invalid'
delete process.env.DEVICE_GATEWAY_PUSH_SECRET
after(() => {
  for (const [key,value] of Object.entries(liveEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

const lifecycleLog = mock.method(console, 'info', () => {})
beforeEach(() => lifecycleLog.mock.resetCalls())

const now = Date.UTC(2026, 10, 7)
const running = { state: 'running' as const, endAt: now + 15 * 60_000 }
const paused = { state: 'paused' as const, endAt: null }
const actor = { userId: 'owner', workspaceId: 'workspace' }
const row = (patch: Partial<ThreadLifecycleRow> = {}): ThreadLifecycleRow => ({
  runId: 'run', ownerId: actor.userId, workspaceId: actor.workspaceId, epoch: 3, sandboxId: 'vm', state: 'running', deviceId: 'device',
  workerLeaseUntil: null, leaseExpiresAt: null, lastActiveAt: now - THREAD_MACHINE_IDLE_MS, runningSince: now - THREAD_MACHINE_IDLE_MS,
  computeSeconds: 0, lifecycleAt: now, lifecycleAtVersion: new Date(now).toISOString(), lifecycle: {}, status: 'queued', stopRequestedAt: null, issueId: 'task', taskClosed: false,
  checkpointReady: false, ...patch,
})

test('an unclaimed VM pauses at two minutes even when a daemon heartbeat stays fresh', () => {
  const idle = row()
  assert.equal(threadMachineLifecycleDecision(idle, running, now - 1).action, 'keep')
  assert.equal(threadMachineLifecycleDecision(idle, running, now).action, 'pause')
  assert.equal(threadMachineLifecycleDecision(row({ leaseExpiresAt: now + 90_000 }), running, now).action, 'keep')
  assert.equal(threadMachineLifecycleDecision(row({ workerLeaseUntil: now + 90_000 }), running, now).action, 'keep')
})

test('preparing, running, finishing, waiting_input and human-control statuses are not safe points', () => {
  for (const status of ['preparing', 'running', 'finishing', 'waiting_input', 'paused']) {
    const decision = threadMachineLifecycleDecision(row({ status, leaseExpiresAt: now + 90_000 }), running, now)
    assert.equal(decision.action, 'keep', status)
  }
})

test('a quota completion with an exited receipt parks without ending the waiting run', async () => {
  const quota = row({ status: 'paused', pauseReason: 'quota_exhausted', safeExit: true })
  assert.equal(threadMachineLifecycleDecision(quota, running, now).action, 'pause')
  const f = fixture(quota)
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(f.machine.state, 'paused')
  assert.equal(f.machine.status, 'paused')
  assert.equal(f.machine.stopRequestedAt, null)
  assert.equal(f.machine.lifecycle.reason, 'quota_wait')
  assert.equal(f.counts().endCalls, 0)
})

test('legacy quota waiting without a safe receipt is not mistaken for an expired execution lease', () => {
  const quota = row({ status: 'paused', pauseReason: 'quota_exhausted', safeExit: false })
  assert.deepEqual(threadMachineLifecycleDecision(quota, running, now),
    { action: 'wait', at: running.endAt, reason: 'quota_safe_point_unverified' })
  assert.equal(threadMachineLifecycleDecision(quota, paused, now).action, 'wait')
})

test('a terminal open task is parked; its workspace is not destroyed when its run ends', () => {
  for (const status of ['succeeded', 'failed', 'stopped', 'cancelled'])
    assert.equal(threadMachineLifecycleDecision(row({ status }), running, now).action, 'pause', status)
})

test('a bounded human review lease keeps a safely ended VM until its absolute deadline', () => {
  for (const status of ['succeeded', 'failed']) {
    const reviewed = row({ status, safeExit: true, reviewExpiresAt: now + 40_000 })
    assert.deepEqual(threadMachineLifecycleDecision(reviewed, running, now),
      { action: 'keep', at: now + 40_000, reason: 'human_review' })
    assert.deepEqual(threadMachineLifecycleDecision(reviewed, running, now + 40_000),
      { action: 'pause', at: now + 40_000, reason: 'run_ended' })
  }
})

test('review cannot defeat stop, cancellation, closure, lost execution or an unproved native exit', () => {
  const reviewed = row({ status: 'succeeded', safeExit: true, reviewExpiresAt: now + 60_000 })
  for (const patch of [{ stopRequestedAt: now }, { status: 'stopped' }, { status: 'cancelled' },
    { taskClosed: true }, { stopReason: 'device_lost' }, { safeExit: false },
    { computeSeconds: THREAD_MACHINE_BUDGET_MS / 1_000 }]) {
    assert.equal(threadMachineLifecycleDecision({ ...reviewed, ...patch }, running, now).action, 'pause', JSON.stringify(patch))
  }
  assert.equal(threadMachineLifecycleDecision({ ...reviewed, status: 'running', leaseExpiresAt: now - 1 }, running, now).reason,
    'execution_lease_lost')
})

test('review resume intent preserves the exact phase until completion, expiry or stop', async () => {
  const pending = row({ status: 'succeeded', safeExit: true, state: 'paused', runningSince: null,
    reviewExpiresAt: now + 60_000, lifecycle: { phase: 'review_resume_requested' } })
  assert.deepEqual(threadMachineLifecycleDecision(pending, paused, now),
    { action: 'wait', at: now + 60_000, reason: 'human_review_resume' })
  assert.equal(threadMachineLifecycleDecision({ ...pending, stopRequestedAt: now }, running, now).action, 'pause')
  const f = fixture(pending)
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(f.machine.lifecycle.phase, 'review_resume_requested')
  assert.equal(f.machine.lifecycleAt, now + 60_000)
  assert.equal(f.counts().pauseCalls, 0)
})

test('a kept review retains parked provenance and does not renew an Agent lease', async () => {
  const f = fixture(row({ status: 'succeeded', safeExit: true, reviewExpiresAt: now + 60_000, lifecycle: { phase: 'review_resumed' } }))
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(f.machine.lifecycle.phase, 'review_resumed')
  assert.equal(f.machine.lifecycleAt, now + 60_000)
  assert.equal(f.machine.leaseExpiresAt, null)
  assert.equal(f.counts().pauseCalls, 0)
})

test('a review opened after the lifecycle snapshot cannot be recorded as parked', async () => {
  const f = fixture(row({ status: 'succeeded', safeExit: true }))
  await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps,
    park: async () => ({ reviewHeldUntil: now + 30_000 }) })
  assert.equal(f.machine.state, 'running')
  assert.equal(f.machine.lifecycle.phase, 'review_resumed')
  assert.equal(f.machine.lifecycleAt, now + 30_000)
  assert.equal(f.counts().pauseCalls, 0)
})

test('stage handoff keeps the same VM for the admitted successor for 45 seconds, then parks', () => {
  const handoff = row({ status: 'succeeded', lifecycle: { phase: 'handoff', handoffRunId: 'next-run', handoffUntil: now + 45_000 } })
  assert.deepEqual(threadMachineLifecycleDecision(handoff, running, now), { action: 'wait', at: now + 45_000, reason: 'stage_handoff' })
  assert.equal(threadMachineLifecycleDecision(handoff, running, now + 45_000).action, 'pause')
  assert.equal(threadMachineLifecycleDecision({ ...handoff, taskClosed: true }, running, now).action, 'pause')
})

test('the execution budget counts running time and requests a stop without suspending a live process', () => {
  const exhausted = row({ status: 'running', computeSeconds: THREAD_MACHINE_BUDGET_MS / 1_000, leaseExpiresAt: now + 90_000 })
  assert.equal(threadMachineLifecycleDecision(exhausted, running, now).action, 'stop')
  assert.equal(threadMachineLifecycleDecision({ ...exhausted, stopRequestedAt: now }, running, now).action, 'keep')
  const resumed = row({ runningSince: now, computeSeconds: 120, lifecycle: { executionDeadline: now - 7 * 24 * 60 * 60_000 } })
  assert.equal(threadMachineExecutionDeadline(resumed, now), now + THREAD_MACHINE_BUDGET_MS - 120_000)
})

test('closed task retirement needs both an hour of retention and a matching uploaded checkpoint', () => {
  const closed = row({ state: 'paused', status: 'succeeded', taskClosed: true, checkpointReady: true, lifecycle: { pausedAt: now } })
  assert.equal(threadMachineLifecycleDecision(closed, paused, now + CLOSED_TASK_RETENTION_MS - 1).action, 'wait')
  assert.equal(threadMachineLifecycleDecision(closed, paused, now + CLOSED_TASK_RETENTION_MS).action, 'retire')
  assert.deepEqual(threadMachineLifecycleDecision({ ...closed, checkpointReady: false }, paused, now + CLOSED_TASK_RETENTION_MS),
    { action: 'wait', at: null, reason: 'checkpoint_unverified' })
})

test('seven days and a Git checkpoint do not authorize destroying an open task native session', () => {
  const open = row({ state: 'paused', status: 'stopped', checkpointReady: true, lifecycle: { pausedAt: now } })
  assert.deepEqual(threadMachineLifecycleDecision(open, paused, now + THREAD_MACHINE_RETENTION_MS),
    { action: 'wait', at: null, reason: 'native_archive_unverified' })
})

test('an ended row with an unacknowledged kill remains recoverable; a pending creation keeps its deadline', () => {
  assert.equal(threadMachineLifecycleDecision(row({ state: 'ended' }), running, now).action, 'retire')
  assert.deepEqual(threadMachineLifecycleDecision(row({ state: 'ended', sandboxId: null, workerLeaseUntil: now + 5_000 }), null, now),
    { action: 'wait', at: now + 5_000 + 1, reason: 'creation_cleanup_unconfirmed' })
})

/** Provider faults and lost responses on a small store boundary. SQL locking,
 * real transaction rollback and ownership races are covered by DB tests. */
function fixture(initial: ThreadLifecycleRow) {
  const machine = structuredClone(initial)
  let clock = now
  let refuseCommit = false
  let transactionSnapshot: ThreadLifecycleRow | undefined
  const queries: string[] = []
  const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length })
  const matches = (values: unknown[]) => machine.runId === values[0] && machine.ownerId === values[1] && machine.workspaceId === values[2]
    && machine.epoch === values[3] && machine.sandboxId === values[4]
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql)
    if (sql === 'BEGIN') { transactionSnapshot = structuredClone(machine); return result() }
    if (sql === 'COMMIT' && refuseCommit) { refuseCommit = false; throw new Error('commit response unavailable') }
    if (sql === 'COMMIT') { transactionSnapshot = undefined; return result() }
    if (sql === 'ROLLBACK') { if (transactionSnapshot) Object.assign(machine, transactionSnapshot); transactionSnapshot = undefined; return result() }
    if (sql.startsWith('SELECT m.*')) return result([{ ...structuredClone(machine),
      lifecycleAtVersion: machine.lifecycleAt == null ? null : new Date(machine.lifecycleAt).toISOString() }])
    if (sql.includes("SET state=CASE WHEN state='ended'")) {
      if (machine.runId !== values[0] || machine.ownerId !== values[1] || machine.workspaceId !== values[2] || machine.epoch !== values[3]
        || machine.lifecycle.reconcileId !== values[4] || machine.operationId !== values[5] || machine.sandboxId !== null
        || (machine.workerLeaseUntil !== null && new Date(machine.workerLeaseUntil).getTime() > Number(values[6]))) return result()
      if (machine.state !== 'ended') machine.state = 'error'
      return result([{ state: machine.state }])
    }
    if (sql.includes('SET "sandboxId"=$7')) {
      if (machine.runId !== values[0] || machine.ownerId !== values[1] || machine.workspaceId !== values[2] || machine.epoch !== values[3]
        || machine.lifecycle.reconcileId !== values[4] || machine.operationId !== values[5] || machine.sandboxId !== null
        || (machine.workerLeaseUntil !== null && new Date(machine.workerLeaseUntil).getTime() > Number(values[10]))) return result()
      machine.sandboxId = String(values[6])
      machine.state = machine.state === 'ended' ? 'ended' : String(values[7])
      machine.runningSince = values[7] === 'running' ? machine.runningSince ?? Number(values[8]) : null
      machine.workerLeaseId = null; machine.workerLeaseUntil = null
      delete machine.lifecycle.creationMissingAt
      machine.lifecycle = { ...machine.lifecycle, ...JSON.parse(String(values[9])), ...(machine.state === 'ended' ? { phase: 'retire_requested' } : {}) }
      return result([{ state: machine.state, runningSince: machine.runningSince, computeSeconds: machine.computeSeconds, lifecycle: structuredClone(machine.lifecycle) }])
    }
    if (sql.includes("'reconcileUntil',$7")) {
      if (!matches(values) || (machine.lifecycle.reconcileUntil ?? 0) > Number(values[7])) return result()
      if ((machine.lifecycleAt == null ? null : new Date(machine.lifecycleAt).toISOString()) !== values[8]
        || (machine.lifecycle.reconcileVersion ?? 0) !== Number(values[9])) return result()
      machine.lifecycle = { ...machine.lifecycle, owner: 'run-recovery', reconcileId: String(values[5]), reconcileUntil: Number(values[6]),
        reconcileVersion: (machine.lifecycle.reconcileVersion ?? 0) + 1 }
      machine.lifecycleAt = Number(values[6])
      return result([{ runId: machine.runId }])
    }
    if (sql.includes("lifecycle-'reconcileId'-'reconcileUntil'")) {
      if (!matches(values) || machine.lifecycle.reconcileId !== values[5] || (machine.state === 'ended' && !values[8])) return result()
      delete machine.lifecycle.reconcileId; delete machine.lifecycle.reconcileUntil
      machine.lifecycle = { ...machine.lifecycle, ...JSON.parse(String(values[6])) }
      machine.lifecycleAt = values[7] == null ? null : Number(values[7])
      return result([{ runId: machine.runId }])
    }
    if (sql.startsWith('SELECT state,epoch')) return result([structuredClone(machine)])
    if (sql.startsWith('SELECT id FROM agent_runs')) return result([{ id: machine.runId }])
    if (sql.startsWith('SELECT status,"stopRequestedAt","stopReason"')) return result([structuredClone(machine)])
    if (sql.startsWith('SELECT 1 FROM coding_review_sessions'))
      return result(machine.reviewExpiresAt && new Date(machine.reviewExpiresAt).getTime() > clock ? [{ found: 1 }] : [])
    if (sql.includes('SET state=$5') || sql.includes("SET state='error'")) {
      if (machine.epoch !== values[1] || machine.sandboxId !== values[2] || machine.lifecycle.reconcileId !== values[3]) return result()
      machine.state = sql.includes('SET state=$5') ? String(values[4]) : 'error'
      machine.runningSince = machine.state === 'running' ? machine.runningSince ?? clock : null
      return result([{ runningSince: machine.runningSince, computeSeconds: machine.computeSeconds }])
    }
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('UPDATE suggestion_executions')) return result()
    throw new Error(`Unimplemented fixture query: ${sql.slice(0, 60)}`)
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool
  let infoCalls = 0, keepAliveCalls = 0, pauseCalls = 0, endCalls = 0
  let providerState: 'running' | 'paused' | 'missing' = 'running'
  const deps = {
    provider: {
      info: async () => { infoCalls++; return { state: providerState, endAt: providerState === 'running' ? clock + 900_000 : null } },
      keepAlive: async () => { keepAliveCalls++ },
    },
    park: async (_pool: Pool, _actor: typeof actor, _runId: string, fence: { epoch: number; sandboxId: string | null }) => {
      if (fence.epoch !== machine.epoch || fence.sandboxId !== machine.sandboxId) return
      if (providerState !== 'paused') pauseCalls++
      providerState = 'paused'; machine.state = 'paused'
    },
    end: async () => { endCalls++; machine.state = 'ended'; machine.sandboxId = null; machine.lifecycleAt = null },
    stop: async () => { machine.stopRequestedAt = clock; return true },
    recover: async () => {},
    acknowledgeStop: async () => false,
    now: () => clock,
  }
  return { machine, pool, deps, queries, advance: (ms: number) => { clock += ms }, setProvider: (value: typeof providerState) => { providerState = value },
    failCommitOnce: () => { refuseCommit = true },
    counts: () => ({ infoCalls, keepAliveCalls, pauseCalls, endCalls }) }
}

test('#956: a resumed row is reconciled without a per-run monitor; terminal state parks it durably', async () => {
  const f = fixture(row({ status: 'succeeded', lifecycle: { phase: 'resumed' } }))
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), now + THREAD_MACHINE_RETENTION_MS)
  assert.equal(f.machine.state, 'paused')
  assert.equal(f.machine.lifecycle.owner, 'run-recovery')
  assert.equal(f.machine.lifecycle.observedStatus, 'succeeded')
  assert.equal(f.machine.lifecycle.reconcileId, undefined)
  assert.equal(f.counts().pauseCalls, 1)
})

test('a queued stop acknowledged after confirmed provider cleanup completes without another deadline', async () => {
  const f = fixture(row({ stopRequestedAt: now }))
  f.deps.acknowledgeStop = async () => {
    f.machine.state = 'ended'; f.machine.sandboxId = null; f.machine.lifecycleAt = null
    f.machine.lifecycle = { owner: 'run-recovery', phase: 'retired' }
    return true
  }
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), false)
  assert.equal(f.machine.lifecycleAt, null)
  assert.equal(f.counts().infoCalls, 0)
})

test('a lost create response is recovered from its exact operation and the unclaimed VM parks', async () => {
  const f = fixture(row({ sandboxId: null, state: 'starting', operationId: 'creation', workerLeaseId: 'old-worker',
    workerLeaseUntil: now - 1, runningSince: null, lifecycle: { phase: 'create_requested' } }))
  let lookups = 0
  const provider = { ...f.deps.provider, findCreated: async (...scope: string[]) => {
    assert.deepEqual(scope, ['run', 'workspace', 'creation', 'owner']); lookups++
    return { sandboxId: 'created-vm', state: 'running' as const, startedAt: now - 180_000, endAt: running.endAt }
  } }
  await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, provider })
  assert.equal(lookups, 1)
  assert.equal(f.machine.sandboxId, 'created-vm')
  assert.equal(f.machine.state, 'paused')
  assert.equal(f.machine.workerLeaseId, null)
  assert.equal(f.machine.workerLeaseUntil, null)
  assert.equal(f.machine.lifecycle.computeSource, 'provider_started_at_estimate')
  assert.equal(f.counts().pauseCalls, 1)
  assert.equal(f.counts().keepAliveCalls, 0)
})

test('a recovered paused creation stays paused with an explicitly unknown compute interval', async () => {
  const f = fixture(row({ sandboxId: null, state: 'starting', operationId: 'creation', workerLeaseUntil: now - 1,
    status: 'succeeded', runningSince: null, lifecycle: { phase: 'create_requested' } }))
  f.setProvider('paused')
  const provider = { ...f.deps.provider, findCreated: async () => ({ sandboxId: 'created-vm', state: 'paused' as const,
    startedAt: now - 900_000, endAt: null }) }
  await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, provider })
  assert.equal(f.machine.sandboxId, 'created-vm')
  assert.equal(f.machine.state, 'paused')
  assert.equal(f.machine.runningSince, null)
  assert.equal(f.machine.computeSeconds, 0)
  assert.equal(f.machine.lifecycle.computeSource, 'unconfirmed_creation_interval')
  assert.equal(f.counts().pauseCalls, 0)
  assert.equal(f.counts().keepAliveCalls, 0)
})

test('two empty creation lookups preserve pending intent and stop automatic discovery without claiming retirement', async () => {
  const f = fixture(row({ sandboxId: null, state: 'ended', operationId: 'creation', workerLeaseId: null,
    workerLeaseUntil: now - 1, lifecycle: { phase: 'retire_requested' } }))
  let lookups = 0
  const provider = { ...f.deps.provider, findCreated: async () => { lookups++; return null } }
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, provider }), now + 30_000)
  assert.equal(lookups, 1)
  f.advance(30_000)
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, provider }), false)
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, provider }), false)
  assert.equal(lookups, 2)
  assert.equal(f.machine.operationId, 'creation')
  assert.equal(f.machine.workerLeaseUntil, now - 1)
  assert.equal(f.machine.lifecycle.phase, 'needs_reconciliation')
  assert.equal(f.machine.lifecycle.reason, 'creation_cleanup_unconfirmed')
  assert.equal(f.counts().endCalls, 0)
})

test('a briefly invisible allocation is discovered once more before leaving a truthful error state', async () => {
  const f = fixture(row({ sandboxId: null, state: 'starting', operationId: 'creation', workerLeaseUntil: now - 1,
    runningSince: null, lifecycle: { phase: 'create_requested' } }))
  let lookups = 0
  const provider = { ...f.deps.provider, findCreated: async () => ++lookups === 1 ? null
    : { sandboxId: 'created-vm', state: 'running' as const, startedAt: now - 180_000, endAt: running.endAt } }
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, provider }), now + 30_000)
  assert.equal(f.machine.state, 'error')
  assert.equal(f.machine.workerLeaseUntil, now - 1)
  assert.equal(f.machine.lifecycle.creationMissingAt, now)
  f.advance(30_000)
  await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, provider })
  assert.equal(lookups, 2)
  assert.equal(f.machine.sandboxId, 'created-vm')
  assert.equal(f.machine.state, 'paused')
  assert.equal(f.counts().pauseCalls, 1)
})

test('live provisioning and transferred allocations do not run creation discovery', async () => {
  for (const patch of [
    { state: 'starting', workerLeaseUntil: now + 30_000, lifecycle: { phase: 'create_requested' } },
    { state: 'ended', workerLeaseUntil: null, lifecycle: { phase: 'transferred' } },
  ]) {
    const f = fixture(row({ sandboxId: null, operationId: 'creation', ...patch }))
    const provider = { ...f.deps.provider, findCreated: async () => { assert.fail('allocation must not be rediscovered'); return null } }
    await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, provider })
    assert.equal(f.counts().endCalls, 0)
  }
})

test('creation discovery cannot attach after the operation, claim, epoch or bootstrap changes', async () => {
  for (const change of [
    (machine: ThreadLifecycleRow) => { machine.operationId = 'replacement-creation' },
    (machine: ThreadLifecycleRow) => { machine.lifecycle.reconcileId = 'replacement-claim' },
    (machine: ThreadLifecycleRow) => { machine.epoch++ },
    (machine: ThreadLifecycleRow) => { machine.workerLeaseUntil = now + 60_000 },
  ]) {
    const f = fixture(row({ sandboxId: null, state: 'starting', operationId: 'creation', workerLeaseUntil: now - 1,
      lifecycle: { phase: 'create_requested' } }))
    const provider = { ...f.deps.provider, findCreated: async () => {
      change(f.machine)
      return { sandboxId: 'old-created-vm', state: 'running' as const, startedAt: now - 180_000, endAt: running.endAt }
    } }
    await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, provider })
    assert.equal(f.machine.sandboxId, null)
    assert.equal(f.counts().pauseCalls, 0)
    assert.equal(f.counts().endCalls, 0)
    assert.equal(f.counts().keepAliveCalls, 0)
  }
})

test('#957: a provider pause refusal persists a retry before the pass returns', async () => {
  const f = fixture(row())
  f.deps.park = async () => { throw new Error('provider refused') }
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), now + 5_000)
  assert.equal(f.machine.state, 'running')
  assert.equal(f.machine.lifecycle.phase, 'pause_failed')
  assert.equal(f.machine.lifecycle.failures, 1)
  assert.equal(f.machine.lifecycleAt, now + 5_000)
  assert.equal(f.machine.lifecycle.reconcileId, undefined)
})

test('provider pause success with a lost DB response is observed without waking the sandbox', async () => {
  const f = fixture(row({ status: 'succeeded' }))
  const realPark = f.deps.park
  f.deps.park = async () => { f.setProvider('paused'); throw new Error('DB unavailable after pause') }
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(f.machine.state, 'running')
  f.advance(5_000)
  f.deps.park = realPark
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(f.machine.state, 'paused')
  assert.equal(f.machine.lifecycle.phase, 'paused')
  assert.equal(f.counts().keepAliveCalls, 0)
  assert.equal(f.counts().pauseCalls, 0, 'observing a paused provider does not issue a second pause or connect')
})

test('simultaneous monitor and recovery passes share one committed claim', async () => {
  const f = fixture(row())
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const info = f.deps.provider.info
  f.deps.provider.info = async () => { entered(); await held; return info() }
  const first = reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  await started
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), now + 60_000)
  release()
  await first
  assert.equal(f.counts().infoCalls, 1)
  assert.equal(f.counts().pauseCalls, 1)
})

function heldSnapshot(pool: Pool) {
  let release!: () => void, observed!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { observed = resolve })
  let held = false
  const wrapped = {
    query: async (sql: string, values?: unknown[]) => {
      const result = await pool.query(sql, values)
      if (!held && sql.startsWith('SELECT m.*')) { held = true; observed(); await wait }
      return result
    },
    connect: () => pool.connect(),
  } as unknown as Pool
  return { pool: wrapped, ready, release }
}

for (const rearmed of [false, true]) test(`an old snapshot cannot claim after another callback completes${rearmed ? ', even if the original deadline is rearmed' : ''}`, async () => {
  const f = fixture(row({ status: 'running', leaseExpiresAt: now + 90_000 }))
  const first = heldSnapshot(f.pool), second = heldSnapshot(f.pool)
  const a = reconcileThreadMachine(first.pool, actor, 'run', f.deps)
  const b = reconcileThreadMachine(second.pool, actor, 'run', f.deps)
  await Promise.all([first.ready, second.ready])
  first.release()
  await a
  // An explicit wake can move the timestamp back to the same clock tick. Its
  // fresh intent still cannot turn an old snapshot into a fresh claim (ABA).
  if (rearmed) f.machine.lifecycleAt = now
  second.release()
  await b
  assert.equal(f.counts().infoCalls, 1)
  assert.equal(f.counts().keepAliveCalls, 1)
})

test('sequential duplicate callbacks share the deadline and provider failure backoff', async () => {
  const f = fixture(row({ status: 'running', leaseExpiresAt: now+90_000 }))
  const deadline = await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), deadline)
  assert.equal(f.counts().infoCalls, 1)
  assert.equal(f.counts().keepAliveCalls, 1)
  f.machine.status = 'succeeded'
  f.deps.park = async () => { throw new Error('provider refused') }
  const retry = await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  const attempts = f.counts().infoCalls
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), retry)
  assert.equal(f.counts().infoCalls, attempts, 'a duplicate callback cannot spend another provider attempt before backoff')
})

test('an old epoch cannot pause or overwrite a sandbox transferred to the next run', async () => {
  const f = fixture(row())
  f.deps.provider.info = async () => { f.machine.epoch++; f.machine.sandboxId = null; f.machine.state = 'ended'; return running }
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(f.counts().pauseCalls, 0)
  assert.equal(f.machine.state, 'ended')
  assert.equal(f.machine.lifecycle.phase, undefined)
})

test('a live offline CLI gets a static timeout renewal and preserves its execution deadline', async () => {
  const f = fixture(row({ status: 'running', leaseExpiresAt: now + 90_000 }))
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), now + 5 * 60_000)
  assert.equal(f.counts().keepAliveCalls, 1)
  assert.equal(f.counts().pauseCalls, 0)
  assert.equal(f.machine.lifecycle.phase, 'active')
  assert.equal(f.machine.lifecycle.executionDeadline, now + THREAD_MACHINE_BUDGET_MS - THREAD_MACHINE_IDLE_MS)
})

test('lost execution leases request recovery and stop; a broken worker is suspended after a bounded grace', async () => {
  const f = fixture(row({ status: 'running', leaseExpiresAt: now - 1 }))
  let recovered = false
  f.deps.recover = async () => { recovered = true }
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), now + 30_000)
  assert.equal(recovered, true)
  assert.equal(f.machine.stopRequestedAt, now)
  assert.equal(f.machine.lifecycle.observedStop, true)
  f.advance(30_000)
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(f.machine.state, 'paused')
  assert.equal(f.machine.status, 'running', 'suspending memory is not a fabricated CLI completion')
  assert.equal(f.machine.lifecycle.reason, 'stop_unacknowledged')
  assert.equal(f.counts().endCalls, 0)
})

test('a heartbeat renewing the lease during provider inspection prevents a stale stop and is reread immediately', async () => {
  const f = fixture(row({ status: 'running', leaseExpiresAt: now - 1 }))
  f.deps.provider.info = async () => {
    // The initial controller snapshot has expired; the current run has not.
    f.machine.leaseExpiresAt = now + 90_000
    return running
  }
  f.deps.stop = async () => false
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), now + 1)
  assert.equal(f.machine.stopRequestedAt, null)
  assert.equal(f.machine.lifecycle.observedStop, false)
  assert.equal(f.machine.lifecycle.reconcileId, undefined)
  assert.equal(f.counts().keepAliveCalls, 0, 'the refused stop releases its old decision before reconciling again')
  f.advance(1)
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(f.counts().keepAliveCalls, 1)
  assert.equal(f.machine.lifecycle.phase, 'active')
})

test('a task reopened during provider inspection is not recorded as stopped after its stop guard refuses', async () => {
  const f = fixture(row({ status: 'running', leaseExpiresAt: now + 90_000, taskClosed: true }))
  f.deps.provider.info = async () => { f.machine.taskClosed = false; return running }
  f.deps.stop = async () => false
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), now + 1)
  assert.equal(f.machine.stopRequestedAt, null)
  assert.equal(f.machine.lifecycle.observedStop, false)
  assert.equal(f.machine.lifecycle.reconcileId, undefined)
})

test('a missing provider is recorded truthfully, reconfirmed once, and preserves native identity for reconciliation', async () => {
  const f = fixture(row({ status: 'succeeded' }))
  f.setProvider('missing')
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), now + 30_000)
  assert.equal(f.machine.state, 'error')
  assert.equal(f.machine.sandboxId, 'vm')
  f.advance(30_000)
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), false)
  assert.equal(f.machine.lifecycle.phase, 'needs_reconciliation')
  assert.equal(f.machine.lifecycle.reason, 'provider_missing')
  assert.equal(f.counts().endCalls, 0)
})

test('a provider miss during the bootstrap lease is deferred until the creation deadline', () => {
  const initial = row({ state: 'starting', workerLeaseUntil: now + 60_000 })
  assert.deepEqual(threadMachineLifecycleDecision(initial, { state: 'missing', endAt: null }, now),
    { action: 'wait', at: now + 60_001, reason: 'provisioning' })
})

test('a provider resume whose DB response was lost renews the running VM instead of abandoning it as paused', async () => {
  const f = fixture(row({ state: 'paused', status: 'running', leaseExpiresAt: now + 90_000, runningSince: null, lifecycle: { phase: 'resume_requested' } }))
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(f.machine.state, 'running')
  assert.equal(f.machine.lifecycle.phase, 'active')
  assert.equal(f.counts().keepAliveCalls, 1)
})

test('a reopened task or changed archival proof refusing retirement cannot be marked retired', async () => {
  const f = fixture(row({ state: 'paused', status: 'succeeded', taskClosed: true, checkpointReady: true, lifecycle: { pausedAt: now - CLOSED_TASK_RETENTION_MS } }))
  f.setProvider('paused')
  await reconcileThreadMachine(f.pool, actor, 'run', { ...f.deps, end: async () => ({ state: 'paused' }) })
  assert.equal(f.machine.state, 'paused')
  assert.equal(f.machine.lifecycle.phase, 'needs_reconciliation')
  assert.equal(f.machine.lifecycle.reason, 'retirement_guard_refused')
})

test('a late park callback cannot replace a committed retirement retry with paused retention', async () => {
  const f = fixture(row({ status: 'succeeded' }))
  f.deps.park = async () => {
    // End commits before the park lock. Its provider kill then refuses; park
    // observes ended and returns without touching the still-owned allocation.
    f.machine.state = 'ended'
    f.machine.lifecycle.phase = 'retire_failed'
    f.machine.lifecycleAt = now + 30_000
  }
  assert.equal(await reconcileThreadMachine(f.pool, actor, 'run', f.deps), now + 1)
  assert.equal(f.machine.lifecycle.phase, 'retire_failed')
  assert.equal(f.machine.lifecycleAt, now + 30_000)
  assert.equal(f.machine.sandboxId, 'vm')
  assert.equal(f.counts().pauseCalls, 0)
})

test('lifecycle transition logs hash identity and reject raw provider text and nonfinite numbers', () => {
  const privateValue = 'secret-token@example.com?key=private'
  const fields = threadLifecycleLogFields({ runId: privateValue, issueId: privateValue, sandboxId: privateValue, epoch: Infinity },
    { phase: privateValue, reason: privateValue, provider: privateValue, deadline: NaN, computeSeconds: 'Infinity', computeSource: privateValue })
  assert.equal(JSON.stringify(fields).includes(privateValue), false)
  assert.equal(fields.phase, 'needs_reconciliation')
  assert.equal(fields.reason, 'unknown')
  assert.equal(fields.provider, 'not_observed')
  assert.equal(fields.epoch, null)
  assert.equal(fields.deadline, null)
  assert.equal(fields.computeSeconds, null)
  assert.equal(fields.computeSource, 'database_estimate')
  assert.match(fields.run!, /^[a-f0-9]{12}$/)
  assert.notEqual(fields.run, fields.task, 'identity domains cannot be linked accidentally')
  assert.equal(fields.run, threadLifecycleLogFields({ runId: privateValue, epoch: 1 }, { phase: 'active' }).run)
  const error = new Error(privateValue); error.name = privateValue
  assert.equal(threadLifecycleErrorKind(error), 'UnknownError')
})

test('unchanged active maintenance emits no duplicate phase transition', async () => {
  const f = fixture(row({ status: 'running', leaseExpiresAt: now + 90_000 }))
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(lifecycleLog.mock.callCount(), 1)
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  assert.equal(lifecycleLog.mock.callCount(), 1)
})

test('a failed keepalive transaction never logs committed active success', async () => {
  const f = fixture(row({ status: 'running', leaseExpiresAt: now + 90_000 }))
  f.failCommitOnce()
  await reconcileThreadMachine(f.pool, actor, 'run', f.deps)
  const phases = lifecycleLog.mock.calls.map(call => (call.arguments[1] as { phase: string }).phase)
  assert.ok(phases.length > 0)
  assert.equal(phases.includes('active'), false)
  assert.deepEqual(phases, ['needs_reconciliation'])
})
