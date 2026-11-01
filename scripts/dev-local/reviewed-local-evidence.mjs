import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const REVIEWED_HELPER = 'scripts/dev-local/worker-mailbox-acceptance.mjs'
const paths = ['app', 'lib', 'packages', 'scripts', 'agents', 'drizzle', 'package.json', 'pnpm-lock.yaml', 'next.config.mjs']
const sha256 = value => createHash('sha256').update(value).digest('hex')

/** Same path/content algorithm as the driver; only the reviewed helper is separated. */
export function artifactFingerprints(root, artifact) {
  assert.match(artifact, /^[a-f0-9]{40}$/, 'An immutable local artifact is required')
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', artifact, '--', ...paths], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort()
  const contents = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: files.map(path => `${artifact}:${path}\n`).join(''), maxBuffer: 64 * 1024 * 1024 })
  const source = createHash('sha256'), runtime = createHash('sha256')
  let offset = 0, harnessFingerprint
  for (const path of files) {
    const end = contents.indexOf(10, offset)
    const header = contents.subarray(offset, end).toString().split(' ')
    assert.equal(header[1], 'blob', 'Artifact source must contain real file blobs')
    const size = Number(header[2]), body = contents.subarray(end + 1, end + 1 + size)
    source.update(`${path}\0`); source.update(body)
    if (path === REVIEWED_HELPER) harnessFingerprint = sha256(body)
    else { runtime.update(`${path}\0`); runtime.update(body) }
    offset = end + 1 + size + 1
  }
  assert.match(harnessFingerprint ?? '', /^[a-f0-9]{64}$/, 'Reviewed helper missing from artifact')
  return { sourceFingerprint: source.digest('hex'), runtimeFingerprint: runtime.digest('hex'), harnessFingerprint }
}

async function checkedFile(file, expected) {
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'An evidence file digest is required')
  const bytes = await readFile(file)
  assert.equal(sha256(bytes), expected, 'Original local evidence changed after review')
  return bytes
}

/** A separate review can combine distinct fixed test runs with identical runtime bytes. */
export async function verifyReviewedLocalEvidence(file, { environment, runtime }) {
  const review = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(review.version, 1)
  assert.equal(review.kind, 'reviewed-local-acceptance')
  assert.deepEqual(review.runtimeFingerprintScope, { algorithm: 'driver-fingerprint-v1', excludedPaths: [REVIEWED_HELPER] })
  assert.ok(Array.isArray(review.runs) && review.runs.length >= 2, 'Separate original test runs are required')
  const passed = new Set()
  let latestSummary
  for (const run of review.runs) {
    const manifest = JSON.parse(await checkedFile(run.manifestFile, run.manifestSha256))
    const actual = artifactFingerprints(review.repositoryRoot, run.artifact)
    assert.equal(actual.runtimeFingerprint, review.runtimeFingerprint, 'Product/runtime code differs across reviewed test runs')
    assert.equal(actual.harnessFingerprint, run.harnessFingerprint, 'Reviewed test helper differs from its artifact')
    assert.equal(actual.sourceFingerprint, manifest.sourceFingerprint, 'Original run source does not match its immutable artifact')
    assert.equal(manifest.fixedSource, true, 'A moving-source run cannot be reused')
    if (manifest.artifact) assert.equal(manifest.artifact, run.artifact)
    if (manifest.startedFingerprint) assert.equal(manifest.startedFingerprint, manifest.sourceFingerprint)
    if (manifest.finishedFingerprint) assert.equal(manifest.finishedFingerprint, manifest.sourceFingerprint)
    if (manifest.runtimeFingerprint) assert.equal(manifest.runtimeFingerprint, actual.runtimeFingerprint)
    if (manifest.harnessFingerprint) assert.equal(manifest.harnessFingerprint, actual.harnessFingerprint)
    for (const evidence of manifest.evidenceFiles ?? []) await checkedFile(evidence.path, evidence.sha256)
    const summaryFile = run.environmentSummaryFile ?? resolve(dirname(run.manifestFile), 'environment-summary.json')
    const summary = JSON.parse(await checkedFile(summaryFile, run.environmentSummarySha256))
    assert.equal(summary.revision, run.artifact)
    assert.equal(summary.sourceFingerprint, manifest.sourceFingerprint)
    const lines = (await readFile(run.progressFile, 'utf8')).trim().split('\n').filter(Boolean)
    const steps = run.steps ?? manifest.steps
    assert.ok(Array.isArray(steps), 'Original step event digests are required')
    for (const item of manifest.passedItems) {
      assert.ok(Number.isInteger(item) && item >= 1 && item <= 7)
      const step = steps.find(value => value.item === item)
      assert.ok(step && step.status === 'passed', 'An explicit passed step receipt is required')
      const events = lines.filter(line => { const event = JSON.parse(line); return event.runId === manifest.runId && event.step.startsWith(`item${item}-`) })
      assert.equal(sha256(`${events.join('\n')}\n`), step.eventsSha256, 'Original passed step events differ from review')
      const states = events.map(line => JSON.parse(line).status)
      assert.ok(states.includes('start') && states.includes('ok') && states.includes('evidence') && !states.includes('fail'), 'Step did not finish with real evidence')
      passed.add(item)
    }
    latestSummary = summary
  }
  assert.ok([1, 2, 3, 4, 5, 6, 7].every(item => passed.has(item)), 'Reviewed evidence must cover all seven local items')
  assert.equal(latestSummary.revision, environment.deploymentSha, 'The owning server must run the latest reviewed artifact')
  assert.equal(latestSummary.origin, environment.origin)
  assert.equal(latestSummary.database, environment.database.name)
  assert.equal(latestSummary.instanceId, environment.instanceId)
  assert.equal(new URL(runtime.server).origin, environment.origin)
  return { passedItems: [...passed], runtimeFingerprint: review.runtimeFingerprint, repositoryRoot: review.repositoryRoot }
}
