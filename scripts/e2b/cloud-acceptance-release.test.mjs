import test from 'node:test'
import assert from 'node:assert/strict'
import { cloudAcceptanceRelease } from './cloud-acceptance-release.mjs'

const sourceCommit = 'a'.repeat(40), workerHash = 'b'.repeat(40)
const fixture = overrides => ({ env: {}, revision: () => sourceCommit, hash: commit => { assert.equal(commit, sourceCommit); return workerHash }, ...overrides })

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
