import assert from 'node:assert/strict'
import { Agent } from 'node:http'
import test from 'node:test'
import { getEventListeners } from 'node:events'
import { apiProxyOptions, developmentDocument, developmentRequest } from './dev-http.mjs'
import { closeDevelopment, developmentOptions, developmentResponse, developmentWorkerReady } from './dev.mjs'

const request = (path, options) => new Request(`http://localhost:3000${path}`, options)
const html = '<!doctype html><html lang="zh-CN"><head></head><body><div id="root"></div></body></html>'

test('development shutdown waits for the real close and preserves failure as a nonzero status', async () => {
  const closing = Promise.withResolvers(), entries = []
  let complete = false
  const pending = closeDevelopment({ close: () => closing.promise }, (...args) => entries.push(args)).then(status => { complete = true; return status })
  await Promise.resolve(); assert.equal(complete, false)
  closing.resolve(); assert.equal(await pending, 0); assert.deepEqual(entries, [])
  const status = await closeDevelopment({ close: async () => { throw new Error('private shutdown detail') } }, (...args) => entries.push(args))
  assert.equal(status, 1)
  assert.deepEqual(entries, [['[dev] Shutdown failed', { name: 'Error', code: 'API_DEV_SHUTDOWN_FAILED' }]])
})

test('development keeps one explicit browser origin and accepts existing port/host switches', () => {
  assert.deepEqual(developmentOptions([], {}), { host: 'localhost', port: 3000, origin: 'http://localhost:3000' })
  assert.deepEqual(developmentOptions(['-p', '3100', '--hostname', '0.0.0.0'], {}), { host: '0.0.0.0', port: 3100, origin: 'http://localhost:3100' })
  assert.deepEqual(developmentOptions(['--port=3102', '--host=::1'], {}), { host: '::1', port: 3102, origin: 'http://[::1]:3102' })
  assert.equal(developmentOptions([], { MIKKA_DEV_PORT: '3103' }).port, 3103)
  for (const args of [['--port', '0'], ['-p', '65536'], ['-p', '1x'], ['--host', 'https://example.invalid'], ['--port'], ['--webpack']]) assert.throws(() => developmentOptions(args, {}))
})

test('only machine paths proxy, retaining the browser Host and exact encoded path', t => {
  const agent = new Agent({ keepAlive: true }); t.after(() => agent.destroy())
  const proxy = apiProxyOptions('http://127.0.0.1:42311/', agent)['^/']
  assert.equal(proxy.changeOrigin, false)
  assert.equal(proxy.target, 'http://127.0.0.1:42311')
  for (const url of ['/mikka/api/auth/callback/github?code=opaque', '/mikka/%61pi/missing', '/mikka/api%2fmissing', '/mikka/w/review', '/.well-known/workflow/v1/flow']) {
    const incoming = { url, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'session=opaque' } }
    const before = structuredClone(incoming)
    assert.equal(proxy.bypass(incoming), undefined)
    assert.deepEqual(incoming, before)
  }
  for (const url of ['/mikka/en/settings', '/mikka/@vite/client', '/mikka/src/index.tsx', '/mikka/@react-refresh']) assert.equal(proxy.bypass({ url }), url)
  for (const target of ['https://127.0.0.1:444', 'http://example.invalid', 'http://user:password@127.0.0.1', 'http://127.0.0.1/base', 'http://127.0.0.1?target=other']) assert.throws(() => apiProxyOptions(target), /API_DEV_PROXY_TARGET_INVALID/)
  assert.throws(() => apiProxyOptions('http://127.0.0.1:42311/'), /API_DEV_PROXY_AGENT_INVALID/)
})

test('development applies real locale, document cookie and private-link policies before HTML transformation', async () => {
  let transformed = 0
  const render = async () => { transformed++; return html }
  const redirected = await developmentDocument(request('/mikka?workspace=x', { headers: { 'Accept-Language': 'en' } }), render)
  assert.equal(redirected.status, 307)
  assert.equal(redirected.headers.get('location'), 'http://localhost:3000/mikka/en?workspace=x')
  assert.equal(transformed, 0)
  const localized = await developmentDocument(request('/mikka/en/reset-password?token=opaque', { headers: { Cookie: 'NEXT_LOCALE=zh-CN', 'Sec-Fetch-Dest': 'document' } }), render)
  assert.equal(localized.status, 200)
  assert.match(await localized.text(), /<html lang="en"/)
  assert.equal(localized.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(localized.headers.get('cache-control'), 'no-store')
  assert.equal(localized.headers.get('vary'), 'Accept-Language, Cookie')
  assert.match(localized.headers.get('set-cookie'), /^NEXT_LOCALE=en; Max-Age=31536000; Path=\/mikka; SameSite=Lax$/)
  assert.equal(transformed, 1)
  const nonDocument = await developmentDocument(request('/mikka/en', { headers: { Cookie: 'NEXT_LOCALE=zh-CN', 'Sec-Fetch-Dest': 'empty' } }), render)
  assert.equal(nonDocument.headers.get('set-cookie'), null)
})

test('page redirects retain the allowed browser host and configured HTTPS preview origin', async () => {
  const incoming = host => ({ method: 'GET', url: '/', originalUrl: '/mikka', headers: { host }, rawHeaders: ['Host', host, 'Accept-Language', 'en', 'Cookie', 'NEXT_LOCALE=en'] })
  const local = developmentRequest(incoming('127.0.0.1:3000'), 'https://preview.example.invalid')
  assert.equal(local.url, 'http://127.0.0.1:3000/mikka')
  const secure = developmentRequest(incoming('preview.example.invalid'), 'https://preview.example.invalid')
  const response = await developmentDocument(secure, () => { throw new Error('unexpected render') })
  assert.equal(response.headers.get('location'), 'https://preview.example.invalid/mikka/en')
  const forgedForwarded = incoming('localhost:3000')
  forgedForwarded.rawHeaders.push('X-Forwarded-Host', 'untrusted.example.invalid')
  assert.equal(developmentRequest(forgedForwarded, 'http://localhost:3000').url, 'http://localhost:3000/mikka')
})

test('HEAD does not transform a document; unknown APIs/assets and writes never get the SPA', async () => {
  const never = () => { throw new Error('HTML_TRANSFORM_MUST_NOT_RUN') }
  const head = await developmentDocument(request('/mikka', { method: 'HEAD' }), never)
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
  for (const path of ['/mikka/api/missing', '/mikka/%61pi/missing', '/.well-known/workflow/missing', '/mikka/assets/missing.js', '/mikka/_next/missing', '/outside']) {
    const response = await developmentDocument(request(path), never)
    assert.equal(response.status, 404, path)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  }
  const write = await developmentDocument(request('/mikka/settings', { method: 'POST' }), never)
  assert.equal(write.status, 405)
  assert.equal(write.headers.get('allow'), 'GET, HEAD')
})

function workerMessages() {
  const listeners = new Set()
  return {
    onMessage(listener) { listeners.add(listener) },
    offMessage(listener) { listeners.delete(listener) },
    emit(message) { for (const listener of listeners) listener(message) },
    get listenerCount() { return listeners.size },
  }
}

test('development waits for the real worker address before its single HTTP check', async () => {
  const api = workerMessages(), deadline = new AbortController()
  const worker = developmentWorkerReady(api)
  assert.equal(api.listenerCount, 1, 'the listener is installed before compilation starts')
  let calls = 0
  const pending = developmentResponse(worker, 'http://localhost:3000', deadline.signal, async (url, init) => {
    calls++
    assert.equal(url, 'http://localhost:3000/mikka/api/version')
    assert.equal(init.signal, deadline.signal)
    return new Response('ready')
  })
  api.emit({ event: 'compiled' })
  await Promise.resolve()
  assert.equal(calls, 0, 'compiled is not ready; no early request can exhaust the SDK address grace')
  api.emit({ address: { host: '127.0.0.1', port: 43001 } })
  await pending
  assert.equal(calls, 1)
  assert.equal(api.listenerCount, 0)
  assert.equal(getEventListeners(deadline.signal, 'abort').length, 0)
})

test('a worker ready message arriving before the wait is retained', async () => {
  const api = workerMessages(), worker = developmentWorkerReady(api)
  api.emit({ address: { host: '127.0.0.1', port: 43002 } })
  await worker.wait(new AbortController().signal)
  assert.equal(api.listenerCount, 0)
  worker.dispose()
})

test('a real worker init error fails immediately without an HTTP retry or raw error disclosure', async () => {
  const api = workerMessages(), worker = developmentWorkerReady(api)
  let calls = 0
  const pending = developmentResponse(worker, 'http://localhost:3000', new AbortController().signal, async () => { calls++; return new Response('unexpected') })
  api.emit({ event: 'init-error', error: 'private initialization detail' })
  await assert.rejects(pending, { code: 'API_DEV_WORKER_INIT_FAILED', message: 'API_DEV_WORKER_INIT_FAILED' })
  assert.equal(calls, 0)
  assert.equal(api.listenerCount, 0)
})

test('worker initialization and HTTP share one deadline and always release listeners', async () => {
  const api = workerMessages(), worker = developmentWorkerReady(api), deadline = new AbortController()
  const entered = Promise.withResolvers()
  let calls = 0
  const pending = developmentResponse(worker, 'http://localhost:3000', deadline.signal, async (_url, init) => {
    calls++
    assert.equal(init.signal, deadline.signal)
    entered.resolve()
    await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
    return new Response('unreachable')
  })
  api.emit({ address: { host: '127.0.0.1', port: 43003 } })
  await entered.promise
  deadline.abort(new Error('same deadline expired'))
  await assert.rejects(pending, /same deadline expired/)
  assert.equal(calls, 1)
  assert.equal(api.listenerCount, 0)

  const otherApi = workerMessages(), waiting = developmentWorkerReady(otherApi), expired = new AbortController()
  const blocked = waiting.wait(expired.signal)
  expired.abort()
  await assert.rejects(blocked, { code: 'API_DEV_STARTUP_TIMEOUT' })
  assert.equal(otherApi.listenerCount, 0)
  assert.equal(getEventListeners(expired.signal, 'abort').length, 0)
  waiting.dispose()
})

test('worker disposal rejects an outstanding wait and HTTP failure remains fatal', async () => {
  const api = workerMessages(), worker = developmentWorkerReady(api)
  const pending = worker.wait(new AbortController().signal)
  worker.dispose()
  await assert.rejects(pending, { code: 'API_DEV_WORKER_CANCELLED' })
  assert.equal(api.listenerCount, 0)
  const readyApi = workerMessages(), ready = developmentWorkerReady(readyApi)
  readyApi.emit({ address: { host: '127.0.0.1', port: 43004 } })
  let calls = 0
  await assert.rejects(developmentResponse(ready, 'http://localhost:3000', new AbortController().signal,
    async () => { calls++; return new Response('unavailable', { status: 503 }) }),
  { code: 'API_DEV_STARTUP_RESPONSE_INVALID' })
  assert.equal(calls, 1)
})
