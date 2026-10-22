import { test } from 'node:test'
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
  assert.deepEqual(seen, previewWarmupPaths)
  assert.ok(seen.includes('/api/agent'))
})

test('compile failures cannot report preview ready', async () => {
  for (const status of [404, 500, 503, 307]) {
    await assert.rejects(warmPreview('http://localhost:3000', {
      fetcher: async () => new Response(null, { status }), log: () => {},
    }), new RegExp(`HTTP ${status}`))
  }
})

test('page gate waits for startup compilation rather than triggering it', async () => {
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

test('failed or timed out compilation blocks page readiness', async () => {
  assert.equal(await waitForPreviewReady('test', { read: async () => 'failed' }), false)
  assert.equal(await waitForPreviewReady('test', { read: async () => 'pending', delay: async () => {}, timeout: 0 }), false)
})

test('production and ordinary non-gated invocations need no marker', async () => {
  assert.equal(await waitForPreviewReady(undefined), true)
})
