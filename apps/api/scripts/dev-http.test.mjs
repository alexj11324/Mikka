import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { developmentPages, developmentRequest } from './dev-http.mjs'

const frontendRequire = createRequire(new URL('../../frontend/package.json', import.meta.url))
const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href)

test('the real Vite base middleware preserves the bare application mount and its guards', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-vite-base-'))
  const frontend = join(root, 'apps/frontend')
  await mkdir(frontend, { recursive: true })
  await writeFile(join(frontend, 'index.html'), '<!doctype html><html lang="zh-CN"><head></head><body>development-page</body></html>')
  const seen = []
  let server, port
  try {
    server = await createServer({
      configFile: false,
      root: frontend,
      base: '/mikka/',
      appType: 'custom',
      logLevel: 'silent',
      cacheDir: join(root, 'cache'),
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, allowedHosts: ['localhost'] },
      plugins: [
        {
          name: 'observe-post-base-request',
          configureServer(vite) {
            return () => vite.middlewares.use((incoming, _outgoing, next) => {
              const request = developmentRequest(incoming, 'http://127.0.0.1')
              seen.push({ url: request.url, method: request.method })
              next()
            })
          },
        },
        developmentPages({ root, origin: 'http://127.0.0.1' }),
      ],
    })
    await server.listen()
    port = server.httpServer.address().port
    const origin = `http://127.0.0.1:${port}`
    const get = (path, init = {}) => fetch(origin + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5_000) })

    await t.test('bare mount is an HTML document for the normal account helper and browser', async () => {
      for (const accept of ['*/*', 'text/html', 'application/json']) {
        const response = await get('/mikka', { headers: { accept } })
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-type'), /^text\/html;/)
        assert.match(await response.text(), /development-page/)
        assert.equal(seen.at(-1).url, origin + '/mikka')
      }
    })
    await t.test('query and locale remain attached to the original URL', async () => {
      const response = await get('/mikka?section=plugins&view=a%2Fb', { headers: { cookie: 'NEXT_LOCALE=zh-CN' } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('location'), null)
      assert.match(await response.text(), /<html lang="zh-CN"/)
      assert.equal(seen.at(-1).url, origin + '/mikka?section=plugins&view=a%2Fb')
      const english = await get('/mikka?section=plugins', { headers: { cookie: 'NEXT_LOCALE=en' } })
      assert.equal(english.status, 307)
      assert.equal(new URL(english.headers.get('location'), origin).pathname, '/mikka/en')
      assert.equal(new URL(english.headers.get('location'), origin).search, '?section=plugins')
    })
    await t.test('HEAD and disallowed methods keep the page response contract', async () => {
      const head = await get('/mikka', { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')
      const post = await get('/mikka?section=plugins', { method: 'POST' })
      assert.equal(post.status, 405)
      assert.equal(post.headers.get('allow'), 'GET, HEAD')
      assert.equal(seen.at(-1).method, 'POST')
    })
    await t.test('trailing slash keeps the existing permanent redirect', async () => {
      const response = await get('/mikka/?section=plugins', { method: 'POST' })
      assert.equal(response.status, 308)
      assert.equal(new URL(response.headers.get('location'), origin).href, origin + '/mikka?section=plugins')
    })
    await t.test('machine paths, encoded mounts and neighboring paths never become the SPA', async () => {
      for (const path of ['/mikka/api/not-a-route', '/mikka%2F', '/mikka-other']) {
        const response = await get(path)
        assert.equal(response.status, 404, path)
        assert.doesNotMatch(await response.text(), /development-page/, path)
      }
    })
    await t.test('Vite still rejects an untrusted Host before the document handler', async () => {
      const before = seen.length
      const response = await new Promise((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port, path: '/mikka', headers: { host: 'untrusted.example', accept: 'text/html' } }, response => {
          const chunks = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
          response.on('error', reject)
        })
        request.setTimeout(5_000, () => request.destroy(new Error('VITE_TEST_REQUEST_TIMEOUT')))
        request.on('error', reject)
        request.end()
      })
      assert.equal(response.status, 403)
      assert.doesNotMatch(response.body, /development-page/)
      assert.equal(seen.length, before)
    })
  } finally {
    await server?.close()
    if (port) {
      const closed = await new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port })
        socket.once('error', error => resolve(error.code === 'ECONNREFUSED'))
        socket.once('connect', () => { socket.destroy(); resolve(false) })
        socket.setTimeout(1_000, () => { socket.destroy(); resolve(false) })
      })
      assert.equal(closed, true)
    }
    await rm(root, { recursive: true, force: true })
  }
})
