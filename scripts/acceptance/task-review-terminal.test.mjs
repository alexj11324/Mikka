import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalAcceptanceFailure, verifyExistingTaskTerminal, verifyTerminalRefusal, withPreviewTerminal } from './task-review-terminal.mjs'

const id = digit => `00000000-0000-4000-8000-${String(digit).padStart(12, '0')}`
const ownerId = 'synthetic-smoke-owner', privateText = 'PRIVATE_COOKIE_OR_NATIVE_OUTPUT_DO_NOT_REPORT'
const taskId = id(1), runId = id(2), workspaceId = id(3), sessionId = id(4), expectedBuild = 'c'.repeat(40)
const options = { ownerId, taskId, runId, workspaceId, expectedBuild, timeoutMs: 1000 }
const frame = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`

function fixture({ identityRuntime = {kind: 'e2b'}, resourceBindings, build = expectedBuild, state = 'succeeded', runWorkspace = workspaceId, requester = ownerId, sessionRun = runId, output = privateText, closeStatus = 204 } = {}) {
  const requests = []
  const client = {
    async json(path) {
      if (path === '/api/version') return { build }
      if (path === '/api/auth/get-session') return { user: { id: ownerId, email: 'fixture+mikka-smoke@example.invalid' } }
      if (path === '/api/workspace') return { currentUserId: ownerId, workspace: { id: workspaceId } }
      assert.equal(path, `/api/runs/${runId}/evidence`)
      return { run: { id: runId, issueId: taskId, status: state, executionIdentity: {
        requester, executionPrincipal: ownerId, workspaceId: runWorkspace, billingAccount: { runtime: identityRuntime }, resourceBindings,
      } } }
    },
    async request(path, init = {}) {
      requests.push({ path, method: init.method ?? 'GET', body: init.body })
      if (init.method === 'DELETE') return new Response(closeStatus === 204 ? null : privateText, { status: closeStatus })
      if (init.method === 'POST') {
        const { requestId } = JSON.parse(init.body)
        return new Response(null, { status: 204, headers: { 'x-terminal-request-id': requestId } })
      }
      const body = frame('output', { text: '' }) + frame('session', { terminalSessionId: sessionId,
        runId: sessionRun, ownerId, expiresAt: Date.now() + 60000 }) + frame('output', { text: output })
      // Deliberate arbitrary chunk boundaries exercise the actual SSE reader.
      const stream = new ReadableStream({ start(controller) {
        for (const part of [body.slice(0, 9), body.slice(9, 17), body.slice(17)]) controller.enqueue(new TextEncoder().encode(part))
        controller.close()
      } })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-terminal-session-id': sessionId } })
    },
  }
  return { client, requests }
}

test('refuses active/stopped, cross-workspace and another requester before opening a terminal', async () => {
  for (const change of [{ state: 'running' }, { state: 'stopped' }, { state: 'cancelled' }, { runWorkspace: id(8) }, { requester: 'other' }]) {
    const { client, requests } = fixture(change)
    const report = await verifyExistingTaskTerminal({ ...options, client })
    assert.equal(report.status, 'failed')
    assert.deepEqual(report.failure, { phase: 'run', code: 'terminal_acceptance_run' })
    assert.deepEqual(requests, [])
  }
})

test('exact build and shared smoke identity are required without choosing another fixture', async () => {
  for (const field of ['build', 'email']) {
    const { client, requests } = fixture(), original = client.json
    client.json = async path => {
      if (field === 'build' && path === '/api/version') return { build: 'd'.repeat(40) }
      if (field === 'email' && path === '/api/auth/get-session') return { user: { id: ownerId, email: 'not-authorized@example.invalid' } }
      return original(path)
    }
    const report = await verifyExistingTaskTerminal({ ...options, client })
    assert.equal(report.status, 'failed'); assert.deepEqual(requests, [])
    assert.equal(JSON.stringify(report).includes('not-authorized@example.invalid'), false)
  }
})

test('a mismatched session run receives no commands and cleanup remains explicit', async () => {
  const { client, requests } = fixture({ sessionRun: id(9) })
  const report = await verifyExistingTaskTerminal({ ...options, client })
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'terminal_acceptance_session')
  assert.deepEqual(requests.map(row => row.method), ['GET', 'DELETE'])
  assert.equal(report.cleanup.status, 'closed')
  assert.equal(JSON.stringify(report).includes(privateText), false)
  assert.equal(JSON.stringify(report).includes(ownerId), false)
})

test('204 input and arbitrary stdout cannot substitute for actual command receipts', async () => {
  const { client, requests } = fixture()
  const report = await verifyExistingTaskTerminal({ ...options, client })
  assert.equal(report.status, 'failed')
  assert.equal(report.failure.code, 'terminal_acceptance_closed')
  assert.equal(report.checks.runWorktreeAndShellTest, undefined)
  assert.equal(report.cleanup.status, 'closed')
  assert.equal(requests.filter(row => row.method === 'POST').length, 1)
  assert.equal(JSON.stringify(report).includes(privateText), false)
})

test('cleanup failure is reported as unconfirmed with no raw response or exception', async () => {
  const { client } = fixture({ sessionRun: id(9), closeStatus: 503 })
  const report = await verifyExistingTaskTerminal({ ...options, client })
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.cleanup, { status: 'unconfirmed', code: 'terminal_acceptance_cleanup' })
  assert.equal(JSON.stringify(report).includes(privateText), false)
  assert.deepEqual(terminalAcceptanceFailure(new Error(privateText)), { code: 'terminal_acceptance_failed' })
})

test('negative evidence only accepts the exact status and a closed response code', async () => {
  const requests = []
  const client = { async request(path, init) {
    requests.push({ path, init })
    return Response.json({ error: 'not_owner_terminal', arbitrary: privateText }, { status: 403 })
  } }
  const proof = await verifyTerminalRefusal({ client, taskId, method: 'POST', status: 403, codes: ['not_owner_terminal'] })
  assert.deepEqual(proof, { method: 'POST', path: `/api/tasks/${taskId}/review/terminal/input`, status: 403, error: 'not_owner_terminal' })
  assert.deepEqual(JSON.parse(requests[0].init.body), { data: '' })
  assert.equal(JSON.stringify(proof).includes(privateText), false)
  for (const response of [Response.json({ error: 'not_owner_terminal' }, { status: 404 }),
    Response.json({ error: privateText }, { status: 403 })]) {
    await assert.rejects(verifyTerminalRefusal({ client: { request: async () => response }, taskId, status: 403,
      codes: ['not_owner_terminal'] }), { message: 'terminal_acceptance_response' })
  }
})

function previewFixture({ exitCode = 0, closeStatus = 204, errorCode = 'review_machine_gone', machineState = 'ended', runState = 'succeeded', ...authority } = {}) {
  const base = fixture({ state: runState, ...authority }), requests = [], encoder = new TextEncoder()
  let controller, endedReadbacks = 0
  const client = { ...base.client,
    async request(path, init = {}) {
      requests.push({ path, method: init.method ?? 'GET', body: init.body })
      if (init.method === 'DELETE') return closeStatus === 204 ? new Response(null, { status: 204 })
        : Response.json({ error: errorCode, raw: privateText }, { status: closeStatus })
      if (init.method === 'POST') {
        const { data, requestId } = JSON.parse(init.body)
        const marker = /MIKKA_PREVIEW_COMMAND_[a-f0-9]+/.exec(data)?.[0]
        if (marker) controller.enqueue(encoder.encode(frame('output', { text: `${privateText}\n${marker}:${exitCode}\r\n` })))
        return new Response(null, { status: 204, headers: { 'x-terminal-request-id': requestId } })
      }
      return new Response(new ReadableStream({ start(value) {
        controller = value
        value.enqueue(encoder.encode(frame('output', { text: '' }) + frame('session', { terminalSessionId: sessionId,
          runId, ownerId, expiresAt: Date.now() + 60000 })))
      } }), { headers: { 'content-type': 'text/event-stream', 'x-terminal-session-id': sessionId } })
    },
    async rpc(action, args) {
      endedReadbacks++; assert.equal(action, 'agents.getThreadMachine'); assert.deepEqual(args, [taskId, runId])
      return { kind: 'cloud', state: machineState, cloud: null }
    },
  }
  return { client, requests, readbacks: () => endedReadbacks }
}

test('the second PTY uses normal authenticated input with unique IDs and keeps all command output private', async () => {
  const f = previewFixture()
  const report = await withPreviewTerminal({ ...options, client: f.client }, async control => {
    assert.ok(Object.isFrozen(control)); assert.ok(control.remaining() > 0 && control.remaining() <= 60000)
    assert.deepEqual(await control.run('test -d .'), { exitCode: 0 })
    assert.deepEqual(await control.run('true'), { exitCode: 0 })
    return { completed: true }
  })
  assert.equal(report.status, 'passed'); assert.equal(report.cleanup.status, 'closed')
  assert.equal(JSON.stringify(report).includes(privateText), false)
  const inputs = f.requests.filter(request => request.method === 'POST').map(request => JSON.parse(request.body))
  assert.equal(inputs.length, 3); assert.equal(new Set(inputs.map(value => value.requestId)).size, 3)
  assert.ok(f.requests.every(request => request.path.startsWith(`/api/tasks/${taskId}/review/terminal`)))
})

test('nonzero native exit is failure and an active/stopped run cannot open the second PTY', async () => {
  const failing = previewFixture({ exitCode: 7 })
  const result = await withPreviewTerminal({ ...options, client: failing.client }, control => control.run('false'))
  assert.equal(result.status, 'failed'); assert.equal(result.failure.code, 'terminal_acceptance_command')
  assert.equal(result.cleanup.status, 'closed')
  for (const runState of ['running', 'stopped', 'cancelled', 'failed']) {
    const f = previewFixture({ runState })
    const refused = await withPreviewTerminal({ ...options, client: f.client }, () => assert.fail('must not open'))
    assert.equal(refused.status, 'failed'); assert.deepEqual(f.requests, [])
  }
})

test('409 cleanup requires the exact reclaimed code and an ended machine with cleared resources', async () => {
  const good = previewFixture({ closeStatus: 409 })
  const result = await withPreviewTerminal({ ...options, client: good.client }, async () => ({ completed: true }))
  assert.equal(result.status, 'passed'); assert.deepEqual(result.cleanup, { status: 'machine_ended', httpStatus: 409, endReadback: true })
  assert.equal(good.readbacks(), 1)
  for (const change of [{ closeStatus: 409, errorCode: 'terminal_ended' }, { closeStatus: 409, machineState: 'paused' }, { closeStatus: 500 }]) {
    const f = previewFixture(change)
    const failed = await withPreviewTerminal({ ...options, client: f.client }, async () => ({ completed: true }))
    assert.equal(failed.status, 'failed'); assert.equal(failed.cleanup.status, 'unconfirmed')
    assert.equal(JSON.stringify(failed).includes(privateText), false)
  }
})

test('the sponsored PTY requires the reviewed workspace to own the frozen hosted grant', async () => {
  const build = 'CF-1'
  const identityRuntime = {kind:'cloudflare_sponsored', ownerId:'mikka-hosted', resourceId:workspaceId}
  const resource = {kind:'cloudflare_sponsored', ownerId:'mikka-hosted', access:'workspace_share', id:workspaceId, workspaceId}
  for (const [changes, passed] of [
    [{}, true], [{identityRuntime:{kind:'e2b'}}, false], [{resourceBindings:[{...resource, workspaceId:id(999)}]}, false],
    [{resourceBindings:[resource,{kind:'e2b'}]}, false], [{identityRuntime:{...identityRuntime,ownerId}}, false],
  ]) {
    const f = previewFixture({build, identityRuntime, resourceBindings:[resource], ...changes})
    const result = await withPreviewTerminal({...options, expectedBuild:build, taskProvider:'cloudflare', client:f.client}, c => c.run('true'))
    assert.equal(result.status, passed ? 'passed' : 'failed')
    if (!passed) assert.equal(f.requests.length, 0)
  }
})
