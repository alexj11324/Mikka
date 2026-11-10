import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { probeWorkspaceTerminal } from './workspace-terminal-acceptance.mjs'

const sourceCommit = 'c'.repeat(40), fixtureId = 'owned-terminal-fixture'
const hash = value => createHash('sha256').update(value).digest('hex')
const cleanup = { leaseRevoked: true, ptyStopped: true, gatewayStopped: true, receiptRestored: true, filesRemoved: true }

// This is the driver's transport contract test. The Python PTY suite and the
// caller's exact-source private E2B acceptance supply the real runtime evidence.
function fixture(options = {}) {
  const observations = { commands: [], files: [], nonces: new Set(), requests: [] }
  let key, gatewayVersion, output, scope, stop
  const completed = new Promise(resolve => { stop = resolve })
  const sandbox = {
    getInfo: async () => ({ state: 'running', metadata: { application: 'mikka-workspace-ingress-acceptance',
      sourceCommit: options.foreign ? 'd'.repeat(40) : sourceCommit, fixtureId } }),
    getHost: port => `${port}-isolated-fixture.e2b.app`,
    files: { write: async entries => {
      observations.files.push(...entries)
      key = Buffer.from(entries.find(entry => entry.path.endsWith('/key')).data)
      gatewayVersion = hash(entries.find(entry => entry.path.endsWith('/gateway.py')).data)
    } },
    commands: { run: async (command, args) => {
      observations.commands.push(command)
      assert.equal(args.user, 'root')
      if (command.includes('# workspace-terminal-prepare')) return { exitCode: 0, stdout: JSON.stringify({ prepared: !options.prepareFailure }) }
      if (command.includes('# workspace-terminal-cleanup')) { stop(); return { exitCode: 0, stdout: JSON.stringify(options.cleanup ?? cleanup) } }
      if (args.background) {
        queueMicrotask(() => args.onStdout('terminal-ready\n'))
        return { pid: 54321, wait: () => options.stuckWait ? new Promise(() => {}) : completed,
          kill: async () => { stop(); return true }, disconnect: async () => stop() }
      }
      return { exitCode: 0, stdout: '' }
    } },
  }
  const frame = (event, data) => output.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
  const boot = '77777777-7777-4777-8777-777777777777'
  const fetchImpl = async (url, args) => {
    const path = new URL(url).pathname
    observations.requests.push(path)
    assert.equal(args.redirect, 'error')
    assert.equal(args.cache, 'no-store')
    if (path === '/health') {
      const challenge = new URL(url).searchParams.get('challenge')
      return Response.json({ version: gatewayVersion, boot,
        proof: createHmac('sha256', key).update(`health:v1:${challenge}:${boot}:${gatewayVersion}`).digest('hex') })
    }
    const authorization = args.headers?.authorization
    if (!authorization) return Response.json({ error: 'terminal_ticket_invalid' }, { status: 401 })
    const [encoded, signature] = authorization.slice(7).split('.')
    assert.equal(signature, createHmac('sha256', key).update(encoded).digest('base64url'))
    const grant = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    assert.equal(grant.operation, path.slice(1))
    assert.equal(grant.boot, boot)
    assert.equal(grant.bodyDigest, hash(args.body ?? ''))
    assert.ok(!observations.nonces.has(grant.nonce)); observations.nonces.add(grant.nonce)
    assert.ok(grant.expiresAt > Date.now() && grant.expiresAt <= Date.now() + 30_000)
    if (path === '/stream') {
      scope = grant
      return new Response(new ReadableStream({ start(controller) {
        output = controller
        frame('output', { text: '' })
        frame('session', { terminalSessionId: options.wrongSession ? boot : scope.sessionId,
          runId: scope.runId, ownerId: scope.ownerId, rights: ['read', 'write', 'resize', 'close'],
          machineStatus: 'running', expiresAt: scope.sessionExpiresAt })
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    assert.equal(grant.sessionId, scope.sessionId)
    assert.equal(grant.sessionExpiresAt, scope.sessionExpiresAt)
    if (path === '/resize') { assert.deepEqual(JSON.parse(args.body), { cols: 111, rows: 37 }); return new Response(null, { status: 204 }) }
    assert.equal(path, '/input')
    if (options.inputFailure) throw new Error(`Bearer PRIVATE_SECRET ${url} ${args.body}`)
    const input = JSON.parse(args.body)
    assert.match(input.requestId, /^[a-f0-9-]{36}$/)
    if (input.data.includes('__TERMINAL_READY__')) frame('output', { text: '\r\n__TERMINAL_READY__\r\n' })
    else if (input.data.includes('__TERMINAL_STDOUT__')) frame('output', { text: '\r\n__TERMINAL_STDOUT__\r\n' })
    else if (input.data.includes('stty size')) frame('output', { text: '\r\n37 111\r\n__TERMINAL_SIZE__\r\n' })
    else if (input.data.includes('read -r answer')) frame('output', { text: '\r\n__TERMINAL_READ__\r\n' })
    else if (input.data === 'fixture-input\n') frame('output', { text: '\r\n__TERMINAL_STDIN__\r\n' })
    else if (input.data === 'exit 7\n') { frame('ended', { exitCode: 7 }); output.close() }
    else { assert.equal(input.data, ''); return Response.json({ error: 'terminal_ended' }, { status: 409 }) }
    return new Response(null, { status: 204 })
  }
  return { sandbox, fetchImpl, observations }
}

test('refuses a foreign VM before any command, file write or request', async () => {
  const fake = fixture({ foreign: true })
  const report = await probeWorkspaceTerminal(fake.sandbox, { sourceCommit, fixtureId, fetchImpl: fake.fetchImpl })
  assert.equal(report.passed, false)
  assert.equal(report.failure, 'terminal_probe_metadata')
  assert.deepEqual(fake.observations.commands, [])
  assert.deepEqual(fake.observations.files, [])
  assert.deepEqual(fake.observations.requests, [])
})

test('does not install a gateway after the fixed-inode prerequisite refuses', async () => {
  const fake = fixture({ prepareFailure: true })
  const report = await probeWorkspaceTerminal(fake.sandbox, { sourceCommit, fixtureId, fetchImpl: fake.fetchImpl })
  assert.equal(report.failure, 'terminal_probe_prepare')
  assert.deepEqual(fake.observations.files, [])
  assert.ok(fake.observations.commands.at(-1).includes('# workspace-terminal-cleanup'))
})

test('verifies ticket/body binding, actual SSE frames and all cleanup acknowledgements', async () => {
  const fake = fixture()
  const report = await probeWorkspaceTerminal(fake.sandbox, { sourceCommit, fixtureId, fetchImpl: fake.fetchImpl })
  assert.equal(report.passed, true)
  assert.equal(report.failure, null)
  assert.deepEqual(report.cleanup, cleanup)
  assert.equal(report.exitCode, 7)
  assert.deepEqual(report.statuses, { unauthorizedStream: 401, unauthorizedInput: 401, stream: 200, resize: 204, postExit: 409 })
  assert.ok(['stdout', 'stdin', 'resize', 'exit', 'postExitRefused'].every(name => report.checks[name]))
  const serialized = JSON.stringify(report)
  for (const forbidden of ['Bearer', 'e2b.app', '__TERMINAL', 'fixture-input']) assert.ok(!serialized.includes(forbidden))
  for (const command of fake.observations.commands.filter(value => value.startsWith('python3 -I -c '))) {
    // Decode the exact shell argument then parse all root scripts, without
    // executing root operations or substituting a different gateway entrypoint.
    const source = execFileSync('python3', ['-c', 'import shlex,sys; print(shlex.split(sys.argv[1])[-1])', command], { encoding: 'utf8' })
    execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source })
  }
})

test('rejects a session bound to another lease and still closes its own process', async () => {
  const fake = fixture({ wrongSession: true })
  const report = await probeWorkspaceTerminal(fake.sandbox, { sourceCommit, fixtureId, fetchImpl: fake.fetchImpl })
  assert.equal(report.passed, false)
  assert.equal(report.failure, 'terminal_probe_protocol')
  assert.deepEqual(report.cleanup, cleanup)
})

test('keeps SDK/HTTP URLs, tickets and input content out of failures and performs cleanup', async () => {
  const fake = fixture({ inputFailure: true })
  const report = await probeWorkspaceTerminal(fake.sandbox, { sourceCommit, fixtureId, fetchImpl: fake.fetchImpl })
  assert.equal(report.passed, false)
  assert.equal(report.failure, 'terminal_probe_transport')
  assert.deepEqual(report.cleanup, cleanup)
  const serialized = JSON.stringify(report)
  for (const forbidden of ['PRIVATE_SECRET', 'Bearer', 'e2b.app', '__TERMINAL', 'stty']) assert.ok(!serialized.includes(forbidden))
})

test('a missing PTY cleanup acknowledgement cannot be reported as a pass', async () => {
  const fake = fixture({ cleanup: { ...cleanup, ptyStopped: false } })
  const report = await probeWorkspaceTerminal(fake.sandbox, { sourceCommit, fixtureId, fetchImpl: fake.fetchImpl })
  assert.equal(report.passed, false)
  assert.equal(report.failure, 'terminal_probe_cleanup')
  assert.equal(report.cleanup.ptyStopped, false)
})

test('an SDK event iterator cannot stall return after root confirmed cleanup', { timeout: 5_000 }, async () => {
  const fake = fixture({ stuckWait: true })
  const report = await probeWorkspaceTerminal(fake.sandbox, { sourceCommit, fixtureId, fetchImpl: fake.fetchImpl })
  assert.equal(report.passed, true)
  assert.deepEqual(report.cleanup, cleanup)
})
