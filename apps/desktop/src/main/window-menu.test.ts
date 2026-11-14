import test from 'node:test'
import assert from 'node:assert/strict'

import { newWindowMenuItem } from './window-menu.ts'

test('New Window uses the standard shortcut and invokes only the supplied opener', () => {
  let opened = 0
  const item = newWindowMenuItem(() => { opened++ })

  assert.equal(item.label, 'New Window')
  assert.equal(item.accelerator, 'CommandOrControl+Shift+N')
  assert.equal(opened, 0)
  item.click()
  assert.equal(opened, 1)
})
