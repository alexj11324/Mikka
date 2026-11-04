import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { generationFailureDetails } from './subscription-generation-diagnostics'

test('SDK error names and bounded HTTP status survive the diagnostic projection', () => {
  for (const name of ['AI_APICallError', 'AI_InvalidResponseDataError', 'AI_JSONParseError', 'AI_TypeValidationError']) {
    const error = Object.assign(new Error('fixture-private-message'), { name, statusCode: 429 })
    assert.deepEqual(generationFailureDetails(error), { errorClass: name, errorCode: null, statusCode: 429, causes: [] })
  }
  const foreign = runInNewContext('Object.assign(new Error("private"), { name: "AI_APICallError", statusCode: 503 })')
  assert.equal(foreign instanceof Error, false)
  assert.equal(generationFailureDetails(foreign).errorClass, 'AI_APICallError')
  assert.equal(generationFailureDetails(foreign).statusCode, 503)
})

test('diagnostics read only fixed fields and never inspect private error payloads', () => {
  const error = Object.assign(new Error(), { name: 'fixture_private_name', code: 'fixture_private_code', statusCode: 'fixture_private_status' })
  for (const key of ['message', 'body', 'headers', 'data', 'stack', 'responseBody', 'responseHeaders', 'requestBodyValues']) {
    Object.defineProperty(error, key, { get() { assert.fail(`must not read ${key}`) } })
  }
  assert.deepEqual(generationFailureDetails(error), { errorClass: 'unknown', errorCode: null, statusCode: null, causes: [] })
  for (const statusCode of [NaN, Infinity, 0, 99, 600, 429.5, '429']) assert.equal(generationFailureDetails({ statusCode }).statusCode, null)
})

test('a cause chain preserves only fixed classes and codes, with four nodes at most', () => {
  const leaf = Object.assign(new Error('private-leaf'), { name: 'WorkerRefusal', code: 'provider_request_rejected' })
  const sdk = Object.assign(new Error('private-sdk', { cause: leaf }), { name: 'AI_APICallError', statusCode: 400 })
  const wrapped = new Error('private-wrapper', { cause: sdk })
  assert.deepEqual(generationFailureDetails(wrapped), {
    errorClass: 'Error', errorCode: null, statusCode: null,
    causes: [
      { errorClass: 'AI_APICallError', errorCode: null, statusCode: 400 },
      { errorClass: 'WorkerRefusal', errorCode: 'provider_request_rejected', statusCode: null },
    ],
  })
  const beyondLimit = Object.assign(new Error('private'), { code: 'ECONNRESET' })
  let root: Error = beyondLimit
  for (let i = 0; i < 4; i++) root = new Error('private', { cause: root })
  const projected = generationFailureDetails(root)
  assert.equal(projected.causes.length, 3)
  assert.ok(projected.causes.every(cause => cause.errorCode === null))
  assert.ok(!JSON.stringify(projected).includes('private'))
})

test('cyclic or throwing cause properties cannot mask the original failure', () => {
  const cycle: { name: string; cause?: unknown } = { name: 'TypeError' }
  cycle.cause = cycle
  assert.deepEqual(generationFailureDetails(cycle), { errorClass: 'TypeError', errorCode: null, statusCode: null, causes: [] })
  const hostile = new Proxy({}, { get() { throw new Error('fixture-private-getter') } })
  assert.deepEqual(generationFailureDetails(hostile), { errorClass: 'unknown', errorCode: null, statusCode: null, causes: [] })
  assert.deepEqual(generationFailureDetails(undefined), { errorClass: 'unknown', errorCode: null, statusCode: null, causes: [] })
})
