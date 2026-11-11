import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { MOBILE_SLOTS, MOBILE_SLOT_EXPORTS, mobileOverlay, overlayResolver } = require('../ui-overlay.js')
const app = resolve(import.meta.dirname, '..')
const repository = resolve(app, '../..')

test('without the overlay, each slot is its default in slots/', () => {
  const { dir, slots } = mobileOverlay(app, {})
  assert.equal(dir, null)
  for (const name of MOBILE_SLOTS) {
    assert.equal(slots[name], join(app, 'slots', `${name}.tsx`))
    const source = readFileSync(slots[name], 'utf8')
    for (const exported of MOBILE_SLOT_EXPORTS[name]) assert.match(source, new RegExp(`export (?:function|const) ${exported}\\b`))
  }
})

test('the overlay fills the slots it has, and its package imports resolve from the app', () => {
  const dir = mkdtempSync(join(repository, '.hosted-ui-test-'))
  try {
    mkdirSync(join(dir, 'slots'))
    writeFileSync(join(dir, 'slots', 'bot-avatar.tsx'), 'export function BotAvatar() { return null }\n')
    const env = { MIKKA_MOBILE_OVERLAY_DIR: dir.slice(repository.length + 1) }
    assert.equal(mobileOverlay(app, env).slots['bot-avatar'], join(dir, 'slots', 'bot-avatar.tsx'))
    const calls: Array<[string, string]> = []
    const next = (context: { originModulePath: string }, name: string) => { calls.push([context.originModulePath, name]); return { type: 'sourceFile', filePath: name } }
    const resolveRequest = overlayResolver(app, env, next)
    assert.deepEqual(resolveRequest({ originModulePath: join(app, 'components/icons.tsx') }, '@ui-slot/bot-avatar', 'ios'), { type: 'sourceFile', filePath: join(dir, 'slots', 'bot-avatar.tsx') })
    resolveRequest({ originModulePath: join(dir, 'slots/bot-avatar.tsx') }, 'react-native-svg', 'ios')
    resolveRequest({ originModulePath: join(dir, 'slots/bot-avatar.tsx') }, './face', 'ios')
    resolveRequest({ originModulePath: join(dir, 'slots/bot-avatar.tsx') }, '@hosted/lib/blink', 'ios')
    assert.deepEqual(calls, [
      [join(app, 'package.json'), 'react-native-svg'],
      [join(dir, 'slots/bot-avatar.tsx'), './face'],
      [join(dir, 'slots/bot-avatar.tsx'), join(dir, 'lib/blink')],
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing or outside overlay fails the bundle; @hosted without one fails', () => {
  assert.throws(() => mobileOverlay(app, { MIKKA_MOBILE_OVERLAY_DIR: '.no-such-layer' }), /MOBILE_OVERLAY_DIR_MISSING/)
  const outside = mkdtempSync(join(tmpdir(), 'layer-'))
  try {
    assert.throws(() => mobileOverlay(app, { MIKKA_MOBILE_OVERLAY_DIR: outside }), /MOBILE_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
  const resolveRequest = overlayResolver(app, {}, () => null)
  assert.throws(() => resolveRequest({ originModulePath: join(app, 'x.tsx') }, '@hosted/x', 'ios'), /MOBILE_OVERLAY_IMPORT_WITHOUT_OVERLAY/)
  assert.throws(() => resolveRequest({ originModulePath: join(app, 'x.tsx') }, '@ui-slot/nope', 'ios'), /MOBILE_SLOT_UNKNOWN/)
})

test('an installed official mobile layer may never substitute the public avatar', () => {
  const dir = mkdtempSync(join(repository, '.hosted-ui-test-'))
  try {
    assert.throws(() => mobileOverlay(app, { MIKKA_MOBILE_OVERLAY_DIR: dir }), /MOBILE_SLOT_REQUIRED: bot-avatar/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
