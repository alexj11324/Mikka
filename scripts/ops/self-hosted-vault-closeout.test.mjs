import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { ownedMachine, ownHttps, loginMatches, publishedImageGuard, imageGuard, fixtureGuard, containerGuard,
  finalImagePassed, stopTunnel } from './self-hosted-vault-closeout.mjs'
const plan = JSON.parse(await readFile(new URL('./self-hosted-vault-plan.json', import.meta.url), 'utf8'))
const actor = { userId: 'fixture', workspaceId: '00000000-0000-4000-8000-000000000001' }
const row = { ...actor, ownerId: actor.userId, sandboxId: 'owned123456789', operationId: '00000000-0000-4000-8000-000000000002' }
const metadata = { application: 'mikka', workspaceId: actor.workspaceId }
test('cleanup requires both exact owner/workspace row and provider metadata', () => {
  assert.equal(ownedMachine(row, actor, metadata), row.sandboxId)
  for (const bad of [{ ...row, ownerId: 'foreign' }, { ...row, workspaceId: 'foreign' }, { ...row, operationId: '' }]) assert.throws(() => ownedMachine(bad, actor, metadata))
  assert.throws(() => ownedMachine(row, actor, { ...metadata, workspaceId: 'foreign' }))
  assert.throws(() => ownedMachine(row, actor, { ...metadata, application: 'other' }))
})
test('fixture origin rejects credentials, query, path and arbitrary domains', () => {
  assert.equal(ownHttps('https://owned-site.trycloudflare.com'), 'https://owned-site.trycloudflare.com')
  for (const value of ['http://owned-site.trycloudflare.com', 'https://example.com', 'https://u@owned.trycloudflare.com', 'https://owned.trycloudflare.com/?token=x', 'https://owned.trycloudflare.com/x']) assert.throws(() => ownHttps(value))
})
test('site accepts exactly the expected disposable fields and rejects ambiguity', () => {
  assert.equal(loginMatches('username=owned&password=secret', 'owned', 'secret'), true)
  for (const body of ['username=owned&password=other', 'username=foreign&password=secret', 'username=owned&password=secret&password=secret', 'username=owned']) assert.equal(loginMatches(body, 'owned', 'secret'), false)
})

const workflow = { GITHUB_REPOSITORY: plan.repository, GITHUB_REF: `refs/heads/${plan.branch}`, GITHUB_ACTOR: 'alexj11324',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '1234', GITHUB_EVENT_NAME: 'push', GITHUB_TOKEN: 'synthetic-test-token' }
test('published source guard requires completed same-source main CI and image without production-domain coupling', async () => {
  const requests = []
  const fetchRun = async (url, init) => {
    requests.push(String(url))
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, 'Bearer synthetic-test-token')
    const id = Number(String(url).split('/').at(-1))
    assert.ok([plan.ciRun, plan.imageRun].includes(id))
    return Response.json({ id, repository: { full_name: plan.repository }, path: id === plan.ciRun
      ? '.github/workflows/ui-policy.yml' : '.github/workflows/self-hosted-image.yml', head_sha: plan.source,
      head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' })
  }
  await publishedImageGuard(workflow, fetchRun)
  assert.equal(requests.length, 2)
  for (const mutation of [{ head_sha: 'b'.repeat(40) }, { status: 'in_progress' }, { conclusion: 'failure' },
    { head_branch: 'candidate' }, { event: 'workflow_dispatch' }, { path: '.github/workflows/other.yml' },
    { repository: { full_name: 'other/repo' } }]) {
    await assert.rejects(publishedImageGuard(workflow, async (url, init) => Response.json({ ...(await (await fetchRun(url, init)).json()), ...mutation })), /SOURCE_CI/)
  }
  for (const mutation of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_ACTOR: 'other' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }]) {
    await assert.rejects(publishedImageGuard({ ...workflow, ...mutation }, async () => { throw new Error('must not fetch') }))
  }
})

const imageRef = `ghcr.io/${plan.repository.toLowerCase()}@${plan.imageDigest}`
const image = { Id: plan.configDigest, RepoDigests: [imageRef], Config: {
  Labels: { 'org.opencontainers.image.revision': plan.source },
  Env: [`MIKKA_CLOUD_WORKER_SOURCE_COMMIT=${plan.source}`, `MIKKA_CLOUD_WORKER_SHA=${plan.workerHash}`] } }
test('final image rejects wrong identity, replaced runtime, observer injection and model credentials', () => {
  assert.equal(imageGuard(image).operatorConfiguredPins, false)
  for (const mutation of [{ Id: 'sha256:' + '0'.repeat(64) }, { RepoDigests: [imageRef.replace(plan.imageDigest, 'latest')] },
    { Config: { ...image.Config, Labels: { 'org.opencontainers.image.revision': 'b'.repeat(40) } } }]) {
    assert.throws(() => imageGuard({ ...image, ...mutation }))
  }
  for (const value of ['MIKKA_CLOUD_WORKER_SHA=' + 'b'.repeat(40), 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT=' + 'b'.repeat(40),
    'E2B_BYO_COMPUTER_TEMPLATE=candidate', 'MIKKA_CLOUD_WORKER_URL=https://example.invalid',
    'MIKKA_CLOUD_TEMPLATE_MODELS={}', 'NODE_OPTIONS=--import=/opt/observer.mjs', 'AI_GATEWAY_API_KEY=synthetic']) {
    assert.throws(() => imageGuard({ ...image, Config: { ...image.Config, Env: [...image.Config.Env, value] } }))
  }
})

test('fixture and running container require the unchanged image and only the data volume', () => {
  const app = { image: imageRef, volumes: ['data:/data'], environment: { MIKKA_EDITION: 'community' } }
  fixtureGuard(app)
  assert.throws(() => fixtureGuard({ ...app, volumes: [...app.volumes, '/tmp/gateway.py:/app/scripts/e2b/subagent-gateway.py:ro'] }))
  for (const key of ['MIKKA_CLOUD_WORKER_SHA', 'E2B_BYO_COMPUTER_TEMPLATE', 'NODE_OPTIONS', 'E2B_API_KEY', 'DECISIONS_API_KEY']) {
    assert.throws(() => fixtureGuard({ ...app, environment: { ...app.environment, [key]: '' } }))
  }
  const container = { Image: plan.configDigest, Config: image.Config, Mounts: [{ Type: 'volume', Destination: '/data', RW: true }] }
  containerGuard(container)
  assert.throws(() => containerGuard({ ...container, Image: 'different' }))
  assert.throws(() => containerGuard({ ...container, Mounts: [...container.Mounts, { Type: 'bind', Destination: '/app/script', RW: false }] }))
  assert.throws(() => containerGuard({ ...container, Config: { Env: [...image.Config.Env, 'MIKKA_CLOUD_WORKER_SHA=' + '0'.repeat(40)] } }))
})

test('final acceptance cannot pass with missing business evidence, incomplete cleanup or an extra VM', () => {
  const report = { status: 'passed', machineCount: 1, modelCalls: 0, hostedUsageRows: 0,
    checks: Object.fromEntries(['emailVerified', 'localEnvelopeEncrypted', 'listReturnsNoPassword', 'realSiteSubmitted',
      'normalAgentStop', 'actualGuardedBroker', 'agentAutomaticSavedLogin', 'logsContainNoPlaintext',
      'finalImageUnmodified', 'bakedWorkerUsed', 'noModelExecution'].map(name => [name, true])),
    cleanup: Object.fromEntries(['subagent', 'e2bConfirmedMissing', 'login', 'key', 'session', 'fixture', 'site', 'tunnels', 'privateFiles'].map(name => [name, true])) }
  assert.equal(finalImagePassed(report), true)
  for (const mutation of [{ checks: {} }, { cleanup: {} }, { machineCount: 2 }, { modelCalls: 1 }, { hostedUsageRows: 1 },
    { cleanup: { ...report.cleanup, e2bConfirmedMissing: false } }, { checks: { ...report.checks, bakedWorkerUsed: false } }]) {
    assert.equal(finalImagePassed({ ...report, ...mutation }), false)
  }
})

test('tunnel cleanup waits for process exit before acknowledging it', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: signal => {
    assert.equal(signal, 'SIGTERM'); queueMicrotask(() => { child.signalCode = signal; child.emit('exit') })
  } })
  await stopTunnel(child)
  assert.equal(child.signalCode, 'SIGTERM')
  await stopTunnel(child)
})
