import assert from 'node:assert/strict'
import test from 'node:test'
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'
import { waitForReply, type ReplyWaitCompletion } from '../../../lib/mcp/reply-wait'
import { requestOwnedMcpTools } from '../../../lib/mcp/tool-lifetime'
import { after } from '../compat/server'
import { createApiHandler } from './application'

function fixture() {
  const firstRead = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<ReplyWaitCompletion>()
  const controller = new AbortController()
  const lifetimes: Promise<unknown>[] = []
  let reads = 0, closes = 0
  const handler = createMcpHandler(instance => {
    const server = requestOwnedMcpTools(instance, after)
    server.registerTool('read_coordinator_messages', { inputSchema: z.object({}) }, async (_input, context) => {
      const value = await waitForReply(async final => {
        reads++; firstRead.resolve()
        return final ? { done: true, value: 'fixture' } : { done: false }
      }, {
        deadline: Date.now() + 90_000,
        signal: context.mcpReq.signal,
        subscribe: () => ({ lost: false, close: () => { closes++ } }),
        onComplete: completed.resolve,
      })
      return { content: [{ type: 'text', text: value }] }
    })
  }, { serverInfo: { name: 'cancellation-fixture', version: '1' } })
  const app = createApiHandler([{ path: '/mikka/api/mcp', template: '/api/mcp', source: 'fixture', methods: ['POST'],
    load: async () => ({ POST: handler }) }])
  const request = Object.assign(new Request('https://example.test/mikka/api/mcp', {
    method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_coordinator_messages', arguments: {} } }),
  }), { waitUntil: (pending: Promise<unknown>) => { lifetimes.push(pending) } })
  return { app, request, controller, firstRead: firstRead.promise, completed: completed.promise, lifetimes,
    counts: () => ({ reads, closes }) }
}

for (const boundary of ['request abort', 'response cancel'] as const) {
  test(`actual MCP SDK ${boundary} closes the healthy observer without a deadline read`, { timeout: 3_000 }, async () => {
    const f = fixture()
    const response = await f.app.fetch(f.request)
    try {
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
      await f.firstRead
      assert.deepEqual(f.counts(), { reads: 1, closes: 0 })
      if (boundary === 'request abort') f.controller.abort()
      else await response.body!.cancel()
      const completion = await f.completed
      assert.equal(completion.outcome, 'aborted')
      assert.equal(completion.aborted, true)
      assert.equal(completion.observerClosed, true)
      assert.equal(completion.observerKind, 'transactional')
      assert.equal(completion.finalReadCalls, 0)
      assert.equal(completion.fallbackWakes, 0)
      assert.deepEqual(f.counts(), { reads: 1, closes: 1 })
    } finally {
      f.controller.abort()
      await response.body?.cancel().catch(() => {})
      await Promise.all(f.lifetimes)
    }
  })
}

test('actual MCP quiet wait keeps the full 90 second deadline and exactly two reads', { timeout: 3_000 }, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 })
  const f = fixture()
  const response = await f.app.fetch(f.request)
  try {
    await f.firstRead
    t.mock.timers.tick(89_999)
    await Promise.resolve()
    assert.deepEqual(f.counts(), { reads: 1, closes: 0 })
    t.mock.timers.tick(1)
    const completion = await f.completed
    assert.equal(completion.outcome, 'deadline')
    assert.equal(completion.aborted, false)
    assert.equal(completion.durationMs, 90_000)
    assert.equal(completion.finalReadCalls, 1)
    assert.equal(completion.fallbackWakes, 0)
    assert.deepEqual(f.counts(), { reads: 2, closes: 1 })
    const text = await response.text()
    assert.match(text, /fixture/)
  } finally {
    f.controller.abort()
    if (!response.bodyUsed) await response.body?.cancel().catch(() => {})
    await Promise.all(f.lifetimes)
  }
})

test('an already-running MCP write remains in waitUntil until its existing callback settles', { timeout: 3_000 }, async () => {
  const entered = Promise.withResolvers<void>(), finishWrite = Promise.withResolvers<void>()
  const lifetimes: Promise<unknown>[] = []
  let writeFinished = false
  const handler = createMcpHandler(instance => {
    const server = requestOwnedMcpTools(instance, after)
    server.registerTool('fixture_write', { inputSchema: z.object({}) }, async () => {
      entered.resolve()
      await finishWrite.promise
      writeFinished = true
      return { content: [{ type: 'text', text: 'fixture' }] }
    })
  })
  const app = createApiHandler([{ path: '/mikka/api/mcp', template: '/api/mcp', source: 'fixture', methods: ['POST'],
    load: async () => ({ POST: handler }) }])
  const request = Object.assign(new Request('https://example.test/mikka/api/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_write', arguments: {} } }),
  }), { waitUntil: (pending: Promise<unknown>) => { lifetimes.push(pending) } })
  const response = await app.fetch(request)
  try {
    await entered.promise
    await response.body!.cancel()
    const raced = await Promise.race([
      Promise.all(lifetimes).then(() => 'request_lifetime_ended'),
      // Drain the transport-close microtasks; the write itself is held by a
      // barrier, so this assertion does not depend on a timing allowance.
      new Promise<string>(resolve => setImmediate(() => resolve('write_still_owned'))),
    ])
    assert.equal(writeFinished, false)
    assert.equal(raced, 'write_still_owned')
  } finally {
    finishWrite.resolve()
    await Promise.all(lifetimes)
  }
  assert.equal(writeFinished, true)
})

for (const valid of [false, true]) test(`actual MCP ${valid ? 'original callback error reaches the SDK' : 'rejected input starts no retained callback'}`, async () => {
  let started = 0, retained = 0
  const lifetimes: Promise<unknown>[] = []
  const handler = createMcpHandler(instance => {
    const server = requestOwnedMcpTools(instance, pending => { retained++; after(pending) })
    server.registerTool('fixture_write', { inputSchema: z.object({ accepted: z.literal(true) }) }, async () => {
      started++
      throw new Error('fixture-original-error')
    })
  })
  const app = createApiHandler([{ path: '/mikka/api/mcp', template: '/api/mcp', source: 'fixture', methods: ['POST'],
    load: async () => ({ POST: handler }) }])
  const request = Object.assign(new Request('https://example.test/mikka/api/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_write', arguments: { accepted: valid } } }),
  }), { waitUntil: (pending: Promise<unknown>) => { lifetimes.push(pending) } })
  const response = await app.fetch(request)
  const text = await response.text()
  const packet = JSON.parse(text.split('\n').find(line => line.startsWith('data: {'))!.slice(6))
  await Promise.all(lifetimes)
  assert.equal(packet.result.isError, true)
  assert.equal(started, valid ? 1 : 0)
  assert.equal(retained, valid ? 1 : 0)
  if (valid) assert.equal(packet.result.content[0].text, 'fixture-original-error')
})

test('cancellation during SDK validation starts no callback after the request lifetime ends', { timeout: 3_000 }, async () => {
  const validating = Promise.withResolvers<void>(), validated = Promise.withResolvers<void>()
  const lifetimes: Promise<unknown>[] = []
  const abort = new AbortController()
  let started = 0, retained = 0
  const handler = createMcpHandler(instance => {
    const server = requestOwnedMcpTools(instance, pending => { retained++; after(pending) })
    server.registerTool('fixture_write', { inputSchema: z.object({}).refine(async () => {
      validating.resolve(); await validated.promise; return true
    }) }, async () => {
      started++
      return { content: [{ type: 'text', text: 'fixture' }] }
    })
  })
  const app = createApiHandler([{ path: '/mikka/api/mcp', template: '/api/mcp', source: 'fixture', methods: ['POST'],
    load: async () => ({ POST: handler }) }])
  const request = Object.assign(new Request('https://example.test/mikka/api/mcp', {
    method: 'POST', signal: abort.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_write', arguments: {} } }),
  }), { waitUntil: (pending: Promise<unknown>) => { lifetimes.push(pending) } })
  const response = await app.fetch(request)
  try {
    await validating.promise
    abort.abort()
    await response.body!.cancel()
    await Promise.all(lifetimes)
    validated.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(started, 0, 'cancelled SDK validation must not start a write')
    assert.equal(retained, 0)
  } finally { validated.resolve(); abort.abort() }
})
