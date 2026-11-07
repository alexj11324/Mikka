import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { preparePresenceSource } from '../issue-1212-presence/presence-source.mjs'
import { prepareMobilePresenceSource } from './source.mjs'

const sourceRoot = process.env.MIKKA_PRESENCE_SOURCE_ROOT
const afterPins = JSON.parse(readFileSync(new URL('../issue-1212-presence/presence-source-hashes.json', import.meta.url)))
const mobilePins = JSON.parse(readFileSync(new URL('./source-hashes.json', import.meta.url)))

test('both after loaders bind the actual remote application HEAD and tree as well as every product blob', async () => {
  const after = preparePresenceSource(sourceRoot), mobile = await prepareMobilePresenceSource(sourceRoot)
  try {
    assert.equal(after.sourceBase, 'a1902d720c5cd6b3ff45d94cfe1bc154d4aa38b9')
    assert.equal(mobile.sourceCommit, after.sourceBase)
    assert.equal(after.sourceTree, '1fc41beaa8fa5c06e0af34ccd85cd52e160125b7')
    assert.equal(mobile.sourceTree, after.sourceTree)
    assert.deepEqual(after.hashes, afterPins.hashes)
    assert.deepEqual(mobile.hashes, mobilePins.hashes)
  } finally { after.close(); mobile.close() }
})

test('identical pinned source files in another Git commit are rejected before compilation or requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-after-head-test-'))
  const git = args => execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    for (const path of Object.keys({ ...afterPins.hashes, ...mobilePins.hashes })) {
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), readFileSync(join(sourceRoot, path)))
    }
    git(['init', '--quiet']); git(['add', '.'])
    git(['-c', 'user.name=Offline Source Test', '-c', 'user.email=offline@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-gpg-sign', '-m', 'Independent test source copy'])
    assert.throws(() => preparePresenceSource(directory), /presence_source_head_mismatch/)
    await assert.rejects(prepareMobilePresenceSource(directory), /presence_mobile_source_head_mismatch/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
