import { resolvePermissions } from '@mikka/protocol/agent-policy'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { desktopConfig, desktopFingerprint, normalizedOperation } from './operation'
import { decideComputerRequest, prepareComputerRequest, type ComputerRequest, type ComputerRequestStore } from './broker'
import { decodeGrpcWeb, encodeOperation, executeDesktop } from './grpc-web'

const config = { url: 'http://desktop.test:3211', token: 'fixture-token-not-a-secret', workspaceId: 'a5f221a6-502d-4c82-bc96-36e97d277a8f' }
class Store implements ComputerRequestStore {
  rows = new Map<string, ComputerRequest>()
  async insert(request: ComputerRequest) { this.rows.set(request.id, request) }
  async pending(userId: string, sessionId: string) { return [...this.rows.values()].filter(v => v.userId === userId && v.sessionId === sessionId && v.status === 'pending') }
  async consume(id: string, userId: string, sessionId: string, target: string, now: Date, status: 'executing' | 'denied') {
    const row = this.rows.get(id)
    if (!row || row.userId !== userId || row.sessionId !== sessionId || row.target !== target || row.status !== 'pending' || row.expiresAt <= now) return null
    row.status = status
    return row
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
