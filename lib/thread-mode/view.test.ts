import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isThreadModeTransitionError, threadModeAvailability, threadModePicker, type ThreadModeRead, type ThreadModeSupport } from './view'

const enforced: ThreadModeSupport = {
  plan: { state: 'enforced' }, execute: { state: 'enforced' }, ask: { state: 'enforced' },
}
const read = (value: Omit<ThreadModeRead, 'support'> & { support?: ThreadModeSupport | null }): ThreadModeRead => ({ support: enforced, ...value })

test('no read yet: no picker rather than a guessed execute', () => {
  assert.equal(threadModePicker(undefined, false), null)
})

test('a thread with no stored choice offers execute, and nothing is locked', () => {
  const view = threadModePicker(read({ mode: 'execute', version: 0, frozenMode: 'execute' }), false)
  assert.ok(view)
  assert.equal(view.mode, 'execute')
  assert.equal(view.locked, false)
  assert.equal(view.selectedUnsupported, false)
  assert.deepEqual(view.options, [
    { mode: 'plan', selected: false, disabled: false },
    { mode: 'execute', selected: true, disabled: false },
    { mode: 'ask', selected: false, disabled: false },
  ])
})

test('an active run makes every option read-only, with runActive', () => {
  const view = threadModePicker(read({ mode: 'plan', version: 2, frozenMode: 'ask' }), true)
  assert.ok(view)
  assert.equal(view.locked, true)
  assert.ok(view.options.every(option => option.disabled && option.reasonKey === 'runActive'))
})

test('the server lock alone is enough, even when the panel read an earlier attempt', () => {
  const view = threadModePicker(read({ mode: 'ask', version: 1, locked: true }), false)
  assert.ok(view)
  assert.equal(view.locked, true)
  assert.ok(view.options.every(option => option.reasonKey === 'runActive'))
})

test('an older server without a support read disables the switch instead of guessing', () => {
  const view = threadModePicker(read({ mode: 'execute', version: 1, support: null }), false)
  assert.ok(view)
  assert.ok(view.options.every(option => option.disabled && option.reasonKey === 'missingHarness'))
})

test('a harness that cannot enforce a mode disables exactly that option', () => {
  const support: ThreadModeSupport = { plan: { state: 'unsupported', reason: 'harness' }, execute: { state: 'enforced' }, ask: { state: 'unsupported', reason: 'harness' } }
  const view = threadModePicker(read({ mode: 'execute', version: 1, support }), false)
  assert.ok(view)
  assert.deepEqual(view.options, [
    { mode: 'plan', selected: false, disabled: true, reasonKey: 'unsupportedHarness' },
    { mode: 'execute', selected: true, disabled: false },
    { mode: 'ask', selected: false, disabled: true, reasonKey: 'unsupportedHarness' },
  ])
})

test('a local daemon that never reported the modes is daemonOutdated, not a harness refusal', () => {
  const availability = threadModeAvailability({ locked: false, selected: 'execute', support: { plan: { state: 'unsupported', reason: 'daemon' }, execute: { state: 'enforced' }, ask: { state: 'unsupported', reason: 'daemon' } } })
  assert.deepEqual(availability.plan, { enabled: false, reasonKey: 'daemonOutdated' })
  assert.deepEqual(availability.ask, { enabled: false, reasonKey: 'daemonOutdated' })
  assert.deepEqual(availability.execute, { enabled: true })
})

test('a stored mode that cannot run here stays selected and offers Execute', () => {
  const support: ThreadModeSupport = { plan: { state: 'unsupported', reason: 'harness' }, execute: { state: 'enforced' }, ask: { state: 'enforced' } }
  const view = threadModePicker(read({ mode: 'plan', version: 4, support }), false)
  assert.ok(view)
  assert.equal(view.mode, 'plan')
  assert.equal(view.selectedUnsupported, true)
  assert.deepEqual(view.options[0], { mode: 'plan', selected: true, disabled: true, reasonKey: 'unsupportedSelected' })
  // Execute is the escape hatch and stays enabled.
  assert.deepEqual(view.options[1], { mode: 'execute', selected: false, disabled: false })
})

test('the badge names the mode the displayed run froze, whatever the stored choice', () => {
  assert.equal(threadModePicker(read({ mode: 'execute', version: 3, frozenMode: 'ask' }), false)?.frozenMode, 'ask')
  assert.equal(threadModePicker(read({ mode: 'execute', version: 3, frozenMode: 'execute' }), false)?.frozenMode, 'execute')
  // A response without a frozen mode draws no badge.
  assert.equal(threadModePicker(read({ mode: 'plan', version: 1 }), false)?.frozenMode, null)
})

test('transition errors are a closed set', () => {
  for (const code of ['threadModeChanged', 'threadModeLocked', 'threadModeUnavailable']) assert.ok(isThreadModeTransitionError(code))
  for (const value of ['', 'pending', null, undefined, 1]) assert.equal(isThreadModeTransitionError(value), false)
})
