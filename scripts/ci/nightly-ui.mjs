import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { artifactFor, checkedRun, github, readArtifactMembers, repository } from '../release/pipeline-inputs.mjs'
import { checkedServiceCache } from '../release/service-build-ci.mjs'
import { validateReleaseManifest } from '../release/service-builds.mjs'
import { assertNoSourceMaps } from '../release/hosted-ui.mjs'
import { rendererActionContract } from '../../lib/renderer-actions.mjs'

const producer = '.github/workflows/cloudflare-api-image.yml'
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

async function pages(api, path, key) {
  const result = []
  for (let page = 1; ; page++) {
    const packet = await api(`${repository}/${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    assert.ok(Array.isArray(packet[key]) && Number.isSafeInteger(packet.total_count), 'nightly_ui_inventory_invalid')
    result.push(...packet[key])
    if (result.length >= packet.total_count) return result
    assert.ok(packet[key].length && page < 100, 'nightly_ui_inventory_incomplete')
  }
}

/** The successful same-source producer owns the context/reuse decision. Its
 * original web source is retained below, never relabelled as the nightly SHA. */
export async function selectNightlyUi({ source, api = github }) {
  assert.match(source ?? '', /^[a-f0-9]{40}$/, 'nightly_ui_source_required')
  const runs = await pages(api, `actions/workflows/cloudflare-api-image.yml/runs?branch=main&event=push&head_sha=${source}&status=success`, 'workflow_runs')
  const selected = runs.find(run => run.head_sha === source && run.status === 'completed' && run.conclusion === 'success')
  assert.ok(selected, 'nightly_ui_exact_producer_unavailable')
  const run = checkedRun(await api(`${repository}/actions/runs/${selected.id}/attempts/${selected.run_attempt}`), producer, { event: 'push' })
  assert.equal(run.head_sha, source, 'nightly_ui_producer_source_mismatch')
  const jobs = await pages(api, `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs')
  const manifests = jobs.filter(job => job.name === 'release-manifest')
  assert.equal(manifests.length, 1, 'nightly_ui_manifest_job_required')
  const [manifestJob] = manifests
  assert.equal(String(manifestJob.run_id), String(run.id))
  assert.equal(String(manifestJob.run_attempt), String(run.run_attempt))
  assert.equal(manifestJob.head_sha, source)
  assert.equal(manifestJob.status, 'completed')
  assert.equal(manifestJob.conclusion, 'success')
  for (const name of ['Verify every service and write the immutable manifest', 'Upload release manifest'])
    assert.deepEqual(manifestJob.steps.filter(step => step.name === name).map(step => step.conclusion), ['success'])
  const artifacts = await pages(api, `actions/runs/${run.id}/artifacts`, 'artifacts')
  const manifestArtifact = artifactFor(run, artifacts, 'release-manifest')
  const manifestBytes = await api(`${repository}/actions/artifacts/${manifestArtifact.id}/zip`, { bytes: true })
  const files = readArtifactMembers(manifestBytes, manifestArtifact)
  assert.deepEqual(Object.keys(files), ['release-manifest.json'])
  const manifest = validateReleaseManifest(files['release-manifest.json'])
  assert.equal(manifest.sourceCommit, source, 'nightly_ui_manifest_source_mismatch')
  const web = manifest.services.web
  const path = `actions/runs/${web.build.runId}/attempts/${web.build.runAttempt}`
  const originalRun = await api(`${repository}/${path}`)
  const originalJobs = await pages(api, `${path}/jobs`, 'jobs')
  const artifact = await api(`${repository}/actions/artifacts/${web.build.artifactId}`)
  checkedServiceCache('web', web, originalRun, originalJobs, artifact)
  assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128 * 1024 * 1024, 'nightly_ui_archive_size_invalid')
  const archive = await api(`${repository}/actions/artifacts/${artifact.id}/zip`, { bytes: true })
  assert.equal(archive.length, artifact.size_in_bytes, 'nightly_ui_archive_size_mismatch')
  assert.equal(hash(archive), artifact.digest, 'nightly_ui_archive_digest_mismatch')
  return { source, run, manifestArtifact, web, artifact, archive }
}

export async function restoreNightlyUi(packet, output) {
  output = resolve(output)
  await mkdir(dirname(output), { recursive: true })
  // Stage beside the destination: workspaces may be mounted on a different
  // filesystem from the system temporary directory, where rename is EXDEV.
  const directory = await mkdtemp(join(dirname(output), '.mikka-nightly-ui-'))
  try {
    const archive = join(directory, 'web.zip'), staged = join(directory, 'web')
    await writeFile(archive, packet.archive, { flag: 'wx', mode: 0o600 })
    // The fixed extractor receives data only and no GitHub token. It validates
    // every ZIP/tar member before writing any renderer file.
    execFileSync('python3', [fileURLToPath(new URL('./unpack-nightly-ui.py', import.meta.url)), archive, staged], {
      input: JSON.stringify(packet.web), encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const proof = JSON.parse(await readFile(join(staged, 'renderer-manifest.json'), 'utf8'))
    const actions = JSON.parse(await readFile(join(staged, 'renderer-actions.json'), 'utf8'))
    assert.deepEqual(actions, rendererActionContract(proof), 'nightly_ui_renderer_contract_mismatch')
    await assertNoSourceMaps(staged)
    const evidence = { source: packet.source, producerRun: String(packet.run.id), producerAttempt: String(packet.run.run_attempt),
      manifestArtifact: String(packet.manifestArtifact.id), webSource: packet.web.sourceCommit,
      overlay: packet.web.overlayCommit, reused: packet.web.reused, contextDigest: packet.web.contextDigest,
      webRun: packet.web.build.runId, webAttempt: packet.web.build.runAttempt, webArtifact: packet.web.build.artifactId,
      assetsDigest: packet.web.artifacts.assets.digest }
    await rm(output, { recursive: true, force: true })
    await rename(staged, output)
    return evidence
  } finally { await rm(directory, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'nightly_ui_main_required')
    assert.ok(['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME), 'nightly_ui_event_invalid')
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    assert.equal(source, process.env.GITHUB_SHA, 'nightly_ui_checkout_mismatch')
    const packet = await selectNightlyUi({ source })
    const evidence = await restoreNightlyUi(packet, resolve('apps/frontend/dist/web'))
    await mkdir('.cache/nightly', { recursive: true })
    await writeFile('.cache/nightly/ui-origin.json', JSON.stringify(evidence, null, 2) + '\n')
    assert.ok(process.env.GITHUB_ENV)
    await appendFile(process.env.GITHUB_ENV, `MIKKA_UI_OVERLAY_SHA=${packet.web.overlayCommit}\n`)
    console.log(JSON.stringify(evidence))
  } catch (error) {
    console.error(/^nightly_ui_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'nightly_ui_verification_failed')
    process.exitCode = 1
  }
}
