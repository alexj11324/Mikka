import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { compile } from 'tailwindcss'
import { HEADER_CONTAINER, HEADER_NARROW, MODE_SLOT_NARROW } from './thread-header-layout'

const require = createRequire(import.meta.url)

// The stylesheet loader Tailwind's compiler asks for. `utilities` carries the
// container-query and viewport variants without the preflight, so the CSS here
// is only what these classes generate.
const loadStylesheet = async (id: string, base: string) => {
  const file = id.startsWith('.') ? resolve(base, id) : require.resolve(id)
  return { path: file, base: dirname(file), content: await readFile(file, 'utf8') }
}

const words = (source: string) => source.split(/\s+/).filter(Boolean)

async function compileClasses(classes: readonly string[]) {
  const compiler = await compile('@import "tailwindcss/utilities";', { base: process.cwd(), loadStylesheet })
  return compiler.build([...classes])
}

/**
 * The narrow header must be a *container* query on the column (#1891 review).
 * A viewport variant (`max-sm:`) compiles to `@media` and never matches in a
 * 320–360 px right column opened inside a 1440 px window, which is the bug this
 * pins: if the variants below ever lose their container modifier, this fails
 * instead of silently rendering nothing.
 */
test('the narrow header compiles to a container query on the column at 22rem', async () => {
  const css = await compileClasses([...words(HEADER_CONTAINER), ...words(HEADER_NARROW), ...words(MODE_SLOT_NARROW)])
  // The slot's wrapper is the query container, named so its children query it.
  assert.match(css, /container-type: inline-size/)
  assert.match(css, /container-name: thread-header/)
  // 22rem (352 px): a 320 px column wraps, a 360 px one does not.
  assert.match(css, /@container thread-header \(width < 22rem\)/)
  assert.match(css, /flex-wrap: wrap/)
  assert.match(css, /order: 9999/)
  assert.match(css, /width: 100%/)
  assert.doesNotMatch(css, /@media/)
})

test('a viewport variant is the different thing: it compiles to @media', async () => {
  // Documents the distinction the review named; the header must not use this.
  const css = await compileClasses(['max-[40rem]:flex-wrap'])
  assert.match(css, /@media \(width < 40rem\)/)
  assert.doesNotMatch(css, /@container/)
})
