import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { CONTRACT, boundedChild, createOwnVmDiagnostic, probeOwnVm, validateDiagnostic } from './own-vm-diagnostic.mjs'

const scope = { runId: '10000000-0000-4000-8000-000000000001', issueId: '10000000-0000-4000-8000-000000000002',
  workspaceId: '10000000-0000-4000-8000-000000000003', sinceMs: 1794038400000, untilMs: 1794038500000 }
const operationId = '10000000-0000-4000-8000-000000000004'
const sandboxId = 'testonlysandbox12345'
const metadata = { application: 'mikka-thread', workspaceId: scope.workspaceId, runId: scope.runId, operationId }
const empty = () => ({ files: { daemonLog: 'missing', bootstrapLog: 'missing', journal: 'missing', pid: 'missing' },
  process: { recordedPidAlive: null }, journal: { valid: false, targetPresent: false, assignmentMatches: false,
    state: 'other', lastSeq: null, sessionPresent: false }, events: [], eventsTruncated: false, logTruncated: false, malformedLines: 0 })
const observed = () => ({ status: 'observed', reason: 'collected', target: { sandboxId, operationId, state: 'running', autoResume: false }, diagnostic: empty() })
function fakeProvider(change = {}) {
  const calls = { list: 0, info: 0, construct: 0, execute: 0 }
  const matches = [{ sandboxId, metadata, state: 'running' }]
  const info = { sandboxID: sandboxId, metadata, state: 'running', lifecycle: { autoResume: false },
    domain: 'e2b.app', envdVersion: '0.10.0', envdAccessToken: 'synthetic-provider-secret' }
  const values = { matches, info, hasNext: false, output: JSON.stringify(empty()), ...change }
  class Sandbox {
    static list(options) {
      calls.list++
      assert.equal(options.retries, 0)
      assert.equal(options.limit, 2)
      assert.deepEqual(options.query.metadata, { application: 'mikka-thread', workspaceId: scope.workspaceId, runId: scope.runId })
      return { hasNext: values.hasNext, nextItems: async () => values.matches }
    }
    static connect() { assert.fail('connect would resume the VM') }
    static create() { assert.fail('create must never be used') }
    constructor(options) {
      calls.construct++
      assert.equal(options.sandboxId, sandboxId)
      assert.equal(options.envdAccessToken, 'synthetic-provider-secret')
      this.commands = { run: async (command, options) => {
        calls.execute++
        assert.equal(options.user, 'user')
        assert.equal(options.timeoutMs, 7000)
        assert.match(command, /signal.alarm\(5\)/)
        if (values.error) throw values.error
        return { exitCode: 0, stdout: values.output, stderr: 'synthetic stderr secret must be ignored' }
      } }
    }
  }
  return { calls, values, options: { apiKey: 'synthetic-api-secret', Sandbox, fetchInfo: async (url, options) => {
    calls.info++
    assert.equal(url, `https://api.e2b.app/sandboxes/${sandboxId}`)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    return new Response(JSON.stringify(values.info))
  } } }
}

test('one exact running/no-auto-resume VM receives one read-only probe and a closed receipt', async () => {
  const provider = fakeProvider()
  const result = await probeOwnVm(scope, provider.options)
  assert.deepEqual(result, observed())
  assert.deepEqual(provider.calls, { list: 1, info: 1, construct: 1, execute: 1 })
  assert.ok(!JSON.stringify(result).includes('secret'))
})

test('foreign, ambiguous or paginated targets never construct or execute a handle', async () => {
  for (const change of [
    { hasNext: true }, { hasNext: undefined }, { matches: [] },
    { matches: [{ sandboxId, metadata, state: 'running' }, { sandboxId, metadata, state: 'running' }] },
    { matches: [{ sandboxId, metadata: { ...metadata, runId: operationId }, state: 'running' }] },
    { matches: [{ sandboxId, metadata: { ...metadata, workspaceId: operationId }, state: 'running' }] },
    { matches: [{ sandboxId, metadata: { ...metadata, application: 'foreign' }, state: 'running' }] },
    { matches: [{ sandboxId, metadata: { ...metadata, operationId: 'secret-value' }, state: 'running' }] },
    { matches: [{ sandboxId: '../foreign', metadata, state: 'running' }] },
  ]) {
    const provider = fakeProvider(change)
    assert.equal((await probeOwnVm(scope, provider.options)).status, 'blocked')
    assert.equal(provider.calls.construct, 0)
    assert.equal(provider.calls.execute, 0)
  }
})

test('paused, missing/true autoResume, changed ownership and unknown domain fail closed', async () => {
  const variants = [value => { value.state = 'paused' }, value => { delete value.lifecycle },
    value => { value.lifecycle = {} }, value => { value.lifecycle.autoResume = true },
    value => { value.lifecycle.autoResume = 'false' }, value => { value.domain = 'attacker.invalid' },
    value => { value.metadata = { ...metadata, operationId: scope.runId } },
    value => { value.metadata = { ...metadata, runId: operationId } }, value => { delete value.envdAccessToken }]
  for (const mutate of variants) {
    const provider = fakeProvider()
    mutate(provider.values.info)
    assert.equal((await probeOwnVm(scope, provider.options)).status, 'blocked')
    assert.equal(provider.calls.construct, 0)
  }
  const paused = fakeProvider({ matches: [{ sandboxId, metadata, state: 'paused' }] })
  assert.equal((await probeOwnVm(scope, paused.options)).reason, 'not_running')
  assert.equal(paused.calls.info, 0)
})

test('SDK stdout is independently validated; free text, keys and unknown field values are rejected', async () => {
  for (const output of ['raw-secret', JSON.stringify({ ...empty(), secret: 'raw-secret' }),
    JSON.stringify({ ...empty(), journal: { ...empty().journal, state: 'arbitrary-secret' } }),
    JSON.stringify({ ...empty(), process: { recordedPidAlive: 'arbitrary-secret' } })]) {
    const provider = fakeProvider({ output })
    assert.equal((await probeOwnVm(scope, provider.options)).reason, 'output_invalid')
  }
  const provider = fakeProvider()
  provider.options.fetchInfo = async () => { throw new Error('SDK credential-bearing message') }
  assert.deepEqual(await probeOwnVm(scope, provider.options), { status: 'blocked', reason: 'probe_failed', target: null, diagnostic: null })
})

const python = fileURLToPath(new URL('./own-vm-diagnostic.py', import.meta.url))
function projectFiles(root, expired = false) {
  return JSON.parse(execFileSync('python3', ['-B', '-c', [
    'import importlib.util,json,sys',
    's=importlib.util.spec_from_file_location("probe",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
    'v=json.load(sys.stdin)',
    'def forbidden(*args,**kwargs): raise AssertionError("expired probe opened a file")',
    'if v["expired"]: m.os.open=forbidden',
    'print(json.dumps(m.collect(v["scope"],v["contract"],sys.argv[2],expires_at_ms=1 if v["expired"] else None)))',
  ].join('\n'), python, root], { input: JSON.stringify({ scope, contract: CONTRACT, expired }), maxBuffer: 32768, timeout: 3000, encoding: 'utf8' }))
}

test('real VM-side projector keeps scoped DaemonError/Zod evidence and removes secret sentinels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'issue1503-diagnostic-'))
  try {
    await mkdir(join(root, 'worker/logs'), { recursive: true })
    const secret = 'SENTINEL_PRIVATE_VALUE_1503'
    const event = { time: scope.sinceMs + 1, level: 50, run_id: scope.runId, msg: 'could not start run',
      err: { type: 'DaemonError', code: 4020, message: `POST /v1/devices/${secret}: unexpected response from the server`,
        stack: secret, upgradeRequired: true, data: [
          { code: 'invalid_type', path: ['subscriptionLease', 'credential', 'accessToken'], input: secret, message: secret },
          { code: 'invalid_type', path: ['taskEnv', secret], input: secret },
          { code: secret, path: [secret], message: secret },
        ], cause: { name: secret, code: secret, status: 503, message: secret } } }
    await writeFile(join(root, 'worker/logs/daemon.log'), [
      { ...event, run_id: operationId }, { ...event, time: scope.sinceMs - 1 }, event,
      { ...event, run_id: null, msg: 'server sync failed', err: { type: secret, code: 123456, message: secret } },
    ].map(value => JSON.stringify(value)).join('\n'))
    await writeFile(join(root, 'thread-bootstrap.log'), secret)
    await writeFile(join(root, 'worker/daemon.pid'), `${process.pid}\n`)
    await writeFile(join(root, 'worker/runs.json'), JSON.stringify({ version: 1, runs: {
      [scope.runId]: { assignment: { runId: scope.runId, issueId: scope.issueId, prompt: secret, taskEnv: { [secret]: secret } },
        sessionId: secret, state: 'running', lastSeq: 0, error: secret },
      [operationId]: { assignment: secret, sessionId: secret },
    } }))
    const value = projectFiles(root)
    assert.equal(validateDiagnostic(value, scope), true)
    assert.equal(JSON.stringify(value).includes(secret), false)
    assert.equal(value.events.length, 2)
    assert.equal(value.events[0].error.classification, 'response_schema')
    assert.deepEqual(value.events[0].error.schemaIssues[1].path, ['taskEnv', '<redacted-key>'])
    assert.deepEqual(value.events[0].error.schemaIssues[2], { code: 'other', path: ['<redacted-key>'] })
    assert.equal(value.events[1].error.name, 'other')
    assert.equal(value.events[1].error.code, 'other')
    assert.deepEqual(value.journal, { valid: true, targetPresent: true, assignmentMatches: true, state: 'running', lastSeq: 0, sessionPresent: true })
    assert.equal(value.process.recordedPidAlive, true)
    for (const change of [
      item => { item.events[0].error.name = secret }, item => { item.events[0].error.code = 123456 },
      item => { item.events[0].error.schemaIssues[0].path = ['taskEnv', 'accessToken'] },
      item => { item.events[0].error.schemaIssues[0].path = [secret] },
      item => { item.events[0].error.cause.code = secret },
    ]) { const mutated = structuredClone(value); change(mutated); assert.equal(validateDiagnostic(mutated, scope), false) }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('filesystem bounds reject symlinks, oversized journals and malformed data without raw output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'issue1503-diagnostic-'))
  try {
    await mkdir(join(root, 'worker'), { recursive: true })
    await writeFile(join(root, 'outside'), 'PRIVATE_OUTSIDE_SENTINEL')
    await symlink(root, join(root, 'worker/logs'))
    await writeFile(join(root, 'worker/runs.json'), 'x'.repeat(1048577))
    await writeFile(join(root, 'worker/daemon.pid'), 'invalid private pid')
    let value = projectFiles(root)
    assert.equal(validateDiagnostic(value, scope), true)
    assert.equal(value.files.daemonLog, 'unavailable')
    assert.equal(value.files.journal, 'too_large')
    assert.equal(value.journal.valid, false)
    await writeFile(join(root, 'worker/runs.json'), '{invalid')
    value = projectFiles(root)
    assert.equal(value.journal.valid, false)
    assert.ok(!JSON.stringify(value).includes('PRIVATE'))
    const expired = projectFiles(root, true)
    assert.deepEqual(Object.values(expired.files), ['expired', 'expired', 'expired', 'expired'])
    assert.equal(validateDiagnostic(expired, scope), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the actual pinned Pino serializer retains schema data but does not invent a lost Error cause', async () => {
  const daemonRequire = createRequire(new URL('../../../packages/daemon/package.json', import.meta.url))
  // The local no-install run points at the integrity-verified existing pnpm
  // cache's three original serializer modules. A normal checkout uses Pino's
  // actual installed dependency, as daemon/src/log.ts does by default.
  const serialize = process.env.MIKKA_1503_TEST_PINO_SERIALIZER
    ? daemonRequire(process.env.MIKKA_1503_TEST_PINO_SERIALIZER)
    : createRequire(daemonRequire.resolve('pino'))('pino-std-serializers').err
  class DaemonError extends Error {
    constructor(code, message, data) { super(message); this.name = 'DaemonError'; this.code = code; this.data = data }
  }
  class ServerUnreachableError extends DaemonError {
    constructor(cause) { super(4020, 'Server unreachable'); this.cause = cause }
  }
  const secret = 'PRIVATE_PINO_CAUSE_1503'
  const schema = new DaemonError(4020, 'POST /v1/claim: unexpected response from the server',
    [{ code: 'invalid_type', path: ['subscriptionLease', 'credential'], message: secret, input: secret }])
  const timeout = new ServerUnreachableError(Object.assign(new Error(secret), { name: 'TimeoutError', code: 'ETIMEDOUT' }))
  const http = new ServerUnreachableError(503)
  const actual = [schema, timeout, http].map(error => JSON.parse(JSON.stringify(serialize(error))))
  assert.equal(actual[0].type, 'DaemonError')
  assert.ok(Array.isArray(actual[0].data))
  assert.equal(Object.hasOwn(actual[1], 'cause'), false)
  assert.equal(actual[2].cause, 503)
  const root = await mkdtemp(join(tmpdir(), 'issue1503-pino-'))
  try {
    await mkdir(join(root, 'worker/logs'), { recursive: true })
    await writeFile(join(root, 'worker/logs/daemon.log'), actual.map(err => JSON.stringify({
      time: scope.sinceMs + 1, level: 50, run_id: scope.runId, msg: 'could not start run', err,
    })).join('\n'))
    const result = projectFiles(root)
    assert.equal(validateDiagnostic(result, scope), true)
    assert.ok(!JSON.stringify(result).includes(secret))
    assert.equal(result.events[0].error.classification, 'response_schema')
    assert.deepEqual(result.events[0].error.schemaIssues, [{ code: 'invalid_type', path: ['subscriptionLease', 'credential'] }])
    assert.equal(result.events[1].error.name, 'ServerUnreachableError')
    assert.deepEqual(result.events[1].error.cause, { name: 'other', code: 'other', status: null })
    assert.equal(result.events[1].error.classification, 'other')
    assert.equal(result.events[2].error.cause.status, 503)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('concurrent live failure/catch share one probe and cleanup awaits that same result', async () => {
  let calls = 0, release
  const ready = new Promise(resolve => { release = resolve })
  const once = createOwnVmDiagnostic({ apiKey: 'synthetic', collect: async () => { calls++; await ready; return observed() } })
  const first = once.collect(scope)
  assert.equal(first, once.collect({ ...scope, runId: operationId }))
  assert.equal(first, once.settled())
  let cleaned = false
  const cleanup = once.settled().then(() => { cleaned = true })
  await Promise.resolve()
  assert.equal(cleaned, false)
  release(); await cleanup
  assert.equal(calls, 1)
  assert.equal((await first).runId, scope.runId)
  assert.equal(cleaned, true)
  const closed = createOwnVmDiagnostic({ apiKey: 'synthetic', collect: () => assert.fail('late live callback must not probe during cleanup') })
  assert.equal(await closed.settled(), null)
  assert.equal((await closed.collect(scope)).reason, 'cleanup_started')
})

test('an ambiguous command transport failure waits out the remote bound before cleanup may proceed', async () => {
  const provider = fakeProvider({ error: new Error('PRIVATE_TRANSPORT_ERROR') })
  let release, entered, completed = false
  const waiting = new Promise(resolve => { entered = resolve })
  const remoteLimit = new Promise(resolve => { release = resolve })
  const result = probeOwnVm(scope, { ...provider.options, waitForRemoteLimit: async milliseconds => {
    assert.ok(milliseconds > 9000 && milliseconds <= 10000)
    entered(); await remoteLimit
  } }).then(value => { completed = true; return value })
  await waiting
  assert.equal(completed, false)
  release()
  assert.equal((await result).reason, 'probe_failed')
  assert.deepEqual(provider.calls, { list: 1, info: 1, construct: 1, execute: 1 })
})

test('hard deadline kills and joins a real hung child before allowing cleanup', async () => {
  let child, closed = false
  const result = await boundedChild(scope, 'synthetic', { deadlineMs: 100, spawnChild: (_exe, _args, options) => {
    child = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},10000)'], options)
    child.on('close', () => { closed = true })
    return child
  } })
  assert.equal(result.reason, 'deadline')
  assert.equal(closed, true)
  assert.equal(child.signalCode, 'SIGKILL')
})

test('the remote projector self-terminates even if a filesystem read hangs', () => {
  const started = performance.now()
  assert.throws(() => execFileSync('python3', ['-B', '-c', [
    'import importlib.util,sys,time',
    's=importlib.util.spec_from_file_location("probe",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
    'm.collect=lambda *args,**kwargs:time.sleep(20)', 'm.main({}, {}, int(time.time()*1000)+9000)',
  ].join('\n'), python], { timeout: 7000, stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 124)
  assert.ok(performance.now() - started < 7000)
})

test('missing key, collector errors and forged child output stay diagnostic-only and closed', async () => {
  const noKey = createOwnVmDiagnostic({ collect: () => assert.fail('must not call provider') })
  assert.equal((await noKey.collect(scope)).reason, 'key_unavailable')
  const failed = createOwnVmDiagnostic({ apiKey: 'synthetic', collect: async () => { throw new Error('PRIVATE') } })
  assert.equal((await failed.collect(scope)).reason, 'child_failed')
  const result = await boundedChild(scope, 'synthetic', { spawnChild: (_exe, _args, options) => spawn(process.execPath,
    ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({secret:"PRIVATE"})))'], options) })
  assert.equal(result.reason, 'output_invalid')
  assert.ok(!JSON.stringify(result).includes('PRIVATE'))
})
