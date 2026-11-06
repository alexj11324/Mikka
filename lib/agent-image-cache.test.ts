import assert from 'node:assert/strict'
import test from 'node:test'
import { publicImageLookup, type PublicImageCacheEntry } from './agent-image-cache'

const image = { src: 'https://upload.wikimedia.org/public.jpg', source: 'https://commons.wikimedia.org/wiki/File:Public.jpg', width: 500, height: 300, title: 'Public', author: 'Public author', license: 'CC0' }

test('public lookup keeps one-day freshness and stale revalidation without credential input', async () => {
  const values = new Map<string, PublicImageCacheEntry>(), scheduled: Array<() => Promise<void>> = []
  let now = 1000, reads = 0, fail = false
  const lookup = publicImageLookup({ get: async key => values.get(key), set: async (key, value) => { assert.match(key, /^[a-f0-9]{64}$/); values.set(key, value) } }, async query => {
    reads++; assert.equal(query, 'Public example'); if (fail) throw new Error('upstream'); return image
  }, work => { scheduled.push(work) }, () => now)
  assert.deepEqual(await lookup(' Public example '), image); assert.equal(reads, 1)
  now += 86_399_000
  assert.deepEqual(await lookup('Public example'), image); assert.equal(reads, 1)
  now += 2000; fail = true
  assert.deepEqual(await lookup('Public example'), image); assert.deepEqual(await lookup('Public example'), image)
  assert.equal(scheduled.length, 1); await scheduled.shift()!(); assert.equal(reads, 2)
  assert.deepEqual([...values.values()][0].value, image)
  fail = false; await lookup('Public example'); await scheduled.shift()!(); assert.equal([...values.values()][0].at, now)
  await lookup('Public example'); assert.equal(reads, 3)
})

test('cold error and cancellation propagate; unsafe cache projections cannot bypass the fixed loader', async () => {
  let reads = 0
  const lookup = publicImageLookup({ get: async () => ({ at: 0, value: { ...image, src: 'http://127.0.0.1/private' } }), set: async () => {} }, async (_query, signal) => {
    reads++; signal?.throwIfAborted(); throw new Error('upstream')
  }, () => { throw new Error('unexpected background') })
  await assert.rejects(lookup('Public example'), /upstream/)
  await assert.rejects(lookup('https://private.invalid'))
  await assert.rejects(lookup('Public example', AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(reads, 1)
})
