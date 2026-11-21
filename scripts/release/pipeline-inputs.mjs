import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateHistoricalReleaseManifest, validateReleaseManifest } from './service-builds.mjs'
import { actionsMikkaRepository, officialMikkaRepository, operationsRepositoryId, publicRepositoryId } from '../cloudflare-source.mjs'

const trustedActors = { owner: { id: '183887963', login: 'alexj11324' }, mergeQueue: { id: '118344674', login: 'github-merge-queue[bot]' } }
const trustedActor = (actor, automatic) => String(actor?.id) === trustedActors.owner.id
  || (automatic && String(actor?.id) === trustedActors.mergeQueue.id && actor?.login === trustedActors.mergeQueue.login)

export const repository = 'alexj11324/Mikka'
const producer = '.github/workflows/cloudflare-api-image.yml'
const deployment = '.github/workflows/cloudflare-app-deploy.yml'
const qualification = '.github/workflows/cloud-services-ci.yml'
const number = /^[1-9][0-9]{0,15}$/
const sha = /^[a-f0-9]{40}$/
const archiveDigest = /^sha256:[a-f0-9]{64}$/
const apiRoot = 'https://api.github.com/repositories/'

export function checkedRun(run, path, { event, successful = true, automaticDeployment = false } = {}) {
  for (const key of ['repository', 'head_repository']) {
    assert.ok(officialMikkaRepository(run[key]?.full_name, String(run[key]?.id)))
    assert.equal(run[key].fork, false)
    assert.equal(run[key].private, false)
  }
  assert.equal(run.path, path)
  assert.equal(run.head_branch, 'main')
  const automatic = (path === producer && run.event === 'push') || (automaticDeployment && path === deployment && run.event === 'workflow_run')
  assert.ok(trustedActor(run.actor, automatic))
  assert.ok(trustedActor(run.triggering_actor, automatic))
  assert.match(run.head_sha ?? '', sha)
  assert.match(String(run.id), number)
  assert.match(String(run.run_attempt), number)
  assert.equal(run.status, 'completed')
  if (successful) assert.equal(run.conclusion, 'success')
  if (event) assert.equal(run.event, event)
  return run
}

/** Do not deploy an older candidate after it has waited for the deployment
 * lease. Every main push produces a manifest; the latest build's completion
 * starts its own run. Superseded runs are recorded, never counted as releases. */
export function selectAutomaticCandidate(event, actualRun, mainSha) {
  assert.ok(officialMikkaRepository(event?.repository?.full_name, String(event?.repository?.id)))
  assert.equal(event.action, 'completed')
  checkedRun(actualRun, producer, { event: 'push' })
  for (const field of ['id', 'run_attempt', 'head_sha', 'event', 'head_branch', 'status', 'conclusion'])
    assert.equal(event.workflow_run?.[field], actualRun[field])
  assert.match(mainSha ?? '', sha)
  return actualRun.head_sha === mainSha ? 'selected' : 'superseded'
}

/** A completed rollback makes its previous manifest current again. A failed
 * deployment must be recovered explicitly before another automatic writer. */
export function baselineOrigin(summary, target = 'staging') {
  assert.equal(summary?.version, 1)
  assert.equal(summary.target, target)
  if (summary.rollback?.status === 'passed') return summary.previousOrigin ?? null
  assert.equal(summary.status, 'passed', 'pipeline_previous_release_requires_recovery')
  assert.equal(summary.verification?.status, 'pass')
  return summary.origin
}

export function artifactFor(run, artifacts, prefix) {
  const expected = `${prefix}-${run.id}-${run.run_attempt}`
  const matching = artifacts.filter(artifact => artifact.name === expected && !artifact.expired)
  assert.equal(matching.length, 1, 'pipeline_original_artifact_required')
  const artifact = matching[0]
  assert.match(String(artifact.id), number)
  assert.equal(artifact.workflow_run?.id, run.id)
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha)
  assert.equal(artifact.workflow_run?.head_branch, run.head_branch)
  assert.equal(artifact.workflow_run?.repository_id, 1427517699)
  assert.equal(artifact.workflow_run?.head_repository_id, 1427517699)
  assert.match(artifact.digest ?? '', archiveDigest)
  assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 4 * 1024 * 1024)
  return artifact
}

export async function github(path, { token, method = 'GET', body, bytes = false } = {}) {
  assert.ok(typeof path === 'string' && !path.startsWith('/') && !path.includes('://'))
  const prefix = path.startsWith(repository + '/') ? repository + '/' : 'alexj11324/mikka-cloud/'
  assert.ok(path.startsWith(prefix), 'pipeline_repository_scope')
  const repositoryId = prefix === repository + '/' ? publicRepositoryId : operationsRepositoryId
  token ??= repositoryId === publicRepositoryId
    ? process.env.MIKKA_PUBLIC_ACTIONS_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
    : process.env.GH_TOKEN
  assert.ok(token, 'pipeline_github_identity_required')
  let response
  try {
    response = await fetch(apiRoot + repositoryId + '/' + path.slice(prefix.length), { method, headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
  } catch { throw new Error('pipeline_github_request_failed') }
  if (!response.ok) throw Object.assign(new Error('pipeline_github_request_rejected'), { status: response.status })
  return bytes ? Buffer.from(await response.arrayBuffer()) : response.json()
}

async function pages(api, path, key) {
  const result = []
  for (let page = 1; ; page++) {
    const value = await api(`${repository}/${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    assert.ok(Array.isArray(value[key]))
    result.push(...value[key])
    if (result.length >= value.total_count || value[key].length < 100) return result
    assert.ok(page < 100, 'pipeline_inventory_too_large')
  }
}

export function readArtifactMembers(bytes, artifact) {
  assert.equal(bytes.length, artifact.size_in_bytes)
  assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), artifact.digest)
  let text
  try {
    text = execFileSync('python3', ['-c', String.raw`
import io,json,stat,sys,zipfile
allowed={'release-manifest.json','previous-manifest.json','pipeline-summary.json','receipt.json'}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    entries=archive.infolist()
    if not 1 <= len(entries) <= 4: raise ValueError('entries')
    seen=set(); result={}; total=0
    for entry in entries:
        if entry.orig_filename not in allowed or entry.orig_filename in seen: raise ValueError('name')
        seen.add(entry.orig_filename)
        if stat.S_IFMT(entry.external_attr >> 16) not in (0,stat.S_IFREG) or entry.flag_bits & 1: raise ValueError('type')
        total += entry.file_size
        if total > 4*1024*1024: raise ValueError('size')
        result[entry.orig_filename]=json.loads(archive.read(entry))
    print(json.dumps(result))
`], { input: bytes, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch { throw new Error('pipeline_artifact_format_invalid') }
  return JSON.parse(text)
}

async function members(api, run, prefix) {
  const artifacts = await pages(api, `actions/runs/${run.id}/artifacts`, 'artifacts')
  const artifact = artifactFor(run, artifacts, prefix)
  const bytes = await api(`${repository}/actions/artifacts/${artifact.id}/zip`, { bytes: true })
  return { artifact, files: readArtifactMembers(bytes, artifact) }
}

async function releasePacket(api, runId, runAttempt) {
  assert.match(String(runId ?? ''), number)
  const path = runAttempt ? `actions/runs/${runId}/attempts/${runAttempt}` : `actions/runs/${runId}`
  const run = checkedRun(await api(`${repository}/${path}`), producer, { event: 'push' })
  assert.equal(String(run.id), String(runId), 'pipeline_release_run_mismatch')
  if (runAttempt) assert.equal(String(run.run_attempt), String(runAttempt), 'pipeline_release_attempt_mismatch')
  const packet = await members(api, run, 'release-manifest')
  assert.deepEqual(Object.keys(packet.files), ['release-manifest.json'], 'pipeline_release_member_required')
  const manifest = packet.files['release-manifest.json']
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'pipeline_release_manifest_required')
  assert.equal(manifest.sourceCommit, run.head_sha)
  return { run, manifest,
    origin: { runId: String(run.id), runAttempt: String(run.run_attempt), artifactId: String(packet.artifact.id) } }
}

async function release(api, runId, runAttempt) {
  const result = await releasePacket(api, runId, runAttempt)
  validateReleaseManifest(result.manifest)
  return result
}

// Only already-published state and rollback use the historical reader. Every
// forward staging/production candidate goes through the strict v2 reader above.
async function historicalRelease(api, runId, runAttempt) {
  const result = await releasePacket(api, runId, runAttempt)
  validateHistoricalReleaseManifest(result.manifest)
  return result
}

export async function priorDeployment(api, currentRun, selectedRun, target = 'staging') {
  const runs = selectedRun ? [await api(`${repository}/actions/runs/${selectedRun}`)]
    : await pages(api, 'actions/workflows/cloudflare-app-deploy.yml/runs?branch=main', 'workflow_runs')
  for (const latest of runs) {
    const isCurrent = String(latest.id) === String(currentRun)
    if (!isCurrent && latest.status !== 'completed') continue
    assert.ok(Number.isSafeInteger(latest.run_attempt) && latest.run_attempt > 0)
    // Re-running only failed jobs does not erase an earlier writer. Search
    // every earlier completed attempt, including this run's previous attempt.
    // A fresh selection failure must never hide a partial deployment.
    for (let attempt = latest.run_attempt - Number(isCurrent); attempt >= 1; attempt--) {
      const run = attempt === latest.run_attempt ? latest
        : await api(`${repository}/actions/runs/${latest.id}/attempts/${attempt}`)
      checkedRun(run, deployment, { successful: false, automaticDeployment: true })
      assert.equal(run.run_attempt, attempt)
      assert.ok(['workflow_run', 'workflow_dispatch'].includes(run.event))
      const jobs = await pages(api, `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs')
      const jobName = target === 'production' ? 'pipeline-production' : 'pipeline'
      const job = jobs.find(job => job.name === jobName)
      if (!job || job.conclusion === 'skipped') continue
      assert.equal(job.status, 'completed')
      const applied = job.steps?.find(step => step.name === (target === 'production'
        ? 'Promote and verify the staged service manifest' : 'Deploy and verify staged service manifest'))
      // A failed checkout/selection never acquired a deployment writer. Do not
      // confuse it with a partially applied release that requires rollback.
      if (!applied || applied.conclusion === 'skipped') continue
      const packet = await members(api, run, target === 'production' ? 'deploy-production' : 'deploy-pipeline')
      const summary = packet.files['pipeline-summary.json']
      assert.equal(summary?.deployment?.runId, String(run.id))
      assert.equal(summary.deployment.runAttempt, String(run.run_attempt))
      const log = (await api(`${repository}/actions/jobs/${job.id}/logs`, { bytes: true })).toString('utf8')
      // Private deployment independently validates all manifests. This also
      // rejects an artifact name supplied by a different job in the same run.
      assert.ok(log.includes(`Artifact ${packet.artifact.name}.zip successfully finalized.`)
        && log.includes(`Artifact ID ${packet.artifact.id}`), 'pipeline_summary_upload_evidence_required')
      // Only the separate preflight can prove rejection before any writer; its
      // failed run has a skipped Deploy step and was handled above. Once this
      // step ran, an admission label cannot hide a possibly partial deployment.
      assert.equal(summary.admission, undefined, 'pipeline_previous_release_requires_recovery')
      assert.notEqual(summary.failedStep, 'migration-identity', 'pipeline_previous_release_requires_recovery')
      return { run, summary, files: packet.files }
    }
  }
  assert.ok(!selectedRun, 'pipeline_requested_release_missing')
  return null
}

async function qualificationOrigin(api) {
  const runs = await pages(api, 'actions/workflows/cloud-services-ci.yml/runs?branch=main&status=success', 'workflow_runs')
  for (const run of runs) {
    checkedRun(run, qualification, { event: 'workflow_dispatch' })
    const artifacts = await pages(api, `actions/runs/${run.id}/artifacts`, 'artifacts')
    if (!artifacts.some(artifact => !artifact.expired && artifact.name === `cloud-services-ci-receipt-${run.id}-${run.run_attempt}`)) continue
    const artifact = artifactFor(run, artifacts, 'cloud-services-ci-receipt')
    return { runId: String(run.id), runAttempt: String(run.run_attempt), artifactId: String(artifact.id) }
  }
  throw new Error('pipeline_operations_qualification_required')
}

/** Selection is read-only. The private publisher rechecks source ancestry,
 * original jobs, upload logs, archive bytes and member digests before writers. */
export async function selectPipeline({ env = process.env, api = github } = {}) {
  assert.ok(actionsMikkaRepository(env), 'pipeline_repository_scope')
  assert.equal(env.GITHUB_REF, 'refs/heads/main')
  assert.ok(trustedActor({ id: env.GITHUB_ACTOR_ID, login: env.GITHUB_ACTOR }, env.GITHUB_EVENT_NAME === 'workflow_run'))
  const report = resolve(env.RUNNER_TEMP, 'deploy-pipeline')
  await mkdir(report, { recursive: true, mode: 0o700 })
  let selected, previous, rollback
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
    selected = await release(api, event.workflow_run?.id, event.workflow_run?.run_attempt)
    const main = await api(`${repository}/git/ref/heads/main`)
    if (selectAutomaticCandidate(event, selected.run, main.object?.sha) === 'superseded') return { status: 'superseded', source: selected.manifest.sourceCommit }
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch')
    assert.ok(['pipeline-stage', 'pipeline-rollback'].includes(env.MIKKA_DEPLOYMENT_PHASE))
    if (env.MIKKA_DEPLOYMENT_PHASE === 'pipeline-rollback') {
      assert.match(env.INPUT_PIPELINE_RUN ?? '', number)
      rollback = await priorDeployment(api, env.GITHUB_RUN_ID, env.INPUT_PIPELINE_RUN)
      selected = await historicalRelease(api, rollback.summary.origin.runId, rollback.summary.origin.runAttempt)
      if (rollback.summary.previousOrigin) previous = await historicalRelease(api, rollback.summary.previousOrigin.runId, rollback.summary.previousOrigin.runAttempt)
    } else selected = await release(api, env.INPUT_RELEASE_RUN)
  }
  if (!rollback) {
    const prior = await priorDeployment(api, env.GITHUB_RUN_ID)
    const origin = prior && baselineOrigin(prior.summary)
    if (origin) previous = await historicalRelease(api, origin.runId, origin.runAttempt)
  }
  const cloud = await api('alexj11324/mikka-cloud/git/ref/heads/main')
  assert.match(cloud.object?.sha ?? '', sha)
  if (env.INPUT_CLOUD_SOURCE) assert.equal(env.INPUT_CLOUD_SOURCE, cloud.object.sha, 'pipeline_operations_source_must_be_current_main')
  const ops = await qualificationOrigin(api)
  const manifestPath = resolve(report, 'release-manifest.json')
  await writeFile(manifestPath, JSON.stringify(selected.manifest, null, 2) + '\n', { mode: 0o600 })
  const variables = { MIKKA_RELEASE_MANIFEST: manifestPath, MIKKA_RELEASE_RUN_ID: selected.origin.runId,
    MIKKA_RELEASE_RUN_ATTEMPT: selected.origin.runAttempt, MIKKA_RELEASE_ARTIFACT_ID: selected.origin.artifactId,
    MIKKA_CF_OPERATIONS_SHA: cloud.object.sha, MIKKA_CLOUD_SOURCE_SHA: cloud.object.sha,
    MIKKA_OPERATIONS_CI_RUN_ID: ops.runId, MIKKA_OPERATIONS_CI_RUN_ATTEMPT: ops.runAttempt,
    MIKKA_OPERATIONS_CI_ARTIFACT_ID: ops.artifactId, MIKKA_PIPELINE_TARGET: 'staging',
    MIKKA_PIPELINE_RECEIPT: resolve(env.RUNNER_TEMP, 'deploy-pipeline-private.json'),
    MIKKA_PIPELINE_SUMMARY: resolve(report, 'pipeline-summary.json') }
  if (previous) {
    variables.MIKKA_PREVIOUS_MANIFEST = resolve(report, 'previous-manifest.json')
    await writeFile(variables.MIKKA_PREVIOUS_MANIFEST, JSON.stringify(previous.manifest, null, 2) + '\n', { mode: 0o600 })
    for (const [key, value] of Object.entries(previous.origin)) variables['MIKKA_PREVIOUS_RELEASE_' + { runId: 'RUN_ID', runAttempt: 'RUN_ATTEMPT', artifactId: 'ARTIFACT_ID' }[key]] = value
  }
  if (rollback) {
    variables.MIKKA_ROLLBACK_RECEIPT = resolve(env.RUNNER_TEMP, 'deploy-pipeline-rollback.json')
    await writeFile(variables.MIKKA_ROLLBACK_RECEIPT, JSON.stringify(rollback.summary) + '\n', { mode: 0o600 })
  }
  for (const value of Object.values(variables)) assert.ok(!/[\r\n]/.test(value))
  await appendFile(env.GITHUB_ENV, Object.entries(variables).map(([key, value]) => `${key}=${value}\n`).join(''))
  const output = { status: 'selected', source: selected.manifest.sourceCommit, operations: cloud.object.sha, report,
    releaseRun: selected.origin.runId, releaseAttempt: selected.origin.runAttempt, releaseArtifact: selected.origin.artifactId }
  return output
}

/** Production consumes the completed staging artifact from this same run,
 * with its own serving baseline. It never silently uses the staging baseline. */
export async function selectPromotion({ env = process.env, api = github } = {}) {
  assert.ok(actionsMikkaRepository(env), 'pipeline_repository_scope')
  assert.equal(env.GITHUB_REF, 'refs/heads/main')
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_run')
  assert.equal(env.GITHUB_ACTOR_ID, trustedActors.owner.id)
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'INPUT_STAGE_ARTIFACT']) assert.match(env[key] ?? '', number)
  assert.match(env.INPUT_OPERATIONS_SOURCE ?? '', sha)
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
  const selected = await release(api, event.workflow_run?.id, event.workflow_run?.run_attempt)
  const run = await api(`${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`)
  const stage = await members(api, run, 'deploy-pipeline')
  assert.equal(String(stage.artifact.id), env.INPUT_STAGE_ARTIFACT)
  assert.deepEqual(stage.files['release-manifest.json'], selected.manifest)
  assert.equal(stage.files['pipeline-summary.json']?.status, 'passed')
  assert.equal(stage.files['pipeline-summary.json'].target, 'staging')
  assert.equal(stage.files['pipeline-summary.json'].rollback, undefined)
  const prior = await priorDeployment(api, env.GITHUB_RUN_ID, undefined, 'production')
  const previousOrigin = prior && baselineOrigin(prior.summary, 'production')
  const previous = previousOrigin && await historicalRelease(api, previousOrigin.runId, previousOrigin.runAttempt)
  const qualification = await qualificationOrigin(api)
  const report = resolve(env.RUNNER_TEMP, 'deploy-production')
  await mkdir(report, { recursive: true, mode: 0o700 })
  const variables = { MIKKA_RELEASE_MANIFEST: resolve(report, 'release-manifest.json'),
    MIKKA_RELEASE_RUN_ID: selected.origin.runId, MIKKA_RELEASE_RUN_ATTEMPT: selected.origin.runAttempt,
    MIKKA_RELEASE_ARTIFACT_ID: selected.origin.artifactId,
    MIKKA_CF_OPERATIONS_SHA: env.INPUT_OPERATIONS_SOURCE, MIKKA_CLOUD_SOURCE_SHA: env.INPUT_OPERATIONS_SOURCE,
    MIKKA_OPERATIONS_CI_RUN_ID: qualification.runId, MIKKA_OPERATIONS_CI_RUN_ATTEMPT: qualification.runAttempt,
    MIKKA_OPERATIONS_CI_ARTIFACT_ID: qualification.artifactId, MIKKA_PIPELINE_TARGET: 'production',
    MIKKA_STAGE_RUN_ID: env.GITHUB_RUN_ID, MIKKA_STAGE_RUN_ATTEMPT: env.GITHUB_RUN_ATTEMPT,
    MIKKA_STAGE_ARTIFACT_ID: env.INPUT_STAGE_ARTIFACT,
    MIKKA_PIPELINE_RECEIPT: resolve(env.RUNNER_TEMP, 'deploy-production-private.json'),
    MIKKA_PIPELINE_SUMMARY: resolve(report, 'pipeline-summary.json') }
  await writeFile(variables.MIKKA_RELEASE_MANIFEST, JSON.stringify(selected.manifest, null, 2) + '\n', { mode: 0o600 })
  if (previous) {
    variables.MIKKA_PRODUCTION_MANIFEST = resolve(report, 'previous-manifest.json')
    await writeFile(variables.MIKKA_PRODUCTION_MANIFEST, JSON.stringify(previous.manifest, null, 2) + '\n', { mode: 0o600 })
    for (const [key, value] of Object.entries(previous.origin)) variables['MIKKA_PRODUCTION_RELEASE_' + { runId: 'RUN_ID', runAttempt: 'RUN_ATTEMPT', artifactId: 'ARTIFACT_ID' }[key]] = value
  }
  for (const value of Object.values(variables)) assert.ok(!/[\r\n]/.test(value))
  await appendFile(env.GITHUB_ENV, Object.entries(variables).map(([key, value]) => `${key}=${value}\n`).join(''))
  return { status: 'selected', source: selected.manifest.sourceCommit, operations: env.INPUT_OPERATIONS_SOURCE, report }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === 'promote'))
    const output = await (process.argv[2] === 'promote' ? selectPromotion() : selectPipeline())
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''))
    console.log(JSON.stringify({ status: output.status, source: output.source }))
  } catch (error) {
    console.error(error instanceof Error && /^pipeline_[a-z_]+$/.test(error.message) ? error.message : 'pipeline_selection_failed')
    process.exitCode = 1
  }
}
