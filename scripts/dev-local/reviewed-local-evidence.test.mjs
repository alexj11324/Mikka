import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { artifactFingerprints, REVIEWED_HELPER, verifyReviewedLocalEvidence } from './reviewed-local-evidence.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')

test('review combines exact-runtime runs and rejects changed runtime, helper, or original evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-reviewed-evidence-'))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  const json = async (path, value) => { const text = JSON.stringify(value); await writeFile(path, text); return hash(text) }
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']); return git(['rev-parse', 'HEAD']) }
  try {
    git(['init'])
    await mkdir(join(root, 'app')); await mkdir(join(root, 'scripts/dev-local'), { recursive: true })
    await writeFile(join(root, 'app/runtime.mjs'), 'export const runtime = 1\n')
    await writeFile(join(root, REVIEWED_HELPER), 'old helper\n'); const first = commit()
    await writeFile(join(root, REVIEWED_HELPER), 'corrected helper\n'); const second = commit()
    const review = { version: 1, kind: 'reviewed-local-acceptance', repositoryRoot: root, runtimeFingerprint: artifactFingerprints(root, first).runtimeFingerprint,
      runtimeFingerprintScope: { algorithm: 'driver-fingerprint-v1', excludedPaths: [REVIEWED_HELPER] }, runs: [] }
    let latest
    for (const [index, artifact, items] of [[1, first, [1, 2, 3, 4, 5, 6]], [2, second, [7]]]) {
      const fp = artifactFingerprints(root, artifact), runId = `fixture-${index}`, dir = join(root, `evidence-${index}`)
      await mkdir(dir)
      const steps = [], lines = []
      for (const item of items) {
        const events = ['start', 'evidence', 'ok'].map(status => JSON.stringify({ runId, step: `item${item}-fixture`, status }))
        lines.push(...events); steps.push({ item, status: 'passed', eventsSha256: hash(events.join('\n') + '\n') })
      }
      const progressFile = join(dir, 'progress.jsonl'); await writeFile(progressFile, lines.join('\n') + '\n')
      latest = { revision: artifact, sourceFingerprint: fp.sourceFingerprint, origin: 'http://localhost:3110', database: `fixture_${index}_e2e`, instanceId: `instance-${index}` }
      const environmentSummaryFile = join(dir, 'environment-summary.json'), environmentSummarySha256 = await json(environmentSummaryFile, latest)
      const manifestFile = join(dir, 'passed-items.json'), manifestSha256 = await json(manifestFile, { runId, fixedSource: true, sourceFingerprint: fp.sourceFingerprint, passedItems: items })
      review.runs.push({ artifact, harnessFingerprint: fp.harnessFingerprint, manifestFile, manifestSha256, environmentSummaryFile, environmentSummarySha256, progressFile, steps })
    }
    const reviewFile = join(root, 'review.json'), environment = { deploymentSha: second, origin: latest.origin, database: { name: latest.database }, instanceId: latest.instanceId }, runtime = { server: latest.origin + '/mikka' }
    await json(reviewFile, review)
    assert.deepEqual((await verifyReviewedLocalEvidence(reviewFile, { environment, runtime })).passedItems, [1, 2, 3, 4, 5, 6, 7])
    review.runs[1].harnessFingerprint = '0'.repeat(64); await json(reviewFile, review)
    await assert.rejects(verifyReviewedLocalEvidence(reviewFile, { environment, runtime }), /helper differs/)
    review.runs[1].harnessFingerprint = artifactFingerprints(root, second).harnessFingerprint
    await writeFile(join(root, 'app/runtime.mjs'), 'export const runtime = 2\n'); const changed = commit()
    review.runs[1].artifact = changed; await json(reviewFile, review)
    await assert.rejects(verifyReviewedLocalEvidence(reviewFile, { environment, runtime }), /runtime code differs/)
    review.runs[1].artifact = second; await json(reviewFile, review)
    await writeFile(review.runs[0].manifestFile, '{"passedItems":[1,2,3,4,5,6,7]}')
    await assert.rejects(verifyReviewedLocalEvidence(reviewFile, { environment, runtime }), /evidence changed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
