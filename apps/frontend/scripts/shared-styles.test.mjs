import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import postcss from 'postcss'
import { repository } from './application-plugin.mjs'
import { sharedStylePlugins } from './shared-styles.mjs'
import { sharedCssTargets } from './css-targets.mjs'

const css = name => readFile(new URL(`../../../app/${name}`, import.meta.url), 'utf8')

/** Run the real build pass: Tailwind expands `@apply`, then Lightning CSS
 * compiles for the frozen targets. This is the order the application ships. */
async function compileThroughSharedStyles(source) {
  const result = await postcss(sharedStylePlugins(repository)).process(source, { from: 'app/globals.css' })
  return result.css
}

test('the shared targets are the frozen baseline from the application\'s Next-era build', () => {
  assert.deepEqual({ ...sharedCssTargets }, { chrome: 7274496, edge: 7274496, firefox: 7274496, safari: 1049600 })
})

test('the shipped stylesheet has no unexpanded @apply, so Tailwind ran before Lightning CSS', async () => {
  const output = await compileThroughSharedStyles(await css('globals.css'))
  assert.ok(!output.includes('@apply'), 'Tailwind expanded every @apply')
})

test('the base layer still applies the border color to every element', async () => {
  // `* { @apply border-border outline-ring/50; }` is what gives every element
  // its border and focus-ring color. Lightning CSS 1.30 and 1.32 drop the
  // selector when they see a nested `@apply`; the pinned 1.33 keeps it. If the
  // Tailwind pass ever moves after Lightning CSS, this is the rule that breaks.
  const output = await compileThroughSharedStyles(await css('globals.css'))
  assert.ok(
    output.includes('*{border-color:var(--border);outline-color:var(--ring)}'),
    'the universal rule keeps its border and ring colors',
  )
})

test('the shipped stylesheet keeps its color and type tokens', async () => {
  const output = await compileThroughSharedStyles(await css('globals.css'))
  for (const token of ['--color-brand-claude:', '--text-xs:', '--text-md:', '--font-sans:']) {
    assert.ok(output.includes(token), `${token} survives the shared pass`)
  }
})

test('the shipped stylesheet guards its lab() colors behind a support query', async () => {
  const output = await compileThroughSharedStyles(await css('globals.css'))
  assert.ok(
    output.includes('@supports (color:lab(0% 0 0))'),
    'lab() colors only apply where the browser supports them',
  )
})

test('the pass is deterministic for the same source', async () => {
  const source = await css('globals.css')
  assert.equal(await compileThroughSharedStyles(source), await compileThroughSharedStyles(source))
})
