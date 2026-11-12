import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { overlayAliases, resolveOverlaySpecifier, PUBLIC_CONTRACT_SLOTS, UI_SLOTS } from './ui-overlay.mjs'

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
  for (const name of UI_SLOTS) if (!PUBLIC_CONTRACT_SLOTS.has(name)) writeFileSync(join(root, '.hosted-ui/slots', name + '.tsx'), '')
  const aliases = overlayAliases(root, { MIKKA_UI_OVERLAY_DIR: '.hosted-ui' })
  assert.equal(aliases.dir, join(root, '.hosted-ui'))
  assert.equal(aliases.turbopack['@ui-slot/bot-avatar'], './.hosted-ui/slots/bot-avatar.tsx')
  assert.equal(aliases.turbopack['@hosted/*'], './.hosted-ui/*')
  assert.equal(resolveOverlaySpecifier('@hosted/utils/cx', aliases), join(root, '.hosted-ui/utils/cx'))
  assert.throws(() => resolveOverlaySpecifier('@ui-slot/nothing', aliases), /UI_SLOT_UNKNOWN/)
})

test('an official build resolves the three known public contracts and rejects every other missing provider', t => {
  const root = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, '.hosted-ui')
  mkdirSync(join(dir, 'slots'), { recursive: true })
  for (const name of UI_SLOTS) if (!PUBLIC_CONTRACT_SLOTS.has(name)) writeFileSync(join(dir, 'slots', name + '.tsx'), '')
  const env = { MIKKA_UI_OVERLAY_DIR: dir }
  const aliases = overlayAliases(root, env)
  for (const name of PUBLIC_CONTRACT_SLOTS) assert.equal(aliases.absolute['@ui-slot/' + name], join(root, 'components/slots', name + '.tsx'))
  for (const name of UI_SLOTS) {
    if (PUBLIC_CONTRACT_SLOTS.has(name)) continue
    const file = join(dir, 'slots', name + '.tsx')
    rmSync(file)
    assert.throws(() => overlayAliases(root, env), { message: 'UI_OVERLAY_SLOT_REQUIRED: ' + name })
    writeFileSync(file, '')
  }
  assert.throws(() => overlayAliases(root, { MIKKA_UI_OVERLAY_SHA: 'a'.repeat(40) }), /UI_OVERLAY_DIR_REQUIRED_FOR_RELEASE/)
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

// A slot's required exports (UI_SLOT_EXPORTS) are what a deployed layer must
// provide. A named import of anything else fails the hosted production build
// when the deployed layer predates it, so optional exports go through a
// namespace import (docs/ui-overlay.md).
test('callers import only the required slot exports by name, and each default exports them', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const { UI_SLOT_EXPORTS } = await import('./ui-overlay.mjs')
  const root = new URL('..', import.meta.url).pathname
  assert.deepEqual(Object.keys(UI_SLOT_EXPORTS).sort(), [...UI_SLOTS].sort())
  const sources = []
  const walk = dir => {
    for (const entry of readdirSync(join(root, dir))) {
      const path = join(dir, entry)
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else if (/\.(?:tsx?|mjs|jsx?)$/.test(entry)) sources.push(path)
    }
  }
  for (const dir of ['app', 'components', 'hooks', 'lib', 'apps/desktop/src']) walk(dir)
  const named = /(?:import|export)\s*(?:type\s+)?\{([^}]*)\}\s*from\s*'@ui-slot\/([^']+)'/g
  const problems = []
  for (const file of sources) {
    if (file.startsWith('components/slots/') || file.startsWith('lib/ui-overlay')) continue
    const text = readFileSync(join(root, file), 'utf8')
    for (const [, names, slot] of text.matchAll(named)) {
      for (const name of names.split(',').map(part => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!UI_SLOT_EXPORTS[slot]?.includes(name)) problems.push(`${file} imports ${name} from @ui-slot/${slot}`)
      }
    }
  }
  for (const [slot, names] of Object.entries(UI_SLOT_EXPORTS)) {
    const text = readFileSync(join(root, `components/slots/${slot}.tsx`), 'utf8')
    for (const name of names) {
      if (!new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(text)) problems.push(`components/slots/${slot}.tsx does not export ${name}`)
    }
  }
  assert.deepEqual(problems, [])
})
