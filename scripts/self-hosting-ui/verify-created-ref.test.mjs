import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyCreatedRef } from './verify-created-ref.mjs'

const expected = { object: { sha: 'created-commit' } }

test('an acknowledged ref can become readable after an initial missing read', async () => {
  const responses = [null, expected]
  const pauses = []
  await verifyCreatedRef(() => responses.shift(), expected.object.sha, ms => pauses.push(ms))
  assert.equal(responses.length, 0)
  assert.equal(pauses.length, 1)
})

test('an existing different commit or a permission error fails immediately', async () => {
  const unexpectedWait = () => assert.fail('unexpected retry')
  await assert.rejects(verifyCreatedRef(() => expected, 'other', unexpectedWait), /EVIDENCE_PUBLICATION_MISMATCH/)
  const denied = new Error('EVIDENCE_GITHUB_HTTP_403')
  await assert.rejects(verifyCreatedRef(() => { throw denied }, expected.object.sha, unexpectedWait), e => e === denied)
})

test('persistent absence ends with the original GitHub error on the final read', async () => {
  const calls = []
  const missing = new Error('EVIDENCE_GITHUB_HTTP_404')
  await assert.rejects(verifyCreatedRef(allowMissing => {
    calls.push(allowMissing)
    if (!allowMissing) throw missing
    return null
  }, expected.object.sha, () => {}), e => e === missing)
  assert.deepEqual(calls, [true, true, true, true, true, true, false])
})
