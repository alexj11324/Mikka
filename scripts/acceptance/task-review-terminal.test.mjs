import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalAcceptanceFailure, verifyExistingTaskTerminal, verifyTerminalRefusal } from './task-review-terminal.mjs'

const id = digit => `00000000-0000-4000-8000-${String(digit).padStart(12, '0')}`
const ownerId = 'synthetic-smoke-owner', privateText = 'PRIVATE_COOKIE_OR_NATIVE_OUTPUT_DO_NOT_REPORT'
const taskId = id(1), runId = id(2), workspaceId = id(3), sessionId = id(4), expectedBuild = 'c'.repeat(40)
const options = { ownerId, taskId, runId, workspaceId, expectedBuild, timeoutMs: 1000 }
const frame = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`

function fixture({ state = 'succeeded', runWorkspace = workspaceId, requester = ownerId, sessionRun = runId, output = privateText, closeStatus = 204 } = {}) {
  const requests = []
  const client = {
    async json(path) {
      if (path === '/api/version') return { build: expectedBuild }
      if (path === '/api/auth/get-session') return { user: { id: ownerId, email: 'fixture+mikka-smoke@example.invalid' } }
      if (path === '/api/workspace') return { currentUserId: ownerId, workspace: { id: workspaceId } }
      assert.equal(path, `/api/runs/${runId}/evidence`)
      return { run: { id: runId, issueId: taskId, status: state, executionIdentity: {
        requester, executionPrincipal: ownerId, workspaceId: runWorkspace, billingAccount: { runtime: { kind: 'e2b' } },
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
