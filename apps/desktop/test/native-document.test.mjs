import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { nativeLifecycleFailure, observeNativeNavigation, waitForBundledDocument } from './native-document.mjs'

// Exercise the installed SDK's actual URL matcher and Frame.waitForURL branch,
// without launching a browser. Only navigation/load/IPC delivery is controlled.
const require = createRequire(import.meta.url)
const pwRequire = createRequire(require.resolve('@playwright/test/package.json'))
const coreRequire = createRequire(pwRequire.resolve('playwright/package.json'))
const { iso: { urlMatches } } = coreRequire('playwright-core/lib/coreBundle')
const sdk = await readFile(coreRequire.resolve('playwright-core/lib/coreBundle'), 'utf8')
const methods = [...sdk.matchAll(/^      async waitForURL\(url3, options\) \{\n[\s\S]*?^      \}/gm)]
  .filter(([method]) => method.includes('urlMatches(') && method.includes('this.waitForLoadState('))
assert.equal(methods.length, 1, 'the installed Frame.waitForURL contract must be identified')
const waitForURL = vm.runInNewContext(`({${methods[0][0]}}).waitForURL`, { urlMatches }, { timeout: 1000 })

function documentPage(initial, { loaded = true, bridge = true, noNavigation = false } = {}) {
  let url = initial, load = Promise.withResolvers(), navigation
  const ipc = Promise.withResolvers(), calls = []
  if (loaded) load.resolve()
  if (bridge) ipc.resolve()
  const page = {
    _page: { context: () => ({ _options: {} }) }, url: () => url, waitForURL,
    async waitForLoadState(state, options) {
      assert.equal(state, 'domcontentloaded'); assert.equal(options.timeout, 137)
      calls.push('domcontentloaded'); await load.promise
    },
    async waitForNavigation(options) {
      assert.equal(options.waitUntil, 'domcontentloaded'); assert.equal(options.timeout, 137)
      calls.push('navigation')
      if (noNavigation) throw new Error('NO_NEW_DOCUMENT_NAVIGATION')
      navigation = { ...Promise.withResolvers(), match: options.url }
      await navigation.promise
      await page.waitForLoadState(options.waitUntil, options)
    },
    async waitForFunction(predicate, arg, options) {
      assert.equal(arg, undefined); assert.equal(options.timeout, 137)
      assert.equal(vm.runInNewContext(`(${predicate})()`, { window: {} }), false)
      calls.push('ipc'); await ipc.promise
      assert.equal(vm.runInNewContext(`(${predicate})()`, { window: { mikka: { bundled: {} } } }), true)
    },
  }
  return { page, calls,
    navigate(next) {
      url = next; load = Promise.withResolvers()
      if (navigation && urlMatches(undefined, url, navigation.match)) navigation.resolve()
    },
    replace(next) { url = next },
    loaded: () => load.resolve(), bridge: () => ipc.resolve(),
  }
}

test('an already loaded bundled SPA auth route needs no new document navigation', async () => {
  for (const path of ['/mikka', '/mikka/sign-in?next=%2F', '/mikka/en/sign-in', '/mikka/settings#account']) {
    const state = documentPage(`mikka://app${path}`, { noNavigation: true })
    await waitForBundledDocument(state.page, { timeout: 137 })
    assert.deepEqual(state.calls, ['domcontentloaded', 'ipc'])
  }
})

test('a completed blank document and available preload cannot bypass the bundled DOMContentLoaded', async () => {
  const state = documentPage('about:blank')
  let ready = false
  const pending = waitForBundledDocument(state.page, { timeout: 137 }).then(() => { ready = true })
  assert.deepEqual(state.calls, ['navigation'])
  state.navigate('mikka://app/mikka')
  await new Promise(setImmediate)
  assert.equal(ready, false)
  assert.deepEqual(state.calls, ['navigation', 'domcontentloaded'])
  // History changes the URL in this document without producing another DCL.
  state.replace('mikka://app/mikka/sign-in')
  state.loaded()
  await pending
  assert.equal(ready, true)
  assert.deepEqual(state.calls, ['navigation', 'domcontentloaded', 'ipc'])
})

test('a matching bundled document still waits for both DOMContentLoaded and the real IPC predicate', async () => {
  const state = documentPage('mikka://app/mikka', { loaded: false, bridge: false })
  let ready = false
  const pending = waitForBundledDocument(state.page, { timeout: 137 }).then(() => { ready = true })
  assert.deepEqual(state.calls, ['domcontentloaded'])
  state.loaded()
  await new Promise(setImmediate)
  assert.equal(ready, false)
  assert.deepEqual(state.calls, ['domcontentloaded', 'ipc'])
  state.bridge()
  await pending
  assert.equal(ready, true)
})

test('blank, foreign, credential-bearing and non-application namespace URLs never satisfy readiness', async () => {
  for (const url of ['about:blank', 'https://app/mikka/sign-in', 'mikka://foreign/mikka/sign-in',
    'mikka://app:123/mikka/sign-in', 'mikka://private:secret@app/mikka/sign-in', 'mikka://app/',
    'mikka://app/mikka-other/sign-in', 'mikka://app/outside/mikka', 'mikka://app/mikka/api/session',
    'mikka://app/mikka/assets/index.html', 'mikka://app/mikka/%61pi/session', 'mikka://app/mikka/%zz',
    'mikka://app/mikka/%2foutside', 'mikka://app/mikka/%252e%252e/outside']) {
    const state = documentPage(url, { noNavigation: true })
    await assert.rejects(waitForBundledDocument(state.page, { timeout: 137 }), /NO_NEW_DOCUMENT_NAVIGATION/)
    assert.deepEqual(state.calls, ['navigation'])
  }
})

test('navigation evidence records bounded main-document transitions without URLs or query values', () => {
  const page = new EventEmitter()
  const main = {}, child = {}
  let url = 'about:blank', at = 100
  page.url = () => url
  page.mainFrame = () => main
  const record = { events: [], overflow: false }
  observeNativeNavigation(page, record, { now: () => at, limit: 3 })
  page.emit('framenavigated', child)
  assert.equal(record.events.length, 0)
  page.emit('domcontentloaded')
  at = 110; url = 'mikka://app/mikka?state=private-state'
  page.emit('framenavigated', main)
  page.emit('domcontentloaded')
  url = 'https://private-user.example/path?token=private-token'
  page.emit('framenavigated', main)
  assert.deepEqual(record, { overflow: true, events: [
    { event: 'domcontentloaded', document: 0, route: 'blank', elapsedMs: 0 },
    { event: 'committed', document: 1, route: 'bundled-root', elapsedMs: 10 },
    { event: 'domcontentloaded', document: 1, route: 'bundled-root', elapsedMs: 10 },
  ] })
  assert.equal(JSON.stringify(record).includes('private'), false)
})

test('same-document History routes have a closed bundled classification without revealing their paths', () => {
  const page = new EventEmitter(), main = {}, record = { events: [], overflow: false }
  let url = 'mikka://app/mikka'
  page.url = () => url; page.mainFrame = () => main
  observeNativeNavigation(page, record, { now: () => 100 })
  for (const next of [url, 'mikka://app/mikka/sign-in?next=private-value',
    'mikka://app/mikka/en/sign-in', 'mikka://app/mikka/api/private-value', 'https://private.example/mikka']) {
    url = next
    page.emit('framenavigated', main)
  }
  assert.deepEqual(record.events.map(event => [event.document, event.route]), [
    [1, 'bundled-root'], [2, 'bundled-route'], [3, 'bundled-route'], [4, 'other'], [5, 'other'],
  ])
  assert.equal(record.events.some(event => event.event === 'domcontentloaded'), false)
  assert.equal(JSON.stringify(record).includes('private'), false)
  assert.equal(JSON.stringify(record).includes('sign-in'), false)
})

test('failure evidence retains a closed error class and owned source locations only', () => {
  const failure = new Error('page.evaluate: Execution context was destroyed; https://private.example/?token=secret')
  failure.stack = 'Error: secret\n at /private/owner/apps/desktop/test/lifecycle.mjs:148:11\n at /private/secret.ts:3:2\n at /private/apps/desktop/test/bundled-session.mjs:16:9'
  const result = nativeLifecycleFailure(failure)
  assert.deepEqual(result, { kind: 'Error', code: 'navigation-context-destroyed', locations: [
    { file: 'lifecycle.mjs', line: 148, column: 11 }, { file: 'bundled-session.mjs', line: 16, column: 9 },
  ] })
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.deepEqual(nativeLifecycleFailure({ name: 'private-token', message: 'private-user' }), { kind: 'other', code: 'other', locations: [] })
})

const lifecycleSource = await readFile(new URL('./lifecycle.mjs', import.meta.url), 'utf8')
const selectFixtureSource = lifecycleSource.match(/^async function selectFixture\(page\) \{[\s\S]*?^\}/m)?.[0]
assert.ok(selectFixtureSource, 'exercise the actual lifecycle workspace-selection function')

// Deliver the real page contract's events in a controlled order. The old
// document is already loaded and has the seeded chat; only a *new* DCL makes
// its successor safe to read. No application response or authority is mocked.
function workspaceSelectionPage({ current = false, immediateLoad = false, clickFailure, usableFailure } = {}) {
  const events = new EventEmitter(), calls = []
  let loaded = current, rejectNavigation, usableCalls = 0, waits = 0
  const ready = () => { loaded = true; events.emit('domcontentloaded') }
  const item = {
    async getAttribute(name) { assert.equal(name, 'aria-current'); return current ? 'true' : null },
    async click() {
      calls.push('workspace-click')
      if (clickFailure) throw clickFailure
      if (immediateLoad) ready()
    },
  }
  const page = {
    async waitForFunction(predicate) {
      assert.equal(vm.runInNewContext('(' + predicate + ')()', { document: { documentElement: { lang: 'en' } } }), true)
    },
    async evaluate(read) {
      return vm.runInNewContext('(' + read + ')()', { document: { documentElement: { lang: 'en' } } })
    },
    getByRole(role, options) {
      assert.equal(options.exact, true)
      if (role === 'button') {
        assert.equal(options.name, 'Workspace menu')
        return { first: () => ({ async click() { calls.push('open-menu') } }) }
      }
      assert.equal(role, 'menuitem'); assert.equal(options.name, 'Fixture workspace')
      return item
    },
    waitForEvent(event, options) {
      assert.equal(event, 'domcontentloaded'); assert.equal(options.timeout, 60_000)
      calls.push('arm-new-document'); waits++
      const result = Promise.withResolvers()
      const resolve = () => { events.off(event, resolve); rejectNavigation = undefined; result.resolve() }
      events.once(event, resolve)
      rejectNavigation = error => { events.off(event, resolve); result.reject(error) }
      return result.promise
    },
  }
  const select = vm.runInNewContext('(' + selectFixtureSource + ')', {
    menuNames: { en: 'Workspace menu' }, fixtures: { fixture: { workspaceName: 'Fixture workspace' } },
    async usable() {
      usableCalls++; calls.push('usable')
      if (!loaded) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')
      if (usableFailure) throw usableFailure
    },
  })
  return {
    run: () => select(page), ready, calls,
    rejectNavigation: error => rejectNavigation?.(error),
    get usableCalls() { return usableCalls }, get waits() { return waits },
    get listeners() { return events.listenerCount('domcontentloaded') },
  }
}

test('workspace selection waits for its new document before reading the old ready chat', async () => {
  const state = workspaceSelectionPage()
  const pending = state.run().then(value => ({ value }), error => ({ error }))
  await new Promise(setImmediate)
  assert.equal(state.usableCalls, 0, 'old chat readiness cannot race the requested full-document navigation')
  assert.equal(state.waits, 1)
  assert.ok(state.calls.indexOf('arm-new-document') < state.calls.indexOf('workspace-click'))
  state.ready()
  assert.deepEqual(await pending, { value: 'en' })
  assert.equal(state.usableCalls, 1)
  assert.equal(state.listeners, 0)
})

test('selecting the current workspace does not wait for a nonexistent new document', async () => {
  const state = workspaceSelectionPage({ current: true })
  assert.equal(await state.run(), 'en')
  assert.equal(state.waits, 0)
  assert.equal(state.usableCalls, 1)
  assert.equal(state.listeners, 0)
})

test('a failed workspace click preserves its failure and observes later page-close rejection', async () => {
  const failure = new Error('WORKSPACE_CLICK_FAILED')
  const state = workspaceSelectionPage({ clickFailure: failure })
  await assert.rejects(state.run(), error => error === failure)
  assert.equal(state.usableCalls, 0)
  // Promise.all must already observe the waiter's later rejection while the
  // owning lifecycle finally block closes the application.
  state.rejectNavigation(new Error('Target page, context or browser has been closed'))
  await new Promise(setImmediate)
  assert.equal(state.listeners, 0)
})

test('workspace selection keeps the original event timeout and page-close failures', async t => {
  for (const kind of ['TimeoutError', 'PageClosedError']) await t.test(kind, async () => {
    const failure = Object.assign(new Error(kind), { name: kind })
    const state = workspaceSelectionPage()
    const pending = state.run().then(value => ({ value }), error => ({ error }))
    await new Promise(setImmediate)
    state.rejectNavigation(failure)
    assert.equal((await pending).error, failure)
    assert.equal(state.usableCalls, 0)
    assert.equal(state.waits, 1)
    assert.equal(state.listeners, 0)
  })
})

test('a document arriving during the click still runs the unchanged viewport and usable checks', async () => {
  const failure = new assert.AssertionError({ message: 'Native renderer layout mismatch' })
  const state = workspaceSelectionPage({ immediateLoad: true, usableFailure: failure })
  await assert.rejects(state.run(), error => error === failure)
  assert.equal(state.usableCalls, 1)
  assert.equal(state.waits, 1)
  assert.equal(state.listeners, 0)
})
