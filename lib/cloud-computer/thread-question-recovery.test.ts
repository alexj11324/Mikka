import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { REGISTRATION_COMPLETE } from '../computer/registration-command'

// The real runtime-maintenance orchestration, with storage/receipt and cloud
// transport boundaries mocked. The same path's immutable SQL receipts and
// custody races are exercised by thread-machine-task.db.test.ts in real PG.
let active: { proof: Record<string, unknown> | null; steps: string[]; onStage?: () => void; onSwitch?: () => void }
mock.module('../factory/questions/execution-continuation.ts', { namedExports: {
  unclaimedPlanQuestionContinuation: async () => { active.steps.push('receipt'); return active.proof },
} })
mock.module('../computer/official-runtime.ts', { namedExports: {
  isOfficialE2BTemplate: (template: string) => ['desktop', 'claude', 'codex'].includes(template),
  runtimeRequestOptions: () => ({}), runtimeCommandOptions: () => ({}),
  bootstrapOfficialInstance: async () => assert.fail('the retained VM must not be replaced'),
  stageOfficialWorkerRelease: async () => { active.steps.push('stage'); active.onStage?.(); return {} },
  switchOfficialWorkerRelease: async (_box: unknown, _release: unknown, _scope: unknown, action: string) => {
    active.steps.push(action)
    if (action === 'switch') active.onSwitch?.()
  },
} })
mock.module('../secrets/runtime.ts', { namedExports: {
  secretMaskerFor: async () => (text: string) => text,
} })
const runtime = import('./thread-machines')
const ensureThreadMachine = async (...args: Parameters<typeof import('./thread-machines').ensureThreadMachine>) =>
  (await runtime).ensureThreadMachine(...args)

const id = (n: number) => `41600000-0000-4000-8000-${String(n).padStart(12, '0')}`
// Keep unexpected SQL rejected while the real registration locks its parent run.
const sandboxRegistrationSql = `WITH parent AS MATERIALIZED (SELECT id FROM agent_runs WHERE id=$1 FOR KEY SHARE)
  UPDATE thread_machines m SET "sandboxId"=$2,"runningSince"=COALESCE(m."runningSince",clock_timestamp()),"restoreStartedAt"=NULL
  FROM parent WHERE m."runId"=parent.id AND m."workerLeaseId"=$3 AND m.state<>'ended' RETURNING m."runId"`.replace(/\s+/g, ' ').trim()
function fixture() {
  const actor = { userId: 'fixture-owner', workspaceId: id(2) }
  const run = { id: id(1), userId: actor.userId, issueId: id(3), deviceId: id(4), deviceRepoId: id(5), runtimeBotId: id(6),
    status: 'failed', stopReason: 'blocked', startedAt: null, sessionId: null as string | null, stopRequestedAt: null, registrationStopRequestedAt: null,
    kind: 'plan', repoPath: 'v2/github.com/acme/app', remoteUrl: 'https://github.com/acme/app.git',
    agentDefinition: { readOnly: true },
    questionContinuation: { requireSessionResume: true, requiredSandboxId: 'fixture-original', originSessionId: 'private-native-session', originRunId: id(7), questionId: id(8) } }
  const machine = { runId: run.id, ownerId: actor.userId, workspaceId: actor.workspaceId, issueId: run.issueId,
    deviceId: run.deviceId, repoId: run.deviceRepoId, botId: run.runtimeBotId, state: 'paused', sandboxId: 'fixture-original', snapshotId: 'codex',
    workerLeaseId: null as string | null, workerLeaseUntil: null as Date | null }
  const task = { id: id(9), userId: actor.userId, issueId: run.issueId, botId: id(15), sourceEventId: id(10),
    stage: 'spec', status: 'blocked', candidateId: null, attemptId: id(11), revision: 6 }
  const question = { id: id(8), revision: 3, answerFingerprint: 'original-answer-fingerprint', status: 'blocked', continuationRunId: run.id }
  const receipt = { request: { kind: 'question_resume', input: { answerId: id(12) } }, result: { continuationRunId: run.id } }
  const flags = { deviceEnabled: true }
  const state = active = { proof: { kind: 'question_resume', originAttemptId: id(13), continuationAttemptId: task.attemptId,
    questionOriginAttemptId: id(13), sourceRunId: id(7), continuationRunId: run.id, questionOriginRunId: id(7),
    originSessionId: run.questionContinuation.originSessionId, questionId: question.id, answerId: id(12), recoveryEventId: id(14),
    historyRunId: id(7), sourceUnclaimed: false }, steps: [] } as typeof active
  const queries: string[] = [], warnings: string[] = []
  let released = false
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql)
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length })
    if (sql === 'SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2') {
      assert.deepEqual(values, [run.id, actor.userId])
      return result([{ issueId: run.issueId }])
    }
    if (sql.startsWith('SELECT t.* FROM factory_tasks')) return result(
      run.sessionId === null && task.stage === 'spec' && task.status === 'blocked' && question.status === 'blocked' && question.continuationRunId === run.id ? [{ ...task }] : [])
    if (sql.startsWith('SELECT revision,"answerFingerprint",id FROM factory_questions')) return result([{ ...question }])
    if (sql.startsWith('SELECT request,result FROM factory_events')) return result([structuredClone(receipt)])
    if (sql.startsWith('SELECT r.*') || (sql.startsWith('SELECT * FROM agent_runs') || sql.startsWith('SELECT *,"stopRequestedAt"::text AS "registrationStopRequestedAt" FROM agent_runs')) || sql.startsWith('SELECT status,"stopRequestedAt"')) return result([{ ...run }])
    if (sql.startsWith('SELECT * FROM thread_machines')) return result([{ ...machine }])
    if (sql.startsWith('SELECT 1 FROM devices d JOIN agent_runs')) return result(flags.deviceEnabled ? [{}] : [])
    if (/^SELECT 1 FROM (factory_questions|devices|thread_machines|agent_runs)/.test(sql)) return result([{}])
    if (sql.startsWith('INSERT INTO devices') && sql.includes(';\nINSERT INTO device_repos')) {
      assert.deepEqual(values, [], 'the native simple-query batch has no bound values')
      assert.deepEqual(sql.split(';\n').map(statement => /^(INSERT INTO|UPDATE) \w+/.exec(statement)?.[0]),
        ['INSERT INTO devices', 'INSERT INTO device_repos', 'UPDATE thread_machines', 'UPDATE device_tokens', 'INSERT INTO device_tokens'])
      return ['INSERT', 'INSERT', 'UPDATE', 'UPDATE', 'INSERT'].map((command, index) => ({
        command, rowCount: 1, rows: index === 4 ? [{ now: new Date() }] : [],
      }))
    }
    if (sql.startsWith('INSERT INTO device_tokens')) return result([{ now: new Date() }])
    if (sql.startsWith('UPDATE thread_machines') || sql.startsWith('WITH locked_run') || sql.replace(/\s+/g, ' ').trim() === sandboxRegistrationSql) {
      if (sql.startsWith('UPDATE thread_machines SET "workerLeaseId"=$2')) {
        machine.workerLeaseId = values[1] as string; machine.workerLeaseUntil = new Date(Date.now() + 60_000)
      }
      if (sql.includes("SET state='running'")) return result([
        { ...machine, state: 'running', epoch: 1, lifecycle: { phase: 'resumed' }, computeSeconds: 0 },
      ])
      return result([{ runId: run.id }])
    }
    if (/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config|SELECT pg_advisory_xact_lock|INSERT INTO (devices|device_repos|device_tokens)|UPDATE (device_tokens|agent_runs|factory_attempts))/.test(sql)) return result([])
    assert.fail(`Unexpected recovery-fixture SQL: ${sql}`)
  }
  const pool = { query, connect: async () => ({ query, release: () => { released = true } }) } as never
  const box = { sandboxId: machine.sandboxId,
    files: { read: async () => 'b'.repeat(40), write: async () => { state.steps.push('bootstrap') } },
    commands: { run: async () => { state.steps.push('worker'); return { stdout: REGISTRATION_COMPLETE + '\n' } } },
  }
  const hooks = { onConnect: undefined as (() => void) | undefined }
  const provider = {
    state: async () => { state.steps.push('provider'); return 'paused' },
    connect: async () => { state.steps.push('connect'); hooks.onConnect?.(); return box },
    create: async () => assert.fail('the retained VM must not be replaced'), kill: async () => assert.fail('the retained VM must not be killed'),
  } as unknown as Parameters<typeof ensureThreadMachine>[3]
  const execute = async () => {
    const saved = process.env.MIKKA_CLOUD_WORKER_URL, sha = process.env.MIKKA_CLOUD_WORKER_SHA
    process.env.MIKKA_CLOUD_WORKER_URL = 'https://fixture.invalid/mikka'; process.env.MIKKA_CLOUD_WORKER_SHA = 'b'.repeat(40)
    const warning = mock.method(console, 'warn', (line: string) => { warnings.push(line) })
    try { return await ensureThreadMachine(pool, actor, run.id, provider, undefined, true) }
    finally {
      warning.mock.restore()
      if (saved === undefined) delete process.env.MIKKA_CLOUD_WORKER_URL; else process.env.MIKKA_CLOUD_WORKER_URL = saved
      if (sha === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA; else process.env.MIKKA_CLOUD_WORKER_SHA = sha
    }
  }
  return { run, task, question, receipt, flags, state, hooks, queries, warnings, execute, released: () => released }
}

test('receipt-bound preclaim spec recovery refreshes the retained runtime without inventing a failed-child SID', async () => {
  const f = fixture(), before = structuredClone(f.run)
  assert.deepEqual(await f.execute(), { runId: f.run.id, state: 'running' })
  assert.deepEqual(f.run, before, 'runtime preparation retains the historical failure and null actual SID')
  for (const boundary of ['provider', 'connect', 'stage', 'switch', 'bootstrap', 'verify']) assert.ok(f.state.steps.includes(boundary), boundary)
  assert.ok(f.state.steps.filter(step => step === 'receipt').length >= 4, 'the proof is revalidated across provider and maintenance boundaries')
  assert.deepEqual(f.warnings, [])
  assert.equal(f.released(), true)
})

test('question JSON and an absent or mismatched actual SID cannot replace the preclaim host receipt', async () => {
  for (const invalid of ['receipt', 'actual_sid', 'stage', 'current_child', 'device']) {
    const f = fixture()
    if (invalid === 'receipt') f.state.proof = null
    if (invalid === 'actual_sid') f.run.sessionId = 'foreign-native-session'
    if (invalid === 'stage') f.task.stage = 'execute'
    if (invalid === 'current_child') f.question.continuationRunId = id(99)
    if (invalid === 'device') f.flags.deviceEnabled = false
    await assert.rejects(f.execute(), { status: 409 })
    assert.ok(!f.state.steps.includes('provider'), invalid)
  }
})

test('a revoked preclaim receipt after provider connect stops before staging or bootstrap', async () => {
  const f = fixture()
  f.hooks.onConnect = () => { f.state.proof = null }
  await assert.rejects(f.execute(), { status: 409 })
  assert.ok(f.state.steps.includes('connect'))
  for (const forbidden of ['stage', 'switch', 'bootstrap']) assert.ok(!f.state.steps.includes(forbidden), forbidden)
})

test('a changed question after staging cannot switch or publish bootstrap credentials', async () => {
  const f = fixture()
  f.state.onStage = () => { f.question.revision++ }
  await assert.rejects(f.execute(), { status: 409 })
  assert.ok(f.state.steps.includes('stage'))
  assert.ok(!f.state.steps.includes('switch'))
  assert.ok(!f.state.steps.includes('rollback'), 'staging alone did not change the active release')
  assert.ok(!f.state.steps.includes('bootstrap'))
})

test('a changed task epoch after switching stops credential bootstrap and restores its release', async () => {
  const f = fixture()
  f.state.onSwitch = () => { f.task.sourceEventId = id(99) }
  await assert.rejects(f.execute(), { status: 409 })
  assert.ok(f.state.steps.includes('switch'))
  assert.ok(f.state.steps.includes('rollback'))
  assert.ok(!f.state.steps.includes('bootstrap'))
})

test('a device disabled after switching gets no fresh credential but its owned lease restores the previous release', async () => {
  const f = fixture()
  f.state.onSwitch = () => { f.flags.deviceEnabled = false }
  await assert.rejects(f.execute(), { status: 409 })
  assert.ok(f.state.steps.includes('switch'))
  assert.ok(f.state.steps.includes('rollback'))
  assert.ok(!f.state.steps.includes('bootstrap'))
})
