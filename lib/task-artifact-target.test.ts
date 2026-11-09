import assert from 'node:assert/strict'
import test from 'node:test'
import { taskArtifactTarget } from './task-artifact-target.ts'

const id = '2b6f6b53-3d0a-4a3e-9d0e-5f1a7c8e9b10'

test('a stored document (plan, acceptance report) opens in the Artifact window by its id', () => {
  assert.deepEqual(taskArtifactTarget({ artifactId: id, kind: 'acceptance', url: '/mikka?artifact=' + id }), { kind: 'artifact', id })
})

test('a pull request has no artifact id and opens on GitHub', () => {
  const url = 'https://github.com/acme/app/pull/12'
  assert.deepEqual(taskArtifactTarget({ kind: 'pull_request', url }), { kind: 'link', url })
})

test('a screenshot or a recording opens at its media address on this origin', () => {
  const url = '/mikka/api/factory/tasks/t/media/c'
  assert.deepEqual(taskArtifactTarget({ kind: 'image', url }), { kind: 'link', url })
})

test('nothing to open: no id, no address, or an address that is neither https nor this origin', () => {
  assert.equal(taskArtifactTarget(null), null)
  assert.equal(taskArtifactTarget({ kind: 'pull_request' }), null)
  assert.equal(taskArtifactTarget({ artifactId: 'not-an-id' }), null)
  assert.equal(taskArtifactTarget({ url: 'javascript:alert(1)' }), null)
  assert.equal(taskArtifactTarget({ url: 'http://example.test/x' }), null)
})
