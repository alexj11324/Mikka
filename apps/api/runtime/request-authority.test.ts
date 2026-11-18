import assert from 'node:assert/strict'
import { createServer, request as sendHttp, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2'
import { once } from 'node:events'
import test from 'node:test'
import { toNodeHandler } from 'srvx/node'
import type { ServerRequest } from 'srvx'
import { withNodeRequestAuthority } from './request-authority'

const origin = 'https://app.example.test'

async function withHttpApplication(handler: (request: ServerRequest) => Response | Promise<Response>, work: (send: (headers?: OutgoingHttpHeaders, path?: string) => Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>) => Promise<void>) {
  const server = createServer(toNodeHandler(handler))
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const send = (headers: OutgoingHttpHeaders = {}, path = '/mikka/api/version') => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const values = Object.fromEntries(Object.entries({
        host: 'app.example.test', 'x-forwarded-host': 'app.example.test', 'x-forwarded-proto': 'https', connection: 'close', ...headers,
      }).filter(([, value]) => value !== undefined))
      const request = sendHttp({ hostname: '127.0.0.1', port: address.port, method: 'POST', path, headers: values }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.once('error', reject)
        response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }))
      })
      request.once('error', reject); request.end('body')
    })
    await work(send)
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('self-hosted Node accepts only its configured HTTPS authority behind a proxy', { timeout: 10_000 }, async () => {
  const handler = withNodeRequestAuthority(async request => Response.json({ url: request.url, body: await request.text() }), { origin })
  await withHttpApplication(handler, async send => {
    const accepted = await send()
    assert.equal(accepted.status, 200)
    assert.deepEqual(JSON.parse(accepted.body), { url: `${origin}/mikka/api/version`, body: 'body' })
    for (const headers of [
      { host: 'other.example.test', 'x-forwarded-host': 'other.example.test' },
      { 'x-forwarded-host': 'other.example.test' },
      { 'x-forwarded-proto': 'http' },
      { forwarded: 'host=other.example.test;proto=https' },
    ]) assert.equal((await send(headers)).status, 400)
  })
})

test('legacy domain remains a fixed redirect without reaching application data', { timeout: 10_000 }, async () => {
  let invoked = false
  const handler = withNodeRequestAuthority(() => { invoked = true; return new Response('unreachable') }, {
    origin: 'https://app.aspectlylabs.com', legacyHost: 'mikka.aspectlylabs.com',
  })
  await withHttpApplication(handler, async send => {
    const result = await send({ host: 'mikka.aspectlylabs.com', 'x-forwarded-host': 'mikka.aspectlylabs.com' }, '/settings?section=account')
    assert.equal(result.status, 308)
    assert.equal(result.headers.location, 'https://app.aspectlylabs.com/mikka/settings?section=account')
    assert.equal(invoked, false)
  })
})

test('a real HTTP/2 client can discover the configured self-host installation', { timeout: 10_000 }, async () => {
  const server = createHttp2Server()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const localOrigin = `http://127.0.0.1:${address.port}`
  server.on('request', toNodeHandler(withNodeRequestAuthority(req => new Response(req.url), { origin: localOrigin })))
  const client = connectHttp2(localOrigin)
  try {
    const get = async (headers: Record<string, string> = {}) => {
      const stream = client.request({ ':path': '/mikka/api/version', ...headers })
      const head = once(stream, 'response')
      stream.end()
      let body = ''
      for await (const chunk of stream) body += chunk
      return { status: (await head)[0][':status'], body }
    }
    const accepted = { status: 200, body: localOrigin + '/mikka/api/version' }
    assert.deepEqual(await get(), accepted)
    assert.deepEqual(await get({ host: address.address + ':' + address.port }), accepted)
    assert.equal((await get({ ':authority': 'other.example.test' })).status, 400)
    assert.equal((await get({ host: 'other.example.test' })).status, 400)
  } finally {
    client.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('plain HTTP is permitted only for loopback and legacy host configuration is validated', () => {
  for (const value of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.doesNotThrow(() => withNodeRequestAuthority(() => new Response(), { origin: value }))
  }
  for (const value of ['http://network.example.test', 'http://127.0.0.1.attacker.test', 'http://10.0.0.5:3000']) {
    assert.throws(() => withNodeRequestAuthority(() => new Response(), { origin: value }))
  }
  for (const legacyHost of ['other.test/path', 'user@other.test', 'other.test:8443', 'https://other.test']) {
    assert.throws(() => withNodeRequestAuthority(() => new Response(), { origin, legacyHost }), /API_REQUEST_AUTHORITY_CONFIG_INVALID/)
  }
})
