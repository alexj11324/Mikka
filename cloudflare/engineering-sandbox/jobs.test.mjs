import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { githubRun, validJob, sourceSuites } from './jobs.mjs'

test('only the upstream main engineering workflow can use compute or read a receipt', () => {
  const repository = 'selfhost/engineering', repositoryId = '12345'
  const workflow = repository + '/.github/workflows/engineering-sandbox.yml@refs/heads/main'
  const allowed = { repository, repository_id: repositoryId, workflow_ref: workflow,
    sub: 'repo:' + repository + ':ref:refs/heads/main', ref: 'refs/heads/main', event_name: 'workflow_dispatch',
    run_id: '1234', run_attempt: '2' }
  assert.equal(githubRun(allowed), null)
  assert.equal(githubRun(allowed, repository, repositoryId), '1234/2')
  for (const altered of [{ repository_id: '1' }, { event_name: 'push' }, { event_name: 'pull_request_target' }, { event_name: 'pull_request' },
    { repository: 'fork/Mikka' }, { sub: 'repo:fork/Mikka:ref:refs/heads/main' },
    { ref: 'refs/pull/1/merge' }, { workflow_ref: workflow.replace('engineering-sandbox', 'another') },
    { run_id: '1234/2' }, { run_attempt: '1/anything' }]) {
    assert.equal(githubRun({ ...allowed, ...altered }, repository, repositoryId), null)
  }
})
test('workload and source are closed inputs', () => {
  const valid = { sha: 'f'.repeat(40), workload: 'factory-handoff', issue: 1503 }
  assert.ok(validJob(valid))
  for (const invalid of [{ sha: 'main' }, { issue: 0 }, { issue: '1503' }, { workload: '__proto__' }, { workload: 'shell' }]) {
    assert.equal(validJob({ ...valid, ...invalid }), false)
  }
})
for (const [profile, paths] of Object.entries(sourceSuites)) {
  test('the declared files run without the repository checkout: ' + profile, async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'engineering-job-'))
    try {
      const input = await Promise.all(paths.map(async path => ({
        path, text: await readFile(new URL('../../' + path, import.meta.url), 'utf8'),
      })))
      const command = await readFile(new URL('./command.txt', import.meta.url), 'utf8')
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: isolated, env: { TMPDIR: isolated, PATH: process.env.PATH },
        input: JSON.stringify({ files: input }), timeout: 30_000, encoding: 'utf8',
      })
      assert.equal(child.status, 0, child.stderr)
      const receipt = JSON.parse(child.stdout)
      assert.equal(receipt.exitCode, 0, receipt.output)
      assert.match(receipt.output, /# fail 0/)
      assert.match(receipt.output, /# pass [1-9]/)
    } finally { await rm(isolated, { recursive: true, force: true }) }
  })
}

test('expensive compilation requires the operator-reviewed public SHA, checksum and an artifact destination', async () => {
  const { approvedEveBuild } = await import('./eve-artifact.mjs')
  const job = {workload:'eve-host-build',sha:'a'.repeat(40),owner:'134/2/eve-host-build'}
  const env = {EVE_BUILD_REVISION:job.sha,EVE_BUILD_SOURCE_SHA256:'b'.repeat(64),EVE_BUILD_ARTIFACTS:{}}
  assert.deepEqual(approvedEveBuild(job,env),{sha:job.sha,sourceDigest:env.EVE_BUILD_SOURCE_SHA256,runId:'134',attempt:'2'})
  for (const change of [{EVE_BUILD_REVISION:'b'.repeat(40)}, {EVE_BUILD_SOURCE_SHA256:'not-a-digest'}, {EVE_BUILD_ARTIFACTS:null}]) {
    assert.throws(() => approvedEveBuild(job,{...env,...change}),/approved source/)
  }
  for (const owner of ['another/attempt','134/2/another','134/2/eve-host-build/other']) {
    assert.throws(() => approvedEveBuild({...job,owner},env),/owner/)
  }
})

test('a mismatched or missing R2 object cannot start a host verification', async () => {
  const { verifyEveArtifact } = await import('./eve-artifact.mjs')
  const artifact = { key: 'run-archive', size: 12, sha256: 'a'.repeat(64) }
  for (const object of [null, { size: 11 }, { size: 12, checksums: { toJSON: () => ({ sha256: 'b'.repeat(64) }) } }]) {
    let executions = 0
    const vm = { exec() {++executions} }
    await assert.rejects(verifyEveArtifact(vm, { get: async key => {
      assert.equal(key, artifact.key)
      return object
    } }, artifact, 'probe', 'source', 'release'), /verification archive changed/)
    assert.equal(executions, 0)
  }
})
