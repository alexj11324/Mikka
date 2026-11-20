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

/** Re-project private output before writing public records. Unknown properties
 * cannot become an accidental address, body, account or credential disclosure. */
export function publicSummary(raw, { source, result }) {
  source = raw?.sourceCommit ?? source
  assert.match(source ?? '', sha, 'pipeline_record_source_required')
  const summary = { version: 1, sourceCommit: source,
    status: result === 'success' && (raw?.rollback?.status === 'passed'
      || (raw?.status === 'passed' && raw?.verification?.status === 'pass')) ? 'passed' : 'failed',
    target: raw?.target === 'production' ? 'production' : 'staging',
    changedServices: [], retainedServices: [], services: {}, productionPromoted: raw?.productionPromoted === true }
  if (!raw) { summary.failedStep = 'selection'; return summary }
  assert.equal(raw.version, 1)
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
        assert.ok(typeof item.route === 'string' && /^\/mikka\/[a-zA-Z0-9_./\[\]-]+$/.test(item.route))
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
  const rows = Object.entries(summary.services).map(([name, service]) =>
    `| ${name} | ${summary.changedServices.includes(name) ? 'changed' : 'retained'} | \`${service.digest}\` | \`${service.sourceCommit}\` |`)
  return [`## Deployment ${summary.status}`, '', `Workflow: [${runId} / attempt ${attempt}](${url})`,
    `Source: \`${summary.sourceCommit}\`; target: **${summary.target}**.`,
    `Changed: ${summary.changedServices.join(', ') || 'none'}; retained: ${summary.retainedServices.join(', ') || 'none'}.`,
    `Production promoted: **${summary.productionPromoted ? 'yes' : 'no'}**.`,
    ...(summary.failedStep ? [`Failed check: **${summary.failedStep}**.`] : []),
    ...(summary.manifestSha256 ? [`Manifest SHA-256: \`${summary.manifestSha256}\`.`] : []),
    ...(summary.rollback ? [`Rollback: **${summary.rollback.status}**, services: ${summary.rollback.services.join(', ') || 'none'}; additive schema retained.`] : []),
    '', '| Service | Action | Deployment digest | Artifact source |', '| --- | --- | --- | --- |', ...rows,
    ...(summary.verification ? ['', 'Verification:', '```json', JSON.stringify(summary.verification, null, 2), '```'] : []), ''].join('\n')
}

export async function recordPipeline({ summary, runId, attempt, api = github }) {
  const body = recordBody(summary, runId, attempt)
  const log = `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`
  const environment = summary.target === 'production' ? 'Production' : 'Staging'
  const servingSource = summary.rollback?.status === 'passed' && summary.previousSourceCommit
    ? summary.previousSourceCommit : summary.sourceCommit
  const prior = await api(`${repository}/deployments?environment=${environment}&sha=${servingSource}&per_page=100`)
  let deployment = prior.find(item => item.payload?.pipelineRun === String(runId) && item.payload?.pipelineAttempt === String(attempt))
  if (!deployment) deployment = await api(`${repository}/deployments`, { method: 'POST', body: {
    ref: servingSource, task: 'deploy', environment, auto_merge: false,
    // This is a record of the already-completed, independently gated release;
    // it does not authorize or trigger a deployment writer.
    required_contexts: [], production_environment: summary.target === 'production', transient_environment: false,
    description: `Verified service pipeline ${runId}/${attempt}`,
    payload: { pipelineRun: String(runId), pipelineAttempt: String(attempt), manifest: summary },
  } })
  assert.ok(Number.isSafeInteger(deployment.id))
  await api(`${repository}/deployments/${deployment.id}/statuses`, { method: 'POST', body: {
    state: summary.status === 'passed' ? 'success' : 'failure', log_url: log,
    description: `Services: ${summary.changedServices.join(', ') || 'retained'}; ${summary.rollback ? 'rollback ' + summary.rollback.status : summary.status}`.slice(0, 140),
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
    const summary = publicSummary(raw, { source: process.env.PIPELINE_SOURCE, result: process.env.PIPELINE_JOB_RESULT })
    const result = await recordPipeline({ summary, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT })
    console.log(JSON.stringify(result))
  } catch { console.error('pipeline_record_failed'); process.exitCode = 1 }
}
