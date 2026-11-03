import test from 'node:test'
import { withBasePath } from './base-path'
import assert from 'node:assert/strict'

import { STALE_BUILD_EVENT, createAppVersionReader, desktopBelowMinimum, isStaleBuild, minDesktopVersion, reloadOnce, watchRemovedActions, markPageNeedsRefresh } from './app-build'

test('navigation and action probes share one public read, then reuse it until stale', async () => {
  let calls = 0, now = 1_000
  let finish!: (response: Response) => void
  const read = createAppVersionReader({ now: () => now, fetch: async (input, init) => {
    calls++
    assert.match(input, /\/api\/version$/)
    assert.equal(init.cache, 'no-store')
    assert.equal(init.credentials, 'omit')
    assert.equal(new Headers(init.headers).get('x-deployment-id'), null)
    if (calls === 1) return new Promise(resolve => { finish = resolve })
    return Response.json({ build: 'newer' })
  } })
  const navigation = read(), action = read()
  assert.equal(navigation, action)
  await Promise.resolve()
  assert.equal(calls, 1)
  finish(Response.json({ build: 'current', minDesktopVersion: '2026.10000.335' }))
  assert.deepEqual(await action, { build: 'current', minDesktopVersion: '2026.10000.335' })
  now += 59_999
  assert.equal((await read())?.build, 'current')
  assert.equal(calls, 1)
  now += 1
  assert.equal((await read())?.build, 'newer')
  assert.equal(calls, 2)
})

test('failed version reads stay unknown and do not turn into a known stale build', async () => {
  let calls = 0
  const read = createAppVersionReader({ fetch: async () => { calls++; throw new Error('fixture-private-network-detail') } })
  assert.equal(await read(), null)
  assert.equal(await read(), null)
  assert.equal(calls, 1)
})

test('a known stale action asks for refresh before any action runs', async () => {
  const priorBuild = process.env.NEXT_PUBLIC_MIKKA_BUILD
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const priorFetch = globalThis.fetch
  const events: string[] = []
  let reads = 0, actions = 0
  try {
    process.env.NEXT_PUBLIC_MIKKA_BUILD = 'fixture-old'
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: (event: Event) => { events.push(event.type); return true } } })
    globalThis.fetch = async () => { reads++; return Response.json({ build: 'fixture-new' }) }
    const { checkPageBuildBeforeAction } = await import(new URL('./app-build.ts?stale-action-fixture', import.meta.url).href)
    if (await checkPageBuildBeforeAction()) actions++
    if (await checkPageBuildBeforeAction()) actions++
    assert.equal(actions, 0)
    assert.equal(reads, 1)
    assert.deepEqual(events, [STALE_BUILD_EVENT, STALE_BUILD_EVENT])
  } finally {
    if (priorBuild === undefined) delete process.env.NEXT_PUBLIC_MIKKA_BUILD
    else process.env.NEXT_PUBLIC_MIKKA_BUILD = priorBuild
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    globalThis.fetch = priorFetch
  }
})

test('a page is stale only when both builds are known and differ', () => {
  assert.equal(isStaleBuild('dpl_old', 'dpl_new'), true)
  assert.equal(isStaleBuild('dpl_same', 'dpl_same'), false)
  assert.equal(isStaleBuild('', 'dpl_new'), false)
  assert.equal(isStaleBuild('dpl_old', ''), false)
  assert.equal(isStaleBuild('dpl_old', undefined), false)
})

test('a missing server action reloads once a minute at most', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
  let reloads = 0
  assert.equal(reloadOnce(storage, 1_000_000, () => { reloads += 1 }), true)
  assert.equal(reloadOnce(storage, 1_030_000, () => { reloads += 1 }), false)
  assert.equal(reloadOnce(storage, 1_061_000, () => { reloads += 1 }), true)
  assert.equal(reloads, 2)
  // No storage (blocked or private): never loop, ask instead.
  const blocked = { getItem: () => { throw new Error('denied') }, setItem: () => {} }
  assert.equal(reloadOnce(blocked, 2_000_000, () => { reloads += 1 }), false)
  assert.equal(reloadOnce(null, 2_000_000, () => { reloads += 1 }), false)
  assert.equal(reloads, 2)
})

test('a removed server action reloads the page; a second miss within the minute asks instead', async () => {
  const store = new Map<string, string>()
  let reloads = 0
  const events: string[] = []
  const target = {
    fetch: async (input: unknown) => new Response('', { status: input === '/missing' ? 404 : 200, headers: input === '/missing' ? { 'x-nextjs-action-not-found': '1' } : {} }),
    sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } },
    location: { href: 'https://app.example/', origin: 'https://app.example', reload: () => { reloads += 1 } },
    dispatchEvent: (event: Event) => { events.push(event.type); return true },
  }
  watchRemovedActions(target as unknown as Window)
  await target.fetch('/ok')
  assert.equal(reloads, 0)
  const response = await target.fetch('/missing')
  assert.equal(response.status, 404)
  assert.equal(reloads, 1)
  await target.fetch('/missing')
  assert.equal(reloads, 1)
  assert.deepEqual(events, [STALE_BUILD_EVENT])
})

test('the server minimum desktop version is a valid version or nothing', () => {
  assert.equal(minDesktopVersion('2026.10000.300'), '2026.10000.300')
  assert.equal(minDesktopVersion(' 1.2.3 '), '1.2.3')
  assert.equal(minDesktopVersion(''), null)
  assert.equal(minDesktopVersion(undefined), null)
  assert.equal(minDesktopVersion('latest'), null)
})

test('a desktop build below the minimum must update; at or above it, or without one, it need not', () => {
  assert.equal(desktopBelowMinimum('2026.10000.294', '2026.10000.300'), true)
  assert.equal(desktopBelowMinimum('2026.10000.300', '2026.10000.300'), false)
  assert.equal(desktopBelowMinimum('2026.10000.301', '2026.10000.300'), false)
  assert.equal(desktopBelowMinimum('2026.10000.294', null), false)
  assert.equal(desktopBelowMinimum('2026.10000.294', 'not-a-version'), false)
  assert.equal(desktopBelowMinimum(undefined, '2026.10000.300'), false)
})


test('a required refresh stops same-origin application traffic while the public version probe remains available', async () => {
  let reads = 0
  const target = { location: { href: 'https://app.example/mikka/en', origin: 'https://app.example' }, fetch: async () => { reads++; return Response.json({ build: 'latest' }) } } as unknown as Window
  watchRemovedActions(target)
  await target.fetch('/mikka/api/workspace')
  markPageNeedsRefresh()
  await assert.rejects(target.fetch('/mikka/api/workspace'), /App refresh required/)
  await assert.rejects(target.fetch('/mikka/en', { method: 'POST', headers: { 'next-action': 'old-action' } }), /App refresh required/)
  assert.equal(reads, 1)
  await target.fetch(withBasePath('/api/version'))
  assert.equal(reads, 2)
})
