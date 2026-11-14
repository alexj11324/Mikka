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

import { prepareFrameworkPreview } from './workspace-ingress-acceptance.mjs'

function previewSandbox(reply, { commandError, output } = {}) {
  const calls = []
  const sandbox = { files: { async write(path, body, options) {
    calls.push({ operation: 'write', path, body: JSON.parse(body), options })
  } }, commands: { async run(command, options) {
    const cleanup = command.startsWith('rm -f -- ')
    calls.push({ operation: cleanup ? 'remove' : 'prepare', command, options })
    if (cleanup) return { exitCode: 0, stdout: '' }
    if (commandError) throw commandError
    return { exitCode: 0, stdout: output ?? JSON.stringify(reply) }
  } } }
  return { sandbox, calls }
}

test('unavailable preview retains only closed probe observations and keeps the original failed condition', async () => {
  for (const outcome of [null, 'timeout', 'connection_failed', 'pin_changed', 'http_error', 'invalid_status']) {
    const diagnostic = { candidateCount: outcome ? 1 : 0, vanishedFds: 2, processReadErrors: 1,
      budgetExpired: false, probes: outcome ? [{ outcome, elapsedMs: 8001 }] : [] }
    const { sandbox, calls } = previewSandbox({ running: false, state: 'unavailable', code: 'no_loopback_server', diagnostic })
    const report = { stage: 'next', passed: false, frameworks: [] }, binding = { runId: 'synthetic-run' }
    await assert.rejects(prepareFrameworkPreview(sandbox, binding, 3101, report), cause => cause.receiptCode === 'preview')
    assert.deepEqual(report.previewDiagnostic, { reply: 'unavailable', error: null, status: null, ...diagnostic, truncated: false })
    assert.equal(report.stage, 'next'); assert.equal(report.passed, false); assert.deepEqual(report.frameworks, [])
    assert.deepEqual(calls.map(row => row.operation), ['write', 'prepare', 'remove'])
    assert.deepEqual(calls[0].body, { operation: 'prepare', binding, port: 3101 })
    assert.deepEqual(calls[0].options, { user: 'root' })
    assert.deepEqual(calls[1].options, { user: 'root', timeoutMs: 25_000 })
    assert.deepEqual(calls[2].options, { user: 'root', timeoutMs: 5000 })
  }
})

test('untrusted prepare reply cannot preserve private strings or unbounded diagnostic values', async () => {
  const privateText = 'synthetic-private-path-url-pid-header-and-capability'
  const reply = { running: false, state: 'unavailable', code: 'no_loopback_server', pid: privateText, host: privateText,
    diagnostic: { candidateCount: true, vanishedFds: 4096 * 1024 + 1, processReadErrors: -1, budgetExpired: privateText,
      path: privateText, probes: Array.from({ length: 17 }, () => ({ outcome: privateText, elapsedMs: 25_001, error: privateText })) } }
  const { sandbox } = previewSandbox(reply), report = { passed: false }
  await assert.rejects(prepareFrameworkPreview(sandbox, {}, 3101, report), cause => cause.receiptCode === 'preview')
  const value = report.previewDiagnostic
  assert.deepEqual([value.candidateCount, value.vanishedFds, value.processReadErrors, value.budgetExpired], [null, null, null, null])
  assert.equal(value.probes.length, 16); assert.equal(value.truncated, true)
  assert.ok(value.probes.every(row => row.outcome === 'other' && row.elapsedMs === null))
  assert.equal(JSON.stringify(report).includes(privateText), false)
  for (const [field, maximum] of [['candidateCount', 16], ['vanishedFds', 4096 * 1024], ['processReadErrors', 4096], ['elapsedMs', 25_000]]) {
    for (const number of [0, maximum, maximum + 1, -1, true, '1', 1.5]) {
      const diagnostic = field === 'elapsedMs' ? { probes: [{ outcome: 'timeout', elapsedMs: number }] } : { [field]: number }
      const fixture = previewSandbox({ running: false, state: 'unavailable', code: 'no_loopback_server', diagnostic }), observed = {}
      await assert.rejects(prepareFrameworkPreview(fixture.sandbox, {}, 3101, observed), cause => cause.receiptCode === 'preview')
      const retained = field === 'elapsedMs' ? observed.previewDiagnostic.probes[0].elapsedMs : observed.previewDiagnostic[field]
      assert.equal(retained, number === 0 || number === maximum ? number : null)
    }
  }
})

test('prepare success, wrong port and control errors keep the same authority gate', async () => {
  const successful = { running: true, port: 3101, gatewayPort: 3102 }
  const report = { passed: false }, { sandbox } = previewSandbox(successful)
  assert.deepEqual(await prepareFrameworkPreview(sandbox, {}, 3101, report), successful)
  assert.equal(report.previewDiagnostic, undefined); assert.equal(report.passed, false)
  const privateText = 'synthetic-private-gateway-error'
  for (const [reply, classification, code, status] of [
    [{ running: true, port: 3102 }, 'port_mismatch', null, null],
    [{ running: 'true', port: 3101 }, 'invalid_reply', null, null],
    [{ error: 'server_stopped', status: 409 }, 'control_error', 'server_stopped', 409],
    [{ error: 'control_unavailable', status: 503 }, 'control_error', 'control_unavailable', 503],
    [{ error: privateText, status: true }, 'control_error', 'other', null],
  ]) {
    const state = previewSandbox(reply), observed = { passed: false }
    await assert.rejects(prepareFrameworkPreview(state.sandbox, {}, 3101, observed), cause => cause.receiptCode === 'preview')
    assert.deepEqual([observed.previewDiagnostic.reply, observed.previewDiagnostic.error, observed.previewDiagnostic.status], [classification, code, status])
    assert.equal(observed.passed, false); assert.equal(JSON.stringify(observed).includes(privateText), false)
  }
  const source = readFileSync(new URL('./workspace-ingress-acceptance.mjs', import.meta.url), 'utf8')
  assert.match(source, /const prepared = await prepareFrameworkPreview\(sandbox, binding, port, runtimeReport\)/)
  assert.match(source, /framework\(sandbox, kind, appRoot, identity, fetchImpl, Socket, report\)/)
})

test('prepare command and JSON failures keep their cause and cleanup without fabricating a reply diagnostic', async () => {
  const privateText = 'synthetic-private-sdk-message-and-output'
  const commandError = new CommandExitError({ exitCode: 1, stdout: privateText, stderr: privateText, error: privateText })
  for (const options of [{ commandError }, { output: privateText }, { output: 'x'.repeat(32_769) }]) {
    const { sandbox, calls } = previewSandbox(null, options), report = { passed: false }
    await assert.rejects(prepareFrameworkPreview(sandbox, {}, 3101, report), cause => {
      assert.equal(cause.receiptCode, 'process'); assert.ok(cause.cause)
      if (options.commandError) assert.equal(cause.cause, commandError)
      return true
    })
    assert.equal(report.previewDiagnostic, undefined); assert.equal(report.passed, false)
    assert.deepEqual(calls.map(row => row.operation), ['write', 'prepare', 'remove'])
    assert.equal(JSON.stringify(report).includes(privateText), false)
  }
})

async function localFrameworkStartup(t, { kind = 'next', status = 200,
  body = `<main>mikka-preview-${kind}-v1</main>`, held = false, disconnect = false, killError } = {}) {
  const { createServer } = await import('node:http')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execute = promisify(execFile), requested = Promise.withResolvers(), release = Promise.withResolvers()
  const stopped = Promise.withResolvers(), calls = []
  let requests = 0, kills = 0, headers, commandError
  const server = createServer(async (request, response) => {
    requests++; headers = request.headers
    if (disconnect) { request.socket.destroy(); requested.resolve(); return }
    response.writeHead(status, status === 302 ? { Location: '/must-not-follow' } : {})
    response.write('<html>'); response.flushHeaders(); requested.resolve()
    if (held) await release.promise
    response.end(body + '</html>')
  })
  let port
  do {
    await new Promise(accept => server.listen(0, '127.0.0.1', accept))
    port = server.address().port
    if ([49983, 50005].includes(port)) await new Promise(accept => server.close(accept))
  } while ([49983, 50005].includes(port))
  const close = async () => {
    release.resolve()
    if (server.listening) {
      server.closeAllConnections()
      await new Promise(accept => server.close(accept))
    }
    stopped.resolve()
  }
  t.after(close)
  const handle = { wait: () => stopped.promise, async kill() {
    kills++
    if (killError) throw killError
    await close()
  } }
  const sandbox = { commands: { async run(command, options) {
    calls.push({ command, options })
    assert.equal(options.user, 'user')
    if (options.background) {
      assert.equal(options.timeoutMs, 0)
      if (kind === 'next') assert.match(command, /dev --webpack --hostname 127\.0\.0\.1 --port \d+$/)
      else assert.match(command, /--host 127\.0\.0\.1 --port \d+ --strictPort$/)
      options.onStdout(kind === 'next' ? 'Ready in 1ms\n' : 'Local: http://127.0.0.1\n')
      return handle
    }
    const match = /^python3 - <<'MIKKA_FRAMEWORK_HTTP_READY'\n([\s\S]*)\nMIKKA_FRAMEWORK_HTTP_READY$/.exec(command)
    assert.ok(match)
    assert.ok(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 90_000)
    try {
      const result = await execute('python3', ['-c', match[1]], { timeout: options.timeoutMs, maxBuffer: 32_768 })
      return { exitCode: 0, stdout: result.stdout }
    } catch (cause) { commandError = cause; throw cause }
  } } }
  return { sandbox, port, handle, calls, requested: requested.promise, release: () => release.resolve(),
    stats: () => ({ requests, kills, listening: server.listening, headers, commandError }) }
}

test('framework startup waits for the complete real loopback document after the banner without a retry', async t => {
  const { startFrameworkServer } = await import('./workspace-ingress-acceptance.mjs')
  for (const kind of ['next', 'vite']) {
    const f = await localFrameworkStartup(t, { kind, held: true })
    let complete = false
    const pending = startFrameworkServer(f.sandbox, kind, `/synthetic/${kind}`, '/synthetic', f.port)
    void pending.then(() => { complete = true })
    await f.requested
    assert.equal(complete, false, 'a banner and response headers alone cannot complete startup')
    assert.equal(f.stats().requests, 1)
    f.release()
    const result = await pending
    assert.equal(result.handle, f.handle)
    assert.equal(result.value, true)
    assert.deepEqual([f.stats().requests, f.stats().kills, f.stats().listening], [1, 0, true])
    assert.equal(f.stats().headers.host, `localhost:${f.port}`)
    assert.equal(f.stats().headers['accept-encoding'], 'identity')
    await result.handle.kill()
    assert.equal(f.stats().listening, false)
  }
})

test('startup refuses wrong or oversized documents and redirects, and cleanup cannot replace the failure', async t => {
  const { startFrameworkServer } = await import('./workspace-ingress-acceptance.mjs')
  for (const options of [{ status: 503 }, { status: 302 }, { body: '<main>mikka-preview-next-v10</main>' },
    { body: 'x'.repeat(1_048_577) }, { body: 'wrong', killError: new Error('synthetic cleanup refusal') }]) {
    const f = await localFrameworkStartup(t, options)
    await assert.rejects(startFrameworkServer(f.sandbox, 'next', '/synthetic/next', '/synthetic', f.port),
      cause => cause.receiptCode === 'ready')
    assert.equal(f.stats().requests, 1)
    assert.equal(f.stats().kills, 1)
    assert.equal(f.stats().listening, Boolean(options.killError))
  }
})

test('an actual loopback HTTP disconnect retains its command cause and stops the startup handle', async t => {
  const { startFrameworkServer } = await import('./workspace-ingress-acceptance.mjs')
  const f = await localFrameworkStartup(t, { disconnect: true })
  await assert.rejects(startFrameworkServer(f.sandbox, 'next', '/synthetic/next', '/synthetic', f.port), cause => {
    assert.equal(cause.receiptCode, 'process')
    assert.equal(cause.cause, f.stats().commandError)
    assert.ok(cause.cause)
    return true
  })
  assert.deepEqual([f.stats().requests, f.stats().kills, f.stats().listening], [1, 1, false])
})

test('the original 90 second deadline includes SDK start and HTTP readiness and is never reset after the banner', async t => {
  const { startFrameworkServer } = await import('./workspace-ingress-acceptance.mjs')
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const started = Promise.withResolvers(), http = Promise.withResolvers(), exited = Promise.withResolvers()
  const calls = []
  let kills = 0
  const handle = { wait: () => exited.promise, async kill() { kills++; exited.resolve() } }
  const sandbox = { commands: { run(command, options) {
    calls.push({ command, options })
    return options.background ? started.promise : http.promise
  } } }
  const pending = startFrameworkServer(sandbox, 'next', '/synthetic/next', '/synthetic', 3199)
  const refused = assert.rejects(pending, cause => cause.receiptCode === 'ready')
  t.mock.timers.tick(70_000)
  calls[0].options.onStdout('Ready in 70000ms\n'); started.resolve(handle)
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].options.timeoutMs, 20_000)
  t.mock.timers.tick(20_000)
  await refused
  assert.equal(kills, 1)
  http.resolve({ exitCode: 0, stdout: JSON.stringify({ status: 200, markerMatched: true }) })
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(kills, 1)
})

test('a process handle delivered after startup expires is killed and never starts an HTTP probe', async t => {
  const { startFrameworkServer } = await import('./workspace-ingress-acceptance.mjs')
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const started = Promise.withResolvers()
  let calls = 0, kills = 0, waits = 0
  const handle = { wait() { waits++; return new Promise(() => {}) }, async kill() { kills++ } }
  const sandbox = { commands: { run() { calls++; return started.promise } } }
  const pending = startFrameworkServer(sandbox, 'next', '/synthetic/next', '/synthetic', 3199)
  const refused = assert.rejects(pending, cause => cause.receiptCode === 'ready')
  t.mock.timers.tick(90_000)
  await refused
  assert.deepEqual([calls, kills, waits], [1, 0, 0])
  started.resolve(handle)
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.deepEqual([calls, kills, waits], [1, 1, 0])
})

test('startup preserves command failure causes and cleans a process that exits before its banner', async () => {
  const { startFrameworkServer } = await import('./workspace-ingress-acceptance.mjs')
  const original = new Error('synthetic SDK failure')
  await assert.rejects(startFrameworkServer({ commands: { async run() { throw original } } },
    'next', '/synthetic/next', '/synthetic', 3199), cause => cause === original)
  let kills = 0, calls = 0
  const handle = { async wait() {}, async kill() { kills++ } }
  await assert.rejects(startFrameworkServer({ commands: { async run() { calls++; return handle } } },
    'next', '/synthetic/next', '/synthetic', 3199), cause => cause.receiptCode === 'ready')
  assert.deepEqual([calls, kills], [1, 1])
})
