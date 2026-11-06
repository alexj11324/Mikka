import assert from 'node:assert/strict'

const ROOT = 'mikka://app/mikka'

/** The first Electron window can still expose about:blank's completed load
 * state. Bind readiness to the actual local document before arming a later
 * authentication-return DOMContentLoaded event; preload availability alone
 * precedes the target document's DOMContentLoaded. */
export async function waitForBundledRootDocument(page, { timeout = 60_000 } = {}) {
  assert.ok(Number.isFinite(timeout) && timeout > 0)
  await page.waitForURL(ROOT, { waitUntil: 'domcontentloaded', timeout })
  await page.waitForFunction(() => Boolean(window.mikka?.bundled), undefined, { timeout })
}

const route = value => {
  if (value === 'about:blank') return 'blank'
  try {
    const url = new URL(value)
    return url.protocol === 'mikka:' && url.host === 'app' && url.pathname === '/mikka' ? 'bundled-root' : 'other'
  } catch { return 'other' }
}

/** Observe only main-document lifecycle events. No URL, query, identity or
 * renderer value is retained, and observation never adds a backend request. */
export function observeNativeNavigation(page, record, { now = Date.now, limit = 64 } = {}) {
  const started = now()
  let document = 0
  const add = event => {
    if (record.events.length >= limit) { record.overflow = true; return }
    record.events.push({ event, document, route: route(page.url()), elapsedMs: now() - started })
  }
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) { document++; add('committed') } })
  page.on('domcontentloaded', () => add('domcontentloaded'))
}

/** A source-location projection, never an exception message or raw stack. */
export function nativeLifecycleFailure(error) {
  const names = ['Error', 'AssertionError', 'TimeoutError', 'TypeError', 'TestAccountError', 'AggregateError']
  const kind = names.includes(error?.name) ? error.name : 'other'
  const code = /Execution context was destroyed|Cannot find context with specified id/.test(String(error?.message))
    ? 'navigation-context-destroyed' : error?.code === 'ERR_ASSERTION' ? 'assertion' : 'other'
  const locations = [...String(error?.stack ?? '').matchAll(/(?:^|[/\\])(lifecycle|native-document|bundled-session|native-device-ready|native-viewport)\.mjs:(\d+):(\d+)/g)]
    .slice(0, 6).map(([, file, line, column]) => ({ file: `${file}.mjs`, line: Number(line), column: Number(column) }))
  return { kind, code, locations }
}
