import { resolvePermissions } from '@mikka/protocol/agent-policy'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { desktopConfig, desktopFingerprint, normalizedOperation } from './operation'
import { decideComputerRequest, prepareComputerRequest, waitForComputerRequest, type ComputerRequest, type ComputerRequestStore } from './broker'
import { decodeGrpcWeb, encodeOperation, executeDesktop } from './grpc-web'

const config = { url: 'http://desktop.test:3211', token: 'fixture-token-not-a-secret', workspaceId: 'a5f221a6-502d-4c82-bc96-36e97d277a8f' }
class Store implements ComputerRequestStore {
  rows = new Map<string, ComputerRequest>()
  async insert(request: ComputerRequest) { this.rows.set(request.id, request) }
  async pending(userId: string, sessionId: string) { return [...this.rows.values()].filter(v => v.userId === userId && v.sessionId === sessionId && v.status === 'pending') }
  async consume(id: string, userId: string, sessionId: string, target: string, now: Date, status: 'executing' | 'denied') {
    const row = this.rows.get(id)
    if (!row || row.userId !== userId || row.sessionId !== sessionId || row.target !== target || row.status !== (status === 'executing' ? 'approved' : 'pending') || row.expiresAt <= now) return null
    row.status = status
    return row
  }
  async read(id: string, userId: string, sessionId: string, target: string) {
    const row = this.rows.get(id)
    return row && row.userId === userId && row.sessionId === sessionId && row.target === target ? row : null
  }
  async cancel(id: string, userId: string, sessionId: string) {
    const row = this.rows.get(id)
    if (row?.userId === userId && row.sessionId === sessionId && ['pending', 'approved'].includes(row.status)) row.status = 'cancelled'
  }
  async approve(id: string, userId: string, sessionId: string, target: string, now: Date) {
    const row = await this.read(id, userId, sessionId, target)
    if (!row || row.status !== 'pending' || row.expiresAt <= now) return null
    row.status = 'approved'; return row
  }
  async finish(id: string, status: string) { this.rows.get(id)!.status = status }
}
const frame = (data: Buffer, flags = 0) => { const header = Buffer.alloc(5); header[0] = flags; header.writeUInt32BE(data.length, 1); return Buffer.concat([header, data]) }
const trailers = (status = 0) => frame(Buffer.from(`grpc-status: ${status}\r\n`), 128)

test('absent/incomplete configuration omits the desktop; target rotation is distinct', () => {
  assert.equal(desktopConfig({}), null)
  assert.equal(desktopConfig({ CUA_DESKTOP_URL: config.url }), null)
  assert.notEqual(desktopFingerprint(config), desktopFingerprint({ ...config, token: 'rotated' }))
  assert.throws(() => desktopConfig({ CUA_DESKTOP_URL: 'http://user:pass@desktop', CUA_DESKTOP_TOKEN: 'test', CUA_WORKSPACE_ID: config.workspaceId }))
})
test('normalization rejects unknown/unsafe operation data and normalizes modifiers', () => {
  assert.throws(() => normalizedOperation({ tool: 'click', x: -1, y: 1 }))
  assert.throws(() => normalizedOperation({ tool: 'screenshot', target: 'http://attacker' }))
  const key = normalizedOperation({ tool: 'key', key: 'ENTER', modifiers: ['SHIFT', 'CONTROL', 'SHIFT'] })
  assert.equal(key.tool, 'key')
  if (key.tool === 'key') assert.deepEqual(key.modifiers, ['CONTROL', 'SHIFT'])
})
test('default ask queues, never executes; owner/session/target/expiry/replay are bound', async () => {
  const store = new Store(); let executed = 0
  const prepared = await prepareComputerRequest(store, 'owner', 'session', config, { tool: 'type', text: 'fixture' })
  const execute = async () => ++executed
  assert.equal(executed, 0)
  for (const [owner, session, target] of [['other', 'session', config], ['owner', 'other', config], ['owner', 'session', { ...config, token: 'rotated' }]] as const) {
    await assert.rejects(decideComputerRequest(store, owner, session, prepared.requestId, true, target, execute))
  }
  assert.equal(executed, 0)
  await store.approve(prepared.requestId, 'owner', 'session', desktopFingerprint(config), new Date())
  const results = await Promise.allSettled([1, 2].map(() => decideComputerRequest(store, 'owner', 'session', prepared.requestId, true, config, execute)))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(executed, 1)
  const expired = await prepareComputerRequest(store, 'owner', 'session', config, { tool: 'screenshot' }, new Date(0))
  await assert.rejects(decideComputerRequest(store, 'owner', 'session', expired.requestId, true, config, execute))
})
test('deny/cancel and failed/uncertain executions cannot replay', async () => {
  const store = new Store(); let calls = 0
  const execute = async () => { calls++; throw new Error('connection lost after dispatch') }
  const denied = await prepareComputerRequest(store, 'owner', 'session', config, { tool: 'screenshot' })
  assert.equal((await decideComputerRequest(store, 'owner', 'session', denied.requestId, false, config, execute)).status, 'denied')
  await assert.rejects(decideComputerRequest(store, 'owner', 'session', denied.requestId, true, config, execute))
  assert.equal(calls, 0)
  const uncertain = await prepareComputerRequest(store, 'owner', 'session', config, { tool: 'click', x: 1, y: 2 })
  await store.approve(uncertain.requestId, 'owner', 'session', desktopFingerprint(config), new Date())
  await assert.rejects(decideComputerRequest(store, 'owner', 'session', uncertain.requestId, true, config, execute))
  await assert.rejects(decideComputerRequest(store, 'owner', 'session', uncertain.requestId, true, config, execute))
  assert.equal(calls, 1)
  assert.equal(store.rows.get(uncertain.requestId)?.status, 'failed')
  assert.ok(!JSON.stringify([...store.rows.values()]).includes(config.token))
})
test('grpc-web framing requires explicit success and a bounded intact unary message', () => {
  assert.deepEqual(decodeGrpcWeb(Buffer.concat([frame(Buffer.from([1])), trailers()])), Buffer.from([1]))
  assert.throws(() => decodeGrpcWeb(frame(Buffer.from([1]))))
  assert.throws(() => decodeGrpcWeb(Buffer.concat([frame(Buffer.from([1])), trailers(16)])))
  assert.throws(() => decodeGrpcWeb(Buffer.from([0, 0])))
  assert.throws(() => decodeGrpcWeb(frame(Buffer.from([1]), 1), '0'))
  for (const input of [{ tool: 'screenshot' }, { tool: 'click', x: 2, y: 4 }, { tool: 'type', text: 'fixture' }, { tool: 'key', key: 'ENTER' }, { tool: 'scroll', x: 2, y: 4, deltaY: 200 }]) {
    assert.ok(encodeOperation(normalizedOperation(input)).payload.length)
  }
})
test('scripted fake agent talks to a real loopback HTTP server with gRPC-Web wire fixtures (not a real desktop)', async () => {
  const received: string[] = []
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['x-cua-env-authorization'], `Bearer ${config.token}`)
    assert.equal(req.headers['content-type'], 'application/grpc-web+proto')
    const body: Buffer[] = []; for await (const chunk of req) body.push(chunk)
    assert.ok(Buffer.concat(body).length > 5)
    received.push(req.url!)
    res.setHeader('Content-Type', 'application/grpc-web+proto')
    const payload = req.url?.endsWith('/Screenshot') ? Buffer.concat([Buffer.from([10, png.length]), png]) : Buffer.from([10, 2, 8, 3])
    res.end(Buffer.concat([frame(payload), trailers()]))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object')
    const endpoint = { ...config, url: `http://127.0.0.1:${address.port}` }
    const store = new Store()
    for (const action of [{ tool: 'click', x: 5, y: 5 }, { tool: 'type', text: 'Mikka CUA fixture' }, { tool: 'screenshot' }]) {
      const request = await prepareComputerRequest(store, 'owner', 'session', endpoint, action)
      await store.approve(request.requestId, 'owner', 'session', desktopFingerprint(endpoint), new Date())
      const result = await decideComputerRequest(store, 'owner', 'session', request.requestId, true, endpoint, executeDesktop)
      assert.equal(result.status, 'complete')
      if (action.tool === 'screenshot' && 'result' in result) assert.equal(result.result.image, `data:image/png;base64,${png.toString('base64')}`)
    }
    assert.deepEqual(received, ['Pointer', 'Keyboard', 'Screenshot'].map(method => `/cua.env.v1.ComputerService/${method}`))
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

// Same protocol resolver used by both server admission and the daemon policy.
test('workspace computer policy uses existing permission table; unknown remains ask', () => {
  assert.equal(resolvePermissions(undefined).computer_use, 'ask')
  assert.equal(resolvePermissions({ computer_use: 'unknown' }).computer_use, 'ask')
  assert.equal(resolvePermissions({ computer_use: 'deny' }).computer_use, 'deny')
  assert.equal(resolvePermissions({ computer_use: 'allow' }).computer_use, 'allow')
})

// Real waiting/claim pipeline; model is intentionally scripted, not a provider.
test('live tool receives screenshot and resumes scripted model, never approval text as execution', async () => {
  const store = new Store(), controller = new AbortController()
  const image = 'data:image/png;base64,fixture'
  const observed: string[] = []
  const execute = async (_config: unknown, operation: { tool: string }) => {
    observed.push(operation.tool)
    return operation.tool === 'screenshot' ? { image } : { executed: true }
  }
  const pending = waitForComputerRequest(store, 'owner', 'session', config, { tool: 'screenshot' }, execute, controller.signal, { pollMs: 1 })
  await new Promise(resolve => setTimeout(resolve, 0))
  const [row] = await store.pending('owner', 'session')
  assert.equal(row.status, 'pending'); assert.deepEqual(observed, [])
  assert.equal(await store.approve(row.id, 'other', 'session', desktopFingerprint(config), new Date()), null)
  assert.ok(await store.approve(row.id, 'owner', 'session', desktopFingerprint(config), new Date()))
  assert.equal(await store.approve(row.id, 'owner', 'session', desktopFingerprint(config), new Date()), null)
  const screenshot = await pending
  assert.equal(screenshot.image, image)
  // Script's next step is permitted only after it observes the actual output.
  const next = waitForComputerRequest(store, 'owner', 'session', config, { tool: 'click', x: 7, y: 9 }, execute, controller.signal, { pollMs: 1 })
  await new Promise(resolve => setTimeout(resolve, 0))
  const [click] = await store.pending('owner', 'session')
  assert.deepEqual(observed, ['screenshot'])
  await store.approve(click.id, 'owner', 'session', desktopFingerprint(config), new Date())
  assert.equal((await next).executed, true)
  assert.deepEqual(observed, ['screenshot', 'click'])
  assert.ok(!JSON.stringify([...store.rows.values()]).includes(image))
})
test('stopping pending/approved tools, expiry and tampering never execute', async () => {
  for (const reason of ['pending-stop', 'approved-stop', 'denied', 'timeout', 'tampered']) {
    const store = new Store(), controller = new AbortController(); let calls = 0
    const result = waitForComputerRequest(store, 'owner', 'session', config, { tool: 'type', text: 'safe fixture' }, async () => ++calls, controller.signal, { pollMs: 5, timeoutMs: reason === 'timeout' ? 10 : 1000 })
    const rejected = assert.rejects(result)
    await new Promise(resolve => setTimeout(resolve, 0))
    const [row] = await store.pending('owner', 'session')
    if (reason === 'approved-stop' || reason === 'tampered') await store.approve(row.id, 'owner', 'session', desktopFingerprint(config), new Date())
    if (reason.endsWith('stop')) controller.abort()
    if (reason === 'denied') await store.consume(row.id, 'owner', 'session', desktopFingerprint(config), new Date(), 'denied')
    if (reason === 'tampered') row.operation = normalizedOperation({ tool: 'type', text: 'changed' })
    await rejected
    assert.equal(calls, 0, reason)
    assert.ok(['cancelled', 'denied', 'failed'].includes(row.status))
    assert.equal(await store.approve(row.id, 'owner', 'session', desktopFingerprint(config), new Date()), null)
  }
})

test('AI SDK live stream waits for approval and delivers PNG to scripted next model step (no provider)', async () => {
  const { streamText, isStepCount } = await import('ai')
  const { MockLanguageModelV3 } = await import('ai/test')
  const { createComputerTools } = await import('./tools')
  const store = new Store(), controller = new AbortController()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  let step = 0, rpcCalls = 0
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['x-cua-env-authorization'], `Bearer ${config.token}`)
    for await (const chunk of req) assert.ok(chunk.length)
    rpcCalls++
    const payload = req.url?.endsWith('/Screenshot') ? Buffer.concat([Buffer.from([10, png.length]), png]) : Buffer.from([10, 2, 8, 3])
    res.end(Buffer.concat([frame(payload), trailers()]))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const endpoint = { ...config, url: `http://127.0.0.1:${address.port}` }
  const model = new MockLanguageModelV3({ doStream: async options => {
    step++
    if (step === 2) {
      const output = options.prompt.find(message => message.role === 'tool')
      assert.ok(output && output.role === 'tool')
      assert.ok(JSON.stringify(output).includes(png.toString('base64')), 'PNG must reach model as image content')
      assert.ok(!JSON.stringify(output).includes('approvalRequired'))
    }
    const final = step === 3
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      if (final) {
        controller.enqueue({ type: 'text-start', id: 'final' })
        controller.enqueue({ type: 'text-delta', id: 'final', delta: 'Script observed the approved screenshot and completed an approved click.' })
        controller.enqueue({ type: 'text-end', id: 'final' })
      } else controller.enqueue({ type: 'tool-call', toolCallId: `call-${step}`, toolName: step === 1 ? 'computer_screenshot' : 'computer_click', input: step === 1 ? '{}' : '{"x":7,"y":9}' })
      controller.enqueue({ type: 'finish', finishReason: { unified: final ? 'stop' : 'tool-calls', raw: undefined }, usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } })
      controller.close()
    } }) }

  } })
  try {
    const result = streamText({ model, tools: createComputerTools(endpoint, store, 'owner', 'session', controller.signal), prompt: 'Scripted screenshot then click fixture.', stopWhen: isStepCount(3), abortSignal: controller.signal })
    const chunks: string[] = []
    const consume = (async () => { for await (const part of result.stream) { assert.notEqual(part.type, 'error'); if (part.type === 'text-delta') chunks.push(part.text) } })()
    for (const tool of ['screenshot', 'click']) {
      const deadline = Date.now() + 5000
      let row: ComputerRequest | undefined
      while (!(row = (await store.pending('owner', 'session'))[0])) {
        assert.ok(Date.now() < deadline, 'live stream must enqueue the model tool')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.equal(row.operation.tool, tool)
      // Deliberately hold each operation pending while the same stream remains
      // open. No RPC or next model step may escape before exact approval.
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(rpcCalls, tool === 'screenshot' ? 0 : 1)
      assert.equal(step, tool === 'screenshot' ? 1 : 2)
      await store.approve(row.id, 'owner', 'session', desktopFingerprint(endpoint), new Date())
    }
    await consume
    assert.match(chunks.join(''), /completed an approved click/)
    assert.equal(step, 3); assert.equal(rpcCalls, 2)
  } finally { controller.abort(); await new Promise<void>(resolve => server.close(() => resolve())) }

})
