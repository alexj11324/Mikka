import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transform } from 'lightningcss'
import { sharedCssTargets } from './css-targets.mjs'

const css = name => readFile(new URL(`../../../app/${name}`, import.meta.url), 'utf8')
const pass = (code, minify) => transform({ filename: 'shared.css', code: Buffer.from(code), minify, targets: sharedCssTargets }).code.toString()

test('the shared targets are the frozen baseline from the application\'s Next-era build', () => {
  assert.deepEqual({ ...sharedCssTargets }, { chrome: 7274496, edge: 7274496, firefox: 7274496, safari: 1049600 })
})

test('a nested @apply keeps its universal selector, so the rule still applies to every element', async () => {
  // Lightning CSS 1.30 and 1.32 drop `*` from `* { @apply ... }`. The base layer
  // relies on it for border and focus-ring defaults, so that is a behavior
  // change, not a formatting difference. Keep the pinned 1.33 behavior asserted.
  const output = pass(await css('globals.css'), true)
  assert.ok(output.includes('*{'), 'the universal selector is still emitted')
  assert.ok(/@layer base\{\*\{(?:@apply|border-color)/.test(output) || output.includes('@layer base{*{'), 'the base layer still scopes the universal rule')
})

test('the compiled stylesheet still carries the shipped color and type tokens', async () => {
  const output = pass(await css('globals.css'), true)
  for (const token of ['--color-brand-claude:', '--text-xs:', '--text-md:', '--font-sans:']) {
    assert.ok(output.includes(token), `${token} survives the Lightning CSS pass`)
  }
})

test('the pass is deterministic for the same source', async () => {
  const source = await css('globals.css')
  assert.equal(pass(source, true), pass(source, true))
})

test('the compiled stylesheet is byte-identical to the Next-era build it replaces', async () => {
  // Frozen from the application's last build through Next's embedded Lightning
  // CSS binding (over app/globals.css, minified, shared targets). A different
  // hash means the visible stylesheet changed; update this constant only with a
  // screenshot comparison of the affected screens.
  const output = pass(await css('globals.css'), true)
  const digest = createHash('sha256').update(output).digest('hex')
  assert.equal(digest, '4a101cdafa30344adc084ce49cb201eb9acba655ff8ab6f27f67cb67c28bf045')
})
