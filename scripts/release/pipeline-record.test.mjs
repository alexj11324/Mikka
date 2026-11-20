import assert from 'node:assert/strict'
import test from 'node:test'
import { publicSummary, recordBody, recordPipeline } from './pipeline-record.mjs'

const names = ['web', 'api', 'eve', 'task', 'world', 'litellm']
function receipt() {
  return { version: 1, target: 'staging', status: 'failed', sourceCommit: 'a'.repeat(40),
    changedServices: ['litellm'], retainedServices: names.filter(name => name !== 'litellm'), failedStep: 'staging-probes',
    services: Object.fromEntries(names.map(name => [name, { digest: 'sha256:' + 'b'.repeat(64),
      contextDigest: 'sha256:' + 'c'.repeat(64), sourceCommit: 'a'.repeat(40), reused: name !== 'litellm',
      token: 'secret', internalAddress: 'https://private.example' }])),
    private: { token: 'secret' }, verification: { status: 'fail', routes: { status: 'fail', total: 1, passed: 0, failed: 1,
      failures: [{ route: '/mikka/api/version', method: 'OPTIONS', status: 404, body: 'secret' }] } } }
}

test('public evidence retains failed routes and immutable digests while discarding private values', () => {
  const summary = publicSummary(receipt(), { result: 'failure' })
  const body = recordBody(summary, '1001', '2')
  assert.doesNotMatch(body, /secret|private\.example|internalAddress/)
  assert.match(body, /\/mikka\/api\/version/)
  assert.match(body, /404/)
  assert.equal(summary.productionPromoted, false)
  assert.equal(summary.status, 'failed')
  const invalid = receipt()
  invalid.verification.routes.failures[0].route = 'https://private.example/?token=secret'
  assert.throws(() => publicSummary(invalid, { result: 'failure' }))
})

test('a successful job cannot turn a failed or missing verification receipt into a passed release', () => {
  assert.equal(publicSummary(receipt(), { result: 'success' }).status, 'failed')
  const missing = publicSummary(null, { source: 'a'.repeat(40), result: 'failure' })
  assert.equal(missing.status, 'failed')
  assert.equal(missing.failedStep, 'selection')
  assert.throws(() => publicSummary(null, { source: 'not-a-sha', result: 'failure' }))
  const noProbe = { ...receipt(), status: 'passed', verification: undefined }
  assert.equal(publicSummary(noProbe, { result: 'success' }).status, 'failed')
  const restored = { ...receipt(), rollback: { status: 'passed', services: ['litellm'] } }
  assert.equal(publicSummary(restored, { result: 'success' }).status, 'passed')
})

test('early selection failures retain the requested target and receipts cannot cross sources or environments', () => {
  const source = 'a'.repeat(40)
  const failed = publicSummary(null, { source, result: 'failure', target: 'production' })
  assert.equal(failed.sourceCommit, source)
  assert.equal(failed.target, 'production')
  assert.equal(failed.failedStep, 'selection')
  assert.equal(failed.status, 'failed')
  assert.throws(() => publicSummary(receipt(), { source: 'b'.repeat(40), result: 'failure' }), /source_mismatch/)
  assert.throws(() => publicSummary(receipt(), { source, result: 'failure', target: 'production' }), /target_mismatch/)
  assert.throws(() => publicSummary(null, { source, result: 'failure', target: 'unknown' }), /target_required/)
  const drill = receipt()
  drill.verification.failureDrill = { kind: 'route-404', status: 404, address: 'private.example' }
  assert.deepEqual(publicSummary(drill, { source, result: 'failure' }).verification.failureDrill, { kind: 'route-404', status: 404 })
  const invalid = structuredClone(drill)
  invalid.verification.failureDrill.kind = 'private.example'
  assert.throws(() => publicSummary(invalid, { source, result: 'failure' }))
  assert.throws(() => publicSummary({ ...drill, target: 'production' }, { source, result: 'failure', target: 'production' }))
})

test('the completed result creates a deployment record and opens or updates one failure issue', async () => {
  for (const existing of [false, true]) {
    const calls = []
    const api = async (path, options = {}) => {
      calls.push({ path, ...options })
      if (!options.method && path.includes('/deployments?')) return []
      if (!options.method && path.includes('/issues?')) return existing ? [{ number: 3000, body: '<!-- deploy-pipeline-failure -->\nprevious' }] : []
      if (path.endsWith('/deployments')) return { id: 42 }
      return { id: 1 }
    }
    const result = await recordPipeline({ summary: publicSummary(receipt(), { result: 'failure' }), runId: '1001', attempt: '2', api })
    assert.equal(result.deploymentId, 42)
    assert.equal(calls.find(call => call.path.endsWith('/statuses')).body.state, 'failure')
    const issue = calls.find(call => call.path.endsWith(existing ? '/issues/3000' : '/issues'))
    assert.equal(issue.method, existing ? 'PATCH' : 'POST')
    assert.ok(issue.body.body.startsWith('<!-- deploy-pipeline-failure -->'))
    assert.equal(calls.some(call => call.path.endsWith('/issues/2895/comments')), true)
    assert.equal(calls.some(call => call.path.endsWith('/issues/2894/comments')), true)
  }
})
