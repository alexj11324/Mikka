import assert from 'node:assert/strict'
import test from 'node:test'
import { githubEvidenceFailure } from './github-error.mjs'

test('GitHub validation retains actionable fields without rejected values or arbitrary messages', () => {
  const secret = 'private-token-and-response-value'
  const value = githubEvidenceFailure({ message: 'Validation Failed', errors: [
    { resource: 'Commit', field: 'author.email', code: 'invalid', value: secret, message: secret },
    { resource: secret, field: secret, code: secret },
  ] }, new Headers({ 'retry-after': secret, 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794030000' }))
  assert.equal(value.category, 'validation_failed')
  assert.deepEqual(value.errors, [{ resource: 'Commit', field: 'author.email', code: 'invalid' },
    { resource: 'unknown', field: 'unknown', code: 'unknown' }])
  assert.equal(value.rateLimitRemaining, 0)
  assert.equal(value.rateLimitReset, 1794030000)
  assert.equal(value.retryAfter, null)
  assert.ok(!JSON.stringify(value).includes(secret))
})

test('rate-limit metadata is numeric and diagnostics bound repeated errors', () => {
  const value = githubEvidenceFailure({ message: 'You have exceeded a secondary rate limit.',
    errors: Array.from({ length: 100 }, () => ({ resource: 'Commit', field: 'tree', code: 'invalid' })) }, new Headers({ 'retry-after': '60' }))
  assert.equal(value.category, 'rate_limited')
  assert.equal(value.retryAfter, 60)
  assert.equal(value.errors.length, 8)
  assert.equal(value.errorsTruncated, true)
})

test('non-JSON or unexpected GitHub errors keep no response text', () => {
  for (const body of [null, '<html>private-token</html>', { message: 'private-token', errors: 'private-token' }]) {
    assert.equal(githubEvidenceFailure(body, new Headers()).category, 'unknown')
    assert.ok(!JSON.stringify(githubEvidenceFailure(body, new Headers())).includes('private-token'))
  }
})

test('recognizes a ref collision without misclassifying other validation or conflict errors', () => {
  const classify = body => githubEvidenceFailure(body, new Headers()).category
  assert.equal(classify({ message: 'Reference already exists' }), 'reference_exists')
  assert.equal(classify({ message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'ref', code: 'already_exists' }] }), 'reference_exists')
  assert.equal(classify({ message: 'Validation Failed', errors: [{ resource: 'Commit', field: 'sha', code: 'invalid' }] }), 'validation_failed')
  assert.equal(classify({ message: 'Git Repository is empty.' }), 'unknown')
})
