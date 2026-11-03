import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiCache } from '../lib/api-cache.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('an old-account prefetch cannot populate the next account cache after sign-out', async () => {
  const cache = new ApiCache(), old = deferred<string>(), next = deferred<string>()
  const oldRead = cache.prefetch('/api/mobile/chat', () => old.promise)
  cache.clear()
  const nextRead = cache.prefetch('/api/mobile/chat', () => next.promise)
  next.resolve('next account'); await nextRead
  old.resolve('old account private chat'); await oldRead
  assert.equal(cache.get('/api/mobile/chat'), 'next account')
})

test('a pending workspace read cannot update the mounted view after context changes', async () => {
  const cache = new ApiCache(), response = deferred<string>()
  let visible = 'empty'
  const previous = cache.context()
  const pending = response.promise.then(value => cache.commit(previous, () => { visible = value }))
  cache.clear()
  cache.commit(cache.context(), () => { visible = 'workspace B' })
  response.resolve('late workspace A'); await pending
  assert.equal(visible, 'workspace B')
})

test('a mutation setter captured before switching cannot write into the current cache or view', () => {
  const cache = new ApiCache(), previous = cache.context()
  let changed = false
  const setPrevious = () => cache.commit(previous, () => { changed = true; cache.set('/settings', 'previous', previous) })
  cache.clear()
  cache.set('/settings', 'current', cache.context())
  assert.equal(setPrevious(), false)
  assert.equal(changed, false)
  assert.equal(cache.get('/settings'), 'current')
})

test('a current context still caches prefetched reads and accepts a saved mutation', async () => {
  const cache = new ApiCache()
  await cache.prefetch('/chat', async () => 'current chat')
  assert.equal(cache.get('/chat'), 'current chat')
  await cache.prefetch('/chat', async () => assert.fail('a current cached read is reused'))
  assert.equal(cache.set('/chat', 'saved', cache.context()), true)
  assert.equal(cache.get('/chat'), 'saved')
})

test('a direct account switch fences responses even if an older sign-out has not finished', async () => {
  const cache = new ApiCache(), response = deferred<string>()
  cache.setIdentity('account A')
  const pending = cache.prefetch('/chat', () => response.promise)
  cache.setIdentity('account B')
  cache.set('/chat', 'account B', cache.context())
  response.resolve('late account A'); await pending
  assert.equal(cache.get('/chat'), 'account B')
  const context = cache.context()
  cache.setIdentity('account B')
  assert.equal(cache.context(), context, 'the same signed-in identity keeps its cache')
})
