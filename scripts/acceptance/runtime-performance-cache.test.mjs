import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cacheDirectory } from './runtime-performance.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-performance-cache-'))
  const outside = await mkdtemp(join(tmpdir(), 'mikka-performance-outside-'))
  try {
    execFileSync('git', ['init', '--quiet', root])
    await writeFile(join(root, '.gitignore'), '/.next/\n/.cache/dev-runtime/\n')
    await run(root, outside)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}

test('cold compiler cache directories are recognized while still absent', () => fixture(async root => {
  for (const path of ['.next', '.cache/dev-runtime/3111']) {
    assert.equal(await cacheDirectory(root, path), join(root, path))
    await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' })
  }
}))

test('tracked cache content is refused even under an ignore rule', () => fixture(async root => {
  await mkdir(join(root, '.next'))
  await writeFile(join(root, '.next', 'kept'), 'tracked evidence')
  execFileSync('git', ['add', '-f', '.next/kept'], { cwd: root })
  await assert.rejects(cacheDirectory(root, '.next'), /tracked files/)
  assert.equal(await readFile(join(root, '.next', 'kept'), 'utf8'), 'tracked evidence')
}))

test('unignored directories and symlinks outside the snapshot are refused', () => fixture(async (root, outside) => {
  await mkdir(join(root, 'unignored'))
  await assert.rejects(cacheDirectory(root, 'unignored'))
  await symlink(outside, join(root, '.next'), 'dir')
  await assert.rejects(cacheDirectory(root, '.next'), /another checkout/)
}))
