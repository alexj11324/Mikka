import test from 'node:test'
import assert from 'node:assert/strict'

import { windowAppearance } from './window-appearance'

test('macOS uses the sidebar material behind a transparent page in both themes', () => {
  for (const dark of [false, true]) {
    const { options, translucent } = windowAppearance('darwin', { dark, reduceTransparency: false })
    assert.equal(translucent, true)
    assert.equal(options.vibrancy, 'sidebar')
    assert.equal(options.visualEffectState, 'followWindow')
    // Fully transparent: any alpha here would tint the material before the page draws.
    assert.equal(options.backgroundColor, '#00000000')
    assert.equal(options.titleBarStyle, 'hiddenInset')
  }
})

test('Reduce transparency keeps the opaque macOS window', () => {
  for (const dark of [false, true]) {
    const { options, translucent } = windowAppearance('darwin', { dark, reduceTransparency: true })
    assert.equal(translucent, false)
    assert.equal(options.vibrancy, undefined)
    assert.equal(options.backgroundColor, dark ? '#000000' : '#f5f5f4')
    assert.equal(options.titleBarStyle, 'hiddenInset')
  }
})

test('Windows and Linux keep the opaque window and native title bar', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const { options, translucent } = windowAppearance(platform, { dark: true, reduceTransparency: false })
    assert.equal(translucent, false)
    assert.deepEqual(options, { backgroundColor: '#000000' })
  }
})
