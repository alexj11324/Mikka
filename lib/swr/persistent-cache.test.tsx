import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act, StrictMode } from 'react'
import { Window } from 'happy-dom'
import { clearPersistentReadCaches, PersistentReadCache, readCacheNamespace, type ReadCacheScope } from './persistent-cache'
import type { ReadStorage, StoredRead } from './indexed-db'
import { registerLiveKeyConnection } from './live-focus'

const scope: ReadCacheScope = { userId: 'owner', workspaceId: 'team', build: 'build-one', role: 'admin' }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) }
}
class MemoryStorage implements ReadStorage {
  active: string | undefined
  rows = new Map<string, StoredRead>()
  activation?: Promise<StoredRead[]>
  clears: (string | undefined)[] = []
  async activate(namespace: string) { this.active = namespace; return this.activation ?? [...this.rows.values()] }
  async write(namespace: string, value: StoredRead) { if (this.active === namespace) this.rows.set(value.key, value) }
  async remove(_namespace: string, key: string) { this.rows.delete(key) }
  async clear(namespace?: string) {
    this.clears.push(namespace)
    if (namespace && this.active !== namespace) return
    this.rows.clear(); this.active = undefined
  }
}
const restore = (cache: PersistentReadCache) => async (key: string, data: unknown) => { cache.set(key, { ...cache.get(key), data }) }
const stored = (data: unknown): StoredRead => ({ key: 'preferences', rawKey: 'preferences', data, savedAt: 1 })

const browser = new Window({ url: 'https://mikka.example/mikka/en' })
let createRoot: typeof import('react-dom/client')['createRoot']
let swr: typeof import('swr')
let useSWRInfinite: typeof import('swr/infinite')['default']
let HydrateReadCache: typeof import('../../components/authenticated-read-cache')['HydrateReadCache']
let AuthenticatedReadCache: typeof import('../../components/authenticated-read-cache')['AuthenticatedReadCache']
let swrDefaults: typeof import('../../components/swr-defaults')['swrDefaults']
let requestedWorkspace: string | null = null
let refreshes = 0
const router = { refresh: () => { refreshes++ } }
mock.module('next/navigation', { namedExports: { useSearchParams: () => ({ get: () => requestedWorkspace }) } })
mock.module(new URL('../../i18n/navigation.ts', import.meta.url).href, { namedExports: { useRouter: () => router } })
mock.module(new URL('../app-build.ts', import.meta.url).href, { namedExports: { APP_BUILD: 'build-one', pageNeedsRefresh: () => false } })

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  swr = await import('swr')
  ;({ default: useSWRInfinite } = await import('swr/infinite'))
  ;({ HydrateReadCache, AuthenticatedReadCache } = await import('../../components/authenticated-read-cache'))
  ;({ swrDefaults } = await import('../../components/swr-defaults'))
})
after(async () => { mock.restoreAll(); await browser.close() })

test('disk namespaces distinguish owner, viewed workspace, build and authorized role', () => {
  const baseline = readCacheNamespace(scope)
  for (const change of [{ userId: 'other' }, { workspaceId: 'other' }, { build: 'build-two' }, { role: 'member' }]) {
    assert.notEqual(readCacheNamespace({ ...scope, ...change }), baseline)
  }
})

test('installed UI may supply its build identity while retaining server workspace authority', async () => {
  const observed: (string | null)[] = []
  function Read() {
    const { cache } = swr.useSWRConfig()
    observed.push(cache instanceof PersistentReadCache ? cache.namespace : null)
    return <output>shared cache</output>
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  const workspace = { workspaceId: scope.workspaceId, role: 'admin' as const }
  const nativeBuild = 'desktop:installed-content-hash:https://mikka.example'
  try {
    await act(async () => root.render(<AuthenticatedReadCache ownerId={scope.userId} workspace={workspace}><Read /></AuthenticatedReadCache>))
    assert.equal(observed.at(-1), readCacheNamespace(scope), 'web keeps its deployment build by default')
    await act(async () => root.render(<AuthenticatedReadCache ownerId={scope.userId} workspace={workspace} build={nativeBuild}><Read /></AuthenticatedReadCache>))
    assert.equal(observed.at(-1), readCacheNamespace({ ...scope, build: nativeBuild }))
    requestedWorkspace = 'unproven-workspace'
    await act(async () => root.render(<AuthenticatedReadCache ownerId={scope.userId} workspace={workspace} build={nativeBuild}><Read /></AuthenticatedReadCache>))
    assert.equal(observed.at(-1), null, 'changing the URL cannot borrow the old workspace authority')
  } finally { requestedWorkspace = null; await act(async () => root.unmount()) }
})

test('fresh server seed and an optimistic write both win over a late disk hydration', async () => {
  for (const seedBeforeStart of [true, false]) {
    const storage = new MemoryStorage(), held = deferred<StoredRead[]>()
    storage.activation = held.promise
    const cache = new PersistentReadCache(scope, storage)
    const fresh = { theme: 'fresh' }
    if (seedBeforeStart) cache.set('preferences', { data: fresh, _k: 'preferences' })
    const hydration = cache.hydrate(restore(cache))
    if (!seedBeforeStart) cache.set('preferences', { data: fresh, _k: 'preferences' })
    held.resolve([stored({ theme: 'old disk' })]); await hydration
    assert.equal(cache.get('preferences')?.data, fresh)
    assert.equal(cache.isHydrated, true)
  }
})

test('deleting a key while disk opens prevents its resurrection', async () => {
  const storage = new MemoryStorage(), held = deferred<StoredRead[]>()
  storage.activation = held.promise
  const cache = new PersistentReadCache(scope, storage)
  const hydration = cache.hydrate(restore(cache))
  cache.delete('preferences')
  held.resolve([stored({ theme: 'deleted' })]); await hydration; await cache.flushed()
  assert.equal(cache.get('preferences'), undefined)
  assert.equal(storage.rows.has('preferences'), false)
})

test('revocation during hydration retires the cache and clears after queued disk work', async () => {
  const storage = new MemoryStorage(), held = deferred<StoredRead[]>()
  storage.activation = held.promise
  const cache = new PersistentReadCache(scope, storage)
  const hydration = cache.hydrate(restore(cache))
  cache.invalidate(false)
  cache.set('preferences', { data: { theme: 'late request' } })
  held.resolve([stored({ theme: 'old disk' })]); await hydration; await cache.flushed()
  assert.equal(cache.size, 0)
  assert.equal(cache.isEnabled, false)
  assert.equal(storage.rows.size, 0)
  assert.deepEqual(storage.clears, [readCacheNamespace(scope)])
})

test('an old tab retiring its namespace does not erase the newly activated account', async () => {
  const storage = new MemoryStorage()
  const cache = new PersistentReadCache(scope, storage)
  await cache.hydrate(restore(cache))
  storage.active = readCacheNamespace({ ...scope, userId: 'new-account' })
  storage.rows.set('preferences', stored({ theme: 'new account' }))
  cache.invalidate(false); await cache.flushed()
  assert.deepEqual(storage.rows.get('preferences')?.data, { theme: 'new account' })
})

test('unavailable storage still releases authorized network reads', async () => {
  const storage = new MemoryStorage()
  storage.activate = async () => { throw new DOMException('storage blocked', 'SecurityError') }
  const cache = new PersistentReadCache(scope, storage)
  await cache.hydrate(restore(cache)); await cache.hydrated
  assert.equal(cache.isHydrated, true)
  cache.set('preferences', { data: { theme: 'network' } })
  assert.deepEqual(cache.get('preferences')?.data, { theme: 'network' })
})

test('task not found removes its detail and activity history, including a delayed disk restore', async () => {
  const storage = new MemoryStorage(), disk = deferred<StoredRead[]>()
  storage.activation = disk.promise
  const cache = new PersistentReadCache(scope, storage)
  const issue = ['issue', 'removed-task'], history = ['issue-activity-versions', 'removed-task']
  const issueKey = swr.unstable_serialize(issue), historyKey = swr.unstable_serialize(history)
  const hydration = cache.hydrate(restore(cache))
  cache.set(issueKey, { _k: issue, error: { status: 404 } })
  disk.resolve([{ key: historyKey, rawKey: history, savedAt: 1, data: { version: 'old', items: [{ id: 'history', title: 'deleted task' }] } }])
  await hydration; await cache.flushed()
  assert.equal(cache.get(issueKey)?.data, undefined)
  assert.equal(cache.get(historyKey), undefined)
  assert.equal(storage.rows.has(historyKey), false)
})

test('global clear waits for a provider that unregisters synchronously on invalidation', async () => {
  const storage = new MemoryStorage(), clearing = deferred<void>(), entered = deferred<void>()
  storage.clear = async () => { entered.resolve(); await clearing.promise; storage.rows.clear() }
  const cache = new PersistentReadCache(scope, storage)
  await cache.hydrate(restore(cache))
  let disconnect = () => {}
  disconnect = cache.connect(() => disconnect())
  let complete = false
  const pending = clearPersistentReadCaches().then(() => { complete = true })
  await entered.promise
  assert.equal(complete, false)
  clearing.resolve(); await pending
  assert.equal(complete, true)
})

for (const navigationType of ['document', undefined] as const) test(navigationType
  ? 'full-document navigation retires old readers while private storage finishes clearing'
  : 'ordinary cache invalidation still refreshes and replaces the retired provider', async () => {
  const { IndexedReadStorage } = await import('./indexed-db')
  const { NextIntlClientProvider } = await import('next-intl')
  const clearing = deferred<void>(), entered = deferred<void>()
  const activate = mock.method(IndexedReadStorage.prototype, 'activate', async () => [])
  const write = mock.method(IndexedReadStorage.prototype, 'write', async () => undefined)
  const clear = mock.method(IndexedReadStorage.prototype, 'clear', async () => { entered.resolve(); await clearing.promise })
  let reads = 0
  let retired: PersistentReadCache | undefined
  function Read() {
    const { cache } = swr.useSWRConfig()
    if (cache instanceof PersistentReadCache) retired = cache
    const { data } = swr.default('preferences', async () => { reads++; return { theme: 'authorized data' } })
    return <output>{data?.theme ?? 'loading'}</output>
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  const beforeRefresh = refreshes
  let navigation: Promise<void> | undefined
  try {
    const render = (workspaceId: string) => <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ Workspace: { loadingEditor: 'Loading workspace' } }}><swr.SWRConfig value={swrDefaults}>
      <AuthenticatedReadCache ownerId={scope.userId} workspace={{ workspaceId, role: 'admin' }}><Read /></AuthenticatedReadCache>
    </swr.SWRConfig></NextIntlClientProvider>
    await act(async () => root.render(render(scope.workspaceId)))
    assert.equal(reads, 1)
    assert.equal(container.textContent, 'authorized data')
    let cleared = false
    await act(async () => {
      navigation = clearPersistentReadCaches({ documentNavigation: navigationType === 'document' }).then(() => { cleared = true })
      await entered.promise
    })
    assert.equal(cleared, false, 'the same-document pause must not pretend storage is already cleared')
    assert.equal(retired?.isEnabled, false)
    assert.equal(retired?.size, 0)
    assert.equal(reads, navigationType ? 1 : 2, 'only an ordinary invalidation remounts readers in the current document')
    assert.equal(refreshes, beforeRefresh + (navigationType ? 0 : 1), 'a full replacement document owns the new bootstrap')
    if (navigationType) assert.equal(container.querySelector('output'), null, 'old business data and readers are unmounted immediately')
    await act(async () => { clearing.resolve(); await navigation })
    assert.equal(cleared, true)
    assert.equal(reads, navigationType ? 1 : 2)
    await act(async () => root.render(render('new-authorized-workspace')))
    assert.equal(reads, navigationType ? 2 : 3, 'the replacement scope must make its own ordinary authorized read')
    assert.equal(container.textContent, 'authorized data')
  } finally {
    clearing.resolve(); await navigation
    await act(async () => root.unmount())
    activate.mock.restore(); write.mock.restore(); clear.mock.restore()
  }
})

test('a document navigation broadcasts ordinary invalidation to other tabs', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')
  const channels: FakeChannel[] = []
  class FakeChannel {
    onmessage?: (event: { data: unknown }) => void
    sent: unknown[] = []
    constructor(readonly name: string) { channels.push(this) }
    postMessage(value: unknown) { this.sent.push(value) }
    close() {}
  }
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, writable: true, value: FakeChannel })
  const local = new PersistentReadCache(scope, new MemoryStorage())
  const localReasons: boolean[] = [], remoteReasons: boolean[] = []
  const disconnect = local.connect(reason => localReasons.push(reason))
  let disconnectRemote = () => {}
  try {
    await clearPersistentReadCaches({ documentNavigation: true })
    assert.deepEqual(localReasons, [true])
    const clear = channels.flatMap(channel => channel.sent).find(value => (value as { type?: string }).type === 'clear')
    assert.deepEqual(clear, { type: 'clear' }, 'another tab never inherits this document navigation')
    disconnect()
    const remote = new PersistentReadCache(scope, new MemoryStorage())
    disconnectRemote = remote.connect(reason => remoteReasons.push(reason))
    channels.at(-1)!.onmessage!({ data: clear })
    assert.equal(remote.isEnabled, false)
    assert.equal(remote.size, 0)
    assert.deepEqual(remoteReasons, [false])
    await remote.flushed()
  } finally {
    disconnect(); disconnectRemote()
    if (original) Object.defineProperty(globalThis, 'BroadcastChannel', original)
    else Reflect.deleteProperty(globalThis, 'BroadcastChannel')
  }
})

test('unmounted providers retire before late activation, while a StrictMode reconnect stays enabled', async () => {
  for (const reconnect of [false, true]) {
    const cache = new PersistentReadCache(scope, new MemoryStorage())
    const disconnect = cache.connect(() => {})
    disconnect()
    const disconnectAgain = reconnect ? cache.connect(() => {}) : () => {}
    await Promise.resolve()
    assert.equal(cache.isEnabled, reconnect)
    disconnectAgain(); await Promise.resolve()
  }
})

for (const strict of [false, true]) test(`real SWR${strict ? ' in StrictMode' : ''} waits for disk and accepts exactly one fresh first response`, async () => {
  const storage = new MemoryStorage(), disk = deferred<StoredRead[]>(), network = deferred<{ theme: string }>()
  storage.activation = disk.promise
  const cache = new PersistentReadCache(scope, storage)
  let reads = 0
  const seen: string[] = []
  function Read() {
    const result = swr.default('preferences', async () => { reads++; return network.promise })
    const text = result.data?.theme ?? 'loading'
    seen.push(text)
    return <output>{text}</output>
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  try {
    const content = <swr.SWRConfig value={{ ...swrDefaults, provider: () => cache }}><HydrateReadCache /><Read /></swr.SWRConfig>
    await act(async () => root.render(strict ? <StrictMode>{content}</StrictMode> : content))
    assert.equal(reads, 0, 'no FETCH start timestamp exists before hydration mutations')
    assert.equal(container.textContent, 'loading')
    await act(async () => { disk.resolve([stored({ theme: 'disk preview' })]); await cache.hydrated })
    assert.equal(container.textContent, 'disk preview')
    assert.equal(reads, 1)
    await act(async () => { network.resolve({ theme: 'fresh network' }); await network.promise })
    assert.equal(container.textContent, 'fresh network', 'SWR must not discard the response as predating the hydration mutation')
    assert.equal(reads, 1)
    assert.ok(seen.indexOf('disk preview') < seen.indexOf('fresh network'))
  } finally { await act(async () => root.unmount()); await cache.flushed() }
})

test('real SWR starts a cold read after an empty or failed disk hydrate', async () => {
  for (const failed of [false, true]) {
    const storage = new MemoryStorage()
    if (failed) storage.activate = async () => { throw new Error('blocked storage') }
    const cache = new PersistentReadCache(scope, storage)
    let reads = 0
    function Read() {
      const { data } = swr.default('preferences', async () => { reads++; return { theme: 'network only' } })
      return <output>{data?.theme ?? 'loading'}</output>
    }
    const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
    try {
      await act(async () => root.render(<swr.SWRConfig value={{ ...swrDefaults, provider: () => cache }}><HydrateReadCache /><Read /></swr.SWRConfig>))
      assert.equal(container.textContent, 'network only')
      assert.equal(reads, 1)
    } finally { await act(async () => root.unmount()); await cache.flushed() }
  }
})

test('a cold paginated settings read resumes after hydration with its real aggregate key', async () => {
  const storage = new MemoryStorage(), disk = deferred<StoredRead[]>()
  storage.activation = disk.promise
  const cache = new PersistentReadCache(scope, storage)
  let reads = 0
  function Audit() {
    const pages = useSWRInfinite((index, previous: { events: string[]; nextCursor: string | null } | null) => {
      if (previous && !previous.nextCursor) return null
      return ['settings:audit', scope.workspaceId, 'all', index === 0 ? null : previous?.nextCursor]
    }, async () => { reads++; return { events: ['authorized audit row'], nextCursor: null } }, { revalidateFirstPage: false })
    return <output>{pages.data?.[0]?.events[0] ?? (pages.isLoading ? 'loading' : 'empty')}</output>
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  try {
    await act(async () => root.render(<swr.SWRConfig value={{ ...swrDefaults, provider: () => cache }}><HydrateReadCache /><Audit /></swr.SWRConfig>))
    assert.equal(reads, 0, 'the private paginated read waits for authenticated cache hydration')
    await act(async () => { disk.resolve([]); await cache.hydrated })
    assert.equal(reads, 1, 'hydration must resume the infinite hook, not mutate an unmounted ordinary page key')
    assert.equal(container.textContent, 'authorized audit row')
    await cache.flushed()
    assert.equal(storage.rows.size, 0, 'private audit responses remain excluded from persistence')
  } finally { await act(async () => root.unmount()); await cache.flushed() }
})

test('the authenticated boundary seeds real SWR before an inner fallback can be replaced by disk', async () => {
  const { IndexedReadStorage } = await import('./indexed-db')
  const disk = deferred<StoredRead[]>(), writes: unknown[] = []
  const activate = mock.method(IndexedReadStorage.prototype, 'activate', () => disk.promise)
  const write = mock.method(IndexedReadStorage.prototype, 'write', async (_scope: string, value: StoredRead) => { writes.push(value.data) })
  const clear = mock.method(IndexedReadStorage.prototype, 'clear', async () => undefined)
  const fresh = { theme: 'fresh server' }, held = deferred<{ theme: string }>()
  let reads = 0
  let revalidate!: () => Promise<unknown>
  function Read() {
    const { data, mutate } = swr.default('preferences', async () => { reads++; return held.promise })
    revalidate = mutate
    return <output>{data?.theme ?? 'loading'}</output>
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  try {
    await act(async () => root.render(<swr.SWRConfig value={swrDefaults}>
      <AuthenticatedReadCache ownerId={scope.userId} workspace={{ workspaceId: scope.workspaceId, role: 'admin' }} initialReads={[{ key: 'preferences', data: fresh }]}>
        <swr.SWRConfig value={{ fallback: { preferences: fresh } }}><Read /></swr.SWRConfig>
      </AuthenticatedReadCache>
    </swr.SWRConfig>))
    assert.equal(container.textContent, 'fresh server')
    await act(async () => { disk.resolve([stored({ theme: 'old disk' })]); await disk.promise })
    assert.equal(container.textContent, 'fresh server')
    assert.equal(reads, 0, 'the server seed has just been authorized and read; hydration does not repeat that read')
    await act(async () => { void revalidate() })
    assert.equal(reads, 1)
    await act(async () => { held.resolve({ theme: 'fresh network' }); await held.promise })
    assert.equal(container.textContent, 'fresh network')
    assert.ok(writes.every(value => (value as { theme: string }).theme !== 'old disk'))
  } finally {
    await act(async () => root.unmount())
    assert.equal(clear.mock.calls.length, 0, 'normal unmount keeps the authorized warm snapshot on disk')
    activate.mock.restore(); write.mock.restore(); clear.mock.restore()
  }
})

test('hydration respects a read explicitly disabled on mount', async () => {
  const cache = new PersistentReadCache(scope, new MemoryStorage())
  let reads = 0
  function Read() {
    swr.default(['coordinator-chat-metadata', 'bot'], async () => { reads++; return 'metadata' }, { revalidateOnMount: false })
    return null
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  try {
    await act(async () => root.render(<swr.SWRConfig value={{ ...swrDefaults, provider: () => cache }}><HydrateReadCache /><Read /></swr.SWRConfig>))
    assert.equal(reads, 0)
  } finally { await act(async () => root.unmount()); await cache.flushed() }
})

test('real SWR keeps a connected key fresh for five minutes, then validates in the background and catches a disconnect', async () => {
  const cache = new PersistentReadCache(scope, new MemoryStorage()), held = deferred<string>()
  let now = 1_000_000, connected: boolean | undefined = true, reads = 0
  const clock = mock.method(Date, 'now', () => now)
  const unregister = registerLiveKeyConnection(cache, ['preferences'], () => connected)
  const focus = async () => { await act(async () => { browser.dispatchEvent(new browser.Event('focus')); await new Promise(resolve => setTimeout(resolve, 10)) }) }
  function Read() {
    const { data, isLoading } = swr.default('preferences', async () => { reads++; return reads === 2 ? held.promise : `read ${reads}` }, { dedupingInterval: 0 })
    return <output data-loading={String(isLoading)}>{data ?? 'loading'}</output>
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  try {
    await act(async () => root.render(<swr.SWRConfig value={{ ...swrDefaults, provider: () => cache }}><HydrateReadCache /><Read /></swr.SWRConfig>))
    assert.equal(reads, 1)
    now += 240_000; await focus(); assert.equal(reads, 1)
    now += 60_001; await focus(); assert.equal(reads, 2)
    assert.equal(container.textContent, 'read 1')
    assert.equal(container.firstElementChild?.getAttribute('data-loading'), 'false')
    await act(async () => { held.resolve('read 2'); await held.promise })
    assert.equal(container.textContent, 'read 2')
    now += 1; await focus(); assert.equal(reads, 2)
    connected = false; now += 1; await focus(); assert.equal(reads, 3)
    assert.equal(container.textContent, 'read 3')
    connected = undefined; now += 60_001; await focus(); assert.equal(reads, 4, 'a read without push coverage keeps its previous one-minute freshness')
  } finally { unregister(); await act(async () => root.unmount()); clock.mock.restore(); await cache.flushed() }
})

test('a server-denied workspace clears durable data without hydrating or refreshing in a loop', async () => {
  const { IndexedReadStorage } = await import('./indexed-db')
  const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {} })
  let clears = 0, activations = 0
  const clear = mock.method(IndexedReadStorage.prototype, 'clear', async () => { clears++ })
  const activate = mock.method(IndexedReadStorage.prototype, 'activate', async () => { activations++; return [] })
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  const beforeRefresh = refreshes
  try {
    requestedWorkspace = 'revoked-workspace'
    await act(async () => root.render(<AuthenticatedReadCache ownerId={scope.userId} workspace={null}><output>unavailable</output></AuthenticatedReadCache>))
    assert.equal(clears, 1)
    assert.equal(activations, 0)
    assert.equal(refreshes, beforeRefresh)
  } finally {
    requestedWorkspace = null
    await act(async () => root.unmount())
    clear.mock.restore(); activate.mock.restore()
    if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB)
    else Reflect.deleteProperty(globalThis, 'indexedDB')
  }
})

test('a document workspace departure retires readers instead of reading again before navigation', async t => {
  let reads = 0, departed: PersistentReadCache | undefined, latest: PersistentReadCache | undefined
  function Read() {
    const { cache } = swr.useSWRConfig()
    if (cache instanceof PersistentReadCache) { departed ??= cache; latest = cache }
    const { data } = swr.default('preferences', async () => { reads++; return { theme: `read ${reads}` } })
    return <output>{data?.theme ?? 'loading'}</output>
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement
  let root = createRoot(container)
  const beforeRefresh = refreshes
  const content = () => <swr.SWRConfig value={swrDefaults}><AuthenticatedReadCache ownerId={scope.userId} workspace={{ workspaceId: scope.workspaceId, role: 'admin' }}><Read /></AuthenticatedReadCache></swr.SWRConfig>
  try {
    await act(async () => root.render(content()))
    assert.equal(reads, 1)
    assert.equal(container.textContent, 'read 1')
    await act(async () => { await clearPersistentReadCaches({ documentNavigation: true }) })
    t.diagnostic(JSON.stringify({ initialReads: 1, readsBeforeAssign: reads, refreshesBeforeAssign: refreshes - beforeRefresh,
      departedEnabled: departed?.isEnabled, departedEntries: departed?.size, oldDocumentText: container.textContent }))
    assert.equal(reads, 1, 'the departing Document must not remount a fresh reader before its full navigation')
    assert.equal(refreshes, beforeRefresh)
    assert.equal(departed?.isEnabled, false)
    assert.equal(departed?.size, 0)
    assert.equal(container.textContent, '')
    await act(async () => { await clearPersistentReadCaches(); root.render(content()) })
    assert.equal(reads, 1, 'a later ordinary clear or parent render cannot revive the retired boundary')
    assert.equal(container.textContent, '')
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(content()))
    assert.equal(reads, 2, 'a fresh document boundary performs its ordinary first read')
    assert.equal(container.textContent, 'read 2')
    assert.notEqual(latest, departed)
    assert.equal(latest?.isEnabled, true)
  } finally { await act(async () => root.unmount()); await departed?.flushed(); await latest?.flushed() }
})

test('document retirement disables and clears synchronously but still waits for pending disk erasure', async () => {
  const { IndexedReadStorage } = await import('./indexed-db')
  const entered = deferred<void>(), erase = deferred<void>()
  const cleared: (string | undefined)[] = []
  const clear = mock.method(IndexedReadStorage.prototype, 'clear', async (namespace?: string) => {
    cleared.push(namespace); entered.resolve(); await erase.promise
  })
  let cache: PersistentReadCache | undefined, reads = 0, finished = false
  let clearing: Promise<void> | undefined
  function Read() {
    const value = swr.useSWRConfig().cache
    if (value instanceof PersistentReadCache) cache = value
    const { data } = swr.default('preferences', async () => { reads++; return { theme: 'authorized view' } })
    return <output>{data?.theme ?? 'loading'}</output>
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
  try {
    await act(async () => root.render(<swr.SWRConfig value={swrDefaults}><AuthenticatedReadCache ownerId={scope.userId} workspace={{ workspaceId: scope.workspaceId, role: 'admin' }}><Read /></AuthenticatedReadCache></swr.SWRConfig>))
    assert.equal(reads, 1)
    await act(async () => {
      clearing = clearPersistentReadCaches({ documentNavigation: true }).then(() => { finished = true })
      assert.equal(cache?.isEnabled, false)
      assert.equal(cache?.size, 0)
      cache?.set('preferences', { _k: 'preferences', data: { theme: 'late response' } })
      assert.equal(cache?.size, 0)
      await entered.promise
    })
    assert.equal(finished, false, 'the caller cannot assign before the captured old provider finishes erasure')
    assert.equal(container.textContent, '')
    assert.equal(reads, 1)
    assert.ok(cleared.includes(readCacheNamespace(scope)))
    await act(async () => { erase.resolve(); await clearing })
    assert.equal(finished, true)
  } finally { erase.resolve(); await clearing; await act(async () => root.unmount()); await cache?.flushed(); clear.mock.restore() }
})

test('document departure still broadcasts clear while remote and denied scopes keep ordinary remounts', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')
  const messages: unknown[] = []
  const channels: Channel[] = []
  class Channel {
    onmessage: ((event: MessageEvent) => void) | null = null
    closed = false
    constructor(readonly name: string) { channels.push(this) }
    postMessage(value: unknown) { messages.push(value) }
    close() { this.closed = true }
  }
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: Channel })
  try {
    for (const mode of ['document', 'ordinary', 'remote', 'denied'] as const) {
      let reads = 0, cache: PersistentReadCache | undefined
      function Read() {
        const current = swr.useSWRConfig().cache
        if (current instanceof PersistentReadCache) cache = current
        const { data } = swr.default('preferences', async () => { reads++; return { theme: `read ${reads}` } })
        return <output>{data?.theme ?? 'loading'}</output>
      }
      const container = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(container)
      const beforeRefresh = refreshes, firstMessage = messages.length
      try {
        await act(async () => root.render(<swr.SWRConfig value={swrDefaults}><AuthenticatedReadCache ownerId={scope.userId} workspace={{ workspaceId: scope.workspaceId, role: 'admin' }}><Read /></AuthenticatedReadCache></swr.SWRConfig>))
        assert.equal(reads, 1)
        const receiver = channels.find(channel => !channel.closed && channel.onmessage)
        assert.ok(receiver)
        await act(async () => {
          if (mode === 'document') await clearPersistentReadCaches({ documentNavigation: true })
          else if (mode === 'ordinary') await clearPersistentReadCaches()
          else if (mode === 'remote') receiver.onmessage!({ data: { type: 'clear' } } as MessageEvent)
          else cache!.set('preferences', { _k: 'preferences', error: { status: 403 } })
        })
        assert.equal(cache?.isEnabled, false)
        assert.equal(cache?.size, 0)
        assert.equal(reads, mode === 'document' ? 1 : 2)
        assert.equal(refreshes - beforeRefresh, mode === 'document' ? 0 : 1)
        if (mode === 'document') {
          assert.ok(messages.slice(firstMessage).some(message => JSON.stringify(message) === '{"type":"clear"}'))
          await act(async () => {
            // Even a callback already queued before close cannot reopen this boundary.
            receiver.onmessage!({ data: { type: 'clear' } } as MessageEvent)
            receiver.onmessage!({ data: { type: 'scope', scope: 'another-document' } } as MessageEvent)
          })
          assert.equal(reads, 1)
          assert.equal(refreshes, beforeRefresh)
          assert.equal(container.textContent, '')
        }
        assert.ok(messages.every(message => !JSON.stringify(message).includes('documentNavigation')), 'local retirement does not propagate to another document')
        t.diagnostic(JSON.stringify({ mode, reads, refreshes: refreshes - beforeRefresh, cacheEnabled: cache?.isEnabled, cacheEntries: cache?.size }))
      } finally { await act(async () => root.unmount()); await cache?.flushed() }
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'BroadcastChannel', original)
    else Reflect.deleteProperty(globalThis, 'BroadcastChannel')
  }
})
