import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { withholdsCachedRead } from '../lib/api-read-state.ts'
import { ApiCache, apiCache } from '../lib/api-cache.ts'

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

test('a confirmed denial retires only the requested path across mounted readers and prefetches', async () => {
  const cache = new ApiCache(), path = '/api/mobile/tasks'
  cache.setIdentity('member')
  const context = cache.context(), result = deferred<string>()
  const loading = cache.prefetch(path, () => result.promise)
  cache.set(path, 'tasks before decision', context)
  cache.set('/api/mobile/home', 'separate permitted response', context)
  const notifications: Error[] = []
  const offTasks = cache.onRevoked(path, reason => notifications.push(reason))
  const offSearch = cache.onRevoked(path, reason => notifications.push(reason))
  const reason = new Error('workspaceAccessDenied')
  cache.revoke(path, context, reason)
  assert.deepEqual(notifications, [reason, reason])
  assert.equal(cache.get(path), null)
  assert.equal(cache.revision(path), 1)
  assert.equal(cache.get('/api/mobile/home'), 'separate permitted response')
  result.resolve('old response'); await loading
  assert.equal(cache.get(path), null)
  offTasks(); offSearch()
  await cache.prefetch(path, async () => 'authorized again')
  assert.equal(cache.get(path), 'authorized again')
  cache.setIdentity('next member')
  cache.set(path, 'next member tasks', cache.context())
  cache.revoke(path, context, reason)
  assert.equal(cache.get(path), 'next member tasks')
  assert.equal(cache.revision(path), 0)
})

test('only explicit resource denials evict an already authorized response', () => {
  assert.equal(withholdsCachedRead(403), true)
  assert.equal(withholdsCachedRead(404), true)
  for (const status of [0, 409, 429, 500, 502, 503, 504]) assert.equal(withholdsCachedRead(status), false)
})

test('two mounted readers remove denied rows, ignore a late success, and retain prior rows on 503', async () => {
  const { Window } = await import('happy-dom')
  const browser = new Window({ url: 'https://fixture.example' })
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement, Fragment } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const path = '/api/mobile/tasks'
  class ApiError extends Error {
    constructor(readonly status: number) { super(String(status)) }
  }
  const noop = () => {}
  const requests: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = []
  const read = () => new Promise<string>((resolve, reject) => requests.push({ resolve, reject }))
  const module = (name: string) => new URL('../lib/' + name + '.ts', import.meta.url).href
  mock.module('react-native', { namedExports: { AppState: { addEventListener: () => ({ remove: noop }) } } })
  mock.module(module('api'), { namedExports: { api: read, ApiError, onWorkspaceChange: () => noop } })
  mock.module(module('live'), { namedExports: { live: { reset: noop }, useLive: noop } })
  const { useApi } = await import('../lib/useApi.ts')
  const reads: Array<ReturnType<typeof useApi<string>>> = []
  function Reader({ index }: { index: number }) {
    reads[index] = useApi<string>(path)
    return createElement('span', null, reads[index].data)
  }
  const root = createRoot(document.body)
  apiCache.setIdentity('member')
  try {
    await act(async () => root.render(createElement(Fragment, null, createElement(Reader, { index: 0 }), createElement(Reader, { index: 1 }))))
    assert.equal(requests.length, 2)
    await act(async () => { requests[0].resolve('allowed'); requests[1].resolve('allowed') })
    assert.deepEqual(reads.map(r => r.data), ['allowed', 'allowed'])
    await act(async () => { void reads[0].reload(); requests[2].reject(new ApiError(503)) })
    assert.deepEqual(reads.map(r => r.data), ['allowed', 'allowed'])
    const oldSetter = reads[1].setData
    await act(async () => { void reads[0].reload(); void reads[1].reload(); requests[3].reject(new ApiError(403)) })
    assert.deepEqual(reads.map(r => r.data), [null, null])
    assert.equal(apiCache.get(path), null)
    await act(async () => { oldSetter('stale mutation'); requests[4].resolve('stale read') })
    assert.equal(document.body.textContent, '')
    await act(async () => { void reads[1].reload(); requests[5].resolve('authorized again') })
    assert.equal(reads[1].data, 'authorized again')
    await act(async () => { void reads[1].reload(); requests[6].reject(new ApiError(404)) })
    assert.equal(apiCache.get(path), null)
    assert.equal(document.body.textContent, '')
  } finally {
    await act(async () => root.unmount())
    apiCache.setIdentity(null)
    await browser.happyDOM.close()
  }
})
