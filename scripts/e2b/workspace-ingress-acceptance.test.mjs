import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { CommandExitError, SandboxError } from 'e2b'
import test from 'node:test'
import { candidateIdentity, cleanupOwnedRuntime, guardReceipt, observeHmr, probeTerminalAfterPreview,
  probeWorkspaceIngress, validateJournal, validPorts } from './workspace-ingress-acceptance.mjs'

const source = 'a'.repeat(40), ops = 'b'.repeat(40), worker = 'c'.repeat(40), digest = 'd'.repeat(64)
const execution = { runId: '1234', runAttempt: '1' }
const fixture = '11111111-2222-3333-4444-555555555555'
const guard = { ok: true, version: 1, sourceSha256: digest, bootId: fixture, installedTicks: 200,
  providerPorts: [49983], preparedBeforeWorker: true, rulesVerified: { ipv4: true, ipv6: true },
  workerPid: 301, workerStartTicks: 205, workerStartedAfterGuard: true }
const journal = { version: 1, purpose: 'mikka-workspace-ingress-acceptance', sourceCommit: source, opsSource: ops,
  workerSha: worker, fixtureId: fixture, templateId: 'owned-template', kind: 'claude', ...execution,
  creationRequested: true, sandboxId: 'owned-sandbox' }

function identitySandbox({ infoError, commandError, output = `${source}\n${worker}\n`, foreignScope = false } = {}) {
  const calls = []
  return { calls, sandboxId: journal.sandboxId,
    async getInfo() {
      calls.push({ operation: 'get_info' })
      if (infoError) throw infoError
      return { templateId: foreignScope ? 'foreign-template' : journal.templateId,
        metadata: { sourceCommit: source, fixtureId: fixture, application: journal.purpose } }
    },
    commands: { async run(command, options) {
      calls.push({ operation: 'command', command, options })
      if (commandError) throw commandError
      if (calls.length > 2) throw new Error('synthetic guard refusal after successful identity')
      return { stdout: output, exitCode: 0 }
    } },
  }
}
const identityProbe = sandbox => probeWorkspaceIngress(sandbox, journal, { Socket: class {} })

test('identity failures distinguish the provider read, root source command and exact source comparison', async () => {
  const infoError = Object.assign(new Error('synthetic private API URL'), { name: 'SandboxNotFoundError', statusCode: 404 })
  const missing = identitySandbox({ infoError })
  const read = await identityProbe(missing)
  assert.equal(read.stage, 'identity'); assert.equal(read.failure, 'internal'); assert.equal(read.passed, false)
  assert.equal(read.identityDiagnostic.operation, 'get_info')
  assert.deepEqual(read.identityDiagnostic.exceptionChain, [{ type: 'SandboxNotFoundError', reason: null, exitCode: null, httpStatus: 404, connectCode: null }])
  assert.equal(missing.calls.length, 1)

  const commandError = new CommandExitError({ exitCode: 128, stdout: 'private command stdout',
    stderr: "fatal: detected dubious ownership in repository at '/synthetic-private-path'", error: 'private command message' })
  const command = identitySandbox({ commandError }), failed = await identityProbe(command)
  assert.equal(failed.failure, 'internal'); assert.equal(failed.passed, false)
  assert.equal(failed.identityDiagnostic.operation, 'source_command')
  assert.equal(failed.identityDiagnostic.exceptionChain[0].type, 'CommandExitError')
  assert.equal(failed.identityDiagnostic.exceptionChain[0].exitCode, 128)
  assert.equal(failed.identityDiagnostic.stderr.gitDubiousOwnership, true)
  assert.equal(failed.identityDiagnostic.stderr.gitNotRepository, false)
  assert.deepEqual(command.calls[1].options, { user: 'root', timeoutMs: 5000 })
  assert.equal(command.calls[1].command, 'git -C /opt/mikka/worker rev-parse HEAD && cat /opt/mikka/worker-source-sha')

  const mismatch = await identityProbe(identitySandbox({ output: `${'f'.repeat(40)}\n${worker}\n` }))
  assert.equal(mismatch.failure, 'source'); assert.equal(mismatch.passed, false)
  assert.equal(mismatch.identityDiagnostic.operation, 'source_compare')
  const foreign = await identityProbe(identitySandbox({ foreignScope: true }))
  assert.equal(foreign.failure, 'scope'); assert.equal(foreign.passed, false)
  assert.equal(foreign.identityDiagnostic.operation, 'get_info')
})

test('identity diagnostics preserve bounded actual SDK fields and redact exception messages, paths and stderr', async () => {
  const privateText = 'synthetic-private-error-url-header-output'
  const connect = Object.assign(new Error(privateText), { name: 'ConnectError', code: 14, statusCode: 503 })
  const unavailable = Object.assign(new Error(privateText, { cause: connect }), { name: 'SandboxUnreachableError' })
  const report = await identityProbe(identitySandbox({ commandError: unavailable }))
  assert.deepEqual(report.identityDiagnostic.exceptionChain, [
    { type: 'SandboxUnreachableError', reason: null, exitCode: null, httpStatus: null, connectCode: null },
    { type: 'ConnectError', reason: null, exitCode: null, httpStatus: 503, connectCode: 14 },
  ])
  assert.equal(JSON.stringify(report).includes(privateText), false)
  for (const name of ['SandboxNotRunningError', 'ServiceBusyError', 'RateLimitError', 'TimeoutError', 'AuthenticationError']) {
    const value = Object.assign(new Error(privateText), { name })
    const row = await identityProbe(identitySandbox({ infoError: value }))
    assert.equal(row.identityDiagnostic.exceptionChain[0].type, name)
    assert.equal(row.passed, false)
  }
  for (const value of [Object.assign(new Error(privateText), { name: privateText, code: 14, statusCode: true, exitCode: 128 }),
    Object.assign(new Error(privateText), { name: 'ConnectError', code: 17, statusCode: 600, exitCode: -1 }),
    new CommandExitError({ exitCode: 1.5, stdout: privateText, stderr: privateText, error: privateText })]) {
    const row = await identityProbe(identitySandbox({ commandError: value }))
    const item = row.identityDiagnostic.exceptionChain[0]
    assert.deepEqual([item.reason, item.exitCode, item.httpStatus, item.connectCode], [null, null, null, null])
    assert.equal(JSON.stringify(row).includes(privateText), false)
  }
})

test('only the two exact fixed SDK messages receive process protocol reasons', async () => {
  for (const [cause, reason] of [[new Error('Expected start event'), 'process_start_event_missing'],
    [new SandboxError('Process exited without a result'), 'process_result_missing']]) {
    const report = await identityProbe(identitySandbox({ commandError: cause }))
    assert.equal(report.identityDiagnostic.exceptionChain[0].reason, reason)
    assert.equal(report.passed, false)
    assert.equal(JSON.stringify(report).includes(cause.message), false)
  }
  const privateText = 'https://synthetic-private-url.invalid/private-token'
  for (const cause of [new Error(`Expected start event ${privateText}`),
    new SandboxError(`Process exited without a result ${privateText}`),
    new Error('Process exited without a result'), new SandboxError('Expected start event')]) {
    const report = await identityProbe(identitySandbox({ commandError: cause }))
    assert.equal(report.identityDiagnostic.exceptionChain[0].reason, null)
    assert.equal(JSON.stringify(report).includes(privateText), false)
    assert.equal(report.passed, false)
  }
})

test('command stderr classifiers and exception causes have hard bounds without changing the failed result', async () => {
  const missing = new CommandExitError({ exitCode: 128, stdout: '',
    stderr: 'fatal: not a git repository (or any of the parent directories): .git', error: 'synthetic' })
  const classified = await identityProbe(identitySandbox({ commandError: missing }))
  assert.equal(classified.identityDiagnostic.stderr.gitNotRepository, true)
  const oversized = new CommandExitError({ exitCode: -255, stdout: '', error: 'synthetic',
    stderr: 'α'.repeat(9000) + "fatal: detected dubious ownership in repository at '/private'" })
  const limited = await identityProbe(identitySandbox({ commandError: oversized }))
  assert.deepEqual(limited.identityDiagnostic.stderr, { gitDubiousOwnership: false, gitNotRepository: false, oversized: true })
  assert.equal(limited.identityDiagnostic.exceptionChain[0].exitCode, -255)
  const cycle = Object.assign(new Error('private'), { name: 'TimeoutError' }); cycle.cause = cycle
  const cyclic = await identityProbe(identitySandbox({ infoError: cycle }))
  assert.equal(cyclic.identityDiagnostic.truncated, true)
  assert.equal(cyclic.identityDiagnostic.exceptionChain.length, 1)
  let chain = new Error('private')
  for (let i = 0; i < 8; i++) chain = new Error('private', { cause: chain })
  const bounded = await identityProbe(identitySandbox({ infoError: chain }))
  assert.equal(bounded.identityDiagnostic.truncated, true)
  assert.equal(bounded.identityDiagnostic.exceptionChain.length, 4)
  for (const row of [classified, limited, cyclic, bounded]) {
    assert.equal(row.failure, 'internal'); assert.equal(row.passed, false)
  }
})

test('successful identity still reaches the original guard and creation timeout/lifecycle remain fixed', async () => {
  const sandbox = identitySandbox(), report = await identityProbe(sandbox)
  assert.equal(report.stage, 'prelistener_guard')
  assert.equal(report.failure, 'process')
  assert.equal(report.identityDiagnostic, undefined)
  assert.equal(sandbox.calls.length, 3)
  const script = readFileSync(new URL('./workspace-ingress-acceptance.mjs', import.meta.url), 'utf8')
  assert.match(script, /Sandbox\.create\(row\.templateId, \{ \.\.\.apiOptions, timeoutMs: 480_000,/)
  assert.match(script, /network: \{ allowPublicTraffic: true \}, lifecycle: \{ onTimeout: 'kill', autoResume: false \}, metadata: metadata\(journal\)/)
})

test('a marker alone cannot establish prelistener protection or a valid resumed worker', () => {
  assert.deepEqual(guardReceipt(guard, digest), guard)
  for (const value of [
    { ...guard, sourceSha256: 'e'.repeat(64) }, { ...guard, preparedBeforeWorker: false },
    { ...guard, workerStartTicks: 199 }, { ...guard, workerStartedAfterGuard: false },
    { ...guard, rulesVerified: { ipv4: true, ipv6: false } },
    { ...guard, providerPorts: [49983, 8080] }, { ...guard, providerPorts: [49983, 49983] },
    { ...guard, bootId: '' },
  ]) assert.throws(() => guardReceipt(value, digest), /workspace_acceptance_guard/)
  assert.deepEqual(guardReceipt(guard, digest, guard), guard)
  assert.throws(() => guardReceipt({ ...guard, workerPid: 302 }, digest, guard), /workspace_acceptance_resume/)
  assert.throws(() => guardReceipt({ ...guard, bootId: '66666666-2222-3333-4444-555555555555' }, digest, guard), /workspace_acceptance_resume/)
})

test('raw fixtures cannot substitute duplicate or provider-reserved listeners', () => {
  const ports = { userLoopback4: 3101, userPublic4: 3102, userLoopback6: 3103, rootMarked: 3104 }
  assert.deepEqual(validPorts(ports), ports)
  assert.throws(() => validPorts({ ...ports, rootMarked: 3101 }), /workspace_acceptance_ports/)
  assert.throws(() => validPorts({ ...ports, rootMarked: 49983 }), /workspace_acceptance_ports/)
  const { userLoopback6: omitted, ...withoutV6 } = ports
  assert.ok(omitted)
  assert.throws(() => validPorts(withoutV6), /workspace_acceptance_ports/)
})

test('candidate acceptance requires both exact private templates and positive conservation', () => {
  const row = kind => ({ baseTemplate: kind, templateId: `owned-${kind}`, buildId: `build-${kind}`,
    preinstalled: true, privateVerified: true, conservation: { before: { entries: 123, sha256: digest }, after: { entries: 123, sha256: digest } } })
  const report = { sourceCommit: source, workerSha: worker, templates: { claude: row('claude'), codex: row('codex') } }
  assert.equal(candidateIdentity(report, source), report)
  const publicCandidate = structuredClone(report); publicCandidate.templates.codex.privateVerified = false
  assert.throws(() => candidateIdentity(publicCandidate, source), /workspace_acceptance_candidate/)
  const changed = structuredClone(report); changed.templates.claude.conservation.after.entries--
  assert.throws(() => candidateIdentity(changed, source), /workspace_acceptance_candidate/)
  assert.throws(() => candidateIdentity({ ...report, templates: { claude: row('claude') } }, source), /workspace_acceptance_candidate/)
})

function provider({ metadataChanged = false, templateChanged = false, absentAfterKill = true, lostCreate = false, rows = 1, next = false } = {}) {
  class Missing extends Error {}
  let killed = false
  const calls = []
  const metadata = { application: journal.purpose, issue: '1724', sourceCommit: source, workerSha: worker,
    fixtureId: fixture, opsSource: ops, ...execution, kind: 'claude' }
  const sdk = { SandboxNotFoundError: Missing, Sandbox: {
    list(options) {
      calls.push(['list', options.query])
      return { hasNext: next, nextItems: async () => Array.from({ length: rows }, () => ({ sandboxId: 'owned-sandbox' })) }
    },
    async getInfo(id) {
      calls.push(['get', id])
      if (killed && absentAfterKill) throw new Missing()
      return { sandboxId: id, templateId: templateChanged ? 'foreign-template' : 'owned-template',
        metadata: metadataChanged ? { ...metadata, fixtureId: 'foreign' } : metadata }
    },
    async kill(id) { calls.push(['kill', id]); killed = true; return true },
    async connect() { assert.fail('cleanup must never resume a VM') },
  } }
  return { sdk, calls, record: lostCreate ? { ...journal, sandboxId: null } : journal }
}

test('cleanup rejects another run/attempt and inconsistent journals before provider access', async () => {
  const state = provider()
  for (const value of [{ ...journal, runId: '1235' }, { ...journal, runAttempt: '2' },
    { ...journal, sourceCommit: 'f'.repeat(40) }, { ...journal, creationRequested: false }]) {
    assert.throws(() => validateJournal(value, source, ops, execution), /workspace_acceptance_journal/)
    await assert.rejects(cleanupOwnedRuntime(value, source, ops, state.sdk, {}, execution), /workspace_acceptance_journal/)
  }
  assert.equal(state.calls.length, 0)
})

test('cleanup needs exact resource scope and a fresh provider absence after kill', async () => {
  for (const options of [{ metadataChanged: true }, { templateChanged: true }]) {
    const state = provider(options)
    await assert.rejects(cleanupOwnedRuntime(state.record, source, ops, state.sdk, {}, execution), /workspace_acceptance_cleanup/)
    assert.equal(state.calls.some(([name]) => name === 'kill'), false)
  }
  const good = provider()
  const result = await cleanupOwnedRuntime(good.record, source, ops, good.sdk, {}, execution)
  assert.equal(result.stopped, true); assert.equal(result.absent, true)
  assert.deepEqual(good.calls.map(([name]) => name), ['get', 'kill', 'get'])
  const visible = provider({ absentAfterKill: false })
  assert.equal((await cleanupOwnedRuntime(visible.record, source, ops, visible.sdk, {}, execution)).stopped, false)
})

test('lost-create reconciliation includes paused VMs, refuses ambiguity and never treats missing proof as cleanup', async () => {
  const good = provider({ lostCreate: true })
  assert.equal((await cleanupOwnedRuntime(good.record, source, ops, good.sdk, {}, execution)).stopped, true)
  assert.deepEqual(good.calls[0][1].state, ['running', 'paused'])
  assert.equal(good.calls[0][1].metadata.fixtureId, fixture)
  for (const options of [{ rows: 2 }, { next: true }]) {
    const state = provider({ ...options, lostCreate: true })
    await assert.rejects(cleanupOwnedRuntime(state.record, source, ops, state.sdk, {}, execution), /workspace_acceptance_cleanup/)
    assert.equal(state.calls.some(([name]) => name === 'kill'), false)
  }
  const missing = provider({ lostCreate: true, rows: 0 })
  const result = await cleanupOwnedRuntime(missing.record, source, ops, missing.sdk, {}, execution)
  assert.deepEqual(result, { stopped: false, absent: false, outcome: 'creation_unconfirmed' })
})

class Socket extends EventEmitter {
  static OPEN = 1
  static last
  readyState = Socket.OPEN
  constructor() { super(); Socket.last = this }
  send() {}
  terminate() { this.readyState = 3; this.emit('close', 1000) }
}

test('a WS that closed or produced invalid traffic before revoke cannot satisfy the revoke receipt', async () => {
  for (const fail of [socket => socket.terminate(), socket => socket.emit('error', new Error('transport')),
    socket => socket.emit('message', Buffer.from('not JSON'), false)]) {
    const observer = observeHmr('wss://owned.example.invalid', [], {}, Socket)
    const socket = Socket.last
    socket.emit('open'); socket.emit('message', Buffer.from('{"type":"connected"}'), false)
    await observer.ready()
    fail(socket)
    assert.throws(() => observer.expectRevoke(), /workspace_acceptance_revoke/)
    observer.close()
  }
  const observer = observeHmr('wss://owned.example.invalid', [], {}, Socket)
  const socket = Socket.last
  socket.emit('open'); socket.emit('message', Buffer.from('{"type":"connected"}'), false)
  await observer.ready(); observer.expectRevoke(); socket.terminate()
  assert.equal((await observer.revoked()).closed, true)
})

function shutdownSandbox({ reply = { stopped: true }, output, exitCode = 0, commandError } = {}) {
  const calls = [], files = new Map()
  const sandbox = { files: { async write(path, value, options) {
    assert.match(path, /^\/run\/mikka-preview\/acceptance-[a-f0-9-]+\.json$/)
    assert.deepEqual(options, { user: 'root' })
    assert.deepEqual(JSON.parse(value), { operation: 'shutdown' })
    files.set(path, value); calls.push('write')
  } }, commands: { async run(command, options) {
    if (command.startsWith('rm -f -- ')) {
      assert.deepEqual(options, { user: 'root', timeoutMs: 5000 })
      assert.ok(command.includes([...files.keys()][0]))
      calls.push('remove'); return { exitCode: 0, stdout: '' }
    }
    assert.deepEqual(options, { user: 'root', timeoutMs: 25_000 })
    const path = [...files.keys()][0]
    assert.equal(command, `chmod 600 '${path}' && python3 '/opt/mikka/worker/scripts/e2b/preview-gateway.py' control '${path}'`)
    calls.push('shutdown')
    if (commandError) throw commandError
    return { exitCode, stdout: output ?? JSON.stringify(reply) }
  } } }
  return { sandbox, calls }
}

const afterFrameworks = () => ({ stage: 'vite', passed: false,
  frameworks: ['next', 'vite'].map(framework => ({ framework, hotReload: true, revoked: true, takeoverDenied: true })) })

test('the real preview-to-terminal transition requires a shutdown acknowledgement and keeps the command budgets and ordering', async () => {
  const { sandbox, calls } = shutdownSandbox({ reply: { stopped: true, private: 'synthetic-private-reply' } })
  const report = afterFrameworks(), frameworks = structuredClone(report.frameworks)
  const fetchImpl = () => { throw new Error('must not issue a network request') }
  const terminalProbe = async (actual, options) => {
    calls.push('terminal')
    assert.equal(actual, sandbox)
    assert.deepEqual(options, { sourceCommit: source, fixtureId: fixture, fetchImpl })
    assert.equal(report.stage, 'terminal'); assert.equal(report.previewStopped, true)
    return { passed: true }
  }
  await probeTerminalAfterPreview(sandbox, report, journal, terminalProbe, fetchImpl)
  assert.deepEqual(calls, ['write', 'shutdown', 'remove', 'terminal'])
  assert.deepEqual(report.frameworks, frameworks)
  assert.deepEqual(report.terminal, { passed: true }); assert.equal(report.passed, false)
  assert.equal(JSON.stringify(report).includes('synthetic-private-reply'), false)
})

test('false, absent and truthy non-boolean shutdown replies cannot advance to PTY or report Vite failure', async () => {
  for (const stopped of [undefined, null, false, 'true', 1, {}, []]) {
    const { sandbox, calls } = shutdownSandbox({ reply: { stopped } }), report = afterFrameworks()
    let terminalCalls = 0
    await assert.rejects(probeTerminalAfterPreview(sandbox, report, journal, async () => {
      terminalCalls++; return { passed: true }
    }, () => {}), cause => cause.receiptCode === 'process')
    assert.equal(report.stage, 'preview_shutdown'); assert.equal(report.previewStopped, false)
    assert.equal(report.passed, false); assert.equal(report.terminal, undefined); assert.equal(terminalCalls, 0)
    assert.deepEqual(calls, ['write', 'shutdown', 'remove'])
  }
})

test('shutdown command failure remains process, retains its cause and completed frameworks, and never calls the terminal probe', async () => {
  const privateText = 'synthetic-private-command-url-and-output'
  const commandError = new CommandExitError({ exitCode: 1, stdout: privateText, stderr: privateText, error: privateText })
  for (const options of [{ commandError }, { exitCode: 1 }, { output: privateText }, { output: 'x'.repeat(32_769) }]) {
    const { sandbox, calls } = shutdownSandbox(options), report = afterFrameworks(), frameworks = structuredClone(report.frameworks)
    let terminalCalls = 0
    await assert.rejects(probeTerminalAfterPreview(sandbox, report, journal, async () => {
      terminalCalls++; return { passed: true }
    }, () => {}), cause => {
      assert.equal(cause.receiptCode, 'process'); assert.ok(cause.cause)
      if (options.commandError) assert.equal(cause.cause, commandError)
      return true
    })
    assert.equal(report.stage, 'preview_shutdown'); assert.equal(report.passed, false)
    assert.deepEqual(report.frameworks, frameworks); assert.equal(report.terminal, undefined); assert.equal(terminalCalls, 0)
    assert.deepEqual(calls, ['write', 'shutdown', 'remove'])
    assert.equal(JSON.stringify(report).includes(privateText), false)
  }
})

test('a failed terminal result after acknowledged shutdown keeps the original terminal condition', async () => {
  const { sandbox, calls } = shutdownSandbox(), report = afterFrameworks()
  await assert.rejects(probeTerminalAfterPreview(sandbox, report, journal, async () => {
    calls.push('terminal'); return { passed: false }
  }, () => {}), cause => cause.receiptCode === 'terminal')
  assert.equal(report.stage, 'terminal'); assert.equal(report.previewStopped, true); assert.equal(report.passed, false)
  assert.deepEqual(calls, ['write', 'shutdown', 'remove', 'terminal'])
})
