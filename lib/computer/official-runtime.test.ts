import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapOfficialInstance, isOfficialE2BTemplate, stageOfficialWorkerRelease, switchOfficialWorkerRelease } from './official-runtime'

const env = { MIKKA_CLOUD_WORKER_SOURCE_COMMIT: 'a'.repeat(40), MIKKA_CLOUD_WORKER_SHA: 'b'.repeat(40) }
test('official templates are explicit, and missing/invalid releases cannot run a bootstrap', async () => {
  assert.equal(isOfficialE2BTemplate('codex'), true)
  assert.equal(isOfficialE2BTemplate('private-derived-template'), false)
  const sandbox = { commands: { run: async () => { throw Error('must not execute') } } } as never
  for (const value of [{}, { ...env, MIKKA_CLOUD_WORKER_SOURCE_COMMIT: 'main' }, { ...env, MIKKA_CLOUD_WORKER_SHA: 'x; exit' }])
    await assert.rejects(bootstrapOfficialInstance(sandbox, 'codex', value), /not configured/)
})
test('a bootstrap names the immutable source and checks a receipt instead of trusting an exit code', async () => {
  const calls: string[] = []
  const sandbox = { commands: { run: async (command: string) => { calls.push(command); return { stdout: calls.length === 1 ? '' : env.MIKKA_CLOUD_WORKER_SHA } } } } as never
  await bootstrapOfficialInstance(sandbox, 'codex', env, async () => 'printf controlled-fixture')
  assert.ok(calls[0].includes(`bash -s -- ${env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT} ${env.MIKKA_CLOUD_WORKER_SHA} codex`))
  assert.equal(calls[1], 'python3 /opt/mikka/runtime/ingress-v1/guard.py verify >/dev/null && cat /opt/mikka/worker-source-sha')
  await assert.rejects(bootstrapOfficialInstance({ commands: { run: async () => ({ stdout: 'wrong receipt' }) } } as never, 'desktop', env, async () => ''), /receipt mismatch/)
})

const identity = { deviceId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', operationId: '33333333-3333-4333-8333-333333333333' }
const release = { sourceCommit: env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT, workerSha: env.MIKKA_CLOUD_WORKER_SHA, previousSha: 'c'.repeat(40) }
test('staging requires a fixed release and exact completion receipt', async () => {
  const calls: string[] = []
  const sandbox = { commands: { run: async (command: string) => { calls.push(command); return { stdout: `mikka-official-instance-staged ${release.sourceCommit} ${release.workerSha}` } } } } as never
  assert.deepEqual(await stageOfficialWorkerRelease(sandbox, 'codex', release.previousSha, env, async () => ''), release)
  assert.ok(calls[0].includes(`codex stage ${release.previousSha}`))
  await assert.rejects(stageOfficialWorkerRelease(sandbox, 'codex', 'main', env), /not configured/)
  await assert.rejects(stageOfficialWorkerRelease({ commands: { run: async () => ({ stdout: 'installed' }) } } as never, 'codex', release.previousSha, env, async () => ''), /staging unconfirmed/)
})
test('readiness requires the authenticated RPC PID to match the verified new process', async () => {
  for (const rpc of ['mikka-runtime-process-verified 41', 'mikka-runtime-process-verified 42']) {
    let count = 0
    const sandbox = { commands: { run: async () => ({ stdout: ++count === 1 ? JSON.stringify({ status: 'verified_process', workerSourceCommit: release.sourceCommit, workerSha: release.workerSha, pid: 42 }) : rpc }) } } as never
    const result = switchOfficialWorkerRelease(sandbox, release, identity, 'verify', async () => '')
    if (rpc.endsWith('42')) await result
    else await assert.rejects(result, /RPC process unconfirmed/)
    assert.equal(count, 2)
  }
  await assert.rejects(switchOfficialWorkerRelease({ commands: { run: async () => ({ stdout: JSON.stringify({status:'verified_process',workerSourceCommit:release.sourceCommit,workerSha:release.workerSha}) }) } } as never, release, identity, 'verify', async () => ''), /process unavailable/)
})
test('rollback explicitly reports restored but not ready', async () => {
  const sandbox = { commands: { run: async () => ({ stdout: JSON.stringify({status:'restored_not_ready',workerSha:release.previousSha}) }) } } as never
  assert.equal((await switchOfficialWorkerRelease(sandbox, release, identity, 'rollback', async () => '')).status, 'restored_not_ready')
})

test('refresh staging and process verification pass the remaining budget to each SDK call', async () => {
  let remaining = 9_000
  const limits: number[] = []
  const budget = (maximum: number) => Math.min(maximum, remaining)
  const sandbox = { commands: { run: async (command: string, options: { timeoutMs: number; requestTimeoutMs?: number; signal?: AbortSignal }) => {
    assert.equal(options.timeoutMs, remaining)
    assert.equal(options.requestTimeoutMs, remaining)
    assert.ok(options.signal instanceof AbortSignal)
    limits.push(options.timeoutMs)
    remaining -= 2_000
    if (command.includes('MIKKA_OFFICIAL_WORKER_STAGE') || command.includes('MIKKA_PRIVATE_RUNTIME_SWITCH')) assert.match(command, /^timeout --signal=TERM --kill-after=3s \d+\.\d{3}s /)
    if (command.includes('MIKKA_PRIVATE_RUNTIME_SWITCH')) assert.match(command, /s flock --exclusive \/opt\/mikka\/runtime-refresh\.lock python3 - verify /)
    return { stdout: command.includes('MIKKA_OFFICIAL_WORKER_STAGE') ? `mikka-official-instance-staged ${release.sourceCommit} ${release.workerSha}`
      : command.includes('MIKKA_PRIVATE_RUNTIME_SWITCH') ? JSON.stringify({ status: 'verified_process', workerSourceCommit: release.sourceCommit, workerSha: release.workerSha, pid: 42 })
      : 'mikka-runtime-process-verified 42' }
  } } } as never
  await stageOfficialWorkerRelease(sandbox, 'codex', release.previousSha, env, async () => '', budget)
  await switchOfficialWorkerRelease(sandbox, release, identity, 'verify', async () => '', budget)
  assert.deepEqual(limits, [9_000, 7_000, 5_000])
})

test('an expired refresh budget starts no staging or runtime switch', async () => {
  const budget = () => { throw new Error('refresh deadline') }
  const sandbox = { commands: { run: async () => { assert.fail('expired maintenance must not start a remote command') } } } as never
  await assert.rejects(stageOfficialWorkerRelease(sandbox, 'codex', release.previousSha, env, async () => '', budget), /refresh deadline/)
  await assert.rejects(switchOfficialWorkerRelease(sandbox, release, identity, 'switch', async () => '', budget), /refresh deadline/)
})

test('refresh staging terminates a foreground process that ignores TERM before its SDK budget', { timeout: 12_000 }, async () => {
  const sandbox = { commands: { run: async (command: string) => promisify(execFile)('bash', ['-c', command], { timeout: 8_000, killSignal: 'SIGKILL' }) } } as never
  await assert.rejects(
    stageOfficialWorkerRelease(sandbox, 'codex', release.previousSha, env, async () => 'trap "" TERM\nwhile :; do sleep 1; done', () => 5_020),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'killed' in error && !error.killed &&
      (('signal' in error && error.signal === 'SIGKILL') || ('code' in error && error.code === 137))),
  )
})

test('private runtime switch preserves files and refuses unsafe process states', async () => {
  await promisify(execFile)('python3', ['packages/daemon/scripts/refresh-cloud-worker.test.py'])
})


test('runtime refusal receipt exposes only closed code and phase from the expected command', async () => {
  for (const action of ['switch', 'rollback'] as const) {
    const fault = Object.assign(new Error('PRIVATE-CREDENTIAL provider message'), { name: 'CommandExitError', exitCode: 1,
      stderr: JSON.stringify({ protocol: 'mikka-runtime-refresh-refusal/v1', action, phase: 'journal_before_stop', code: 'runtime_journal_missing' }),
      stdout: 'PRIVATE-CREDENTIAL stdout', command: 'PRIVATE-CREDENTIAL command', cause: { token: 'PRIVATE-CREDENTIAL' } })
    const sandbox = { commands: { run: async () => { throw fault } } } as never
    await assert.rejects(switchOfficialWorkerRelease(sandbox, release, identity, action, async () => ''), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'RuntimeRefreshError')
      assert.deepEqual(Object.fromEntries(['code', 'runtimePhase', 'exitCode'].map(key => [key, (error as unknown as Record<string, unknown>)[key]])), {
        code: 'runtime_journal_missing', runtimePhase: 'journal_before_stop', exitCode: 1,
      })
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE-CREDENTIAL/)
      assert.equal(error.cause, undefined)
      return true
    })
  }
})

test('unknown, extra, oversized, or wrong-action runtime stderr is never promoted to a trusted receipt', async () => {
  const valid = { protocol: 'mikka-runtime-refresh-refusal/v1', action: 'switch', phase: 'journal_before_stop', code: 'runtime_journal_missing' }
  for (const stderr of ['PRIVATE-CREDENTIAL', JSON.stringify({ ...valid, phase: 'PRIVATE-CREDENTIAL' }),
    JSON.stringify({ ...valid, code: 'runtime_PRIVATE_CREDENTIAL' }), JSON.stringify({ ...valid, action: 'rollback' }),
    JSON.stringify({ ...valid, detail: 'PRIVATE-CREDENTIAL' }), JSON.stringify(valid) + '\nPRIVATE-CREDENTIAL', ' '.repeat(2048) + JSON.stringify(valid)]) {
    const fault = Object.assign(new Error('PRIVATE-CREDENTIAL'), { name: 'CommandExitError', exitCode: 1, stderr })
    const sandbox = { commands: { run: async () => { throw fault } } } as never
    await assert.rejects(switchOfficialWorkerRelease(sandbox, release, identity, 'switch', async () => ''), error => error === fault)
  }
})
