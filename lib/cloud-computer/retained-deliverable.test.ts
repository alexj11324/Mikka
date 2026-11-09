import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { gzipSync } from 'node:zlib'
import type { Pool, PoolClient } from 'pg'
import { createRetainedDeliverableObserver, type RetainedDeliverableRuntime } from './retained-deliverable'
import { retainedDeliverableForRecovery, type RetainedDeliverableScope } from '../factory/deliverable-recovery'
import type { FactoryTask } from '../factory/store'

// The provider-orchestration fixture has no real node-postgres executor.
// Keep inherited app configuration out; live commit semantics use real PG tests.
const liveEnvironment = { DEVICE_GATEWAY_URL:process.env.DEVICE_GATEWAY_URL, DEVICE_GATEWAY_PUSH_SECRET:process.env.DEVICE_GATEWAY_PUSH_SECRET }
process.env.DEVICE_GATEWAY_URL = 'https://unused-retained-fixture.invalid'
delete process.env.DEVICE_GATEWAY_PUSH_SECRET
after(() => {
  for (const [key,value] of Object.entries(liveEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

const id = (n: number) => `71660000-0000-4000-8000-${String(n).padStart(12, '0')}`
const instant = Date.parse('2026-11-04T04:00:00Z')
const refused = { code: 'factoryDeliverableSnapshotUnavailable' }

/** Provider orchestration against a synthetic admitted row. The real shared
 * eligibility projection/hash code runs here; its SQL ownership predicates and
 * the final receipt transaction are covered by the factory PostgreSQL tests. */
async function fixture() {
  const task: FactoryTask = { id: id(1), userId: 'fixture-owner', issueId: id(2), botId: id(3), scopeVersion: 1,
    sourceEventId: id(4), revision: 18, stage: 'review', status: 'waiting', attemptId: id(5), candidateId: id(6), reason: '',
    route: { issueId: id(2), eventId: id(4), sourceEventId: id(4), rationale: 'fixture', missingInformation: [], missingPermissions: [], needsSpec: false } }
  const producer = { id: id(7), botId: task.botId, sessionId: 'original-native-session', kind: 'implement',
    agentDefinition: { readOnly: false }, continuesRunId: id(17),
    questionContinuation: { questionId: id(18), originSessionId: 'original-native-session', requireSessionResume: true },
    report: { sourceCommit: 'a'.repeat(40), verify: { status: 'not_run' } },
    deviceId: id(8), deviceRepoId: id(9), worktreePath: `/home/user/.mikka/worker/worktrees/${id(10)}` }
  const review = { id: id(11), botId: task.botId }, candidate = { id: task.candidateId, runId: producer.id }
  const question = { id: id(12), revision: 1, status: 'open', answer: null, answerId: null,
    waitingBinding: { taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, candidateId: task.candidateId, revision: task.revision } }
  const row = { producer, review, candidate, question, workspaceId: id(13), repoPath: `/home/user/.mikka/bot-workspaces/${task.botId}`, remoteUrl: null,
    sandboxId: 'fixture-original-vm', machineOperationId: id(14), machineSnapshotId: 'desktop',
    checkpointBase: producer.report.sourceCommit, checkpointFiles: 1,
    checkpointTakenAt: new Date(instant - 120_000), checkpointUpdatedAt: new Date(instant - 120_000),
    patch: gzipSync(Buffer.from('diff --git a/DELIVERY.md b/DELIVERY.md\nnew file mode 100644\n+verified artifact\n')) }
  const machine = { runId: review.id, ownerId: task.userId, workspaceId: row.workspaceId, sandboxId: row.sandboxId,
    operationId: row.machineOperationId, snapshotId: row.machineSnapshotId, deviceId: producer.deviceId, repoId: producer.deviceRepoId,
    state: 'paused', runningSince: null, workerLeaseId: null as string | null, workerLeaseUntil: null as number | null }
  const state = { now: instant, inTransaction: false, eligible: true, permission: 'allow', failLease: false,
    failSession: null as 'start' | 'end' | null,
    admissionReads: 0, taskLocks: 0, destroyedConnections: 0, beforeSecondRead: undefined as (() => void) | undefined }
  const events: string[] = [], logs: string[] = [], queries: { sql: string; values: unknown[] }[] = []
  const sessions: { startedAt: number; endedAt: number | null; source: string; reason: string | null }[] = []
  let rollbackMachine = { ...machine }
  let rollbackSessions = structuredClone(sessions)
  const matches = (values: unknown[]) => [machine.runId, machine.ownerId, machine.workspaceId, machine.sandboxId, machine.operationId, machine.workerLeaseId]
    .every((value, index) => value === values[index])
  const result = (rows: object[] = []) => ({ rows, rowCount: rows.length })
  const query = async (input: string | { text: string; values?: unknown[] }, parameters?: unknown[]) => {
    const sql = typeof input === 'string' ? input : input.text, values = parameters ?? (typeof input === 'string' ? [] : input.values ?? [])
    queries.push({ sql, values })
    if (sql === 'BEGIN') { assert.equal(state.inTransaction, false); state.inTransaction = true; rollbackMachine = { ...machine }; rollbackSessions = structuredClone(sessions); events.push('begin'); return result() }
    if (sql === 'COMMIT') { state.inTransaction = false; events.push('commit'); return result() }
    if (sql === 'ROLLBACK') { Object.assign(machine, rollbackMachine); sessions.splice(0,sessions.length,...rollbackSessions); state.inTransaction = false; events.push('rollback'); return result() }
    if (sql.startsWith('SET LOCAL') || sql.startsWith('SELECT set_config')) return result()
    if (sql.includes('pg_advisory_xact_lock')) { assert.equal(state.inTransaction, true); assert.deepEqual(values, [`computer-policy:${row.workspaceId}`]); events.push('policy_lock'); return result() }
    if (sql.startsWith('SELECT permission')) return result([{ permission: state.permission }])
    if (sql.startsWith('SELECT to_jsonb(producer)')) {
      state.admissionReads++
      if (state.admissionReads === 2) state.beforeSecondRead?.()
      const token = values[8]
      const leaseMatches = token ? token === machine.workerLeaseId && (machine.workerLeaseUntil ?? 0) > state.now :
        machine.workerLeaseUntil === null || machine.workerLeaseUntil <= state.now
      if (!state.eligible || machine.state !== 'paused' || !leaseMatches) return result()
      return result([{ ...row, sandboxId: machine.sandboxId, machineOperationId: machine.operationId, machineSnapshotId: machine.snapshotId }])
    }
    if (sql.startsWith('SELECT a.id,a.stage,a.status')) return result([{ ownerRevision: 16, completionRevision: 17, evidence: [],
      completionRecoveryEventId: id(15), completionEventId: id(16) }])
    if (sql.startsWith('SELECT "runId" FROM thread_machines')) { assert.equal(state.inTransaction, true); return result([{ runId: machine.runId }]) }
    if (sql.startsWith('SELECT id FROM agent_runs WHERE')) { assert.equal(state.inTransaction,true); return result([{ id:machine.runId }]) }
    if (sql.startsWith('WITH parent AS MATERIALIZED')) {
      assert.equal(state.inTransaction, true, 'session observations share the bounded custody transaction')
      const held = matches(values) && machine.state === 'paused' && machine.runningSince === null && (machine.workerLeaseUntil ?? 0) > state.now
      if (!held) return result([{ held: false, changed: false }])
      const open = sessions.find(session => session.endedAt === null)
      const starting = sql.includes('INSERT INTO thread_machine_sessions')
      if (state.failSession === 'start' && starting || state.failSession === 'end' && !starting && open) throw new Error('Synthetic session write failure')
      if (starting && !open) {
        sessions.push({ startedAt: state.now, endedAt: null, source: 'observed', reason: null }); events.push('session_started')
      } else if (!starting && open) { open.endedAt = state.now; open.reason = 'paused'; events.push('session_ended') }
      return result([{ held: true, changed: starting ? !open : Boolean(open) }])
    }
    if (sql.startsWith('UPDATE thread_machines SET "workerLeaseId"=$6')) {
      assert.equal(state.inTransaction, true)
      if (state.failLease || (machine.workerLeaseUntil !== null && machine.workerLeaseUntil > state.now)) return result()
      assert.match(sql, /interval '3 minutes'/)
      assert.deepEqual(values.slice(0, 5), [machine.runId, machine.ownerId, machine.workspaceId, machine.sandboxId, machine.operationId])
      assert.deepEqual(values.slice(6), [machine.deviceId, machine.repoId, machine.snapshotId])
      machine.workerLeaseId = values[5] as string; machine.workerLeaseUntil = state.now + 180_000
      events.push('lease'); return result([{ runId: machine.runId }])
    }
    if (sql.startsWith('UPDATE thread_machines SET "workerLeaseId"=NULL')) {
      assert.equal(state.inTransaction, false)
      if (!matches(values)) return result()
      machine.workerLeaseId = null; machine.workerLeaseUntil = null; events.push('release'); return result([{ runId: machine.runId }])
    }
    if (sql.startsWith("UPDATE thread_machines SET state='error'")) {
      assert.equal(state.inTransaction, false)
      if (!matches(values) || machine.state === 'ended') return result()
      machine.state = 'error'; events.push('unconfirmed'); return result([{ runId: machine.runId }])
    }
    assert.fail(`Unexpected observer fixture query: ${sql}`)
  }
  const tx = { query, release: (error?: Error) => {
    if (error) { state.destroyedConnections++; Object.assign(machine, rollbackMachine); sessions.splice(0,sessions.length,...rollbackSessions); state.inTransaction = false }
    assert.equal(state.inTransaction, false)
  } } as unknown as PoolClient
  const pool = { query, connect: async () => tx } as unknown as Pool
  const eligibility = await retainedDeliverableForRecovery(tx, task)
  assert.ok(eligibility)
  const scope = eligibility.scope
  state.admissionReads = 0; queries.length = 0
  const originalScope = structuredClone(scope), originalRows = structuredClone({ producer, review, candidate, question })
  const value = { head: 'b'.repeat(40), tree: 'c'.repeat(40), diffSha256: scope.checkpoint.patchSha256, diffBytes: scope.checkpoint.patchBytes,
    clean: true, observedAt: new Date(instant).toISOString(), journalUpdatedAt: new Date(instant - 60_000).toISOString(),
    producerRunId: producer.id, sessionId: producer.sessionId, worktreePath: producer.worktreePath }
  const calls: { phase: string; sandboxId: string; budget: number }[] = []
  const commands: { command: string; options: { user: string; timeoutMs: number; requestTimeoutMs: number; signal: AbortSignal } }[] = []
  const hooks: Partial<Record<'state' | 'connect' | 'script' | 'probe' | 'pause', () => void | Promise<void>>> = {}
  let states = 0
  const record = async (phase: keyof typeof hooks, received: RetainedDeliverableScope, budget: (maximum: number) => number) => {
    assert.equal(state.inTransaction, false, 'provider I/O must be outside database locks')
    assert.deepEqual(received, originalScope, 'only the original, DB-authorized scope reaches the provider')
    const remaining = budget(60_000)
    assert.ok(remaining > 0 && remaining <= 55_000)
    calls.push({ phase, sandboxId: received.sandboxId, budget: remaining }); events.push(phase)
    await hooks[phase]?.()
  }
  const output = { stdout: JSON.stringify({ ok: true, value }), exitCode: 0 }
  const sandbox = { sandboxId: scope.sandboxId, commands: { run: async (command: string, options: typeof commands[number]['options']) => {
    assert.equal(state.inTransaction, false); events.push('probe'); commands.push({ command, options }); await hooks.probe?.(); return output
  } } }
  const runtime: RetainedDeliverableRuntime = {
    state: async (received, budget) => { await record('state', received, budget); states++; return 'paused' },
    connect: async (received, budget) => { await record('connect', received, budget); return sandbox },
    pause: async (received, budget) => { await record('pause', received, budget) },
    script: async () => { events.push('script'); await hooks.script?.(); return '// the deployed standalone probe\n' },
    now: () => state.now, log: line => logs.push(line),
  }
  const lockTask = async (received: PoolClient) => {
    assert.equal(received, tx); assert.equal(state.inTransaction, true); assert.equal(events.at(-1), 'policy_lock')
    state.taskLocks++; return task
  }
  const observe = () => createRetainedDeliverableObserver(pool, lockTask, runtime)(scope)
  const unchanged = () => assert.deepEqual({ producer, review, candidate, question }, originalRows)
  return { observe, pool, tx, lockTask, scope, row, machine, sessions, task, state, events, logs, queries, calls, commands, hooks, output, value, sandbox, runtime, unchanged,
    states: () => states }
}

test('observes only the admitted retained VM, restores pause, and keeps its lease for the final task transaction', async () => {
  const f = await fixture(), observed = await f.observe()
  assert.deepEqual(f.scope.legacyQuestionSubmission, { questionId: id(18), continuesRunId: id(17) })
  assert.deepEqual(observed.snapshot, { ...f.value, sandboxId: f.scope.sandboxId, machineRunId: f.scope.machineRunId })
  assert.equal(observed.leaseId, f.machine.workerLeaseId)
  assert.equal(f.machine.workerLeaseUntil, instant + 180_000)
  assert.equal(f.machine.state, 'paused')
  assert.equal(f.machine.runningSince, null, 'maintenance never changes the custody state used by recovery')
  assert.deepEqual(f.sessions, [{ startedAt: instant, endedAt: instant, source: 'observed', reason: 'paused' }])
  assert.ok(f.events.indexOf('session_started') > f.events.indexOf('connect'))
  assert.ok(f.events.indexOf('session_ended') > f.events.lastIndexOf('state'))
  assert.deepEqual(f.calls.map(call => call.phase), ['state', 'connect', 'pause', 'state'])
  assert.deepEqual(f.events.filter(event => ['state', 'connect', 'script', 'probe', 'pause'].includes(event)), ['state', 'connect', 'script', 'probe', 'pause', 'state'])
  assert.ok(f.state.taskLocks >= 4, 'each effect rechecks the authorized task and held lease')
  assert.equal(f.commands.length, 1)
  const { command, options } = f.commands[0]
  assert.match(command, /^\/usr\/bin\/timeout --signal=TERM --kill-after=2s /)
  assert.match(command, /\/usr\/bin\/env -i/)
  assert.match(command, /\/opt\/mikka\/runtime\/node\/bin\/node/)
  assert.match(command, /the deployed standalone probe/)
  const encodedInput = command.match(/--mikka-retained-delivery-probe '([A-Za-z0-9_-]+)'$/)?.[1]
  assert.ok(encodedInput)
  assert.deepEqual(JSON.parse(Buffer.from(encodedInput, 'base64url').toString('utf8')).legacyQuestionSubmission, f.scope.legacyQuestionSubmission)
  assert.equal(options.user, 'user'); assert.equal(options.timeoutMs, options.requestTimeoutMs)
  assert.ok(options.timeoutMs <= 25_000 && options.signal instanceof AbortSignal)
  assert.deepEqual(f.logs, []); f.unchanged()
  await observed.release()
  assert.equal(f.machine.workerLeaseId, null); assert.equal(f.machine.workerLeaseUntil, null)
})

test('policy, full-scope drift, second-read drift and a lost lease CAS all refuse before provider I/O', async () => {
  for (const fault of ['deny', 'unknown_policy', 'owner', 'question', 'checkpoint', 'producer_predecessor', 'second_read', 'lease_cas']) {
    const f = await fixture()
    if (fault === 'deny') f.state.permission = 'deny'
    if (fault === 'unknown_policy') f.state.permission = 'unexpected'
    if (fault === 'owner') f.scope.ownerId = 'another-owner'
    if (fault === 'question') f.scope.questionIdentityDigest = 'd'.repeat(64)
    if (fault === 'checkpoint') f.scope.checkpoint.patchSha256 = 'd'.repeat(64)
    if (fault === 'producer_predecessor') f.scope.legacyQuestionSubmission!.continuesRunId = id(90)
    if (fault === 'second_read') f.state.beforeSecondRead = () => { f.row.question.revision++ }
    if (fault === 'lease_cas') f.state.failLease = true
    await assert.rejects(f.observe(), refused, fault)
    assert.equal(f.calls.length, 0, fault); assert.equal(f.commands.length, 0, fault)
    assert.equal(f.machine.workerLeaseId, null, fault); assert.equal(f.state.inTransaction, false, fault)
    assert.ok(f.events.includes('rollback'), fault)
  }
})

test('custody lost before connect or after connect prevents the next effect and prevents pausing the new owner', async () => {
  for (const moment of ['state', 'connect', 'script', 'probe'] as const) {
    for (const drift of ['lease', 'operation', 'sandbox', 'ended'] as const) {
      const f = await fixture()
      f.hooks[moment] = () => {
        if (drift === 'lease') f.machine.workerLeaseId = id(90)
        if (drift === 'operation') f.machine.operationId = id(91)
        if (drift === 'sandbox') f.machine.sandboxId = 'new-owner-vm'
        if (drift === 'ended') { f.machine.state = 'ended'; f.machine.workerLeaseId = null; f.machine.workerLeaseUntil = null }
      }
      await assert.rejects(f.observe(), refused, `${moment}:${drift}`)
      assert.equal(f.calls.filter(call => call.phase === 'pause').length, 0, `${moment}:${drift}`)
      if (moment === 'state') assert.equal(f.calls.filter(call => call.phase === 'connect').length, 0)
      if (moment !== 'probe') assert.equal(f.commands.length, 0)
      if (drift === 'lease') assert.equal(f.machine.workerLeaseId, id(90), 'cleanup never clears a newer lease')
      if (drift === 'ended') assert.equal(f.machine.state, 'ended')
      f.unchanged()
    }
  }
})

test('scope changes with the same lease also invalidate provider authority', async () => {
  for (const moment of ['state', 'connect', 'probe'] as const) {
    const f = await fixture()
    f.hooks[moment] = () => { f.row.question.revision++ }
    await assert.rejects(f.observe(), refused)
    assert.equal(f.calls.some(call => call.phase === 'pause'), false)
    if (moment === 'state') assert.equal(f.calls.some(call => call.phase === 'connect'), false)
    if (moment === 'connect') assert.equal(f.commands.length, 0)
  }
})

test('provider errors and malformed probe output restore this VM and release only its own lease without exposing raw text', async () => {
  for (const fault of ['script', 'probe', 'json', 'large', 'exit', 'unknown_code', 'safe_code', 'journal_state', 'journal_binding']) {
    const f = await fixture()
    if (fault === 'script' || fault === 'probe') f.hooks[fault] = () => { throw new Error('PRIVATE-CREDENTIAL raw provider output') }
    if (fault === 'json') f.output.stdout = 'PRIVATE-CREDENTIAL invalid json'
    if (fault === 'large') f.output.stdout = 'PRIVATE-CREDENTIAL'.repeat(1000)
    if (fault === 'exit') { f.output.exitCode = 9; f.output.stdout = 'PRIVATE-CREDENTIAL stderr' }
    if (fault === 'unknown_code') f.output.stdout = JSON.stringify({ ok: false, code: 'PRIVATE-CREDENTIAL' })
    if (fault === 'safe_code') f.output.stdout = JSON.stringify({ ok: false, code: 'retained_delivery_git_filter', message: 'PRIVATE-CREDENTIAL' })
    if (fault === 'journal_state' || fault === 'journal_binding') f.output.stdout = JSON.stringify({ ok: false, code: `retained_delivery_${fault}_mismatch`, message: 'PRIVATE-CREDENTIAL' })
    await assert.rejects(f.observe(), refused, fault)
    assert.equal(f.calls.filter(call => call.phase === 'pause').length, 1, fault)
    assert.equal(f.machine.workerLeaseId, null, fault)
    assert.equal(f.machine.state, 'paused', fault)
    assert.equal(f.sessions.length, 1, fault)
    assert.equal(f.sessions[0].reason, 'paused', fault)
    assert.doesNotMatch(f.logs.join('\n'), /PRIVATE-CREDENTIAL/)
    assert.equal(JSON.parse(f.logs[0]).code, fault === 'safe_code' ? 'retained_delivery_git_filter' :
      fault === 'journal_state' || fault === 'journal_binding' ? `retained_delivery_${fault}_mismatch` : undefined)
    f.unchanged()
  }
})

test('an unexpected returned sandbox is never probed or paused through that object', async () => {
  const f = await fixture()
  f.sandbox.sandboxId = 'foreign-returned-vm'
  await assert.rejects(f.observe(), refused)
  assert.equal(f.commands.length, 0)
  assert.ok(f.calls.every(call => call.sandboxId === f.scope.sandboxId))
  assert.equal(f.calls.filter(call => call.phase === 'pause').length, 1)
  assert.ok(f.machine.workerLeaseId, 'an unexpected connect result does not establish that the requested resume completed')
  assert.equal(f.machine.state, 'error')
})

test('a failed or genuinely late connect remains uncertain even after a paused read, so it retains error and lease', async () => {
  for (const fault of ['error', 'late']) {
    const f = await fixture()
    let finishConnect: (() => void) | undefined
    if (fault === 'error') f.hooks.connect = () => { throw new Error('PRIVATE-CREDENTIAL ambiguous connect') }
    else {
      f.hooks.state = () => { if (f.states() === 0) f.state.now = instant + 34_990 }
      f.hooks.connect = () => new Promise<void>(resolve => { finishConnect = resolve })
    }
    await assert.rejects(f.observe(), refused)
    assert.equal(f.machine.state, 'error')
    assert.ok(f.machine.workerLeaseId)
    assert.equal(f.machine.workerLeaseUntil, instant + 180_000)
    assert.equal(f.calls.filter(call => call.phase === 'pause').length, 1)
    assert.equal(f.commands.length, 0)
    assert.deepEqual(f.sessions, [], 'an uncertain connect is not evidence of a start')
    assert.doesNotMatch(f.logs.join('\n'), /PRIVATE-CREDENTIAL/)
    const before = { ...f.machine }, callCount = f.calls.length
    finishConnect?.()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.machine, before, 'a late response cannot release the lease or accept a snapshot')
    assert.equal(f.calls.length, callCount, 'no background provider operation may act after the observation ends')
    f.unchanged()
  }
})

test('a pool connection acquired after the transaction deadline is destroyed without issuing a query', async () => {
  const f = await fixture()
  let reads = 0, finishConnect: ((client: PoolClient) => void) | undefined
  f.runtime.now = () => reads++ === 0 ? instant : instant + 34_990
  const pending = new Promise<PoolClient>(resolve => { finishConnect = resolve })
  const pool = { query: f.pool.query, connect: () => pending } as unknown as Pool
  await assert.rejects(createRetainedDeliverableObserver(pool, f.lockTask, f.runtime)(f.scope), refused)
  finishConnect!(f.tx)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.state.destroyedConnections, 1)
  assert.equal(f.queries.length, 0)
  assert.equal(f.calls.length, 0)
})

test('unconfirmed pause retains the lease and records error; it never reports a successful snapshot', async () => {
  for (const fault of ['pause_error', 'still_running', 'verification_error']) {
    const f = await fixture()
    if (fault === 'pause_error') f.hooks.pause = () => { throw new Error('PRIVATE-CREDENTIAL') }
    if (fault !== 'pause_error') {
      const originalState = f.runtime.state
      f.runtime.state = async (scope, budget) => {
        const state = await originalState(scope, budget)
        if (f.states() > 1) {
          if (fault === 'verification_error') throw new Error('PRIVATE-CREDENTIAL')
          return 'running'
        }
        return state
      }
    }
    await assert.rejects(f.observe(), refused)
    assert.equal(f.machine.state, 'error', fault)
    assert.ok(f.machine.workerLeaseId, fault)
    assert.equal(f.machine.workerLeaseUntil, instant + 180_000)
    assert.equal(f.sessions.length, 1)
    assert.equal(f.sessions[0].endedAt, null, 'pause request or ambiguous result cannot close a running interval')
    assert.doesNotMatch(f.logs.join('\n'), /PRIVATE-CREDENTIAL/)
    f.unchanged()
  }
})

test('an already-running provider VM is refused before connect and is not paused by an observation that did not resume it', async () => {
  const f = await fixture(), originalState = f.runtime.state
  f.runtime.state = async (scope, budget) => { await originalState(scope, budget); return 'running' }
  await assert.rejects(f.observe(), refused)
  assert.deepEqual(f.calls.map(call => call.phase), ['state'])
  assert.equal(f.machine.state, 'error'); assert.equal(f.machine.workerLeaseId, null)
})

test('a failed session write restores the VM or retains uncertainty without inventing a closed interval', async () => {
  for (const fault of ['start', 'end'] as const) {
    const f = await fixture()
    f.state.failSession = fault
    await assert.rejects(f.observe(), refused)
    assert.equal(f.calls.filter(call => call.phase === 'pause').length, 1)
    if (fault === 'start') {
      assert.deepEqual(f.sessions, [])
      assert.equal(f.machine.state, 'paused')
      assert.equal(f.machine.workerLeaseId, null)
      assert.equal(f.commands.length, 0, 'failed start persistence stops the probe and restores the known VM')
    } else {
      assert.equal(f.sessions.length, 1)
      assert.equal(f.sessions[0].endedAt, null)
      assert.equal(f.machine.state, 'error')
      assert.ok(f.machine.workerLeaseId, 'a failed end write stays available to reconciliation')
    }
  }
})

test('a proven pre-connect pause closes an older interval before a distinct maintenance resume', async () => {
  const f = await fixture()
  f.sessions.push({ startedAt: instant - 60_000, endedAt: null, source: 'running_since', reason: null })
  const observed = await f.observe()
  assert.deepEqual(f.sessions, [
    { startedAt: instant - 60_000, endedAt: instant, source: 'running_since', reason: 'paused' },
    { startedAt: instant, endedAt: instant, source: 'observed', reason: 'paused' },
  ])
  await observed.release()
})

test('post-pause custody loss cannot become a successful observation or clear a replacement lease', async () => {
  const f = await fixture(), originalState = f.runtime.state
  f.runtime.state = async (scope, budget) => {
    const state = await originalState(scope, budget)
    if (f.states() > 1) f.machine.workerLeaseId = id(92)
    return state
  }
  await assert.rejects(f.observe(), refused)
  assert.equal(f.machine.workerLeaseId, id(92)); assert.equal(f.machine.state, 'paused')
  assert.equal(f.sessions[0].endedAt, null, 'a newer lease cannot be modified by the old pause observation')
})

test('the success release callback cannot clear a lease or operation assigned after observation', async () => {
  for (const drift of ['lease', 'operation', 'sandbox']) {
    const f = await fixture(), result = await f.observe()
    if (drift === 'lease') f.machine.workerLeaseId = id(93)
    if (drift === 'operation') f.machine.operationId = id(94)
    if (drift === 'sandbox') f.machine.sandboxId = 'replacement-vm'
    const current = { ...f.machine }
    await result.release()
    assert.deepEqual(f.machine, current, drift)
  }
})

test('exhausting the observation budget still leaves time to restore pause, without running the probe', async () => {
  const f = await fixture()
  f.hooks.script = () => { f.state.now += 35_001 }
  await assert.rejects(f.observe(), refused)
  assert.equal(f.commands.length, 0)
  assert.equal(f.calls.filter(call => call.phase === 'pause').length, 1)
  assert.equal(f.machine.workerLeaseId, null)
  assert.ok(f.calls.filter(call => call.phase === 'pause').every(call => call.budget > 0 && call.budget <= 19_999))
})

test('invalid snapshot identity, digest, size, clean flag or observation date fails closed after restoration', async () => {
  for (const change of [
    { head: 'a'.repeat(40) }, { tree: 'untrusted' }, { diffSha256: 'd'.repeat(64) }, { diffBytes: 0 }, { clean: false },
    { producerRunId: id(99) }, { sessionId: 'new-session' }, { worktreePath: '/tmp/foreign' },
    { observedAt: new Date(instant - 61_000).toISOString() }, { observedAt: new Date(instant + 61_000).toISOString() },
    { journalUpdatedAt: new Date(instant + 1).toISOString() },
  ]) {
    const f = await fixture()
    f.output.stdout = JSON.stringify({ ok: true, value: { ...f.value, ...change } })
    await assert.rejects(f.observe(), refused, JSON.stringify(change))
    assert.equal(f.machine.workerLeaseId, null)
    assert.equal(f.calls.filter(call => call.phase === 'pause').length, 1)
    f.unchanged()
  }
})

test('only the fixed observation fields cross the provider boundary; oversized deployed scripts are refused', async () => {
  const f = await fixture()
  f.output.stdout = JSON.stringify({ ok: true, value: { ...f.value, secret: 'PRIVATE-CREDENTIAL', sandboxId: 'forged', machineRunId: id(99) } })
  const result = await f.observe()
  assert.deepEqual(result.snapshot, { ...f.value, sandboxId: f.scope.sandboxId, machineRunId: f.scope.machineRunId })
  assert.doesNotMatch(JSON.stringify(result.snapshot), /PRIVATE-CREDENTIAL/)
  await result.release()
  const oversized = await fixture()
  oversized.runtime.script = async () => 'x'.repeat(64 * 1024 + 1)
  await assert.rejects(oversized.observe(), refused)
  assert.equal(oversized.commands.length, 0)
  assert.equal(oversized.machine.workerLeaseId, null)
})
