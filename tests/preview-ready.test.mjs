import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { warmPreview, previewWarmupPaths } from '../scripts/dev-preview.mjs'
import { waitForPreviewReady } from '../lib/preview-ready.mjs'

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
  assert.deepEqual(seen, previewWarmupPaths.map(path => `/mikka${path}`))
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

test('compile failures cannot report preview ready', async () => {
  for (const status of [404, 500, 503, 307]) {
    await assert.rejects(warmPreview('http://localhost:3000', {
      fetcher: async () => new Response(null, { status }), log: () => {},
    }), new RegExp(`HTTP ${status}`))
  }
})

test('startup diagnostic marker waits for compilation', async () => {
  let reads = 0
  let delays = 0
  const ready = await waitForPreviewReady('test-ready', {
    read: async () => {
      if (++reads === 1) throw Object.assign(new Error('pending'), { code: 'ENOENT' })
      return 'ready'
    },
    delay: async () => { delays++ },
  })
  assert.equal(ready, true)
  assert.equal(delays, 1)
})

test('failed or timed out compilation reports diagnostic failure', async () => {
  assert.equal(await waitForPreviewReady('test', { read: async () => 'failed' }), false)
  assert.equal(await waitForPreviewReady('test', { read: async () => 'pending', delay: async () => {}, timeout: 0 }), false)
})

test('page proxy does not wait for background chat compilation', async () => {
  const source = await readFile(new URL('../proxy.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /waitForPreviewReady|PREVIEW_READY_FILE/)
})

test('production and ordinary non-gated invocations need no marker', async () => {
  assert.equal(await waitForPreviewReady(undefined), true)
})
