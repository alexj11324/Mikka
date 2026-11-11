import assert from 'node:assert/strict'
import test from 'node:test'
import { completedCiSuite, linkedCiSuiteRun } from './ci-suite-event'
import { GITHUB_APP_MANIFEST_TEMPLATE } from './manifest-template'

const sha = 'a'.repeat(40)
const payload = {
  installation: { id: 123 },
  repository: { id: 456, full_name: 'Acme/App' },
  action: 'completed',
  check_suite: {
    id: 789,
    status: 'completed',
    conclusion: 'failure',
    head_sha: sha,
    pull_requests: [{ number: 7, head: { sha } }, { number: 7, head: { sha } }, { number: 8, head: { sha } }],
  },
}
const row = {
  runId: 'run-id',
  userId: 'owner',
  botId: 'bot-id',
  issueId: 'issue-id',
  pullUrl: 'https://github.com/acme/app/pull/7',
  headSha: sha,
  state: 'open',
}
test('completed suite is one bounded canonical wake hint, never an entire check rollup', () => {
  const result = completedCiSuite('check_suite', payload)!
  assert.deepEqual(result, {
    installationId: 123, repositoryId: 456, repository: 'acme/app',
    suiteId: 789, headSha: sha, conclusion: 'failure', numbers: [7, 8], heads: { '7': sha, '8': sha },
  })
  assert.equal(completedCiSuite('workflow_run', payload), null)
  assert.equal(completedCiSuite('check_run', payload), null)
  assert.equal(completedCiSuite('check_suite', { ...payload, action: 'requested' }), null)
  assert.equal(completedCiSuite('check_suite', { ...payload, check_suite: { ...payload.check_suite, status: 'queued' } }), null)
  assert.equal(completedCiSuite('check_suite', { ...payload, check_suite: { ...payload.check_suite, conclusion: null } }), null)
  assert.equal(completedCiSuite('check_suite', { ...payload, installation: { id: 0 } }), null)
  assert.equal(completedCiSuite('check_suite', { ...payload, repository: { id: 456, full_name: '../private' } }), null)
  assert.equal(completedCiSuite('check_suite', { ...payload, check_suite: { ...payload.check_suite, head_sha: 'not-a-commit' } }), null)
  assert.equal(completedCiSuite('check_suite', { ...payload, check_suite: { ...payload.check_suite, pull_requests: [{ number: -1 }] } }), null)
  assert.equal(completedCiSuite('check_suite', { ...payload, check_suite: { ...payload.check_suite, pull_requests: Array.from({ length: 101 }, () => ({ number: 7 })) } }), null)
})

test('only an already-bound open PR on exactly that head and repository receives a suite hint', () => {
  const event = completedCiSuite('check_suite', payload)!
  assert(linkedCiSuiteRun(event, row))
  assert(linkedCiSuiteRun(event, { ...row, state: 'draft' }))
  assert(linkedCiSuiteRun(event, { ...row, pullUrl: 'https://github.com/Acme/App/pull/7' }))
  // GitHub Actions PR checks may run on a synthetic merge commit; the
  // associated PR's head.sha still proves the original source head.
  const synthetic = completedCiSuite('check_suite', {
    ...payload, check_suite: { ...payload.check_suite, head_sha: 'b'.repeat(40) },
  })!
  assert(linkedCiSuiteRun(synthetic, row))
  assert(!linkedCiSuiteRun(synthetic, { ...row, headSha: 'c'.repeat(40) }))
  for (const invalid of [
    { state: 'merged' }, { state: 'closed' }, { state: null },
    { headSha: 'b'.repeat(40) }, { headSha: null },
    { pullUrl: 'https://github.com/other/app/pull/7' },
    { pullUrl: 'https://github.com/acme/app/pull/9' },
    { pullUrl: 'https://github.com/acme/app/pull/7/extra' },
    { pullUrl: 'https://github.com/acme/app/pull/0' },
    { botId: null }, { runId: '' }, { userId: '' },
  ]) assert.equal(linkedCiSuiteRun(event, { ...row, ...invalid }), false, JSON.stringify(invalid))
  // GitHub omits pull_requests for some fork check suites. Match by exact
  // repository and head SHA, never guess from an unrelated PR or old SHA.
  const fork = completedCiSuite('check_suite', {
    ...payload, check_suite: { ...payload.check_suite, pull_requests: [] },
  })!
  assert(linkedCiSuiteRun(fork, row))
  assert(!linkedCiSuiteRun(fork, { ...row, headSha: 'c'.repeat(40) }))
  assert(!linkedCiSuiteRun(fork, { ...row, pullUrl: 'https://github.com/foreign/repo/pull/7' }))
})

test('new self-hosted GitHub Apps subscribe to aggregate CI results without more permissions', () => {
  assert(GITHUB_APP_MANIFEST_TEMPLATE.events.includes('check_suite'))
  assert(GITHUB_APP_MANIFEST_TEMPLATE.events.includes('status'))
  assert.equal(GITHUB_APP_MANIFEST_TEMPLATE.permissions.checks, 'read')
  assert.equal(GITHUB_APP_MANIFEST_TEMPLATE.permissions.statuses, 'read')
  assert(!GITHUB_APP_MANIFEST_TEMPLATE.events.includes('workflow_run'))
})
