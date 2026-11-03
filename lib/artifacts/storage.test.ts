import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { putArtifactObject } from './storage'

test('signed uploads retain exact byte length when a fetch adapter streams the body', async (t) => {
  const keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const
  const previous = keys.map((key) => process.env[key])
  for (const key of keys) process.env[key] = 'isolated-storage-fixture'
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key]
    else process.env[key] = previous[i]
  }))
  const received: Array<{ size: number; hash: string }> = []
  const server = createServer(async (request, response) => {
    if (!request.headers['content-length']) {
      request.resume()
      response.writeHead(411).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    assert.equal(request.headers['content-length'], String(bytes.length))
    assert.equal(request.headers['if-none-match'], '*')
    received.push({ size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') })
    response.writeHead(200).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address() as { port: number }
  const fetchImpl = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const signed = new Request(input, init)
    // Framework fetch adapters can turn a buffered Request into a stream.
    // A stream loses the body's implicit length unless the header is explicit.
    return fetchImpl(new Request(`http://127.0.0.1:${address.port}/object`, {
      method: signed.method, headers: signed.headers, body: signed.body,
      duplex: 'half',
    } as RequestInit))
  })
  const fixtures = [Buffer.from('中文 Markdown 📎'), Buffer.alloc(6 * 1024 * 1024, 137)]
  for (const bytes of fixtures) {
    await putArtifactObject('fixture', bytes, 'application/octet-stream')
  }
  await putArtifactObject('unicode', '中文 Markdown 📎', 'text/plain')
  assert.deepEqual(received, [...fixtures, fixtures[0]].map((bytes) => ({
    size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'),
  })))
})
