import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'esbuild'
import { apiProxyOptions, developmentDocument, developmentRequest } from './dev-http.mjs'
import { closeDevelopment, developmentOptions, tracingEntry } from './dev.mjs'

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

test('only machine paths proxy, retaining the browser Host and exact encoded path', () => {
  const proxy = apiProxyOptions('http://127.0.0.1:42311/')['^/']
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

test('the bundled worker entry executes tracing before loading its dynamic runtime graph', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-dev-tracing-'))
  try {
    const runtime = join(directory, 'runtime.mjs')
    await writeFile(runtime, 'if (globalThis.__tracingBeforeRuntime !== true) throw new Error("TRACING_TOO_LATE"); console.log("tracing-first"); export default {fetch(){return new Response("ok")}}\n')
    const entry = await tracingEntry({ directory, originalEntry: runtime, tracing: 'globalThis.__tracingBeforeRuntime = true;\n' })
    const output = join(directory, 'compiled.mjs')
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' })
    const { stdout } = await promisify(execFile)(process.execPath, [output], { timeout: 10_000 })
    assert.equal(stdout.trim(), 'tracing-first')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
