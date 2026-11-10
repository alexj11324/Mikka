import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { compileSharedStyles } from './build-renderer.mjs'

test('the native shared palette retains the web build color space for neutral color mixing', async () => {
  const file = fileURLToPath(new URL('../../../app/globals.css', import.meta.url))
  const css = await compileSharedStyles(await readFile(file, 'utf8'), file)
  const declarations = new Map()
  postcss.parse(css).walkRules(rule => {
    if (rule.selector !== ':root' && rule.selector !== '.dark') return
    for (const node of rule.nodes) if (node.type === 'decl') declarations.set(`${rule.selector}/${node.prop}`, node.value)
  })
  // The actual hosted 7973 CSS uses these lab() values. Retaining oklch(... 0 0)
  // gives Chromium an explicit zero hue and turns this shared soft blue pink.
  assert.equal(declarations.get(':root/--sidebar-primary'), 'lab(44.0605% 29.0279 -86.0352)')
  assert.equal(declarations.get(':root/--sidebar'), 'lab(98.26% 0 0)')
  assert.equal(declarations.get('.dark/--sidebar-primary'), 'lab(36.9089% 35.0961 -85.6872)')
  assert.equal(declarations.get('.dark/--sidebar'), 'lab(1.3738% 0 0)')
  assert.match(declarations.get(':root/--sidebar-primary-soft'), /color-mix\(in oklab,\s*var\(--sidebar-primary\)\s*15%,\s*var\(--sidebar\)\)/)
  assert.match(declarations.get('.dark/--sidebar-primary-soft'), /color-mix\(in oklab,\s*var\(--sidebar-primary\)\s*40%,\s*var\(--sidebar\)\)/)
})
