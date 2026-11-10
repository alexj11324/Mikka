import { REGISTRATION_COMPLETE, REGISTRATION_WAITING, REGISTRATION_LEGACY } from '../computer/registration-command'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'
import { promisify } from 'node:util'
import { CLOUD_PRELOADER_WAKE_COMMAND, CLOUD_PRELOADER_WAKE_RECEIPT } from '../computer/worker-command'
import { logRuntimeRefreshFailure, readWorkerTail, saveWorkerTail, workerCommand, workerOutputForwarder, TAIL_MAX, WORKER_LOG } from './thread-worker-logs'

const mask = (text: string) => text.replaceAll('sekret', '[secret:TOKEN]')
// Admit only the parent-locked sandbox registration statement, not arbitrary CTEs.
const sandboxRegistrationSql = `WITH parent AS MATERIALIZED (SELECT id FROM agent_runs WHERE id=$1 FOR KEY SHARE)
  UPDATE thread_machines m SET "sandboxId"=$2,"runningSince"=COALESCE(m."runningSince",clock_timestamp()),"restoreStartedAt"=NULL
  FROM parent WHERE m."runId"=parent.id AND m."workerLeaseId"=$3 AND m.state<>'ended' RETURNING m."runId"`.replace(/\s+/g, ' ').trim()

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
      const query = async (sql: string, values: unknown[] = []) => {
        queries.push(sql)
        if (sql === 'SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2') {
          assert.deepEqual(values, [run.id, actor.userId])
          return { rows: [{ issueId: run.issueId }], rowCount: 1 }
        }
        if (sql.startsWith('SELECT t.* FROM factory_tasks')) return { rows: [], rowCount: 0 }
        if (sql.startsWith('SELECT r.*')) return { rows: [{ ...run }], rowCount: 1 }
        if (sql.startsWith('SELECT * FROM thread_machines')) return { rows: [{ ...machine }], rowCount: 1 }
        if (sql.startsWith('SELECT status,"stopRequestedAt"')) return { rows: [{ status: 'failed', stopRequestedAt: null }], rowCount: 1 }
        if (/^SELECT 1 FROM (factory_questions|devices|thread_machines)/.test(sql)) return { rows: [{}], rowCount: 1 }
        if (sql.startsWith('UPDATE thread_machines') || sql.replace(/\s+/g, ' ').trim() === sandboxRegistrationSql) return { rows: [{ runId: run.id }], rowCount: 1 }
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
        kill: async () => assert.fail('no kill'),
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
      const query = async (sql: string, values: unknown[] = []) => {
        queries.push(sql)
        if (sql === 'SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2') {
          assert.deepEqual(values, [run.id, actor.userId])
          return { rows: [{ issueId: run.issueId }], rowCount: 1 }
        }
        if (sql.startsWith('SELECT r.*')) return { rows: phase === 'admission' ? [] : [{ ...run,
          ...(phase === 'execution_identity' ? { agentDefinition: { executionIdentity: {} } } : {}),
        }], rowCount: phase === 'admission' ? 0 : 1 }
        if (sql.startsWith('SELECT * FROM thread_machines')) return { rows: [{ ...machine,
          ...(phase === 'question_machine' ? { sandboxId: 'other-vm' } : {}),
          ...(phase === 'verify_worker' ? { snapshotId: 'legacy-fixture' } : {}),
        }], rowCount: 1 }
        if (sql.startsWith('SELECT 1 FROM factory_questions')) return { rows: phase === 'question_source' ? [] : [{}], rowCount: phase === 'question_source' ? 0 : 1 }
        if (sql.startsWith('SELECT status,"stopRequestedAt"')) return { rows: [{ status: 'queued', stopRequestedAt: null }], rowCount: 1 }
        if (sql.startsWith('UPDATE thread_machines') || sql.replace(/\s+/g, ' ').trim() === sandboxRegistrationSql) return { rows: [{ runId: run.id }], rowCount: 1 }
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
        kill: async () => assert.fail('no kill'),
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

// Exercise the real provisioning orchestration. The SQL/provider boundaries
// are synthetic here; thread-machine-task.db.test.ts retains real PG coverage.
async function bootstrapFixture(scenario: 'preloaded' | 'fallback' | 'legacy' | 'publish_failed' | 'revoked' | 'old_registration' | 'lease_lost') {
  const { ensureThreadMachine } = await import('./thread-machines')
  const id = (n: number) => `41700000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const actor = { userId: 'bootstrap-fixture-owner', workspaceId: id(2) }
  const run = { id: id(1), userId: actor.userId, issueId: id(3), deviceId: id(4), deviceRepoId: id(5), runtimeBotId: id(6),
    status: 'queued', stopRequestedAt: null, repoPath: 'v2/github.com/acme/app', remoteUrl: 'https://github.com/acme/app.git', runHarness: 'codex' }
  const machine = { runId: run.id, ownerId: actor.userId, workspaceId: actor.workspaceId, issueId: run.issueId,
    botId: run.runtimeBotId, state: 'starting', snapshotId: 'codex', operationId: id(7), sandboxId: null }
  const queries: string[] = [], commands: { command: string; options: Record<string, unknown> }[] = []
  const uploads: { path: string; data: string }[][] = []
  const fault = new Error('synthetic publication failure')
  const wall = Date.now(), floor = new Date(wall)
  let clockAdvance = 0, tokenHash = '', credentialDeviceId = '', authenticated = false, finished = false, released = false
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length })
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql)
    if (sql === 'SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2') return result([{ issueId: run.issueId }])
    if (sql.startsWith('SELECT r.*') || sql.startsWith('SELECT * FROM agent_runs') || sql.startsWith('SELECT status,"stopRequestedAt"')) return result([{ ...run }])
    if (sql.startsWith('SELECT * FROM thread_machines')) return result([{ ...machine }])
    if (sql.startsWith('SELECT 1 FROM devices d JOIN device_tokens')) return result(authenticated ? [{}] : [])
    if (sql.startsWith('SELECT 1 FROM agent_runs r JOIN thread_machines')) return result([{}])
    if (sql.startsWith('SELECT 1 FROM thread_machines')) return result(scenario === 'lease_lost' ? [] : [{}])
    if (sql === 'SELECT clock_timestamp() AS now') return result([{ now: floor }])
    if (sql.startsWith('INSERT INTO devices') && sql.includes(';\nINSERT INTO device_repos')) {
      assert.deepEqual(values, [], 'native batch has no values array')
      const issued = /INSERT INTO device_tokens [\s\S]*?VALUES \('[a-f0-9-]+'::uuid,'([^']+)'::text,'Thread worker','([a-f0-9]{64})'::text,'([a-f0-9-]{36})'::uuid,'([a-f0-9-]{36})'::uuid,now\(\)\+interval '24 hours'\) RETURNING clock_timestamp\(\) AS now$/.exec(sql)
      assert.ok(issued, 'the real batched credential statement retains its native types')
      assert.equal(issued[1], actor.userId); assert.equal(issued[4], actor.workspaceId)
      tokenHash = issued[2]; credentialDeviceId = issued[3]
      return ['INSERT','INSERT','UPDATE','UPDATE','INSERT'].map((command,index)=>({
        command, rowCount:1, rows:index===4?[{now:floor}]:[],
      }))
    }
    if (sql.startsWith('INSERT INTO device_tokens')) {
      tokenHash = values[3] as string; credentialDeviceId = values[4] as string
      assert.equal(values[1], actor.userId); assert.equal(values[5], actor.workspaceId)
      return result([{ now: floor }])
    }
    if (sql.startsWith("UPDATE thread_machines m SET state='running'")) {
      assert.deepEqual(values, [run.id,values[1],credentialDeviceId,tokenHash,floor])
      assert.match(sql, /t\."revokedAt" IS NULL/)
      assert.match(sql, /t\."lastUsedAt">=\$5/)
      if (!authenticated) return result([])
      finished = true
      return result([{ ...machine, epoch: 1, lifecycle: { phase: 'created' }, computeSeconds: 0 }])
    }
    if (sql.startsWith('UPDATE thread_machines') || sql.replace(/\s+/g, ' ').trim() === sandboxRegistrationSql) return result([{ runId: run.id }])
    if (/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory_xact_lock|INSERT INTO (devices|device_repos)|UPDATE (device_tokens|agent_runs|factory_attempts))/.test(sql)) return result([])
    assert.fail(`Unexpected bootstrap-fixture SQL: ${sql}`)
  }
  const pool = { query, connect: async () => ({ query, release: () => { released = true } }) } as never
  const box = { sandboxId: 'bootstrap-fixture-vm', files: {
    read: async () => 'a'.repeat(40),
    write: async (files: { path: string; data: string }[], options: unknown) => {
      assert.deepEqual(options, { user: 'root', useOctetStream: false })
      assert.equal(queries.at(-1), 'COMMIT')
      assert.ok(queries.includes('COMMIT'))
      uploads.push(files)
    },
  }, commands: { run: async (command: string, options: Record<string, unknown>) => {
    commands.push({ command, options })
    if (command.startsWith('tail -n 200 ')) return { stdout: '', stderr: '', exitCode: 0 }
    if (command.includes('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json')) {
      assert.equal(options.user, 'root'); assert.notEqual(options.background, true)
      assert.ok(command.indexOf('mv /home/user/.mikka/initial-run.next') < command.indexOf('mv /home/user/.mikka/bootstrap.next'))
      if (scenario === 'publish_failed') throw fault
      authenticated = scenario === 'preloaded' || scenario === 'fallback' || scenario === 'legacy'
      if (!authenticated) {
        const onStdout = options.onStdout as ((chunk:string)=>void) | undefined
        onStdout?.(REGISTRATION_WAITING + '\n')
        throw new Error('cloud_registration_timeout')
      }
      return { stdout: (scenario === 'legacy' ? REGISTRATION_LEGACY : REGISTRATION_COMPLETE) + '\n', stderr: '', exitCode: 0 }
    }
    assert.match(command, /node dist\/cloud\/cloud-worker\.js/)
    assert.equal(options.user, 'user'); assert.equal(options.background, true)
    if (scenario === 'fallback') authenticated = true
    return { stdout: '', stderr: '', exitCode: 0 }
  } } }
  const provider = { create: async () => box,
    connect: async () => assert.fail('a fresh fixture does not resume another VM'), kill: async () => assert.fail('no provider kill belongs to this helper'),
  } as unknown as Parameters<typeof ensureThreadMachine>[3]
  const saved = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA }
  process.env.MIKKA_CLOUD_WORKER_URL = 'https://fixture.invalid/mikka'; process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40)
  const clock = mock.method(Date, 'now', () => wall + clockAdvance)
  const warning = mock.method(console, 'warn', () => {})
  const info = mock.method(console, 'info', () => {})
  let error: unknown
  try { await ensureThreadMachine(pool, actor, run.id, provider) } catch (caught) { error = caught }
  finally {
    clock.mock.restore(); warning.mock.restore(); info.mock.restore()
    if (saved.url === undefined) delete process.env.MIKKA_CLOUD_WORKER_URL; else process.env.MIKKA_CLOUD_WORKER_URL = saved.url
    if (saved.sha === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA; else process.env.MIKKA_CLOUD_WORKER_SHA = saved.sha
  }
  return { queries, commands, uploads, error, fault, finished, released }
}

test('bootstrap publication wakes the preloader without another remote start command', async () => {
  const f = await bootstrapFixture('preloaded')
  assert.ifError(f.error)
  assert.equal(f.uploads.length, 1)
  assert.equal(f.commands.length, 1, 'one atomic publish/wake command replaces publish then redundant start')
  assert.match(f.commands[0].command, /runuser -u user -- sh -c/)
  assert.ok(f.finished); assert.ok(f.released)
  assert.equal(f.queries.filter(sql => sql.startsWith('SELECT 1 FROM devices d JOIN device_tokens')).length, 0)
  assert.equal(f.queries.filter(sql => sql.startsWith("UPDATE thread_machines m SET state='running'")).length, 1, 'the final fenced update proves live credential registration')
  const bootstrap = JSON.parse(f.uploads[0][0].data)
  assert.ok(!JSON.stringify(f.commands).includes(bootstrap.credential), 'credentials stay in the file upload, never command text or options')
})

test('a legitimate legacy release keeps its database registration proof without a new RPC or eager masker', async()=>{
  const current=await bootstrapFixture('preloaded'), legacy=await bootstrapFixture('legacy')
  assert.ifError(legacy.error)
  assert.equal(legacy.commands.length,1)
  assert.ok(legacy.finished)
  assert.equal(legacy.queries.filter(sql=>sql.startsWith('SELECT 1 FROM devices d JOIN device_tokens')).length,1)
  assert.equal(legacy.queries.length,current.queries.length+1)
})

test('an unavailable preloader retains the existing user background fallback and registration proof', async () => {
  const fast = await bootstrapFixture('preloaded'), fallback = await bootstrapFixture('fallback')
  assert.ifError(fallback.error)
  assert.equal(fallback.uploads.length, 1); assert.equal(fallback.commands.length, 1)
  // Native simple-query SQL contains this invocation's UUIDs/token digest.
  // Compare full statements, retaining every non-identity literal and predicate.
  const shape = (sql: string) => sql.replace(/'[a-f0-9-]{36}'::uuid/g, "'<uuid>'::uuid")
    .replace(/'[a-f0-9]{64}'::text/g, "'<hash>'::text")
  assert.deepEqual(fallback.queries.map(shape), fast.queries.map(shape), 'the fast path adds no SQL or authorization work')
  assert.ok(fallback.finished); assert.ok(fallback.released)
})

test('failed publication or a lost credential lease never starts a worker', async () => {
  for (const scenario of ['publish_failed', 'lease_lost'] as const) {
    const f = await bootstrapFixture(scenario)
    if (scenario === 'publish_failed') assert.equal(f.error, f.fault)
    else assert.match(String(f.error), /Thread provisioning cancelled/)
    assert.equal(f.commands.filter(row => row.options.background === true).length, 0)
    assert.equal(f.uploads.length, scenario === 'publish_failed' ? 1 : 0)
    assert.equal(f.finished, false); assert.ok(f.released)
    assert.ok(f.queries.includes('ROLLBACK'))
  }
})

test('a successful wake cannot stand in for a live new credential registration', async () => {
  for (const scenario of ['revoked', 'old_registration'] as const) {
    const f = await bootstrapFixture(scenario)
    assert.match(String(f.error), /Thread worker did not register/)
    assert.equal(f.finished, false); assert.ok(f.released)
    assert.equal(f.commands.filter(row => row.options.background === true).length, 0)
    assert.ok(f.queries.includes('ROLLBACK'))
  }
})

test('the preloader wake command signals only a live wait-bootstrap process and reports failed signals as fallback', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-bootstrap-wake-'))
  const pidFile = join(directory, 'preloaded.pid')
  const command = CLOUD_PRELOADER_WAKE_COMMAND.replaceAll('/home/user/.mikka/preloaded.pid', pidFile)
  const execute = promisify(execFile)
  const launch = async (preloader: boolean) => {
    const child = spawn(process.execPath, ['-e', `let wakes=0; process.on('SIGUSR1',()=>{wakes++;process.send('woken')}); process.on('message',()=>process.send(wakes)); process.send('ready')`,
      ...(preloader ? ['--', '--wait-bootstrap'] : [])], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    assert.deepEqual(await once(child, 'message'), ['ready', undefined])
    return child
  }
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended
  }
  try {
    const absent = await execute('sh', ['-c', command])
    assert.equal(absent.stdout, ''); assert.equal(absent.stderr, '')
    const child = await launch(true)
    try {
      await writeFile(pidFile, `${child.pid}\n`)
      const woken = once(child, 'message')
      assert.equal((await execute('sh', ['-c', command])).stdout.trim(), CLOUD_PRELOADER_WAKE_RECEIPT)
      assert.deepEqual(await woken, ['woken', undefined])
      // Deterministically reproduce the exit-between-check-and-signal branch;
      // the real /proc and kill -0 checks still run against the live process.
      const failedSignal = 'kill() { if test "$1" = "-USR1"; then return 1; else command kill "$@"; fi; }; '
      assert.equal((await execute('sh', ['-c', failedSignal + command])).stdout, '')
      const count = once(child, 'message'); child.send?.('count')
      assert.deepEqual(await count, [1, undefined])
    } finally { await stop(child) }
    assert.equal((await execute('sh', ['-c', command])).stdout, '', 'an exited PID is not a wake acknowledgement')
    const unrelated = await launch(false)
    try {
      await writeFile(pidFile, `${unrelated.pid}\n`)
      assert.equal((await execute('sh', ['-c', command])).stdout, '')
      const count = once(unrelated, 'message'); unrelated.send?.('count')
      assert.deepEqual(await count, [0, undefined], 'another live process receives no signal')
    } finally { await stop(unrelated) }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
