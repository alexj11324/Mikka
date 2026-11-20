import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkedServiceCache, stageContext, trustedBuildSource } from './service-build-ci.mjs'
import { registryImage, serviceDigest } from './service-builds.mjs'

const revision = 'a'.repeat(40), merge = 'b'.repeat(40)
function event(kind) {
  const ref = kind === 'push' ? 'refs/heads/main' : 'refs/pull/23/merge'
  const sha = kind === 'push' ? revision : merge
  return {
    env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REPOSITORY_ID: '1427517699',
      GITHUB_ACTOR_ID: '183887963', GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324',
      GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha, GITHUB_EVENT_NAME: kind,
      GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/cloudflare-api-image.yml@' + ref,
      GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1' },
    payload: kind === 'push' ? { ref, after: sha } : { number: 23, pull_request: {
      head: { repo: { full_name: 'alexj11324/Mikka', id: 1427517699, fork: false }, sha: revision },
      base: { ref: 'main', repo: { full_name: 'alexj11324/Mikka' } }, user: { id: 183887963 } } },
  }
}

test('automatic publication uses the real main push allowed by the existing protected environment', () => {
  const { env, payload } = event('push')
  assert.equal(trustedBuildSource(env, payload), revision)
})

test('PRs including the owner\'s, foreign actors, mismatched runs and simulated dispatches cannot obtain publication authority', () => {
  const pr = event('pull_request')
  assert.throws(() => trustedBuildSource(pr.env, pr.payload))
  pr.payload.pull_request.head.repo.fork = true
  assert.throws(() => trustedBuildSource(pr.env, pr.payload))
  for (const mutate of [
    value => { value.env.GITHUB_REPOSITORY = 'outsider/Mikka' },
    value => { value.env.GITHUB_REPOSITORY_ID = '7' },
    value => { value.env.GITHUB_ACTOR_ID = '7' },
    value => { value.env.GITHUB_REF = 'refs/heads/feature' },
    value => { value.env.GITHUB_TRIGGERING_ACTOR = 'outsider' },
    value => { value.env.GITHUB_WORKFLOW_SHA = merge },
    value => { value.env.GITHUB_WORKFLOW_REF = 'alexj11324/Mikka/.github/workflows/other.yml@refs/heads/main' },
    value => { value.env.GITHUB_EVENT_NAME = 'workflow_dispatch' },
    value => { value.env.GITHUB_EVENT_NAME = 'pull_request_target' },
  ]) {
    const value = event('push'); mutate(value)
    assert.throws(() => trustedBuildSource(value.env, value.payload))
  }
  const value = event('push'); value.payload.after = merge
  assert.throws(() => trustedBuildSource(value.env, value.payload))
})

test('the Docker context contains exactly the selected files and preserves executable permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-minimal-context-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source'), target = join(directory, 'docker')
  await mkdir(join(source, 'runtime'), { recursive: true })
  await writeFile(join(source, 'runtime/start.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(source, 'runtime/start.sh'), 0o755)
  await writeFile(join(source, 'unrelated.txt'), 'not a build input\n')
  await stageContext(target, ['runtime/start.sh'], source)
  assert.deepEqual(await readdir(target), ['runtime'])
  assert.equal(await readFile(join(target, 'runtime/start.sh'), 'utf8'), '#!/bin/sh\nexit 0\n')
  assert.equal((await lstat(join(target, 'runtime/start.sh'))).mode & 0o777, 0o755)
  await assert.rejects(stageContext(target, ['../outside'], source))
})

test('registry reuse verifies raw manifest bytes and only treats HTTP 404 as a cache miss', async t => {
  const input = { account: 'c'.repeat(32), repository: 'mikka-litellm', contextDigest: 'sha256:' + 'd'.repeat(64),
    username: 'ephemeral-user', password: 'ephemeral-value' }
  const bytes = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json' })
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  let response = new Response(bytes, { headers: { 'docker-content-digest': digest } })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://registry.cloudflare.com/v2/' + input.account + '/mikka-litellm/manifests/' + 'd'.repeat(64))
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Basic ' + Buffer.from(input.username + ':' + input.password).toString('base64'))
    return response
  })
  assert.deepEqual(await registryImage(input), { image: 'registry.cloudflare.com/' + input.account + '/mikka-litellm@' + digest,
    imageDigest: digest, tag: 'd'.repeat(64) })
  response = new Response(null, { status: 404 })
  assert.equal(await registryImage(input), null)
  response = new Response(null, { status: 403 })
  await assert.rejects(registryImage(input), error => error.message === 'REGISTRY_LOOKUP_FAILED' && error.cause?.message === 'HTTP_403')
  response = new Response(bytes, { headers: { 'docker-content-digest': 'sha256:' + 'e'.repeat(64) } })
  await assert.rejects(registryImage(input), /Registry manifest digest differs/)
})

test('a successful service survives a sibling failure, but missing provenance or a skipped gate cannot become a cache hit', () => {
  const digest = 'sha256:' + 'c'.repeat(64)
  const receipt = { kind: 'container', contextDigest: digest, sourceCommit: revision, overlayCommit: null,
    build: { runId: '101', runAttempt: '1', artifactId: '201', workflow: 'cloudflare-api-image.yml' }, reused: false,
    image: 'registry.cloudflare.com/' + 'd'.repeat(32) + '/mikka-litellm@' + digest, imageDigest: digest, localImageId: digest,
    artifacts: { worker: { path: 'workers/litellm.mjs', digest } } }
  receipt.digest = serviceDigest(receipt)
  const repo = { id: 1427517699, full_name: 'alexj11324/Mikka', private: false, fork: false }
  const run = { id: 101, run_attempt: 1, head_sha: revision, repository: repo, head_repository: repo,
    event: 'push', head_branch: 'main', path: '.github/workflows/cloudflare-api-image.yml',
    status: 'completed', conclusion: 'failure', actor: { id: 183887963 }, triggering_actor: { id: 183887963 } }
  const job = { name: 'service-build (litellm)', run_id: 101, run_attempt: 1, status: 'completed', conclusion: 'success',
    steps: ['Build and verify service', 'Publish immutable service image', 'Upload service artifact', 'Upload service cache receipt']
      .map(name => ({ name, conclusion: 'success' })) }
  const artifact = { id: 201, name: 'service-litellm-101-1', expired: false, workflow_run: {
    id: 101, head_sha: revision, repository_id: 1427517699, head_repository_id: 1427517699 } }
  assert.equal(checkedServiceCache('litellm', receipt, run, [job], artifact), receipt)
  for (const change of [
    value => { value.job.conclusion = 'failure' },
    value => { value.job.steps[0].conclusion = 'skipped' },
    value => { value.job.steps.pop() },
    value => { value.run.head_repository.fork = true },
    value => { value.run.triggering_actor.id = 7 },
    value => { value.artifact.expired = true },
    value => { value.artifact.workflow_run.head_sha = merge },
  ]) {
    const value = structuredClone({ receipt, run, job, artifact }); change(value)
    assert.throws(() => checkedServiceCache('litellm', value.receipt, value.run, [value.job], value.artifact))
  }
})
