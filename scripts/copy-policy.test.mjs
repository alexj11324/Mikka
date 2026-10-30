// Figma names the cloud machine 「E2B」; the old product name must not come back (FE-7).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const banned = ['Mikka', 'Cloud'].join(' ')

test(`no 「${banned}」 in shipped copy, code or tests`, () => {
  let hits = ''
  try {
    hits = execFileSync('git', ['grep', '-n', '-F', banned, '--', 'messages', 'components', 'app', 'lib', 'hooks', 'tests', 'scripts', 'docs', ':!docs/design/decisions.md'], { encoding: 'utf8' })
  } catch (error) { if (error.status !== 1) throw error }
  assert.equal(hits, '', `use 「E2B」 (through i18n) instead:\n${hits}`)
})
