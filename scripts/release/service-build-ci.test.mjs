import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkedServiceCache, selectServicePublications, stageContext, trustedBuildSource } from './service-build-ci.mjs'
import { registryImage, serviceDigest, serviceNames } from './service-builds.mjs'
import { UI_SLOTS, uiOverlay } from '../../lib/ui-overlay.mjs'

const revision = 'a'.repeat(40), merge = 'b'.repeat(40)

async function selectionFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-build-selection-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const operations = join(directory, '.operations-input')
  const releases = join(operations, 'docs/operations/releases')
  await mkdir(releases, { recursive: true })
  const staging = join(releases, 'hosted-api-staging.json')
  const input = join(releases, 'deploy-build-inputs.json')
  const stagingBytes = JSON.stringify({ source: revision, overlaySource: revision }) + '\n'
  await writeFile(staging, stagingBytes)
  await writeFile(input, JSON.stringify({ version: 1, overlaySource: merge }) + '\n')
  const git = args => execFileSync('git', args, { cwd: operations, encoding: 'utf8', stdio: 'pipe' })
  git(['init', '--quiet']); git(['add', '.'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'approved build input'])
  // Execute the production step itself; this source-only workflow has no package install.
  const workflow = await readFile(new URL('../../.github/workflows/cloudflare-api-image.yml', import.meta.url), 'utf8')
  const selections = workflow.split('\n        id: selection\n')
  assert.equal(selections.length, 2)
  const step = selections[1].split('\n      - ')[0]
  const run = step.split('        run: |\n')[1]?.replace(/^ {10}/gm, '')
  assert.ok(run)
  const output = join(directory, 'output')
  const select = async () => {
    await writeFile(output, '')
    const result = spawnSync('bash', ['-e', '-c', run], {
      cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: output },
    })
    assert.ifError(result.error)
    return { ...result, output: await readFile(output, 'utf8') }
  }
  return { directory, input, staging, stagingBytes, select }
}

test('automatic builds select an independent compatible UI pin while preserving the serving staging request', async t => {
  const { directory, staging, stagingBytes, select } = await selectionFixture(t)
  const requiredAdditions = new Set(['automation-editor', 'automations', 'pull-directory'])
  for (const pin of [revision, merge]) {
    const slots = join(directory, pin, 'slots')
    await mkdir(slots, { recursive: true })
    for (const name of UI_SLOTS) {
      if (pin === revision && requiredAdditions.has(name)) continue
      await writeFile(join(slots, name + '.tsx'), '')
    }
  }
  // A pinned official build must still reject the old provider inventory.
  assert.throws(() => uiOverlay(directory, { MIKKA_UI_OVERLAY_DIR: revision, MIKKA_UI_OVERLAY_SHA: revision }),
    /UI_OVERLAY_SLOT_REQUIRED: automation-editor/)
  const result = await select()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  const selected = /^overlay=([a-f0-9]{40})\n$/.exec(result.output)?.[1]
  assert.ok(selected)
  assert.doesNotThrow(() => uiOverlay(directory, { MIKKA_UI_OVERLAY_DIR: selected, MIKKA_UI_OVERLAY_SHA: selected }))
  assert.equal(selected, merge)
  assert.equal(await readFile(staging, 'utf8'), stagingBytes)
})

test('an unavailable or invalid independent build input fails closed without falling back to staging or disclosing input', async t => {
  const { input, staging, stagingBytes, select } = await selectionFixture(t)
  const invalid = [null, [], {}, { version: 1 }, { overlaySource: merge },
    { version: '1', overlaySource: merge }, { version: 2, overlaySource: merge },
    { version: 1, overlaySource: merge.toUpperCase() }, { version: 1, overlaySource: merge.slice(1) },
    { version: 1, overlaySource: merge + '\n' }, { version: 1, overlaySource: 17 },
    { version: 1, overlaySource: merge, source: revision }]
  for (const bytes of [...invalid.map(value => JSON.stringify(value)), 'invalid-json', null]) {
    if (bytes === null) await rm(input)
    else await writeFile(input, bytes)
    const result = await select()
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'APPROVED_BUILD_SELECTION_UNAVAILABLE\n')
    assert.equal(result.output, '')
    assert.equal(await readFile(staging, 'utf8'), stagingBytes)
  }
})

function event(kind) {
  const ref = kind === 'push' ? 'refs/heads/main' : 'refs/pull/23/merge'
  const sha = kind === 'push' ? revision : merge
  return {
    env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963',
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

test('merge queue publication requires the numeric bot identity and a real main push', () => {
  const { env, payload } = event('push')
  Object.assign(env, { GITHUB_ACTOR_ID: '118344674', GITHUB_ACTOR: 'github-merge-queue[bot]', GITHUB_TRIGGERING_ACTOR: 'github-merge-queue[bot]' })
  assert.equal(trustedBuildSource(env, payload), revision)
  for (const patch of [
    { GITHUB_TRIGGERING_ACTOR: 'alexj11324', GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_ACTOR_ID: '7' }, { GITHUB_ACTOR: 'outsider' }, { GITHUB_ACTOR_ID: undefined },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_TRIGGERING_ACTOR: 'outsider' }, { GITHUB_REPOSITORY_ID: '7' },
  ]) assert.throws(() => trustedBuildSource({ ...env, ...patch }, payload))
  assert.equal(trustedBuildSource({ ...env, GITHUB_TRIGGERING_ACTOR: 'alexj11324' }, payload), revision)
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
  const job = { name: 'service-build (litellm)', run_id: 101, run_attempt: 1, head_sha: revision, status: 'completed', conclusion: 'success',
    steps: ['Build and verify service', 'Publish immutable service image', 'Upload service artifact', 'Upload service cache receipt']
      .map(name => ({ name, conclusion: 'success' })) }
  const artifact = { id: 201, name: 'service-litellm-101-1', expired: false, workflow_run: {
    id: 101, head_sha: revision, repository_id: 1427517699, head_repository_id: 1427517699 } }
  assert.equal(checkedServiceCache('litellm', receipt, run, [job], artifact), receipt)
  const bot = { id: 118344674, login: 'github-merge-queue[bot]' }
  assert.equal(checkedServiceCache('litellm', receipt, { ...run, actor: bot, triggering_actor: bot }, [job], artifact), receipt)
  assert.equal(checkedServiceCache('litellm', receipt, { ...run, actor: bot, triggering_actor: { id: 183887963, login: 'alexj11324' } }, [job], artifact), receipt)
  for (const actor of [{ ...bot, id: 7 }, { ...bot, login: 'outsider' }, { login: bot.login }]) {
    for (const field of ['actor', 'triggering_actor'])
      assert.throws(() => checkedServiceCache('litellm', receipt, { ...run, [field]: actor }, [job], artifact))
  }
  for (const change of [
    value => { value.job.conclusion = 'failure' },
    value => { value.job.steps[0].conclusion = 'skipped' },
    value => { value.job.steps.pop() },
    value => { value.run.head_repository.fork = true },
    value => { value.run.conclusion = 'cancelled' },
    value => { value.run.status = 'in_progress' },
    value => { value.run.triggering_actor.id = 7 },
    value => { value.artifact.expired = true },
    value => { value.artifact.workflow_run.head_sha = merge },
  ]) {
    const value = structuredClone({ receipt, run, job, artifact }); change(value)
    assert.throws(() => checkedServiceCache('litellm', value.receipt, value.run, [value.job], value.artifact))
  }
})


test('a failed-job rerun assembles successful original attempts without relabeling or adopting a failed partial upload', () => {
  const digest = 'sha256:' + 'c'.repeat(64)
  const plan = { sourceCommit: revision, services: Object.fromEntries(serviceNames.map(name => [name, { contextDigest: digest }])) }
  const cached = Object.fromEntries(serviceNames.filter(name => !['eve', 'litellm'].includes(name)).map(name => [name, { retained: true }]))
  function publication(name, attempt, conclusion = 'success') {
    const artifactId = 200 + attempt * 10 + (name === 'eve' ? 1 : 2)
    const receipt = { service: name, kind: 'container', contextDigest: digest, sourceCommit: revision, overlayCommit: null,
      release: revision.slice(0, 12) + '-101-' + attempt, reused: false,
      build: { runId: '101', runAttempt: String(attempt), workflow: 'cloudflare-api-image.yml' },
      image: 'registry.cloudflare.com/' + 'd'.repeat(32) + '/mikka-' + name + '@' + digest,
      imageDigest: digest, localImageId: digest, artifacts: { worker: { path: 'workers/' + name + '.mjs', digest } } }
    const job = { id: artifactId + 1000, name: 'service-build (' + name + ')', run_id: 101, run_attempt: attempt,
      head_sha: revision, status: 'completed', conclusion,
      steps: ['Build and verify service', 'Publish immutable service image', 'Upload service artifact', 'Upload service cache receipt']
        .map(name => ({ name, conclusion: 'success' })) }
    const artifact = { id: artifactId, name: 'service-' + name + '-101-' + attempt, expired: false,
      workflow_run: { id: 101, head_sha: revision, head_branch: 'main', repository_id: 1427517699, head_repository_id: 1427517699 } }
    return { receipt, job, artifact }
  }
  const packets = [publication('eve', 1, 'failure'), publication('litellm', 1), publication('eve', 2), publication('eve', 3, 'failure')]
  const select = selected => selectServicePublications(plan, cached, selected.map(p => p.receipt), selected.map(p => p.artifact),
    selected.map(p => p.job), { runId: '101', runAttempt: '3' })
  const selected = Object.fromEntries(select(packets).map(item => [item.name, item]))
  assert.equal(selected.litellm.receipt.build.runAttempt, '1')
  assert.equal(selected.litellm.receipt.build.artifactId, '212')
  assert.equal(selected.eve.receipt.build.runAttempt, '2')
  assert.equal(selected.eve.receipt.build.artifactId, '221')
  assert.equal(selected.eve.receipt.release, revision.slice(0, 12) + '-101-2')
  assert.equal(selected.eve.artifactName, 'service-eve-101-2')
  assert.throws(() => select(packets.filter(p => p.receipt.service !== 'litellm')), /No successful original service publication/)
  for (const change of [
    p => { p[1].job.steps[2].conclusion = 'skipped' },
    p => { p[1].job.head_sha = merge },
    p => { p[1].artifact.workflow_run.repository_id = 1 },
    p => { p[1].artifact.expired = true },
    p => { p[1].receipt.build.runId = '102' },
    p => { p[1].receipt.build.runAttempt = '4' },
  ]) {
    const altered = structuredClone(packets); change(altered)
    assert.throws(() => select(altered))
  }
})
