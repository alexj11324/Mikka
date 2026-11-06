import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchNodeHandler } from 'srvx/node'
import { createDockerNodeRuntime } from './docker-node'

const origin = 'https://3000-001m6p8qt9pcng01mwgkmshdz6m.sbx.sandboxes-cloud.docker.com'
const input = (headers: Record<string, string> = {}) => new Request(`${origin}/mikka/api/fixture?x=1`, {
  method: 'POST', body: 'actual Node request body', headers: { host: new URL(origin).host, 'content-type': 'text/plain', ...headers },
})

// The official SDK bridge constructs real IncomingMessage/ServerResponse over
// an in-memory duplex. This verifies adapter semantics, not network listening
// or public Docker HTTP acceptance, and never uses app auth or a database.
test('non-listening Node adapter preserves real req/res/body, fixed origin and waitUntil close barrier', { timeout: 5000 }, async () => {
  const background = Promise.withResolvers<void>(), seen: string[] = []
  let closeCalls = 0, completed = false
  const runtime = createDockerNodeRuntime({ fetch: async request => {
    assert.ok(request.runtime?.node?.req); assert.ok(request.runtime?.node?.res)
    assert.equal(request.url, `${origin}/mikka/api/fixture?x=1`)
    assert.equal(request.method, 'POST'); seen.push(await request.text())
    request.waitUntil!(background.promise)
    const headers = new Headers()
    headers.append('set-cookie', 'one=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT')
    headers.append('set-cookie', 'two=; Max-Age=0; Path=/mikka')
    return new Response('done', { headers })
  } }, { origin, onClose: () => { closeCalls++ } })
  assert.deepEqual(Object.keys(runtime).sort(), ['close', 'handle'])
  try {
    const response = await fetchNodeHandler(runtime.handle, input())
    assert.equal(response.status, 200); assert.equal(await response.text(), 'done')
    assert.deepEqual(seen, ['actual Node request body'])
    assert.deepEqual(response.headers.getSetCookie(), ['one=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'two=; Max-Age=0; Path=/mikka'])
    const closing = runtime.close().then(() => { completed = true })
    await Promise.resolve(); assert.equal(completed, false); assert.equal(closeCalls, 0)
    background.resolve(); await closing; await runtime.close()
    assert.equal(closeCalls, 1)
  } finally { background.resolve(); await runtime.close() }
})

test('raw ingress guards reject foreign Host/proxy metadata before the application and retain failed close', { timeout: 5000 }, async () => {
  let invoked = 0, closed = 0
  const runtime = createDockerNodeRuntime({ fetch: () => { invoked++; return Response.json({ okay: true }) } }, {
    origin, onClose: () => { closed++; throw new Error('fixture close failure') },
  })
  const deniedHeaders: Record<string, string>[] = [{ host: 'foreign.invalid' }, { 'x-forwarded-host': 'foreign.invalid' }, { 'x-forwarded-proto': 'http' }]
  for (const headers of deniedHeaders) {
    const response = await fetchNodeHandler(runtime.handle, input(headers))
    assert.equal(response.status, 400); await response.arrayBuffer()
  }
  assert.equal(invoked, 0)
  const first = runtime.close(); assert.equal(runtime.close(), first)
  await assert.rejects(first, /fixture close failure/)
  await assert.rejects(runtime.close(), /fixture close failure/)
  assert.equal(closed, 1)
  assert.throws(() => createDockerNodeRuntime({ fetch: () => new Response() }, { origin: 'https://foreign.invalid', onClose() {} }), /DOCKER_RUNTIME_ORIGIN_INVALID/)
})
