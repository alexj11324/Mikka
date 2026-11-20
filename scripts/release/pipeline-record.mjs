import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { github, repository } from './pipeline-inputs.mjs'

const sha = /^[a-f0-9]{40}$/
const digest = /^sha256:[a-f0-9]{64}$/
const number = /^[1-9][0-9]{0,15}$/
const services = ['web', 'api', 'eve', 'task', 'world', 'litellm']
const marker = '<!-- deploy-pipeline-failure -->'
const failedSteps = ['selection', 'artifacts', 'existing-resources', 'migrations', ...services, 'manifest-readback', 'staging-probes', 'production-probes', 'unknown']
const features = ['coordinator', 'credentialVault', 'approvedWrites', 'cloudComputer']
const admissionFailures = ['migration_identity_required', 'migration_identity_mismatch', 'migration_execution_changed']

/** Only the private migration guard's rejection before any plan or writer has
 * this empty service shape. Provenance is validated elsewhere; recording a
 * failure here never grants release eligibility. */
function rejectedAdmission(raw, summary) {
  assert.deepEqual(Object.keys(raw).sort(), [
    'admission', 'changedServices', 'deployment', 'failedStep', 'failureCode', 'manifestSha256', 'operationsQualification', 'origin',
    'previousOrigin', 'previousSourceCommit', 'productionPromoted', 'retainedServices', 'services', 'sourceCommit',
    'status', 'target', 'version',
  ])
  assert.equal(raw.admission, 'rejected')
  assert.equal(raw.status, 'failed')
  assert.equal(raw.failedStep, 'migration-identity')
  assert.ok(admissionFailures.includes(raw.failureCode), 'pipeline_record_admission_code_invalid')
  assert.equal(raw.productionPromoted, false)
  assert.deepEqual(raw.changedServices, [])
  assert.deepEqual(raw.retainedServices, [])
  assert.deepEqual(raw.services, {})
  assert.match(raw.manifestSha256, /^[a-f0-9]{64}$/)
  const origin = (value, source) => {
    assert.deepEqual(Object.keys(value ?? {}).sort(), ['archiveSha256', 'artifactId', 'event', 'runAttempt', 'runId', 'source'])
    assert.equal(value.source, source)
    assert.equal(value.event, 'push')
    assert.match(value.archiveSha256, /^[a-f0-9]{64}$/)
    for (const key of ['runId', 'runAttempt', 'artifactId']) assert.match(value[key], number)
  }
  origin(raw.origin, summary.sourceCommit)
  assert.equal(raw.previousOrigin === null, raw.previousSourceCommit === null)
  if (raw.previousSourceCommit !== null) {
    assert.match(raw.previousSourceCommit, sha)
    origin(raw.previousOrigin, raw.previousSourceCommit)
    summary.previousSourceCommit = raw.previousSourceCommit
  }
  assert.deepEqual(Object.keys(raw.deployment ?? {}).sort(), ['driverSource', 'operationsSource', 'runAttempt', 'runId'])
  for (const key of ['runId', 'runAttempt']) assert.match(raw.deployment[key], number)
  for (const key of ['driverSource', 'operationsSource']) assert.match(raw.deployment[key], sha)
  assert.deepEqual(Object.keys(raw.operationsQualification ?? {}).sort(), ['artifactId', 'privateSource', 'runAttempt', 'runId'])
  for (const key of ['runId', 'runAttempt', 'artifactId']) assert.match(raw.operationsQualification[key], number)
  assert.match(raw.operationsQualification.privateSource, sha)
  return { ...summary, status: 'failed', manifestSha256: raw.manifestSha256,
    failedStep: 'migration-identity', failureCode: raw.failureCode, admission: 'rejected' }
}

/** Re-project private output before writing public records. Unknown properties
 * cannot become an accidental address, body, account or credential disclosure. */
export function publicSummary(raw, { source, result, target = 'staging' }) {
  assert.ok(['staging', 'production'].includes(target), 'pipeline_record_target_required')
  if (source && raw) assert.equal(raw.sourceCommit, source, 'pipeline_record_source_mismatch')
  if (raw) assert.equal(raw.target, target, 'pipeline_record_target_mismatch')
  source = source ?? raw?.sourceCommit
  assert.match(source ?? '', sha, 'pipeline_record_source_required')
  const summary = { version: 1, sourceCommit: source,
    status: result === 'success' && (raw?.rollback?.status === 'passed'
      || (raw?.status === 'passed' && raw?.verification?.status === 'pass')) ? 'passed' : 'failed',
    target,
    changedServices: [], retainedServices: [], services: {}, productionPromoted: raw?.productionPromoted === true }
  if (!raw) { summary.failedStep = 'selection'; return summary }
  assert.equal(raw.version, 1)
  if (raw.admission !== undefined || raw.failedStep === 'migration-identity') return rejectedAdmission(raw, summary)
  for (const key of ['changedServices', 'retainedServices']) {
    assert.ok(Array.isArray(raw[key]) && raw[key].every(name => services.includes(name)))
    assert.equal(new Set(raw[key]).size, raw[key].length)
    summary[key] = raw[key]
  }
  assert.deepEqual([...summary.changedServices, ...summary.retainedServices].sort(), [...services].sort())
  for (const name of services) {
    const service = raw.services?.[name]
    assert.match(service?.digest ?? '', digest)
    assert.match(service.contextDigest ?? '', digest)
    assert.match(service.sourceCommit ?? '', sha)
    summary.services[name] = { digest: service.digest, contextDigest: service.contextDigest,
      sourceCommit: service.sourceCommit, reused: service.reused === true }
  }
  if (raw.previousSourceCommit !== null && raw.previousSourceCommit !== undefined) {
    assert.match(raw.previousSourceCommit, sha)
    summary.previousSourceCommit = raw.previousSourceCommit
  }
  if (raw.manifestSha256) {
    assert.match(raw.manifestSha256, /^[a-f0-9]{64}$/)
    summary.manifestSha256 = raw.manifestSha256
  }
  if (raw.failedStep) summary.failedStep = failedSteps.includes(raw.failedStep) ? raw.failedStep : 'unknown'
  if (raw.verification) {
    const verification = { status: raw.verification.status === 'pass' ? 'pass' : 'fail' }
    if (raw.verification.failureDrill !== undefined) {
      assert.equal(target, 'staging')
      assert.equal(raw.verification.failureDrill.kind, 'route-404')
      assert.equal(raw.verification.failureDrill.status, 404)
      verification.failureDrill = { kind: 'route-404', status: 404 }
    }
    if (raw.verification.smoke) verification.smoke = { status: raw.verification.smoke.status === 'pass' ? 'pass' : 'fail',
      results: (raw.verification.smoke.results ?? []).map(item => {
        assert.ok(features.includes(item.feature) && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599)
        return { feature: item.feature, status: item.status, on: item.on === true }
      }) }
    if (raw.verification.routes) {
      const route = raw.verification.routes
      verification.routes = { status: route.status === 'pass' ? 'pass' : 'fail' }
      for (const key of ['total', 'passed', 'failed']) if (route[key] !== undefined) {
        assert.ok(Number.isInteger(route[key]) && route[key] >= 0)
        verification.routes[key] = route[key]
      }
      verification.routes.failures = (route.failures ?? []).map(item => {
        assert.ok(typeof item.route === 'string' && /^\/mikka\/[a-zA-Z0-9_./[\]-]+$/.test(item.route))
        assert.ok(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(item.method))
        assert.ok(item.status === null || (Number.isInteger(item.status) && item.status >= 100 && item.status <= 599))
        return { route: item.route, method: item.method, status: item.status }
      })
    }
    summary.verification = verification
  }
  if (raw.rollback) {
    assert.ok(Array.isArray(raw.rollback.services) && raw.rollback.services.every(name => services.includes(name)))
    summary.rollback = { status: raw.rollback.status === 'passed' ? 'passed' : 'failed', services: raw.rollback.services,
      database: 'additive-schema-retained' }
  }
  return summary
}

export function recordBody(summary, runId, attempt) {
  assert.match(String(runId), number); assert.match(String(attempt), number)
  const url = `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`
  const rejected = summary.admission === 'rejected'
  const rows = Object.entries(summary.services).map(([name, service]) =>
    `| ${name} | ${summary.changedServices.includes(name) ? 'changed' : 'retained'} | \`${service.digest}\` | \`${service.sourceCommit}\` |`)
  return [rejected ? '## Deployment admission rejected' : `## Deployment ${summary.status}`, '', `Workflow: [${runId} / attempt ${attempt}](${url})`,
    `Source: \`${summary.sourceCommit}\`; target: **${summary.target}**.`,
    rejected ? 'Service plan: **not created**; deployment writes: **not started**.'
      : `Changed: ${summary.changedServices.join(', ') || 'none'}; retained: ${summary.retainedServices.join(', ') || 'none'}.`,
    `Production promoted: **${summary.productionPromoted ? 'yes' : 'no'}**.`,
    ...(summary.failedStep ? [`Failed check: **${summary.failedStep}**.`] : []),
    ...(rejected ? [`Failure code: \`${summary.failureCode}\`.`] : []),
    ...(summary.verification?.failureDrill ? [`Staging failure drill: **${summary.verification.failureDrill.kind}** (HTTP 404).`] : []),
    ...(summary.manifestSha256 ? [`Manifest SHA-256: \`${summary.manifestSha256}\`.`] : []),
    ...(summary.rollback ? [`Rollback: **${summary.rollback.status}**, services: ${summary.rollback.services.join(', ') || 'none'}; additive schema retained.`] : []),
    ...(summary.rollback && summary.previousSourceCommit ? [`Restored source: \`${summary.previousSourceCommit}\`.`] : []),
    ...(rejected ? [] : ['', '| Service | Action | Deployment digest | Artifact source |', '| --- | --- | --- | --- |', ...rows]),
    ...(summary.verification ? ['', 'Verification:', '```json', JSON.stringify(summary.verification, null, 2), '```'] : []), ''].join('\n')
}

export async function recordPipeline({ summary, runId, attempt, api = github }) {
  const body = recordBody(summary, runId, attempt)
  const rejected = summary.admission === 'rejected'
  const log = `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`
  const environment = summary.target === 'production' ? 'Production' : 'Staging'
  const servingSource = summary.rollback?.status === 'passed' && summary.previousSourceCommit
    ? summary.previousSourceCommit : summary.sourceCommit
  const prior = await api(`${repository}/deployments?environment=${environment}&sha=${servingSource}&per_page=100`)
  let deployment = prior.find(item => item.payload?.pipelineRun === String(runId) && item.payload?.pipelineAttempt === String(attempt))
  if (!deployment) deployment = await api(`${repository}/deployments`, { method: 'POST', body: {
    ref: servingSource, task: 'deploy', environment, auto_merge: false,
    // This records the workflow outcome; it does not authorize or trigger a deployment writer.
    required_contexts: [], production_environment: summary.target === 'production', transient_environment: false,
    description: rejected ? `Migration admission rejected ${runId}/${attempt}` : `Verified service pipeline ${runId}/${attempt}`,
    payload: { pipelineRun: String(runId), pipelineAttempt: String(attempt), manifest: summary },
  } })
  assert.ok(Number.isSafeInteger(deployment.id))
  await api(`${repository}/deployments/${deployment.id}/statuses`, { method: 'POST', body: {
    state: summary.status === 'passed' ? 'success' : 'failure', log_url: log,
    description: rejected ? 'Migration admission rejected; no service plan or deployment writes.'
      : `Services: ${summary.changedServices.join(', ') || 'retained'}; ${summary.rollback ? 'rollback ' + summary.rollback.status : summary.status}`.slice(0, 140),
    auto_inactive: summary.status === 'passed',
  } })
  await api(`${repository}/issues/2895/comments`, { method: 'POST', body: { body } })
  if (summary.changedServices.length === 1) await api(`${repository}/issues/2894/comments`, { method: 'POST', body: { body } })
  if (summary.status === 'failed') {
    const open = await api(`${repository}/issues?state=open&per_page=100`)
    const existing = open.find(issue => !issue.pull_request && issue.body?.startsWith(marker))
    if (existing) await api(`${repository}/issues/${existing.number}`, { method: 'PATCH', body: { body: marker + '\n' + body } })
    else await api(`${repository}/issues`, { method: 'POST', body: { title: `[部署] ${environment} 自动发布验证失败`, body: marker + '\n' + body } })
  }
  return { deploymentId: deployment.id, status: summary.status }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let raw
    try { raw = JSON.parse(await readFile(resolve(process.env.PIPELINE_REPORT_DIRECTORY ?? 'pipeline-report', 'pipeline-summary.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const summary = publicSummary(raw, { source: process.env.PIPELINE_SOURCE, result: process.env.PIPELINE_JOB_RESULT,
      target: process.env.PIPELINE_TARGET ?? 'staging' })
    const result = await recordPipeline({ summary, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT })
    console.log(JSON.stringify(result))
  } catch { console.error('pipeline_record_failed'); process.exitCode = 1 }
}
