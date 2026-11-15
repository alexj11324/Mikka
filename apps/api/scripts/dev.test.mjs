import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Agent } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getEventListeners } from 'node:events'
import { waitForApiReady } from '../../../scripts/dev-local/shutdown.mjs'
import { apiProxyOptions, developmentDocument, developmentRequest } from './dev-http.mjs'
import { closeDevelopment, developmentOptions, developmentResponse, developmentWorkerReady, staleRouteFiles, staleRoutesRefusal } from './dev.mjs'

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
  assert.deepEqual(developmentOptions([], {}), { host: 'localhost', port: 3000, allowStaleRoutes: false, origin: 'http://localhost:3000' })
  assert.deepEqual(developmentOptions(['-p', '3100', '--hostname', '0.0.0.0'], {}), { host: '0.0.0.0', port: 3100, allowStaleRoutes: false, origin: 'http://localhost:3100' })
  assert.deepEqual(developmentOptions(['--port=3102', '--host=::1'], {}), { host: '::1', port: 3102, allowStaleRoutes: false, origin: 'http://[::1]:3102' })
  assert.equal(developmentOptions([], { MIKKA_DEV_PORT: '3103' }).port, 3103)
  // The stale-route guard's escape hatch is explicit and composes with the existing switches.
  assert.equal(developmentOptions(['--allow-stale-routes'], {}).allowStaleRoutes, true)
  assert.equal(developmentOptions(['--allow-stale-routes', '-p', '3104'], {}).port, 3104)
  for (const args of [['--port', '0'], ['-p', '65536'], ['-p', '1x'], ['--host', 'https://example.invalid'], ['--port'], ['--webpack'], ['--allow-stale-route']]) assert.throws(() => developmentOptions(args, {}))
})

test('a dev start refuses a route manifest the checkout does not contain', () => {
  const expected = new Map([['routes.json', '{"version":1}\n'], ['routes.ts', 'export const routes = []\n']])
  // Identical bytes: the generator rewrites unconditionally, but git compares
  // content, so a same-bytes rewrite leaves the tree clean and must not block.
  assert.deepEqual(staleRouteFiles(expected, new Map(expected)), [])
  // Real content difference: serving would run a route table nobody committed.
  const changed = staleRouteFiles(new Map([['routes.json', '{"version":1,"routes":[]}\n'], ['routes.ts', expected.get('routes.ts')]]), new Map(expected))
  assert.deepEqual(changed, [{ path: 'apps/api/generated/routes.json', missing: false }])
  // A generated file the checkout never had is a missing commit, not a change.
  const added = staleRouteFiles(expected, new Map([['routes.json', expected.get('routes.json')]]))
  assert.deepEqual(added, [{ path: 'apps/api/generated/routes.ts', missing: true }])
  const refusal = staleRoutesRefusal([...changed, ...added])
  assert.equal(refusal.code, 'API_DEV_ROUTES_STALE')
  for (const text of ['apps/api/generated/routes.json', 'apps/api/generated/routes.ts', 'Changed:', 'Not in this checkout:',
    'node apps/api/scripts/generate-routes.mjs', 'git add apps/api/generated && git commit', '--allow-stale-routes']) assert.ok(refusal.message.includes(text), text)
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

test('worker initialization preserves only a closed diagnosis from the actual env-runner message format', async () => {
  // env-runner 0.3.11 sends Error.message, without its name/code. The worker
  // can terminate before stderr flushes, so this IPC message is the evidence.
  const privateDetail = 'private-worker-location-and-credential'
  const cases = [
    [`Cannot find package 'pg' imported from /${privateDetail}/entry.mjs`, 'module-missing', 'pg'],
    [`Cannot find module '/${privateDetail}/mikka-tracing.mjs' imported from /${privateDetail}/index.mjs`, 'module-missing', 'tracing-entry'],
    [`Cannot find package '${privateDetail}' imported from /private/entry.mjs`, 'module-missing', null],
    [`The requested module '${privateDetail}' does not provide an export named 'default'`, 'export-missing', null],
    [`Unexpected token '${privateDetail}' (at /private/entry.mjs:1:2)`, 'module-syntax', null],
    [`listen EADDRINUSE: address already in use /${privateDetail}`, 'listen-address-in-use', null],
    [`listen EACCES: permission denied /${privateDetail}`, 'listen-access-denied', null],
    [`[env-runner] Entry module "/${privateDetail}" must export a \`fetch\` handler (export default { fetch(req) { ... } }).`, 'entry-handler-missing', null],
    [privateDetail, 'unavailable', null],
    [{ message: privateDetail, code: 'EADDRINUSE' }, 'unavailable', null],
  ]
  for (const [raw, reason, dependency] of cases) {
    const api = workerMessages(), worker = developmentWorkerReady(api, { phase: 'hot-replacement' })
    const pending = worker.wait(new AbortController().signal)
    api.emit({ event: 'init-error', error: raw })
    await assert.rejects(pending, error => {
      assert.equal(error.code, 'API_DEV_WORKER_INIT_FAILED')
      assert.equal(error.message, 'API_DEV_WORKER_INIT_FAILED')
      assert.deepEqual(error.cause, { phase: 'hot-replacement', reason, dependency })
      assert.equal(JSON.stringify(error.cause).includes(privateDetail), false)
      return true
    })
    assert.equal(api.listenerCount, 0)
  }
})

test('startup diagnostics distinguish initial workers and never forward an untrusted phase', async () => {
  for (const [options, phase] of [[undefined, 'initial-start'], [{ phase: 'private-phase' }, 'unavailable']]) {
    const api = workerMessages(), worker = developmentWorkerReady(api, options)
    const pending = worker.wait(new AbortController().signal)
    api.emit({ event: 'init-error', error: 'private initialization detail' })
    await assert.rejects(pending, error => {
      assert.deepEqual(error.cause, { phase, reason: 'unavailable', dependency: null })
      return true
    })
  }
})

test('the CI TAP reporter retains the closed worker cause without disclosing the original IPC message', async t => {
  const privateDetail = 'private-initialization-sentinel'
  const program = `import test from 'node:test';
import { developmentWorkerReady } from ${JSON.stringify(new URL('./dev.mjs', import.meta.url).href)};
test('controlled initialization refusal', async () => {
  let emit;
  const api = { onMessage(listener) { emit = listener }, offMessage() {} };
  const worker = developmentWorkerReady(api, { phase: 'hot-replacement' });
  const pending = worker.wait(new AbortController().signal);
  emit({ event: 'init-error', error: ${JSON.stringify(`Cannot find package 'pg' imported from /${privateDetail}/entry.mjs`)} });
  await pending;
});`
  const directory = await mkdtemp(join(tmpdir(), 'mikka-worker-report-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = join(directory, 'worker.test.mjs')
  await writeFile(fixture, program, { mode: 0o600 })
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], {
    encoding: 'utf8', timeout: 5_000, env: { PATH: process.env.PATH, NODE_OPTIONS: '' },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, 'the child must still fail at its first initialization refusal')
  const output = result.stdout + result.stderr
  assert.ok(output.includes('API_DEV_WORKER_INIT_FAILED'))
  const diagnosis = /^# \[dev\] Worker initialization failed (\{.*\})$/m.exec(output)
  assert.ok(diagnosis, 'the same TAP reporter used by CI must expose the closed cause')
  assert.deepEqual(JSON.parse(diagnosis[1]), { phase: 'hot-replacement', reason: 'module-missing', dependency: 'pg' })
  assert.equal(output.includes(privateDetail), false)
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

test('owned API readiness ignores unrelated IPC and preserves failure before ready', async t => {
  const origin = 'http://localhost:3110'
  const child = program => {
    const proc = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill() })
    return proc
  }
  await waitForApiReady(child(`process.send({ type: 'other' });process.send({ type: 'api-ready', origin: '${origin}' })`), origin, AbortSignal.timeout(10_000))
  await assert.rejects(waitForApiReady(child('process.exit(23)'), origin, AbortSignal.timeout(10_000)), /exited before readiness: 23/)
  await assert.rejects(waitForApiReady(child("process.send({ type: 'api-ready', origin: 'http://localhost:9000' })"), origin, AbortSignal.timeout(10_000)), /API_DEV_ORIGIN_MISMATCH/)
  await assert.rejects(waitForApiReady(child('setTimeout(() => {}, 10000)'), origin, AbortSignal.timeout(100)), { name: 'TimeoutError' })
})
