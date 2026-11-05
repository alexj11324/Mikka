import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { TOKENS } from '../lib/tokens.ts'

const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8')
const normal = (value: string) => value.replace(/\s+/g, '').toLowerCase()

/** Every `--name: value; /* token *\/` line of one colour scheme's block. */
function lines(scheme: 'light' | 'dark') {
  const block = css.split(`@variant ${scheme} {`)[1]?.split('}')[0] ?? ''
  return [...block.matchAll(/(--[\w-]+):\s*([^;]+);\s*\/\*\s*(\w+)\s*\*\//g)].map(([, variable, value, token]) => ({ variable, value, token }))
}

for (const scheme of ['light', 'dark'] as const) {
  test(`styles/tokens.css ${scheme} values are the lib/tokens.ts tokens they name`, () => {
    const found = lines(scheme)
    assert.ok(found.length > 20, 'tokens.css has its token lines')
    for (const { variable, value, token } of found) {
      assert.ok(token in TOKENS, `${variable} names a token in lib/tokens.ts (${token})`)
      assert.equal(normal(value), normal(TOKENS[token as keyof typeof TOKENS][scheme]), `${variable} (${scheme}) is ${token}`)
    }
  })
}
