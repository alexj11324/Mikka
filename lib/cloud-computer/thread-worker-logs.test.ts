import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { logRuntimeRefreshFailure, readWorkerTail, saveWorkerTail, workerCommand, workerOutputForwarder, TAIL_MAX, WORKER_LOG } from './thread-worker-logs'

const mask = (text: string) => text.replaceAll('sekret', '[secret:TOKEN]')

test('worker output reaches the server log line by line, masked, bounded and split across chunks', () => {
  const lines: Record<string, string>[] = []
  const { onStdout, onStderr } = workerOutputForwarder('run-1', mask, line => lines.push(JSON.parse(line)))
  onStdout('daemon started\nclaim run-1 uses sekret')
  onStdout(' value\n\n')
  onStderr(`${'x'.repeat(900)}\n`)
  assert.deepEqual(lines.map(line => [line.event, line.runId, line.stream, line.line.length < 100 ? line.line : `len:${line.line.length}`]), [
    ['thread_worker_output', 'run-1', 'stdout', 'daemon started'],
    ['thread_worker_output', 'run-1', 'stdout', 'claim run-1 uses [secret:TOKEN] value'],
    ['thread_worker_output', 'run-1', 'stderr', 'len:500'],
  ])
})

test('a chatty worker is cut off after a bounded number of lines, with one notice', () => {
  const lines: string[] = []
  const { onStdout } = workerOutputForwarder('run-2', mask, line => lines.push(line))
  onStdout(Array.from({ length: 700 }, (_, i) => `line ${i}`).join('\n') + '\n')
  assert.equal(lines.length, 501)
  assert.match(lines[500], /further output kept in the sandbox log only/)
})

test('the worker command keeps streaming and appends to the sandbox log', () => {
  assert.equal(workerCommand('run-worker'), `{ run-worker; } 2>&1 | tee -a ${WORKER_LOG}`)
})

test('the tail is read back bounded; a failing or hanging read gives null without throwing', async () => {
  const commands: string[] = []
  const box = (stdout: string) => async () => ({ commands: { run: async (cmd: string) => { commands.push(cmd); return { stdout } } } })
  assert.equal(await readWorkerTail(box('worker said hi\n')), 'worker said hi')
  assert.match(commands[0], /tail -n 200 \/home\/user\/\.mikka\/thread-bootstrap\.log/)
  assert.equal((await readWorkerTail(box('y'.repeat(TAIL_MAX * 2))))!.length, TAIL_MAX)
  assert.equal(await readWorkerTail(box('   \n')), null)
  assert.equal(await readWorkerTail(async () => { throw new Error('sandbox gone') }), null)
  const started = Date.now()
  assert.equal(await readWorkerTail(() => new Promise(() => {}), 50), null)
  assert.ok(Date.now() - started < 1000, 'a hung read gives up at its timeout')
})

test('the tail is saved masked with the machine; as an error only where the run has none', async () => {
  const calls: [string, unknown[]][] = []
  const query = { query: async (sql: string, values: unknown[]) => { calls.push([sql, values]); return { rows: [], rowCount: 1 } } } as never
  await saveWorkerTail(query, 'run-3', null, mask, 'ignored')
  assert.equal(calls.length, 0, 'nothing read, nothing written')
  await saveWorkerTail(query, 'run-3', 'boom sekret', mask)
  await saveWorkerTail(query, 'run-3', 'boom sekret', mask, 'Thread worker did not register')
  assert.deepEqual(calls.map(([sql, values]) => [sql.split(' WHERE')[0], values]), [
    ['UPDATE thread_machines SET "logTail"=$2', ['run-3', 'boom [secret:TOKEN]']],
    ['UPDATE thread_machines SET "logTail"=$2', ['run-3', 'boom [secret:TOKEN]']],
    ['UPDATE agent_runs SET error=$2', ['run-3', 'Thread worker did not register\nboom [secret:TOKEN]']],
  ])
  assert.match(calls[2][0], /error IS NULL/, 'an existing error is never overwritten')
})

test('refresh diagnostics allow only fixed error identifiers and bounded numeric status/exit codes', () => {
  const lines: string[] = []
  for (const error of [null, 'PRIVATE-CREDENTIAL', {
    name: 'PRIVATE-CREDENTIAL', code: 'PRIVATE-CREDENTIAL', status: 9999, exitCode: -1,
    message: 'PRIVATE-CREDENTIAL', stack: 'PRIVATE-CREDENTIAL', cause: { token: 'PRIVATE-CREDENTIAL' },
  }]) logRuntimeRefreshFailure('run-4', 'connect', error, line => lines.push(line))
  for (const line of lines) assert.deepEqual(JSON.parse(line), {
    event: 'thread_runtime_refresh_failed', runId: 'run-4', phase: 'connect', errorClass: 'unknown', errorCode: 'unknown',
  })
  logRuntimeRefreshFailure('run-4', 'connect', { name: 'E2BKeyError', code: 'e2b_key_invalid', statusCode: 403, detail: 'PRIVATE-CREDENTIAL' }, line => lines.push(line))
  assert.deepEqual(JSON.parse(lines.at(-1)!), {
    event: 'thread_runtime_refresh_failed', runId: 'run-4', phase: 'connect', errorClass: 'E2BKeyError', errorCode: 'e2b_key_invalid', status: 403,
  })
  let reads = 0
  logRuntimeRefreshFailure('run-4', 'connect', { get name() { return reads++ ? 'PRIVATE-CREDENTIAL' : 'Error' } }, line => lines.push(line))
  assert.deepEqual(JSON.parse(lines.at(-1)!), {
    event: 'thread_runtime_refresh_failed', runId: 'run-4', phase: 'connect', errorClass: 'Error', errorCode: 'unknown',
  })
  assert.doesNotMatch(lines.join('\n'), /PRIVATE-CREDENTIAL/)
})

// Real refresh orchestration with a synthetic admitted row and provider. This
// checks its diagnostic boundary; ownership/custody use the real PG fixtures.
test('runtime refresh failures name their actual phase without logging provider output or changing run history', async () => {
  const { ensureThreadMachine } = await import('./thread-machines')
  const id = (n: number) => `41400000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const actor = { userId: 'fixture-owner', workspaceId: id(2) }
  const run = { id: id(1), userId: actor.userId, issueId: id(3), deviceId: id(4), deviceRepoId: id(5), runtimeBotId: id(6),
    status: 'failed', sessionId: 'original-session', botSandboxId: 'fixture-parent', repoPath: '/fixture/workspace', remoteUrl: null,
    questionContinuation: { requireSessionResume: true, requiredSandboxId: 'fixture-original', originSessionId: 'original-session', originRunId: id(7), questionId: id(8) } }
  const machine = { runId: run.id, ownerId: actor.userId, workspaceId: actor.workspaceId, issueId: run.issueId,
    deviceId: run.deviceId, repoId: run.deviceRepoId, botId: run.runtimeBotId, state: 'paused', sandboxId: 'fixture-original', snapshotId: 'desktop' }
  const before = structuredClone(run)
  const saved = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA, commit: process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT }
  process.env.MIKKA_CLOUD_WORKER_URL = 'https://fixture.invalid/mikka'
  process.env.MIKKA_CLOUD_WORKER_SHA = 'b'.repeat(40)
  process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = 'c'.repeat(40)
  try {
    for (const scenario of ['provider_state', 'connect', 'read_worker', 'install_computer', 'stage_release', 'diagnostic_getter', 'diagnostic_sink']) {
      const phase = scenario.startsWith('diagnostic_') ? 'connect' : scenario
      const fault = Object.assign(new Error('PRIVATE-CREDENTIAL fixture output'), {
        name: phase === 'stage_release' ? 'CommandExitError' : 'Error', code: phase === 'read_worker' ? 'ENOENT' : 'untrusted-PRIVATE-CREDENTIAL',
        ...(phase === 'stage_release' ? { exitCode: 73 } : {}), stderr: 'PRIVATE-CREDENTIAL stderr', command: 'PRIVATE-CREDENTIAL command',
      })
      if (scenario === 'diagnostic_getter') Object.defineProperty(fault, 'name', { get: () => { throw new Error('diagnostic getter failed') } })
      const queries: string[] = [], warnings: unknown[][] = []
      const warning = mock.method(console, 'warn', (...args: unknown[]) => {
        if (scenario === 'diagnostic_sink') throw new Error('diagnostic sink failed')
        warnings.push(args)
      })
      let released = false
      const query = async (sql: string) => {
        queries.push(sql)
        if (sql.startsWith('SELECT r.*')) return { rows: [{ ...run }], rowCount: 1 }
        if (sql.startsWith('SELECT * FROM thread_machines')) return { rows: [{ ...machine }], rowCount: 1 }
        if (sql.startsWith('SELECT status,"stopRequestedAt"')) return { rows: [{ status: 'failed', stopRequestedAt: null }], rowCount: 1 }
        if (/^SELECT 1 FROM (factory_questions|devices|thread_machines)/.test(sql)) return { rows: [{}], rowCount: 1 }
        if (sql.startsWith('UPDATE thread_machines')) return { rows: [{ runId: run.id }], rowCount: 1 }
        if (/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config|SELECT pg_advisory_xact_lock)/.test(sql)) return { rows: [], rowCount: 0 }
        assert.fail(`Unexpected diagnostic-fixture SQL: ${sql}`)
      }
      const pool = { query, connect: async () => ({ query, release: () => { released = true } }) } as never
      const sandbox = { sandboxId: machine.sandboxId,
        files: { read: async () => { if (phase === 'read_worker') throw fault; return 'a'.repeat(40) }, write: async () => assert.fail('no bootstrap credential may be published') },
        commands: { run: async (command: string) => {
          if (command.includes('MIKKA_RUNTIME_HASHES')) { if (phase === 'install_computer') throw fault; return { stdout: '' } }
          if (command.includes('MIKKA_OFFICIAL_WORKER_STAGE')) throw fault
          assert.fail('no runtime switch or worker command may run')
        } },
      }
      const provider = {
        state: async () => { if (phase === 'provider_state') throw fault; return 'paused' },
        connect: async () => { if (phase === 'connect') throw fault; return sandbox },
        create: async () => assert.fail('the original VM may not be replaced'),
        snapshot: async () => assert.fail('no snapshot'), kill: async () => assert.fail('no kill'),
      } as unknown as Parameters<typeof ensureThreadMachine>[3]
      try {
        await assert.rejects(ensureThreadMachine(pool, actor, run.id, provider, undefined, true), error => error === fault)
        assert.deepEqual(warnings.map(args => JSON.parse(String(args[0]))), scenario.startsWith('diagnostic_') ? [] : [{
          event: 'thread_runtime_refresh_failed', runId: run.id, phase,
          errorClass: phase === 'stage_release' ? 'CommandExitError' : 'Error',
          errorCode: phase === 'read_worker' ? 'ENOENT' : 'unknown', ...(phase === 'stage_release' ? { exitCode: 73 } : {}),
        }])
        assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE-CREDENTIAL/)
        assert.deepEqual(run, before)
        assert.ok(queries.some(sql => sql.startsWith("UPDATE thread_machines SET state='error'")), 'the existing lease cleanup still runs')
        assert.ok(queries.every(sql => !/^(INSERT|DELETE)|^UPDATE (agent_runs|factory_|device_tokens)/.test(sql)), 'diagnostics write no historical business state')
        assert.equal(released, true)
      } finally { warning.mock.restore() }
    }
  } finally {
    for (const [name, value] of [['MIKKA_CLOUD_WORKER_URL', saved.url], ['MIKKA_CLOUD_WORKER_SHA', saved.sha], ['MIKKA_CLOUD_WORKER_SOURCE_COMMIT', saved.commit]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value
    }
  }
})

test('question wake failures identify the rejecting boundary without exposing provider data or preventing lease cleanup', async () => {
  const { ensureThreadMachine } = await import('./thread-machines')
  const id = (n: number) => `41500000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const actor = { userId: 'fixture-owner', workspaceId: id(2) }
  const run = { id: id(1), userId: actor.userId, issueId: id(3), deviceId: id(4), deviceRepoId: id(5), runtimeBotId: id(6),
    status: 'queued', botSandboxId: 'fixture-parent', repoPath: 'v2/github.com/acme/app', remoteUrl: 'https://github.com/acme/app.git',
    questionContinuation: { requireSessionResume: true, requiredSandboxId: 'fixture-original', originSessionId: 'PRIVATE-NATIVE-SESSION', originRunId: id(7), questionId: id(8) } }
  const machine = { runId: run.id, ownerId: actor.userId, workspaceId: actor.workspaceId, issueId: run.issueId,
    deviceId: run.deviceId, repoId: run.deviceRepoId, botId: run.runtimeBotId, state: 'paused', sandboxId: 'fixture-original', snapshotId: 'codex' }
  const saved = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA }
  process.env.MIKKA_CLOUD_WORKER_URL = 'https://fixture.invalid/mikka'
  process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40)
  try {
    for (const scenario of ['admission', 'execution_identity', 'question_machine', 'question_source', 'provider_state', 'connect', 'read_worker', 'verify_worker', 'diagnostic_getter', 'diagnostic_sink']) {
      const phase = scenario.startsWith('diagnostic_') ? 'connect' : scenario
      const fault = Object.assign(new Error('PRIVATE-CREDENTIAL provider output'), {
        name: phase === 'provider_state' ? 'AuthenticationError' : 'Error',
        code: phase === 'read_worker' ? 'ENOENT' : 'PRIVATE-CREDENTIAL', statusCode: 503,
        stack: 'PRIVATE-CREDENTIAL stack', cause: { token: 'PRIVATE-CREDENTIAL' },
      })
      if (scenario === 'diagnostic_getter') Object.defineProperty(fault, 'name', { get: () => { throw new Error('PRIVATE-CREDENTIAL getter') } })
      const queries: string[] = [], warnings: unknown[][] = []
      let released = false
      const warning = mock.method(console, 'warn', (...args: unknown[]) => {
        if (scenario === 'diagnostic_sink') throw new Error('PRIVATE-CREDENTIAL sink')
        warnings.push(args)
      })
      const query = async (sql: string) => {
        queries.push(sql)
        if (sql.startsWith('SELECT r.*')) return { rows: [{ ...run,
          ...(phase === 'admission' ? { botSandboxId: null } : {}),
          ...(phase === 'execution_identity' ? { agentDefinition: { executionIdentity: {} } } : {}),
        }], rowCount: 1 }
        if (sql.startsWith('SELECT * FROM thread_machines')) return { rows: [{ ...machine,
          ...(phase === 'question_machine' ? { sandboxId: 'other-vm' } : {}),
          ...(phase === 'verify_worker' ? { snapshotId: 'legacy-fixture' } : {}),
        }], rowCount: 1 }
        if (sql.startsWith('SELECT 1 FROM factory_questions')) return { rows: phase === 'question_source' ? [] : [{}], rowCount: phase === 'question_source' ? 0 : 1 }
        if (sql.startsWith('SELECT status,"stopRequestedAt"')) return { rows: [{ status: 'queued', stopRequestedAt: null }], rowCount: 1 }
        if (sql.startsWith('UPDATE thread_machines')) return { rows: [{ runId: run.id }], rowCount: 1 }
        if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory_xact_lock)/.test(sql)) return { rows: [], rowCount: 0 }
        assert.fail(`Unexpected question diagnostic-fixture SQL: ${sql}`)
      }
      const pool = { query, connect: async () => ({ query, release: () => { released = true } }) } as never
      const provider = {
        state: async () => { if (phase === 'provider_state') throw fault; return 'paused' },
        connect: async () => {
          if (phase === 'connect') throw fault
          return { sandboxId: machine.sandboxId,
            files: { read: async () => { if (phase === 'verify_worker') return 'b'.repeat(40); throw fault }, write: async () => assert.fail('no bootstrap credential may be published') },
            commands: { run: async () => assert.fail('no worker command may run') } }
        },
        create: async () => assert.fail('the original VM may not be replaced'),
        snapshot: async () => assert.fail('no snapshot'), kill: async () => assert.fail('no kill'),
      } as unknown as Parameters<typeof ensureThreadMachine>[3]
      try {
        await assert.rejects(ensureThreadMachine(pool, actor, run.id, provider), error =>
          ['admission', 'execution_identity', 'question_machine', 'question_source', 'verify_worker'].includes(phase)
            ? error instanceof Error && /Thread unavailable|executionIdentityUnavailable|Original question machine unavailable|Worker version mismatch/.test(error.message)
            : error === fault)
        const beforeProvider = ['admission', 'question_machine', 'question_source'].includes(phase)
        assert.deepEqual(warnings.map(args => JSON.parse(String(args[0]))), scenario.startsWith('diagnostic_') ? [] : [{
          event: 'thread_runtime_start_failed', runId: run.id, phase,
          errorClass: phase === 'execution_identity' ? 'unknown' : phase === 'provider_state' ? 'AuthenticationError' : 'Error',
          errorCode: phase === 'read_worker' ? 'ENOENT' : 'unknown',
          ...(['execution_identity', 'verify_worker'].includes(phase) ? {} : { status: beforeProvider ? phase === 'admission' ? 404 : 409 : 503 }),
        }])
        assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE-/)
        assert.ok(queries.includes('ROLLBACK'), 'diagnostics never replace rollback')
        if (!['admission', 'execution_identity'].includes(phase))
          assert.ok(queries.some(sql => sql.includes('"workerLeaseId"=NULL') && sql.includes('"workerLeaseId"=$2')), 'cleanup still releases only its own lease')
        assert.ok(queries.every(sql => !/^(INSERT|DELETE)|^UPDATE (agent_runs|factory_|device_tokens)/.test(sql)), 'diagnostics do not write business history or credentials')
        assert.equal(released, true)
      } finally { warning.mock.restore() }
    }
  } finally {
    if (saved.url === undefined) delete process.env.MIKKA_CLOUD_WORKER_URL; else process.env.MIKKA_CLOUD_WORKER_URL = saved.url
    if (saved.sha === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA; else process.env.MIKKA_CLOUD_WORKER_SHA = saved.sha
  }
})



test('runtime guard diagnostics keep their closed phase and never emit a provider payload', () => {
  const lines: string[] = []
  logRuntimeRefreshFailure('run-guard', 'switch_release', {
    name: 'RuntimeRefreshError', code: 'runtime_journal_missing', runtimePhase: 'journal_before_stop', exitCode: 1,
    message: 'PRIVATE-CREDENTIAL', stderr: 'PRIVATE-CREDENTIAL', cause: { token: 'PRIVATE-CREDENTIAL' },
  }, line => lines.push(line))
  assert.deepEqual(JSON.parse(lines[0]), { event: 'thread_runtime_refresh_failed', runId: 'run-guard', phase: 'switch_release',
    errorClass: 'RuntimeRefreshError', errorCode: 'runtime_journal_missing', runtimePhase: 'journal_before_stop', exitCode: 1 })
  logRuntimeRefreshFailure('run-guard', 'rollback', { name: 'RuntimeRefreshError', code: 'runtime_PRIVATE_CREDENTIAL', runtimePhase: 'PRIVATE-CREDENTIAL', exitCode: 1 }, line => lines.push(line))
  assert.deepEqual(JSON.parse(lines[1]), { event: 'thread_runtime_refresh_failed', runId: 'run-guard', phase: 'rollback',
    errorClass: 'RuntimeRefreshError', errorCode: 'unknown', exitCode: 1 })
  assert.doesNotMatch(lines.join('\n'), /PRIVATE.CREDENTIAL/)
})
