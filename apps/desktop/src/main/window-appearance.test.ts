import test from 'node:test'
import assert from 'node:assert/strict'

import { windowAppearance } from './window-appearance'

test('macOS window is opaque with inset traffic lights in both themes', () => {
  for (const dark of [false, true]) {
    const options = windowAppearance('darwin', { dark })
    assert.equal('vibrancy' in options, false)
    assert.equal(options.backgroundColor, dark ? '#000000' : '#f5f5f4')
    assert.equal(options.titleBarStyle, 'hiddenInset')
  }
})

test('Windows and Linux keep the opaque window and native title bar', () => {
  for (const platform of ['win32', 'linux'] as const) {
    assert.deepEqual(windowAppearance(platform, { dark: true }), { backgroundColor: '#000000' })
  }
})
