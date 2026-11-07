import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { overlayAliases, resolveOverlaySpecifier, UI_SLOTS } from './ui-overlay.mjs'

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ui-overlay-'))
  mkdirSync(join(root, 'components/slots'), { recursive: true })
  return root
}

test('without MIKKA_UI_OVERLAY_DIR every slot is its default and @hosted/ does not resolve', t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const aliases = overlayAliases(root, {})
  assert.equal(aliases.dir, null)
  assert.deepEqual(Object.keys(aliases.absolute), UI_SLOTS.map(name => `@ui-slot/${name}`))
  assert.equal(aliases.turbopack['@ui-slot/bot-avatar'], './components/slots/bot-avatar.tsx')
  assert.equal(aliases.turbopack['@hosted/*'], undefined)
  assert.equal(resolveOverlaySpecifier('@ui-slot/bot-avatar', aliases), join(root, 'components/slots/bot-avatar.tsx'))
  assert.throws(() => resolveOverlaySpecifier('@hosted/utils/cx', aliases), /UI_OVERLAY_IMPORT_WITHOUT_OVERLAY/)
  assert.equal(resolveOverlaySpecifier('@/lib/utils', aliases), null)
})

test('with the variable a slot the layer fills resolves into it, and @hosted/ to the layer root', t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.hosted-ui/slots'), { recursive: true })
  writeFileSync(join(root, '.hosted-ui/slots/bot-avatar.tsx'), '')
  const aliases = overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: '.hosted-ui' })
  assert.equal(aliases.dir, join(root, '.hosted-ui'))
  assert.equal(aliases.turbopack['@ui-slot/bot-avatar'], './.hosted-ui/slots/bot-avatar.tsx')
  assert.equal(aliases.turbopack['@hosted/*'], './.hosted-ui/*')
  assert.equal(resolveOverlaySpecifier('@hosted/utils/cx', aliases), join(root, '.hosted-ui/utils/cx'))
  assert.throws(() => resolveOverlaySpecifier('@ui-slot/nothing', aliases), /UI_SLOT_UNKNOWN/)
})

test('a slot the layer does not fill keeps its default', t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.hosted-ui'), { recursive: true })
  const aliases = overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: join(root, '.hosted-ui') })
  assert.equal(aliases.turbopack['@ui-slot/bot-avatar'], './components/slots/bot-avatar.tsx')
})

test('a missing layer or one outside the repository fails the build', t => {
  const root = repository()
  const outside = mkdtempSync(join(tmpdir(), 'ui-overlay-outside-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: '.hosted-ui' }), /UI_OVERLAY_DIR_MISSING/)
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: outside }), /UI_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
  symlinkSync(outside, join(root, 'linked'))
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: 'linked' }), /UI_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: '.' }), /UI_OVERLAY_DIR_OUTSIDE_REPOSITORY/)
})
