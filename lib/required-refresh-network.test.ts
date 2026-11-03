import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { once } from 'node:events'

// Real HTTP body consumption must stop after headers, not only new fetches.
test('requiring refresh aborts an already-open business stream and preserves the version probe', async t => {
  const server = createServer((request, response) => {
    if (request.url === '/api/version') { response.end(JSON.stringify({ build: 'new' })); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: first\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const target = { fetch: globalThis.fetch, location: { origin, href: origin + '/' } } as unknown as Window
  const { watchRemovedActions, markPageNeedsRefresh } = await import('./app-build')
  watchRemovedActions(target)
  const response = await target.fetch(origin + '/stream')
  const reader = response.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/)
  const caller = new AbortController()
  const otherResponse = await target.fetch(new Request(origin + '/stream', { signal: caller.signal }))
  const otherReader = otherResponse.body!.getReader()
  await otherReader.read()
  caller.abort()
  await assert.rejects(otherReader.read(), { name: 'AbortError' })
  const pending = reader.read()
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  markPageNeedsRefresh()
  let beacons = 0
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { sendBeacon: () => { beacons++; return true } } })
  t.after(() => { if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator') })
  const { httpReadSource } = await import('./conversation-reads')
  httpReadSource.beacon('fixture-conversation', { messageId: 'fixture-message', position: 1 })
  assert.equal(beacons, 0)
  // A broken implementation must fail rather than leave the test hanging.
  const timeout = setTimeout(() => server.closeAllConnections(), 500)
  t.after(() => clearTimeout(timeout))
  await rejected
  const { withBasePath } = await import('./base-path')
  // The fixture serves metadata at either configured base path.
  server.removeAllListeners('request')
  server.on('request', (_request, reply) => reply.end(JSON.stringify({ build: 'new' })))
  assert.equal((await target.fetch(origin + withBasePath('/api/version'))).status, 200)
})
