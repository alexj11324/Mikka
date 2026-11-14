import test from 'node:test'
import { withBasePath } from './base-path'
import assert from 'node:assert/strict'

import { STALE_BUILD_EVENT, createAppVersionReader, desktopBelowMinimum, isStaleBuild, minDesktopVersion, watchRemovedActions, markPageNeedsRefresh } from './app-build'

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

test('concurrent stale actions share one refresh notification and a later action stays blocked', async () => {
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
    const attempt = async () => { if (await checkPageBuildBeforeAction()) actions++ }
    await Promise.all([attempt(), attempt()])
    await attempt()
    assert.equal(actions, 0)
    assert.equal(reads, 1)
    assert.deepEqual(events, [STALE_BUILD_EVENT])
  } finally {
    if (priorBuild === undefined) delete process.env.NEXT_PUBLIC_MIKKA_BUILD
    else process.env.NEXT_PUBLIC_MIKKA_BUILD = priorBuild
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    globalThis.fetch = priorFetch
  }
})

test('a pending version check cannot reopen a page retired by another response', async () => {
  const priorBuild = process.env.NEXT_PUBLIC_MIKKA_BUILD
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const priorFetch = globalThis.fetch
  const target = new EventTarget()
  const pending = Promise.withResolvers<Response>()
  try {
    process.env.NEXT_PUBLIC_MIKKA_BUILD = 'fixture-old'
    Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
    globalThis.fetch = () => pending.promise
    const app = await import(new URL('./app-build.ts?version-retired-while-pending', import.meta.url).href)
    const allowed = app.checkPageBuildBeforeAction()
    app.markPageNeedsRefresh()
    pending.resolve(Response.json({ build: 'fixture-old' }))
    assert.equal(await allowed, false)
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

function refreshTarget(response: () => Response) {
  let reads = 0, reloads = 0
  const events: string[] = []
  const signals: (AbortSignal | null | undefined)[] = []
  const store = new Map<string, string>()
  const target = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => { reads++; signals.push(init?.signal); return response() },
    sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } },
    location: { href: 'https://app.example/', origin: 'https://app.example', reload: () => { reloads++ } },
    dispatchEvent: (event: Event) => { events.push(event.type); return true },
  }
  return { target, events, signals, reads: () => reads, reloads: () => reloads }
}

const missingAction = () => new Response('', { status: 404, headers: { 'x-nextjs-action-not-found': '1' } })

test('concurrent missing action responses retire the page once', async () => {
  const app = await import(new URL('./app-build.ts?concurrent-missing', import.meta.url).href)
  const fixture = refreshTarget(missingAction)
  app.watchRemovedActions(fixture.target as unknown as Window)
  await Promise.all([fixture.target.fetch('/actions/first'), fixture.target.fetch('/actions/second')])
  assert.equal(fixture.reads(), 2)
  assert.deepEqual(fixture.events, [STALE_BUILD_EVENT])
  assert.equal(app.pageRefreshSignal().aborted, true)
})

test('a missing action asks for refresh without reloading, and retires obsolete traffic', async () => {
  const app = await import(new URL('./app-build.ts?missing-action-explicit-refresh', import.meta.url).href)
  const fixture = refreshTarget(missingAction)
  app.watchRemovedActions(fixture.target as unknown as Window)
  assert.equal((await fixture.target.fetch('/missing')).status, 404)
  assert.equal(fixture.reloads(), 0)
  assert.deepEqual(fixture.events, [STALE_BUILD_EVENT])
  assert.equal(app.pageNeedsRefresh(), true)
  assert.equal(fixture.signals[0]?.aborted, true)
  await assert.rejects(fixture.target.fetch('/write', { method: 'POST' }), /App refresh required/)
  assert.equal(fixture.reads(), 1)
  await fixture.target.fetch(withBasePath('/api/version'))
  assert.equal(fixture.reads(), 2)
  assert.deepEqual(fixture.events, [STALE_BUILD_EVENT])
})

test('third-party response headers do not retire or reload the app', async () => {
  const app = await import(new URL('./app-build.ts?external-action-header', import.meta.url).href)
  const fixture = refreshTarget(missingAction)
  app.watchRemovedActions(fixture.target as unknown as Window)
  await fixture.target.fetch('https://other.example/missing')
  assert.equal(fixture.reloads(), 0)
  assert.deepEqual(fixture.events, [])
  assert.equal(app.pageNeedsRefresh(), false)
})

test('ordinary errors do not require an app refresh', async () => {
  const app = await import(new URL('./app-build.ts?ordinary-response-error', import.meta.url).href)
  const fixture = refreshTarget(() => new Response('', { status: 404 }))
  app.watchRemovedActions(fixture.target as unknown as Window)
  await fixture.target.fetch('/missing')
  assert.equal(fixture.reloads(), 0)
  assert.deepEqual(fixture.events, [])
  assert.equal(app.pageNeedsRefresh(), false)
})

test('missing-action handling does not depend on access to sessionStorage', async () => {
  const app = await import(new URL('./app-build.ts?blocked-session-storage', import.meta.url).href)
  const fixture = refreshTarget(missingAction)
  Object.defineProperty(fixture.target, 'sessionStorage', { get() { throw new Error('blocked storage fixture') } })
  app.watchRemovedActions(fixture.target as unknown as Window)
  await fixture.target.fetch('/missing')
  assert.equal(fixture.reloads(), 0)
  assert.deepEqual(fixture.events, [STALE_BUILD_EVENT])
  assert.equal(app.pageNeedsRefresh(), true)
})

test('a late refresh subscriber catches the marker before waiting for another event', async () => {
  const app = await import(new URL('./app-build.ts?late-refresh-subscriber', import.meta.url).href)
  const target = new EventTarget()
  let offers = 0
  app.markPageNeedsRefresh()
  const stop = app.subscribePageRefresh(target, () => { offers++ })
  assert.equal(offers, 1)
  stop()
  target.dispatchEvent(new Event(STALE_BUILD_EVENT))
  assert.equal(offers, 1)
})

test('an early refresh subscriber waits for an event and unsubscribes cleanly', async () => {
  const app = await import(new URL('./app-build.ts?early-refresh-subscriber', import.meta.url).href)
  const target = new EventTarget()
  let offers = 0
  const stop = app.subscribePageRefresh(target, () => { offers++ })
  assert.equal(offers, 0)
  app.markPageNeedsRefresh()
  target.dispatchEvent(new Event(STALE_BUILD_EVENT))
  assert.equal(offers, 1)
  stop()
  target.dispatchEvent(new Event(STALE_BUILD_EVENT))
  assert.equal(offers, 1)
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
