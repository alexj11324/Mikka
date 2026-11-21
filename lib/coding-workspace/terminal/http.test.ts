import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { PoolClient } from 'pg'
import { TerminalError } from '@mikka/protocol/coding-terminal'
import { ReviewAuthorityError } from '../review-authority'
import { terminalFixture } from './test-fixture'

const unexpected = async () => { throw new Error('Unexpected real runtime call') }
mock.module('../review-sessions', { namedExports: { beginReviewSession: unexpected, readReviewSession: unexpected,
  closeReviewSession: unexpected, revokeReviewSession: unexpected } })
mock.module('../review-machine', { namedExports: { resumeReviewMachine: unexpected } })
mock.module('./runtime', { namedExports: { prepareTerminal: unexpected, existingTerminal: unexpected, terminalRequest: unexpected } })
const { reviewTerminalHandlers, relayTerminal } = await import('./http')
type Dependencies = NonNullable<Parameters<typeof reviewTerminalHandlers>[0]>
const encoder = new TextEncoder()
const output = 'event: output\ndata: {"text":"pwd\\r\\n"}\n\nevent: ended\ndata: {"exitCode":7}\n\n'

function fixture() {
  const f = terminalFixture(), events: string[] = [], controls: { operation: string; body: string }[] = []
  const client = {} as PoolClient
  let inside = false
  const deps: Dependencies = {
    authority: async () => { events.push('authority'); return f.scope },
    authorized: async (_request, _task, work, expected) => {
      if (expected) assert.deepEqual(expected, { runId: f.scope.runId, bindingId: f.scope.bindingId })
      events.push('transaction'); inside = true
      try { const value = await work(f.scope, client); events.push('commit'); return value }
      finally { inside = false }
    },
    begin: async (_scope, options, database) => { assert.equal(inside, true); assert.equal(database, client); assert.equal(options.kind, 'terminal'); events.push('begin'); return f.lease },
    read: async (_scope, options, database) => { assert.equal(inside, true); assert.equal(database, client); assert.equal(options.kind, 'terminal'); events.push('read'); return f.lease },
    close: async () => { events.push('closed') },
    revoke: async () => { events.push('revoked'); return { closed: 1, pending: 0 } },
    resume: async () => { assert.equal(inside, false); events.push('resume') },
    prepare: async () => { assert.equal(inside, false); events.push('prepare'); return f.prepared },
    existing: async () => { assert.equal(inside, false); events.push('existing'); return f.prepared },
    grant: (_prepared, scope, lease, operation, body) => {
      assert.equal(inside, true); assert.equal(scope, f.scope); assert.equal(lease.id, f.lease.id)
      events.push('grant'); controls.push({ operation, body: body ?? '' }); return 'synthetic-one-use-ticket'
    },
    request: async (_prepared, operation, ticket) => {
      assert.equal(inside, false); assert.equal(ticket, 'synthetic-one-use-ticket'); events.push('request')
      return operation === 'stream' ? new Response(output, { headers: { 'content-type': 'text/event-stream' } }) : new Response(null, { status: 204 })
    },
  }
  const request = (method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new Request(
    `https://mikka.example.test/api/tasks/${f.scope.taskId}/review/terminal`,
    { method, headers: { accept: 'text/event-stream', origin: 'https://mikka.example.test', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { ...f, deps, events, controls, request }
}

test('the exact frontend GET delivers SSE only after resume, prepare and final committed grant', async () => {
  const f = fixture(), api = reviewTerminalHandlers(f.deps)
  const response = await api.stream(f.request(), f.scope.taskId)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-terminal-session-id'), f.lease.id)
  assert.deepEqual(f.events, ['authority', 'transaction', 'begin', 'commit', 'resume', 'authority', 'prepare', 'transaction', 'read', 'grant', 'commit', 'request'])
  assert.equal(await response.text(), output)
  assert.equal(f.events.at(-1), 'closed')
})

test('owner, reclaimed, unsupported and active-Agent states preserve the documented status contract', async () => {
  for (const [code, status] of [['not_owner_terminal', 403], ['review_machine_gone', 409], ['review_not_found', 404]] as const) {
    const f = fixture(); f.deps.authority = async () => { throw new ReviewAuthorityError(code) }
    const response = await reviewTerminalHandlers(f.deps).stream(f.request(), f.scope.taskId)
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { error: code })
    assert.deepEqual(f.events, [])
  }
  for (const [scope, status] of [[{ machineKind: 'local' as const }, 404], [{ nativeExitedProof: false }, 423]] as const) {
    const f = fixture(); Object.assign(f.scope, scope)
    const response = await reviewTerminalHandlers(f.deps).stream(f.request(), f.scope.taskId)
    assert.equal(response.status, status)
    assert.deepEqual(f.events, ['authority'])
  }
})

test('POST data is forwarded once under an existing lease and cannot create or resume a PTY', async () => {
  const f = fixture(), response = await reviewTerminalHandlers(f.deps).input(f.request('POST', { data: '\x03' }), f.scope.taskId)
  assert.equal(response.status, 204)
  assert.equal(await response.text(), '')
  const forwarded = JSON.parse(f.controls[0]!.body)
  assert.equal(forwarded.data, '\x03')
  assert.equal(forwarded.requestId, response.headers.get('x-terminal-request-id'))
  assert.deepEqual(f.events, ['authority', 'existing', 'transaction', 'read', 'grant', 'commit', 'request'])
  f.deps.read = async () => null
  const ended = await reviewTerminalHandlers(f.deps).input(f.request('POST', { data: 'pwd\n' }), f.scope.taskId)
  assert.equal(ended.status, 409)
  assert.equal(f.controls.length, 1)
})

test('an old VM missing ingress capability returns 404 even when durable cleanup stays pending', async () => {
  const f = fixture()
  f.deps.prepare = async () => { f.events.push('prepare'); throw new TerminalError('terminal_unsupported', { detail: 'runtime_version' }) }
  f.deps.revoke = async () => { f.events.push('revoked'); return { closed: 0, pending: 1 } }
  const response = await reviewTerminalHandlers(f.deps).stream(f.request(), f.scope.taskId)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'terminal_unsupported', detail: 'runtime_version' })
  assert.equal(f.events.at(-1), 'revoked')
  assert.equal(f.events.includes('grant'), false)
  assert.equal(f.events.includes('request'), false)
})

test('same-origin, UTF-8 and closed-payload guards reject before any authority or remote call', async () => {
  const f = fixture(), api = reviewTerminalHandlers(f.deps)
  for (const [body, status] of [[{ data: '界'.repeat(5462) }, 413], [{ data: 'pwd\n', sandboxId: 'other' }, 400], [{ data: 1 }, 400]] as const)
    assert.equal((await api.input(f.request('POST', body), f.scope.taskId)).status, status)
  assert.equal((await api.input(f.request('POST', { data: 'pwd\n' }, { origin: 'https://attacker.invalid' }), f.scope.taskId)).status, 403)
  assert.equal((await api.stream(f.request('GET', undefined, { 'sec-fetch-mode': 'navigate' }), f.scope.taskId)).status, 403)
  assert.deepEqual(f.events, [])
})

test('a revoke winning the final authority check prevents open and durably closes the acquired lease', async () => {
  const f = fixture(), authorized = f.deps.authorized
  let transactions = 0
  f.deps.authorized = async (...args) => {
    if (++transactions === 2) throw new ReviewAuthorityError('review_binding_changed')
    return authorized(...args)
  }
  const response = await reviewTerminalHandlers(f.deps).stream(f.request(), f.scope.taskId)
  assert.equal(response.status, 409)
  assert.equal(f.events.at(-1), 'revoked')
  assert.equal(f.events.includes('request'), false)
  assert.equal(f.events.includes('closed'), false)
})

test('uncertain stream opens are durably revoked; explicit close reports pending cleanup without claiming success', async () => {
  const f = fixture()
  f.deps.request = async () => { throw new TerminalError('terminal_unavailable', { detail: 'runtime' }) }
  const failed = await reviewTerminalHandlers(f.deps).stream(f.request(), f.scope.taskId)
  assert.equal(failed.status, 503)
  assert.equal(f.events.at(-1), 'revoked')
  f.events.length = 0
  f.deps.revoke = async () => { f.events.push('revoked'); return { closed: 0, pending: 1 } }
  assert.equal((await reviewTerminalHandlers(f.deps).close(f.request('DELETE'), f.scope.taskId)).status, 503)
  assert.deepEqual(f.events, ['transaction', 'read', 'commit', 'revoked'])
  f.deps.revoke = async () => ({ closed: 1, pending: 0 })
  assert.equal((await reviewTerminalHandlers(f.deps).close(f.request('DELETE'), f.scope.taskId)).status, 204)
})

test('SSE detach and escaped user text cannot falsely acknowledge process cleanup', async () => {
  let closed = 0, cancelled = false
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode('event: output\ndata: {"text":"event: ended\\n"}\n\n')) },
    cancel() { cancelled = true },
  }))
  const abort = new AbortController(), relayed = relayTerminal(upstream, async () => { closed++ }, abort)
  const reader = relayed.getReader()
  await reader.read(); await reader.cancel(); reader.releaseLock()
  assert.equal(cancelled, true); assert.equal(abort.signal.aborted, true); assert.equal(closed, 0)
  const text = new Response(relayTerminal(new Response('event: output\ndata: {"text":"event: ended\\n"}\n\n'), async () => { closed++ }, new AbortController()))
  await text.text()
  assert.equal(closed, 0)
})
