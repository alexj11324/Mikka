import assert from 'node:assert/strict'

const METHOD = 'playwright_set_fixed_time'
const SCOPE = 'parity-renderer-only'

function wallTime(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  assert.ok(Number.isSafeInteger(time) && time > 0 && new Date(time).toISOString() === value, 'PARITY_CAPTURE_CLOCK_INVALID')
  return time
}

export function createCaptureClock(started, input) {
  assert.ok(Number.isSafeInteger(started) && started > 0, 'PARITY_CAPTURE_CLOCK_INVALID')
  const fixed = input === undefined ? new Date(started).toISOString() : input
  assert.ok(wallTime(fixed) <= started, 'PARITY_CAPTURE_CLOCK_FUTURE')
  return { method: METHOD, wallTime: fixed, timers: 'running', scope: SCOPE }
}

function validate(clock) {
  assert.deepEqual(Object.keys(clock ?? {}).sort(), ['method', 'scope', 'timers', 'wallTime'], 'PARITY_CAPTURE_CLOCK_INVALID')
  assert.equal(clock.method, METHOD, 'PARITY_CAPTURE_CLOCK_INVALID')
  assert.equal(clock.timers, 'running', 'PARITY_CAPTURE_CLOCK_INVALID')
  assert.equal(clock.scope, SCOPE, 'PARITY_CAPTURE_CLOCK_INVALID')
  return wallTime(clock.wallTime)
}

/** Only screenshot renderers share this Date. Browser timers keep advancing;
 * the system browser, main process, backend, cold-start and idle clocks do not
 * use this helper. Install before the first captured document is navigated to. */
export async function installCaptureClock(page, clock) {
  const time = validate(clock)
  await page.clock.setFixedTime(new Date(time))
  assert.equal(await page.evaluate(() => Date.now()), time, 'PARITY_CAPTURE_CLOCK_NOT_INSTALLED')
}

export function assertSameCaptureClock(before, after) {
  validate(before)
  validate(after)
  assert.deepEqual(before, after, 'PARITY_CAPTURE_CLOCK_MISMATCH')
}
