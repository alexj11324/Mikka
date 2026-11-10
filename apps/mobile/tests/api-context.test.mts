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

test('revocation retires visible data and an older in-flight read cannot restore it', () => {
  const cache = new ApiCache()
  cache.setIdentity('member')
  cache.accessProof('workspace','before')
  cache.set('/thread','private execution',cache.context())
  const previous = cache.context()
  let notified = 0
  const unwatch = cache.watch(() => { notified++ })
  cache.accessProof('workspace','after')
  assert.equal(cache.get('/thread'),null)
  assert.equal(cache.set('/thread','late private execution',previous),false)
  assert.equal(notified,1)
  unwatch()
})

test('an old ticket cannot retire or change a newly signed-in account cache', () => {
  const cache = new ApiCache()
  cache.setIdentity('first')
  const ticketContext = cache.context()
  cache.setIdentity('second')
  cache.set('/thread','second account',cache.context())
  assert.equal(cache.commit(ticketContext,()=>cache.accessProof('workspace','old',new Date(0).toISOString())),false)
  assert.equal(cache.get('/thread'),'second account')
})

test('known grant expiry clears content without a socket event and cancels its only timer', context => {
  context.mock.timers.enable({apis:['Date','setTimeout'],now:10_000})
  const cache = new ApiCache(() => Date.now())
  cache.setIdentity('member')
  cache.accessProof('workspace','proof','2099-01-01T00:00:00.000Z',1000,10_000)
  cache.set('/thread','temporarily authorized',cache.context())
  context.mock.timers.tick(999)
  assert.equal(cache.get('/thread'),'temporarily authorized')
  context.mock.timers.tick(1)
  assert.equal(cache.get('/thread'),null)
  const generation = cache.context()
  context.mock.timers.tick(60_000)
  assert.equal(cache.context(),generation,'expiry does not start an idle polling loop')
  cache.setIdentity(null)
})

test('a delayed ticket cannot extend a grant using the client wall clock', context => {
  context.mock.timers.enable({ apis: ['Date','setTimeout'], now: 20_000 })
  const cache = new ApiCache(() => Date.now())
  cache.setIdentity('member')
  cache.set('/thread','old authorized view',cache.context())
  cache.accessProof('workspace','proof','2099-01-01T00:00:00.000Z',1000,18_000)
  assert.equal(cache.get('/thread'),null)
  cache.setIdentity(null)
})
