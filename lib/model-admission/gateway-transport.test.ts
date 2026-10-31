import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

test('the actual Gateway SDK transport refuses a real HTTP redirect without sending the second request', async () => {
  let requests = 0, redirected = 0
  const server = createServer((request, response) => {
    requests++
    if (request.url === '/redirected') { redirected++; response.writeHead(200).end('{}'); return }
    response.writeHead(307, { location: '/redirected' }).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const nativeFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const original = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(original.origin, 'https://ai-gateway.vercel.sh')
    assert.equal(init?.redirect, 'error')
    // Only the synthetic request is routed to an isolated loopback HTTP peer.
    return nativeFetch(`http://127.0.0.1:${address.port}${original.pathname}`, init)
  }) as typeof fetch
  try {
    const { createTrustedGatewayModel } = await import('../abuse/model')
    const model = await createTrustedGatewayModel('deepseek/deepseek-v4.1-flash', 'synthetic-gateway-test-key')
    await assert.rejects(Promise.resolve(model.doGenerate({ prompt: [] })))
    assert.equal(requests, 1)
    assert.equal(redirected, 0)
  } finally {
    globalThis.fetch = nativeFetch
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
