import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createCaptureClock, installCaptureClock, assertSameCaptureClock } from './parity-clock.mjs'

const require = createRequire(import.meta.url)
const intlRequire = createRequire(require.resolve('use-intl'))
const React = intlRequire('react')
const { renderToStaticMarkup } = intlRequire('react-dom/server')
const { IntlProvider, useNow, useFormatter, createFormatter } = require('use-intl')
const EPOCH = Date.parse('2026-11-06T00:00:00.000Z')
const BEFORE = Date.parse('2026-11-06T05:29:14.000Z')
const AFTER = Date.parse('2026-11-06T05:31:32.000Z')

test('capture time is explicit, canonical, shared across the pair and never future', () => {
  const clock = createCaptureClock(BEFORE)
  assertSameCaptureClock(clock, createCaptureClock(AFTER, clock.wallTime))
  assert.throws(() => createCaptureClock(BEFORE, new Date(AFTER).toISOString()), /PARITY_CAPTURE_CLOCK_FUTURE/)
  assert.throws(() => createCaptureClock(BEFORE, '2026-11-06'), /PARITY_CAPTURE_CLOCK_INVALID/)
  assert.throws(() => assertSameCaptureClock(clock, createCaptureClock(AFTER)), /PARITY_CAPTURE_CLOCK_MISMATCH/)
  assert.throws(() => assertSameCaptureClock({}, {}), /PARITY_CAPTURE_CLOCK_INVALID/)
})

// Use the installed, pinned Playwright clock implementation, not a local copy.
// This exercises its actual Date/timer controller with Node's real timers in
// isolated VM globals. It is a SDK regression, not a browser or Mac OS claim.
async function sdkClock() {
  const pwRequire = createRequire(require.resolve('@playwright/test/package.json'))
  const coreRequire = createRequire(pwRequire.resolve('playwright/package.json'))
  const core = dirname(coreRequire.resolve('playwright-core/package.json'))
  const bundle = await readFile(join(core, 'lib/coreBundle.js'), 'utf8')
  const start = bundle.indexOf('var init_clockSource = __esm(')
  assert.ok(start >= 0, 'Installed Playwright clock source must be identified')
  const literal = bundle.slice(start).match(/^    source = ('.*');$/m)?.[1]
  assert.ok(literal, 'Installed Playwright clock source must be present')
  const source = vm.runInNewContext(literal, {}, { timeout: 1000 })
  const context = vm.createContext({
    module: { exports: {} }, Date, Intl, performance, setTimeout, clearTimeout,
    setInterval, clearInterval, queueMicrotask, AbortSignal, Event: class extends Event {},
  })
  vm.runInContext(source, context, { timeout: 1000 })
  const { controller } = context.module.exports.inject()(context, 'chromium')
  return {
    context,
    page: {
      clock: { setFixedTime: async date => controller.setFixedTime(date.getTime()) },
      evaluate: async fn => vm.runInContext('(' + fn.toString() + ')()', context),
    },
    close: async () => { await controller.pauseAt(controller.now()); controller.uninstall() },
  }
}

function renderTime(runtime, globalNow) {
  function Timestamp() {
    const now = useNow({ updateInterval: 60_000 })
    return React.createElement('time', null, useFormatter().relativeTime(new Date(EPOCH), now))
  }
  const originalDate = globalThis.Date
  try {
    globalThis.Date = runtime.context.Date
    return renderToStaticMarkup(React.createElement(IntlProvider, { locale: 'en', ...(globalNow ? { now: globalNow } : {}) }, React.createElement(Timestamp)))
  } finally {
    globalThis.Date = originalDate
  }
}

test('the real useNow first render no longer crosses the observed 5.5-hour boundary', { timeout: 5000 }, async () => {
  const format = createFormatter({ locale: 'en' })
  assert.equal(format.relativeTime(new Date(EPOCH), new Date(BEFORE)), '5 hours ago')
  assert.equal(format.relativeTime(new Date(EPOCH), new Date(AFTER)), '6 hours ago')
  const before = await sdkClock()
  const after = await sdkClock()
  try {
    const clock = createCaptureClock(BEFORE)
    await installCaptureClock(before.page, clock)
    await installCaptureClock(after.page, clock)
    assert.equal(renderTime(before), '<time>5 hours ago</time>')
    assert.equal(renderTime(after), '<time>5 hours ago</time>')
    // Legacy server-rendered Next can supply its own provider now. Do not claim
    // that a renderer Date override replaces that explicit server value.
    assert.equal(renderTime(after, new Date(AFTER)), '<time>6 hours ago</time>')
  } finally {
    await before.close()
    await after.close()
  }
})

test('setFixedTime keeps actual timeout, interval and monotonic clock advancing', { timeout: 5000 }, async () => {
  const runtime = await sdkClock()
  try {
    const clock = createCaptureClock(BEFORE)
    await installCaptureClock(runtime.page, clock)
    const start = runtime.context.performance.now()
    let intervals = 0
    const interval = runtime.context.setInterval(() => { intervals++ }, 10)
    await new Promise(resolve => runtime.context.setTimeout(resolve, 70))
    runtime.context.clearInterval(interval)
    assert.ok(intervals >= 2, 'Intervals must run without fast-forwarding')
    assert.ok(runtime.context.performance.now() - start >= 40, 'Monotonic time must advance naturally')
    assert.equal(runtime.context.Date.now(), BEFORE)
  } finally {
    await runtime.close()
  }
})
