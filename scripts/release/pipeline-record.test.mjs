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
  assert.equal(missing.failedStep, 'unknown')
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
  assert.equal(failed.failedStep, 'unknown')
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

const preflightStep = 'Verify migration admission before preparing the product'
const selectionStep = 'Select the latest verified main candidate and staging baseline'

// The failed original attempt had selection success, preflight failure and a
// skipped writer. No private summary was produced, so these API facts locate
// the failure without proving a service plan, deployment or zero-writer receipt.
function failedAttempt(target = 'staging') {
  return { total_count: 1, jobs: [{ id: 2001, run_id: 1001, run_attempt: 2,
    head_sha: 'e'.repeat(40), head_branch: 'main', name: target === 'production' ? 'pipeline-production' : 'pipeline',
    status: 'completed', conclusion: 'failure', steps: [
      { number: 9, name: selectionStep, status: 'completed', conclusion: 'success' },
      { number: 15, name: preflightStep, status: 'completed', conclusion: 'failure' },
      { number: 20, name: 'Deploy and verify staged service manifest', status: 'completed', conclusion: 'skipped' },
      { number: 21, name: 'Upload pipeline receipts', status: 'completed', conclusion: 'success' },
    ] }] }
}

async function missingSummaryRecord({ target = 'staging', jobs = failedAttempt(target), unavailable = false, result = 'failure' } = {}) {
  const calls = []
  const api = async (path, options = {}) => {
    calls.push({ path, ...options })
    if (path.includes('/actions/runs/')) {
      if (unavailable) throw new Error('private.example synthetic-secret')
      return jobs
    }
    if (!options.method && (path.includes('/deployments?') || path.includes('/issues?'))) return []
    if (path.endsWith('/deployments')) return { id: 42 }
    return { id: 1 }
  }
  await recordPipeline({ summary: publicSummary(null, { source: 'a'.repeat(40), result, target }),
    runId: '1001', attempt: '2', driverSource: 'e'.repeat(40), api })
  const deployment = calls.find(call => call.path.endsWith('/deployments')).body
  const status = calls.find(call => call.path.endsWith('/statuses')).body
  const issue = calls.find(call => call.path.endsWith('/issues')).body
  return { calls, deployment, status, issue, summary: deployment.payload.manifest }
}

test('missing summaries record the actual failed workflow step without inventing deployment evidence', async () => {
  for (const target of ['staging', 'production']) {
    const { calls, deployment, status, issue, summary } = await missingSummaryRecord({ target })
    assert.equal(summary.failedStep, 'migration-preflight')
    assert.equal(summary.summaryAvailable, false)
    assert.equal(deployment.payload.manifest.changedServices, null)
    assert.equal(deployment.payload.manifest.retainedServices, null)
    assert.equal(deployment.payload.manifest.services, null)
    assert.equal(deployment.payload.manifest.productionPromoted, null)
    assert.deepEqual(summary.workflowFailure, { jobId: '2001', stepNumber: 15, name: preflightStep })
    assert.equal(status.state, 'failure')
    assert.equal(status.auto_inactive, false)
    assert.equal(deployment.ref, 'a'.repeat(40))
    assert.match(issue.body, /Failed check: \*\*migration-preflight\*\*/)
    assert.ok(issue.body.includes(preflightStep))
    assert.match(issue.body, /deployment summary: \*\*unavailable\*\*/)
    assert.match(issue.body, /Service changes: \*\*unknown\*\*/)
    assert.doesNotMatch(JSON.stringify(calls), /Changed: none|retained: none|Services: retained|Verified service|not started|admission rejected|Production promoted: \*\*no\*\*/)
    assert.equal(calls.some(call => call.path.endsWith('/issues/2894/comments')), false)
    assert.equal(calls.filter(call => call.path.includes('/actions/runs/')).length, 1)
    assert.equal(calls.find(call => call.path.includes('/actions/runs/')).path,
      'alexj11324/Mikka/actions/runs/1001/attempts/2/jobs?per_page=100')
  }
})

test('failure recording binds the original job attempt and never copies arbitrary step names or errors', async () => {
  const cases = [
    ['different run', jobs => { jobs.jobs[0].run_id = 1002 }],
    ['different attempt', jobs => { jobs.jobs[0].run_attempt = 1 }],
    ['different driver source', jobs => { jobs.jobs[0].head_sha = 'b'.repeat(40) }],
    ['different branch', jobs => { jobs.jobs[0].head_branch = 'fork-branch' }],
    ['different target', jobs => { jobs.jobs[0].name = 'pipeline-production' }],
    ['incomplete job', jobs => { jobs.jobs[0].status = 'in_progress' }],
    ['successful job', jobs => { jobs.jobs[0].conclusion = 'success' }],
    ['skipped step', jobs => { jobs.jobs[0].steps[1].conclusion = 'skipped' }],
    ['unknown step', jobs => { jobs.jobs[0].steps[1].name = 'private.example synthetic-secret' }],
    ['ambiguous jobs', jobs => { jobs.jobs.push(structuredClone(jobs.jobs[0])); jobs.total_count++ }],
    ['incomplete inventory', jobs => { jobs.total_count++ }],
  ]
  for (const [name, mutate] of cases) {
    const jobs = failedAttempt()
    mutate(jobs)
    const { calls, summary, status, issue } = await missingSummaryRecord({ jobs })
    assert.equal(summary.failedStep, 'unknown', name)
    assert.equal(summary.workflowFailure, undefined, name)
    assert.equal(status.state, 'failure', name)
    assert.match(issue.body, /Service changes: \*\*unknown\*\*/, name)
    assert.doesNotMatch(JSON.stringify(calls), /private\.example|synthetic-secret/, name)
  }
  const unavailable = await missingSummaryRecord({ unavailable: true })
  assert.equal(unavailable.summary.failedStep, 'unknown')
  assert.equal(unavailable.status.state, 'failure')
  assert.doesNotMatch(JSON.stringify(unavailable.calls), /private\.example|synthetic-secret/)
  const missingAfterSuccess = await missingSummaryRecord({ result: 'success' })
  assert.equal(missingAfterSuccess.status.state, 'failure')
})

test('a verified selection failure remains selection and the earliest failure wins over receipt upload', async () => {
  const jobs = failedAttempt()
  jobs.jobs[0].steps[0].conclusion = 'failure'
  jobs.jobs[0].steps[1].conclusion = 'skipped'
  jobs.jobs[0].steps[3].conclusion = 'failure'
  const { summary, issue } = await missingSummaryRecord({ jobs })
  assert.equal(summary.failedStep, 'selection')
  assert.deepEqual(summary.workflowFailure, { jobId: '2001', stepNumber: 9, name: selectionStep })
  assert.match(issue.body, /Failed check: \*\*selection\*\*/)
})
