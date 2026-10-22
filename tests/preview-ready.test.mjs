import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { warmPreview, previewWarmupPaths } from '../scripts/dev-preview.mjs'

test('startup compiles chat, images, history and workspace with read-only HEAD requests', async () => {
  const seen = []
  await warmPreview('http://127.0.0.1:3100', {
    fetcher: async (url, options) => {
      seen.push(url.pathname)
      assert.equal(url.port, '3100')
      assert.equal(options.method, 'HEAD')
      assert.equal(options.redirect, 'manual')
      return new Response(null, { status: 401 })
    }, log: () => {},
  })
  assert.deepEqual(seen, previewWarmupPaths.map(path => path === '/' ? '/mikka' : `/mikka${path}`))
  assert.ok(seen.includes('/mikka'))
  assert.ok(seen.includes('/mikka/api/agent'))
})

test('startup begins every warmup without waiting for other routes', async () => {
  const started = []
  const releases = []
  const warming = warmPreview('http://localhost:3000', {
    fetcher: url => {
      started.push(url.pathname)
      return new Promise(resolve => releases.push(() => resolve(new Response(null, { status: 401 }))))
    }, log: () => {},
  })
  assert.equal(started.length, previewWarmupPaths.length)
  releases.forEach(release => release())
  await warming
})

test('startup supports deployments without a base path', async () => {
  const seen = []
  await warmPreview('http://localhost:3000', {
    basePath: '',
    fetcher: async url => {
      seen.push(url.pathname)
      return new Response(null, { status: 401 })
    }, log: () => {},
  })
  assert.deepEqual(seen, previewWarmupPaths)
})

test('page warmup accepts the sign-in redirect but API redirects remain failures', async () => {
  await warmPreview('http://localhost:3000', {
    fetcher: async url => new Response(null, { status: url.pathname === '/mikka' ? 307 : 401 }), log: () => {},
  })
})

test('compile failures cannot report preview ready', async () => {
  for (const status of [404, 500, 503, 307]) {
    await assert.rejects(warmPreview('http://localhost:3000', {
      fetcher: async () => new Response(null, { status }), log: () => {},
    }), new RegExp(`HTTP ${status}`))
  }
})

test('optional warmup aborts a stalled request instead of hanging startup work', async () => {
  const keepAlive = setInterval(() => {}, 1000)
  let calls = 0
  try {
    await assert.rejects(warmPreview('http://localhost:3000', {
      timeout: 10,
      fetcher: async (_url, { signal }) => {
        calls++
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      log: () => {},
    }), { name: 'TimeoutError' })
    assert.equal(calls, previewWarmupPaths.length)
  } finally {
    clearInterval(keepAlive)
  }
})

test('page requests never wait for unrelated AI routes or readiness marker files', async () => {
  const proxy = await readFile(new URL('../proxy.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(proxy, /waitForPreviewReady|PREVIEW_READY_FILE|await ready/)
  assert.match(proxy, /return localize\(request\)/)
})

test('preview bootstrap script is inside head to avoid hydration failure', async () => {
  const layout = await readFile(new URL('../app/[locale]/layout.tsx', import.meta.url), 'utf8')
  assert.match(layout, /<head>[\s\S]*?<Script id="disable-openui-devtools" strategy="beforeInteractive">[\s\S]*?<\/head>\s*<body/)
  assert.doesNotMatch(layout, /<html[^>]*>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?\{process\.env/)
})

test('startup keeps Next readiness output intact and makes precompilation opt-in', async () => {
  const script = await readFile(new URL('../scripts/dev-preview.mjs', import.meta.url), 'utf8')
  assert.match(script, /process\.env\.PREVIEW_WARMUP !== '1'/)
  assert.match(script, /process\.stdout\.write\(text\)/)
  assert.doesNotMatch(script, /PREVIEW_READY_FILE|writeFile|text\.replace/)
})
