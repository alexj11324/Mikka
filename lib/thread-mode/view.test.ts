import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isThreadModeTransitionError, threadModePicker } from './view'

test('no read yet: no picker rather than a guessed execute', () => {
  assert.equal(threadModePicker(undefined, false), null)
})

test('a thread with no stored choice offers execute, and nothing is locked', () => {
  const view = threadModePicker({ mode: 'execute', version: 0, frozenMode: 'execute' }, false)
  assert.ok(view)
  assert.equal(view.mode, 'execute')
  assert.equal(view.locked, false)
  assert.deepEqual(view.options, [
    { mode: 'plan', selected: false, disabled: false },
    { mode: 'execute', selected: true, disabled: false },
    { mode: 'ask', selected: false, disabled: false },
  ])
  // The displayed run's own mode is a fact, even when it matches the choice.
  assert.equal(view.frozenMode, 'execute')
})

test('an active run makes every option read-only', () => {
  const view = threadModePicker({ mode: 'plan', version: 2, frozenMode: 'ask' }, true)
  assert.ok(view)
  assert.equal(view.locked, true)
  assert.ok(view.options.every(option => option.disabled))
})

test('the server lock alone is enough, even when the panel read an earlier attempt', () => {
  const view = threadModePicker({ mode: 'ask', version: 1, locked: true }, false)
  assert.ok(view)
  assert.equal(view.locked, true)
})

test('a frozen mode different from the stored choice is a badge', () => {
  const view = threadModePicker({ mode: 'execute', version: 3, frozenMode: 'ask' }, true)
  assert.ok(view)
  assert.equal(view.frozenMode, 'ask')
  assert.equal(view.mode, 'execute')
})

test('transition errors are a closed set', () => {
  for (const code of ['threadModeChanged', 'threadModeLocked', 'threadModeUnavailable']) assert.ok(isThreadModeTransitionError(code))
  for (const value of ['', 'pending', null, undefined, 1]) assert.equal(isThreadModeTransitionError(value), false)
})
