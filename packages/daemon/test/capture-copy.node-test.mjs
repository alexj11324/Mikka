import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyCaptureFd } from '../src/agents/capture-copy.mjs'

test('copy keeps the checked file when its pathname is replaced by a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-fd-'))
  try {
    const file = join(dir, 'checked'), moved = join(dir, 'original'), other = join(dir, 'other'), output = join(dir, 'output')
    const allowed = Buffer.from('synthetic-allowed'), outside = Buffer.from('synthetic-outside')
    writeFileSync(file, allowed); writeFileSync(other, outside)
    const fd = openSync(file, 'r')
    try {
      renameSync(file, moved)
      symlinkSync(other, file)
      copyCaptureFd(fd, output, allowed.length)
    } finally { closeSync(fd) }
    assert.deepEqual(readFileSync(output), allowed)
    assert.notDeepEqual(readFileSync(output), outside)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
