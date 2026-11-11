import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('published runtime, deployment and build sources cannot restore the retired workspace switch', () => {
  // Two upgrade regression tests must still pass an obsolete setting to prove it is ignored.
  const allowed = ['apps/api/runtime/server-page.test.ts', 'lib/server-info.test.ts']
  const flag = ['MIKKA', 'COMMUNITY', 'UI'].join('_')
  const scan = spawnSync('git', ['grep', '--fixed-strings', '--files-with-matches', '-I', '-e', flag,
    '--', '.', ':(exclude,glob)**/*.md', ':(exclude,glob)*.md', ...allowed.map(file => ':(exclude)' + file)],
  { cwd: new URL('../', import.meta.url), encoding: 'utf8' })
  if (scan.error) throw scan.error
  assert.equal(scan.status, 1, scan.stderr || 'Remove the retired workspace flag from: ' + scan.stdout.trim())
})
