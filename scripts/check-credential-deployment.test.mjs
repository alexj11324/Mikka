import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDeployment } from './check-credential-deployment.mjs'
const base = { lifecycleApproved: true, origin: 'https://fixture.invalid', sha: 'a'.repeat(40) }
test('deployment probes use only fixed GETs, discard sensitive bodies and redact transport errors', async () => {
  const calls = []
  const config = { ...base, requestId: '12345678-1234-4123-8123-123456789abc', ownerCookie: 'synthetic-owner', otherOwnerCookie: 'synthetic-other' }
  const report = await checkDeployment(config, async (url, options) => {
    calls.push({ url, options })
    return new Response('synthetic-sensitive-body', { status: [401, 200, 404][calls.length - 1], headers: { 'cache-control': 'private, no-store' } })
  })
  assert.equal(report.result, 'GET_PROBES_PASS')
  assert.equal(report.basePath, '/mikka')
  assert.equal(report.targetOrigin, base.origin)
  assert.deepEqual(calls.map(call => call.url.pathname), [
    '/mikka/api/credential-requests/00000000-0000-4000-8000-000000000000',
    `/mikka/api/credential-requests/${config.requestId}`,
    `/mikka/api/credential-requests/${config.requestId}`,
  ])
  assert.equal(report.productionAcceptanceComplete, false)
  assert.equal(report.deploymentShaVerified, false)
  assert.equal(JSON.stringify(report).includes('synthetic'), false)
  for (const call of calls) { assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error'); assert.equal(call.url.origin, base.origin) }
  const failed = await checkDeployment(base, async () => { throw new Error('synthetic-sensitive-exception') })
  assert.equal(failed.result, 'INCOMPLETE_OR_FAILED')
  assert.equal(JSON.stringify(failed).includes('synthetic'), false)
})
test('reject unsafe targets before network; missing identities or cache controls cannot pass', async () => {
  for (const origin of ['http://fixture.invalid', 'https://user:pass@fixture.invalid', 'https://fixture.invalid/path', 'https://fixture.invalid/?token=value']) {
    await assert.rejects(checkDeployment({ ...base, origin }, () => { throw new Error('must not call') }), /invalid_target/)
  }
  const report = await checkDeployment(base, async () => new Response(null, { status: 401 }))
  assert.equal(report.result, 'INCOMPLETE_OR_FAILED')
  assert.equal(report.checks[0].noStore, false)
})

test('no target request without explicit lifecycle cleanup authorization', async () => {
  let called = false
  await assert.rejects(checkDeployment({ ...base, lifecycleApproved: false }, () => { called = true }), /lifecycle_approval_required/)
  assert.equal(called, false)
})
