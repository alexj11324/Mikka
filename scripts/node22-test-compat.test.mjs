// Unit tests run on Node 22 as well as CI's Node 24. Node 22's mock.module
// ignores the `exports` option (it takes namedExports/defaultExport), and it
// has no --test-isolation flag (only --experimental-test-isolation).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.mts', '*.mjs', '*.js', 'package.json'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean).filter((path) => !path.startsWith('node_modules/') && path !== 'scripts/node22-test-compat.test.mjs')

test('mock.module never uses the Node 24-only exports option', () => {
  const found = []
  for (const path of tracked) {
    const text = readFileSync(new URL(path, root), 'utf8')
    if (!text.includes('mock.module')) continue
    for (const call of text.matchAll(/mock\.module\(((?:(?!mock\.module)[\s\S]){0,400})/g))
      if (/[{,]\s*exports\s*[:,}]/.test(call[1])) found.push(`${path}:${text.slice(0, call.index).split('\n').length}`)
  }
  assert.deepEqual(found, [], 'use namedExports / defaultExport instead')
})

test('no command uses the Node 24-only --test-isolation flag', () => {
  const found = tracked.filter((path) => /(?<!experimental-)--test-isolation/.test(readFileSync(new URL(path, root), 'utf8')))
  assert.deepEqual(found, [], 'use --experimental-test-isolation instead')
})
