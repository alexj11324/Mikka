import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { LookupFunction } from 'node:net'
import { guardedLookup, linkPreview, previewDispatcher, type DispatchedFetchInit } from './link-preview'

/** Asks a connect-time lookup the way net.connect does, keeping both callback shapes. */
function ask(lookupAtConnect: LookupFunction, hostname: string, options: { all?: boolean } = {}) {
  return new Promise<{ error: NodeJS.ErrnoException | null; answers: { address: string; family?: number }[] }>(resolve => {
    lookupAtConnect(hostname, options, (error, address, family) => {
      resolve({ error, answers: Array.isArray(address) ? address : [{ address, family }] })
    })
  })
}

test('guardedLookup answers the address it checked and refuses a private one', async () => {
  const guard = guardedLookup()
  assert.deepEqual(await ask(guard, '140.82.112.3', { all: true }), { error: null, answers: [{ address: '140.82.112.3', family: 4 }] })
  assert.deepEqual(await ask(guard, '140.82.112.3'), { error: null, answers: [{ address: '140.82.112.3', family: 4 }] })
  for (const hostname of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1']) {
    assert.equal((await ask(guard, hostname, { all: true })).error?.code, 'EPRIVATEADDRESS', hostname)
  }
})

test('guardedLookup checks the answer the connection gets, not the one the link was checked with', async () => {
  // What DNS rebinding looks like from here: the name answered a public address
  // when publicUrl looked, and answers a private one when the socket dials.
  const replayed = ['140.82.112.3', '169.254.169.254']
  const guard = guardedLookup(async () => [{ address: replayed.shift()!, family: 4 }])
  assert.equal((await ask(guard, 'rebind.example')).error, null)
  assert.equal((await ask(guard, 'rebind.example')).error?.code, 'EPRIVATEADDRESS')
})

test('a preview never opens a socket to a private address', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<head><title>local</title></head>')
  })
  // No host, so loopback is reachable over both 127.0.0.1 and ::1 and a
  // connection that slipped past the guard would land here instead of refusing.
  await new Promise<void>(resolve => server.listen(0, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const target = `http://localhost:${port}/`
  try {
    assert.equal(await linkPreview(target), null)
    // The same agent the preview fetches through, dialling a refused name.
    const init: DispatchedFetchInit = { dispatcher: previewDispatcher }
    await assert.rejects(fetch(target, init), (error: { cause?: { code?: string } }) => error.cause?.code === 'EPRIVATEADDRESS')
    assert.deepEqual(requests, [])
  } finally {
    server.close()
  }
})

test('linkPreview refuses anything but a public http(s) URL on the default port', async () => {
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://example.com:8080/', 'http://user:secret@example.com/']) {
    assert.equal(await linkPreview(url), null, url)
  }
})
