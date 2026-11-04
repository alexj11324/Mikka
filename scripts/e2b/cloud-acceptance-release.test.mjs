import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloudAcceptanceRelease } from './cloud-acceptance-release.mjs'

const sourceCommit = 'a'.repeat(40), workerHash = 'b'.repeat(40)
const fixture = overrides => ({ env: {}, revision: () => sourceCommit, status: () => '', hash: commit => { assert.equal(commit, sourceCommit); return workerHash }, ...overrides })

test('official instance release derives its worker digest from the exact acceptance revision', () => {
  assert.deepEqual(cloudAcceptanceRelease(fixture()), { sourceCommit, workerHash })
  assert.deepEqual(cloudAcceptanceRelease(fixture({ sourceCommit, workerHash, env: { MIKKA_CLOUD_WORKER_SOURCE_COMMIT: sourceCommit, MIKKA_CLOUD_WORKER_SHA: workerHash } })), { sourceCommit, workerHash })
})

test('private template configuration and a different source stop before worker preparation', () => {
  for (const env of [{ E2B_ACCEPTANCE_TEMPLATE: 'private-old-template' }, { LOCAL_LOOP_CLOUD_TEMPLATE_FILE: '/tmp/private-template.json' }]) {
    assert.throws(() => cloudAcceptanceRelease(fixture({ env, hash: () => assert.fail('No preparation for a private template') })), /official E2B templates/)
  }
  for (const source of ['main', 'c'.repeat(40)]) {
    assert.throws(() => cloudAcceptanceRelease(fixture({ sourceCommit: source, hash: () => assert.fail('No preparation for another source') })), /must match/)
  }
})

test('an old or malformed worker receipt cannot identify the official instance release', () => {
  assert.throws(() => cloudAcceptanceRelease(fixture({ revision: () => 'main' })), /immutable/)
  assert.throws(() => cloudAcceptanceRelease(fixture({ hash: () => 'not-a-digest' })), /fixed source/)
  for (const supplied of [{ workerHash: 'c'.repeat(40) }, { env: { MIKKA_CLOUD_WORKER_SHA: 'c'.repeat(40) } }, { env: { E2B_WORKER_SHA: 'c'.repeat(40) } }]) {
    assert.throws(() => cloudAcceptanceRelease(fixture(supplied)), /different source code/)
  }
})

test('real Git rejects changed or untracked runtime source before hashing but ignores generated caches', () => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-cloud-release-'))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    mkdirSync(join(root, 'lib'))
    writeFileSync(join(root, 'lib/runtime.ts'), 'export const value = 1\n')
    git(['init', '-q']); git(['add', 'lib/runtime.ts'])
    git(['-c', 'user.name=Acceptance fixture', '-c', 'user.email=acceptance@example.invalid', 'commit', '-qm', 'fixture'])
    mkdirSync(join(root, '.cache'))
    writeFileSync(join(root, '.cache/generated.json'), '{}')
    assert.equal(cloudAcceptanceRelease({ root, env: {}, hash: () => workerHash }).workerHash, workerHash)
    const rejectBeforeHash = () => assert.throws(() => cloudAcceptanceRelease({
      root, env: {}, hash: () => assert.fail('Dirty source must not prepare a worker or allocate a paid instance'),
    }), /clean tracked and untracked source/)
    writeFileSync(join(root, 'lib/runtime.ts'), 'export const value = 2\n')
    rejectBeforeHash()
    git(['add', 'lib/runtime.ts'])
    rejectBeforeHash()
    git(['restore', '--source=HEAD', '--staged', '--worktree', 'lib/runtime.ts'])
    writeFileSync(join(root, 'lib/untracked.ts'), 'export const untracked = true\n')
    rejectBeforeHash()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
