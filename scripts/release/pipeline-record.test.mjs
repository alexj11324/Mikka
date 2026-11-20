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

function admissionReceipt(target = 'staging', failureCode = 'migration_execution_changed') {
  const origin = source => ({ source, runId: '1000', runAttempt: '1', artifactId: '9000', event: 'push', archiveSha256: 'd'.repeat(64) })
  return { version: 1, target, status: 'failed', sourceCommit: 'a'.repeat(40), previousSourceCommit: 'b'.repeat(40),
    manifestSha256: 'c'.repeat(64), origin: origin('a'.repeat(40)), previousOrigin: origin('b'.repeat(40)),
    deployment: { runId: '1001', runAttempt: '2', driverSource: 'e'.repeat(40), operationsSource: 'f'.repeat(40) },
    operationsQualification: { runId: '7000', runAttempt: '1', artifactId: '9001', privateSource: '9'.repeat(40) },
    failedStep: 'migration-identity', failureCode, admission: 'rejected',
    changedServices: [], retainedServices: [], services: {}, productionPromoted: false }
}

test('a dedicated migration admission rejection publishes only safe failure evidence for either target', () => {
  for (const target of ['staging', 'production']) for (const code of [
    'migration_identity_required', 'migration_identity_mismatch', 'migration_execution_changed',
  ]) {
    const raw = admissionReceipt(target, code)
    const summary = publicSummary(raw, { source: raw.sourceCommit, result: 'success', target })
    assert.deepEqual(summary, { version: 1, sourceCommit: raw.sourceCommit, status: 'failed', target,
      changedServices: [], retainedServices: [], services: {}, productionPromoted: false,
      previousSourceCommit: raw.previousSourceCommit, manifestSha256: raw.manifestSha256,
      failedStep: 'migration-identity', failureCode: code, admission: 'rejected' })
    const body = recordBody(summary, '1001', '2')
    assert.match(body, /admission rejected/)
    assert.match(body, /Service plan: \*\*not created\*\*; deployment writes: \*\*not started\*\*/)
    assert.ok(body.includes(code))
    assert.doesNotMatch(body, /retained|Verified|\| Service \||operationsSource|operationsQualification|archiveSha256|9000|9001/)
    for (const privateSource of [raw.deployment.operationsSource, raw.operationsQualification.privateSource]) {
      assert.equal(JSON.stringify(summary).includes(privateSource), false)
    }
    const bootstrap = { ...raw, previousSourceCommit: null, previousOrigin: null }
    assert.equal(publicSummary(bootstrap, { result: 'failure', target }).previousSourceCommit, undefined)
  }
})

test('migration admission rejection cannot conceal service writes, an unrelated failure, or private fields', () => {
  const cases = [
    ['missing admission', raw => { delete raw.admission }],
    ['unexpected field', raw => { raw.error = { path: '/private/operator', sql: 'private SQL' } }],
    ['unexpected status', raw => { raw.status = 'passed' }],
    ['unexpected admission', raw => { raw.admission = 'approved' }],
    ['unrelated failure', raw => { raw.failedStep = 'staging-probes' }],
    ['unbounded failure code', raw => { raw.failureCode = '/private/operator: private SQL' }],
    ['missing code', raw => { delete raw.failureCode }],
    ['changed service', raw => { raw.changedServices = ['api'] }],
    ['claimed retained service', raw => { raw.retainedServices = names }],
    ['service receipt', raw => { raw.services = receipt().services }],
    ['production promoted', raw => { raw.productionPromoted = true }],
    ['rollback receipt', raw => { raw.rollback = { status: 'passed', services: [] } }],
    ['verification receipt', raw => { raw.verification = { status: 'pass' } }],
    ['missing manifest digest', raw => { delete raw.manifestSha256 }],
    ['missing previous source', raw => { delete raw.previousSourceCommit }],
    ['previous identity mismatch', raw => { raw.previousSourceCommit = null }],
    ['previous origin missing', raw => { raw.previousOrigin = null }],
    ['candidate origin mismatch', raw => { raw.origin.source = 'b'.repeat(40) }],
    ['previous origin mismatch', raw => { raw.previousOrigin.source = 'a'.repeat(40) }],
    ['untrusted origin event', raw => { raw.origin.event = 'pull_request' }],
    ['invalid artifact identity', raw => { raw.origin.artifactId = 'private-artifact' }],
    ['invalid archive digest', raw => { raw.origin.archiveSha256 = 'not-a-digest' }],
    ['origin private locator', raw => { raw.origin.locator = 'private.example' }],
    ['deployment private value', raw => { raw.deployment.token = 'synthetic-secret' }],
    ['invalid operation source', raw => { raw.deployment.operationsSource = 'private-ref' }],
    ['missing operations qualification', raw => { delete raw.operationsQualification }],
    ['invalid qualification artifact', raw => { raw.operationsQualification.artifactId = 'private-ref' }],
    ['invalid qualification source', raw => { raw.operationsQualification.privateSource = 'private-ref' }],
    ['qualification private locator', raw => { raw.operationsQualification.locator = 'private.example' }],
  ]
  for (const [name, mutate] of cases) {
    const raw = admissionReceipt()
    mutate(raw)
    assert.throws(() => publicSummary(raw, { result: 'failure' }), undefined, name)
  }
  const ordinary = receipt()
  ordinary.changedServices = []
  ordinary.retainedServices = []
  assert.throws(() => publicSummary(ordinary, { result: 'failure' }))
  const incomplete = receipt()
  delete incomplete.services.api
  assert.throws(() => publicSummary(incomplete, { result: 'failure' }))
})

test('a rejected admission creates or updates the failure issue without recording a verified or retained deployment', async () => {
  for (const existing of [false, true]) {
    const calls = []
    const api = async (path, options = {}) => {
      calls.push({ path, ...options })
      if (!options.method && path.includes('/deployments?')) return []
      if (!options.method && path.includes('/issues?')) return existing ? [{ number: 3000, body: '<!-- deploy-pipeline-failure -->\nprevious' }] : []
      if (path.endsWith('/deployments')) return { id: 42 }
      return { id: 1 }
    }
    const result = await recordPipeline({ summary: publicSummary(admissionReceipt(), { result: 'failure' }), runId: '1001', attempt: '2', api })
    assert.deepEqual(result, { deploymentId: 42, status: 'failed' })
    const status = calls.find(call => call.path.endsWith('/statuses')).body
    assert.equal(status.state, 'failure')
    assert.equal(status.auto_inactive, false)
    assert.match(status.description, /admission rejected/)
    const deployment = calls.find(call => call.path.endsWith('/deployments')).body
    assert.match(deployment.description, /admission rejected/)
    assert.equal(deployment.ref, 'a'.repeat(40))
    const issue = calls.find(call => call.path.endsWith(existing ? '/issues/3000' : '/issues'))
    assert.equal(issue.method, existing ? 'PATCH' : 'POST')
    assert.ok(issue.body.body.startsWith('<!-- deploy-pipeline-failure -->'))
    assert.equal(calls.some(call => call.path.endsWith('/issues/2895/comments')), true)
    assert.equal(calls.some(call => call.path.endsWith('/issues/2894/comments')), false)
    assert.doesNotMatch(JSON.stringify(calls), /Verified|Services: retained|operationsSource|operationsQualification|archiveSha256|9000|9001/)
  }
})
