import assert from 'node:assert/strict'

function bundledDocument(url) {
  if (url.protocol !== 'mikka:' || url.host !== 'app' || url.username || url.password) return false
  let path
  try { path = decodeURIComponent(url.pathname) } catch { return false }
  return (path === '/mikka' || path.startsWith('/mikka/'))
    && !/^\/mikka\/(?:api|assets)(?:\/|$)/.test(path)
    && !/%(?:2e|2f|5c|00|25)/i.test(url.pathname) && !path.includes('\\')
    && !path.split('/').some(part => part === '.' || part === '..')
}

/** The first Electron window can still expose about:blank's completed load
 * state. Bind readiness to the actual local document before arming a later
 * authentication-return DOMContentLoaded event; preload availability alone
 * precedes the target document's DOMContentLoaded. The SPA can already have
 * replaced its URL with /sign-in without creating a new document. */
export async function waitForBundledDocument(page, { timeout = 60_000 } = {}) {
  assert.ok(Number.isFinite(timeout) && timeout > 0)
  await page.waitForURL(bundledDocument, { waitUntil: 'domcontentloaded', timeout })
  await page.waitForFunction(() => Boolean(window.mikka?.bundled), undefined, { timeout })
}

/** A server change can replace its originating document before evaluate replies.
 * Arm the next main-frame DOMContentLoaded before selecting once, then verify
 * the completed bundled document's immutable preload target. */
export async function selectBundledServer(page, selection, expectedServerUrl, { timeout = 30_000 } = {}) {
  if (typeof expectedServerUrl !== 'string' || !expectedServerUrl || !Number.isFinite(timeout) || timeout <= 0) throw new Error('NATIVE_SERVER_CHOICE_OPTIONS_INVALID')
  const expires = performance.now() + timeout
  const timeoutError = new Error('NATIVE_SERVER_CHOICE_TIMEOUT')
  let timer, fail, onDocument, onClose, onCrash, finished = false
  const active = () => {
    if (finished || performance.now() >= expires) throw timeoutError
  }
  const remaining = () => { active(); return Math.max(1, expires - performance.now()) }
  const deadline = new Promise((_, reject) => {
    fail = reject
    timer = setTimeout(() => reject(timeoutError), timeout)
  })
  const operation = (async () => {
    await page.waitForURL(bundledDocument, { waitUntil: 'domcontentloaded', timeout: remaining() })
    active()
    const document = new Promise(resolve => {
      onDocument = () => { page.off('domcontentloaded', onDocument); resolve() }
      onClose = () => fail(new Error('NATIVE_SERVER_CHOICE_PAGE_CLOSED'))
      onCrash = () => fail(new Error('NATIVE_SERVER_CHOICE_PAGE_CRASHED'))
      page.on('domcontentloaded', onDocument)
      page.on('close', onClose)
      page.on('crash', onCrash)
    })
    const selected = Promise.resolve().then(() => {
      active()
      return page.evaluate(url => window.mikka.bundled.server.select(url), selection)
    }).catch(error => {
      if (!/^(?:page\.evaluate: )?Execution context was destroyed, most likely because of a navigation\.?$/.test(error?.message ?? '')) throw error
    })
    await Promise.all([document, selected])
    active()
    assert.ok(bundledDocument(new URL(page.url())), 'server selection must load a bundled application document')
    const actual = await page.evaluate(() => window.mikka?.app.serverUrl)
    active()
    assert.equal(actual, expectedServerUrl)
  })()
  try {
    await Promise.race([operation, deadline])
  } finally {
    finished = true
    clearTimeout(timer)
    if (onDocument) page.off('domcontentloaded', onDocument)
    if (onClose) page.off('close', onClose)
    if (onCrash) page.off('crash', onCrash)
  }
}

const route = value => {
  if (value === 'about:blank') return 'blank'
  try {
    const url = new URL(value)
    return bundledDocument(url) ? url.pathname === '/mikka' ? 'bundled-root' : 'bundled-route' : 'other'
  } catch { return 'other' }
}

/** Observe only main-frame events. The retained `document` field is a
 * framenavigated-event ordinal, including History changes, not a DOM document
 * identity. No URL, query, identity or renderer value is retained. */
export function observeNativeNavigation(page, record, { now = Date.now, limit = 64 } = {}) {
  const started = now()
  let navigation = 0
  const add = event => {
    if (record.events.length >= limit) { record.overflow = true; return }
    record.events.push({ event, document: navigation, route: route(page.url()), elapsedMs: now() - started })
  }
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) { navigation++; add('committed') } })
  page.on('domcontentloaded', () => add('domcontentloaded'))
}

/** A source-location projection, never an exception message or raw stack. */
export function nativeLifecycleFailure(error) {
  const names = ['Error', 'AssertionError', 'TimeoutError', 'TypeError', 'TestAccountError', 'AggregateError']
  const kind = names.includes(error?.name) ? error.name : 'other'
  const code = /Execution context was destroyed|Cannot find context with specified id/.test(String(error?.message))
    ? 'navigation-context-destroyed' : error?.code === 'ERR_ASSERTION' ? 'assertion' : 'other'
  const locations = [...String(error?.stack ?? '').matchAll(/(?:^|[/\\])(lifecycle|native-document|bundled-session|bundled-sign-in|native-device-ready|native-viewport)\.mjs:(\d+):(\d+)/g)]
    .slice(0, 6).map(([, file, line, column]) => ({ file: `${file}.mjs`, line: Number(line), column: Number(column) }))
  return { kind, code, locations }
}
