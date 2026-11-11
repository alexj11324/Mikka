import assert from 'node:assert/strict'
import test from 'node:test'
import { publishEvidenceRef } from './verify-created-ref.mjs'

const branch = 'evidence/self-hosting-ui/source-42-1'
const sha = 'a'.repeat(40)
const ref = `refs/heads/${branch}`
const receipt = { ref, object: { type: 'commit', sha } }

function checkPublication(responses, expectedCalls) {
  const calls = []
  const published = publishEvidenceRef((path, body) => {
    calls.push({ path, body })
    const response = responses.shift()
    if (response instanceof Error) throw response
    return response
  }, branch, sha)
  return published.finally(() => assert.deepEqual(calls, expectedCalls))
}

const create = { path: '/refs', body: { ref, sha } }
const read = { path: `/ref/heads/${branch}`, body: undefined }

test('creates the evidence ref atomically and verifies the exact commit with one read', () =>
  checkPublication([receipt, receipt], [create, read]))

test('rejects a malformed commit SHA before creating anything', async () => {
  await assert.rejects(publishEvidenceRef(() => assert.fail('unexpected request'), branch, 'abc'), /EVIDENCE_PUBLICATION_MISMATCH/)
})

test('a collision or denied create preserves the GitHub error and never reads or overwrites', async () => {
  for (const code of ['EVIDENCE_BRANCH_ALREADY_EXISTS', 'EVIDENCE_GITHUB_HTTP_403']) {
    const error = new Error(code)
    await assert.rejects(checkPublication([error], [create]), actual => actual === error)
  }
})

test('a wrong ref, object type or SHA fails either receipt', async () => {
  for (const bad of [null, { ...receipt, ref: ref + '-other' }, { ref, object: { type: 'tag', sha } },
    { ref, object: { type: 'commit', sha: 'b'.repeat(40) } }]) {
    await assert.rejects(checkPublication([bad], [create]), /EVIDENCE_PUBLICATION_MISMATCH/)
    await assert.rejects(checkPublication([receipt, bad], [create, read]), /EVIDENCE_PUBLICATION_MISMATCH/)
  }
})

test('a missing or forbidden independent read fails immediately with its GitHub error', async () => {
  for (const code of [404, 403]) {
    const error = new Error(`EVIDENCE_GITHUB_HTTP_${code}`)
    await assert.rejects(checkPublication([receipt, error], [create, read]), actual => actual === error)
  }
})
