import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { artifactFor, baselineOrigin, checkedRun, readArtifactMembers, selectAutomaticCandidate } from './pipeline-inputs.mjs'

const source = 'a'.repeat(40)
const repo = { id: 1427517699, full_name: 'alexj11324/Mikka', fork: false, private: false }
const producer = '.github/workflows/cloudflare-api-image.yml'
const run = () => ({ id: 101, run_attempt: 2, path: producer, event: 'push', status: 'completed',
  conclusion: 'success', head_sha: source, head_branch: 'main', actor: { id: 183887963 },
  triggering_actor: { id: 183887963 }, repository: repo, head_repository: repo })
const event = original => ({ action: 'completed', repository: repo, workflow_run: structuredClone(original) })

test('the completed main push selects only the latest queued source, without rewriting workflow identity', () => {
  const original = run()
  assert.equal(selectAutomaticCandidate(event(original), original, source), 'selected')
  assert.equal(selectAutomaticCandidate(event(original), original, 'b'.repeat(40)), 'superseded')
  const forged = event(original)
  forged.workflow_run.run_attempt = 1
  assert.throws(() => selectAutomaticCandidate(forged, original, source))
})

test('failed builds, fork PRs, branches and different actors never become deployable candidates', () => {
  for (const change of [
    { conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' },
    { head_branch: 'feature' }, { head_repository: { ...repo, fork: true } },
    { repository: { ...repo, private: true } }, { actor: { id: 123 } },
    { triggering_actor: { id: 123 } }, { path: '.github/workflows/other.yml' },
  ]) {
    const original = { ...run(), ...change }
    assert.throws(() => selectAutomaticCandidate(event(original), original, source))
  }
  assert.equal(checkedRun(run(), producer, { event: 'push' }).id, 101)
})

test('a failed stage blocks the next writer while a completed rollback restores its previous origin', () => {
  const origin = { runId: '101', runAttempt: '2', artifactId: '301' }
  const previousOrigin = { runId: '99', runAttempt: '1', artifactId: '299' }
  const summary = { version: 1, target: 'staging', status: 'passed', verification: { status: 'pass' }, origin, previousOrigin }
  assert.deepEqual(baselineOrigin(summary), origin)
  assert.throws(() => baselineOrigin({ ...summary, status: 'failed' }), /requires_recovery/)
  assert.throws(() => baselineOrigin({ ...summary, verification: { status: 'fail' } }))
  assert.deepEqual(baselineOrigin({ ...summary, status: 'failed', rollback: { status: 'passed' } }), previousOrigin)
  assert.equal(baselineOrigin({ ...summary, previousOrigin: null, rollback: { status: 'passed' } }), null)
})

test('artifact selection requires the original attempt, complete provenance, immutable digest and unexpired bytes', () => {
  const original = run()
  const artifact = { id: 301, name: 'release-manifest-101-2', expired: false, size_in_bytes: 100,
    digest: 'sha256:' + 'c'.repeat(64), workflow_run: { id: 101, head_sha: source, head_branch: 'main',
      repository_id: 1427517699, head_repository_id: 1427517699 } }
  assert.equal(artifactFor(original, [artifact], 'release-manifest'), artifact)
  for (const changes of [{ expired: true }, { name: 'release-manifest-101-1' }, { digest: null },
    { workflow_run: { ...artifact.workflow_run, head_sha: 'b'.repeat(40) } },
    { workflow_run: { ...artifact.workflow_run, head_repository_id: 1 } }]) {
    assert.throws(() => artifactFor(original, [{ ...artifact, ...changes }], 'release-manifest'))
  }
  assert.throws(() => artifactFor(original, [artifact, artifact], 'release-manifest'))
})

test('archive bytes are authenticated and traversal, duplicate members and unexpected private files are rejected', () => {
  const zip = names => execFileSync('python3', ['-c',
    'import io,sys,zipfile,json\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n for name in json.loads(sys.argv[1]): z.writestr(name,"{\\"version\\":1}")\nsys.stdout.buffer.write(b.getvalue())', JSON.stringify(names)], { stdio: ['ignore', 'pipe', 'pipe'] })
  const metadata = bytes => ({ size_in_bytes: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') })
  const good = zip(['release-manifest.json'])
  assert.deepEqual(readArtifactMembers(good, metadata(good)), { 'release-manifest.json': { version: 1 } })
  assert.throws(() => readArtifactMembers(good, { ...metadata(good), digest: 'sha256:' + '0'.repeat(64) }))
  for (const names of [['../release-manifest.json'], ['release-manifest.json', 'release-manifest.json'], ['private-receipt.json']]) {
    const bytes = zip(names)
    assert.throws(() => readArtifactMembers(bytes, metadata(bytes)), /pipeline_artifact_format_invalid/)
  }
})
