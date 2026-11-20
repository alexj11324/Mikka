import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditExternalClientMocks, externalClientMocks } from './external-client-mock-policy.mjs'

test('provider mocks fail across package, alias, relative and URL module names', () => {
  for (const code of [
    `mock.module('e2b', {})`,
    `t.mock.module('@/lib/computer/e2b-provider', {})`,
    `mock.module('../lib/slack/automation-notice.ts', {})`,
    `mock.module(new URL('../lib/github/user-access.ts', import.meta.url).href, {})`,
    `renamedMock.module('@slack/web-api', {})`,
  ]) {
    const found = externalClientMocks('tests/provider.test.ts', code)
    assert.equal(found.length, 1)
    assert.equal(auditExternalClientMocks(found, {}).length, 1)
  }
  assert.deepEqual(externalClientMocks('tests/provider.test.ts', `import { Sandbox } from 'e2b'; mock.module('../lib/db/index.ts', {})`), [])
})

test('the exact existing file/module count is allowed, while added mocks and baseline expansion fail', () => {
  const found = externalClientMocks('tests/provider.test.ts', `mock.module('e2b', {})`)
  const baseline = { 'tests/provider.test.ts:e2b': 1 }
  assert.deepEqual(auditExternalClientMocks(found, baseline), [])
  assert.equal(auditExternalClientMocks([...found, ...found], baseline).length, 1)
  assert.equal(auditExternalClientMocks(found, { ...baseline, 'tests/another.test.ts:e2b': 1 }, baseline).length, 1)
  assert.deepEqual(auditExternalClientMocks([], {}, baseline), [])
})
