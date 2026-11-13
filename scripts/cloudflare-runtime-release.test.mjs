import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { packageEve } from './package-eve.mjs'
import { checkedResource, packagePrebuiltEve, registryGraph, releaseIdentity, verifyApiPayload, verifyResources } from './cloudflare-runtime-release.mjs'

const publicSha = 'a'.repeat(40), overlaySha = 'b'.repeat(40)
const runId = '80001', runAttempt = '1', buildId = runId + '-' + runAttempt
const release = 'aaaaaaaaaaaa-80001-1'
const imageDigest = 'sha256:' + 'c'.repeat(64)
const api = { version: 1, provider: 'github-actions', repository: 'alexj11324/Mikka', repositoryId: '1427517699', ref: 'refs/heads/main',
  workflowRef: 'alexj11324/Mikka/.github/workflows/cloudflare-api-image.yml@refs/heads/main', workflowSha: publicSha,
  actor: 'alexj11324', actorId: '183887963', triggeringActor: 'alexj11324', runId, runAttempt, publicSha, privateSha: overlaySha,
  buildId, release, digest: imageDigest, localImageId: 'sha256:' + 'd'.repeat(64),
  image: 'registry.cloudflare.com/' + 'e'.repeat(32) + '/mikka-api@' + imageDigest,
  overlayCheckout: { repository: 'alexj11324/mikka-hosted-ui', requestedSha: overlaySha, actualSha: overlaySha },
  webRenderer: 'f'.repeat(64), workerDigest: 'sha256:' + '1'.repeat(64), webArchiveSha256: '2'.repeat(64), webArchiveBytes: 123,
  workerBundles: {
    apiIngress: { path: 'ingress.mjs', sha256: '1'.repeat(64), bytes: 120 },
    eveRuntime: { path: 'workers/eve-runtime.mjs', sha256: '3'.repeat(64), bytes: 220 },
    taskSandbox: { path: 'workers/task-sandbox.mjs', sha256: '4'.repeat(64), bytes: 320 },
    web: { path: 'workers/web.mjs', sha256: '5'.repeat(64), bytes: 420 },
    credentialIdentity: { path: 'workers/credential-identity.mjs', sha256: '6'.repeat(64), bytes: 520 },
    credentialBroker: { path: 'workers/credential-broker.mjs', sha256: '7'.repeat(64), bytes: 620 },
    appGateway: { path: 'workers/app-gateway.mjs', sha256: '8'.repeat(64), bytes: 720 },
  },
  offlineVerification: 'buildkit-network-none', publication: 'registry-only', production: false }
api.publicBuildSettings = { publicSha, privateSha: overlaySha, publication: 'registry-only', NEXT_PUBLIC_POSTHOG_KEY: 'public-analytics',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_public', NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'public-turnstile', NEXT_PUBLIC_COMPUTER_ENABLED: '1' }
api.publicBuildSettingsSha256 = createHash('sha256').update(JSON.stringify(api.publicBuildSettings)).digest('hex')
const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REPOSITORY_ID: '1427517699',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: publicSha,
  GITHUB_WORKFLOW_SHA: publicSha, GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/cloudflare-eve-image.yml@refs/heads/main',
  GITHUB_ACTOR: 'alexj11324', GITHUB_ACTOR_ID: '183887963', GITHUB_TRIGGERING_ACTOR: 'alexj11324',
  GITHUB_RUN_ID: '90001', GITHUB_RUN_ATTEMPT: '2', API_RUN_ID: runId, API_RUN_ATTEMPT: runAttempt, API_IMAGE_DIGEST: imageDigest, OVERLAY_SHA: overlaySha }
const bytes = Buffer.from('accepted resource bytes\n')
const digestOf = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const resource = { path: 'lib/resource.txt', bytes: bytes.length, sha256: digestOf(bytes).slice(7) }

test('manual publication binds the genuine public workflow run to the accepted API source pair', () => {
  const result = releaseIdentity(env, 'eve', api)
  assert.equal(result.runId, '90001')
  assert.equal(result.runAttempt, '2')
  assert.equal(result.apiBuildId, buildId)
  assert.equal(result.apiProvider, 'github-actions')
  assert.equal(result.apiRunId, runId)
  assert.equal(result.apiRunAttempt, runAttempt)
  assert.equal(result.release, release)
  for (const patch of [{ GITHUB_REPOSITORY: 'alexj11324/mikka-hosted-ui' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_WORKFLOW_SHA: overlaySha }, { GITHUB_SHA: overlaySha },
    { GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/another.yml@refs/heads/main' },
    { API_IMAGE_DIGEST: 'sha256:' + '3'.repeat(64) }, { API_RUN_ID: 'another' }, { API_RUN_ATTEMPT: '2' }, { OVERLAY_SHA: publicSha },
    { GITHUB_RUN_ID: 'not-a-run' }]) assert.throws(() => releaseIdentity({ ...env, ...patch }, 'eve', api))
  for (const patch of [{ publication: 'none' }, { production: true }, { provider: 'cloudflare-workers-builds' }, { runAttempt: '2' }, { actorId: '1' }, { workflowSha: overlaySha },
    { publicBuildSettingsSha256: '0'.repeat(64) },
    { publicBuildSettings: { ...api.publicBuildSettings, NEXT_PUBLIC_COMPUTER_ENABLED: '0' } },
    { overlayCheckout: { ...api.overlayCheckout, actualSha: publicSha } }, { image: api.image.replace('/mikka-api@', '/another@') }]) {
    assert.throws(() => releaseIdentity(env, 'eve', { ...api, ...patch }))
  }
})

test('prebuilt API resources require matching supplemental metadata and portable unique paths', () => {
  const app = { version: 1, revision: publicSha, overlaySha, deploymentId: release, preset: 'node-server', resources: [resource] }
  assert.deepEqual(verifyApiPayload(api, api, app), [resource])
  assert.throws(() => verifyApiPayload(api, { ...api, buildId: 'another' }, app))
  assert.throws(() => verifyApiPayload(api, { ...api, workerBundles: { ...api.workerBundles,
    web: { ...api.workerBundles.web, sha256: '0'.repeat(64) } } }, app))
  assert.throws(() => verifyApiPayload(api, api, { ...app, revision: overlaySha }))
  assert.throws(() => verifyApiPayload(api, api, { ...app, resources: [resource, resource] }))
  for (const path of ['../escape', '/etc/passwd', 'lib/../../escape', 'lib//resource', '.env', 'lib/.env.local', '.git/config', 'lib\\escape', 'lib/\0bad']) {
    assert.throws(() => checkedResource({ ...resource, path }))
  }
})

test('restored resources reject altered bytes, file links and escaping parent links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-runtime-resource-'))
  try {
    const output = join(directory, 'output')
    await mkdir(join(output, 'lib'), { recursive: true })
    await writeFile(join(output, resource.path), bytes)
    await verifyResources(output, [resource])
    await writeFile(join(output, resource.path), 'changed')
    await assert.rejects(verifyResources(output, [resource]))
    await rm(join(output, resource.path))
    await writeFile(join(directory, 'outside'), bytes)
    await symlink(join(directory, 'outside'), join(output, resource.path))
    await assert.rejects(verifyResources(output, [resource]))
    await rm(join(output, 'lib'), { recursive: true })
    await symlink(directory, join(output, 'lib'))
    await assert.rejects(verifyResources(output, [{ ...resource, path: 'lib/outside' }]))
    assert.deepEqual(await readFile(join(directory, 'outside')), bytes)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

function imageGraph() {
  const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', config: { Labels: {
    'org.opencontainers.image.revision': publicSha, 'com.mikka.overlay': overlaySha, 'com.mikka.release': release,
  } } }))
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: digestOf(config), size: config.length, mediaType: 'application/vnd.oci.image.config.v1+json' }, layers: [] }))
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{ digest: digestOf(manifest), size: manifest.length, mediaType: 'application/vnd.oci.image.manifest.v1+json', platform: { os: 'linux', architecture: 'amd64' } }] }))
  const records = new Map([[digestOf(index), index], [digestOf(manifest), manifest], [digestOf(config), config]])
  const reference = 'registry.cloudflare.com/' + 'e'.repeat(32) + '/mikka-eve@' + digestOf(index)
  return { config, manifest, index, reference, records }
}

test('Registry proof checks exact root, selected amd64 manifest and configuration bytes across Docker ID classes', async () => {
  const graph = imageGraph()
  const read = async reference => graph.records.get(reference.split('@')[1])
  for (const id of [digestOf(graph.config), digestOf(graph.manifest), digestOf(graph.index)]) {
    const result = await registryGraph(graph.reference, id, read)
    assert.equal(result.imageConfig, digestOf(graph.config))
    assert.equal(result.imageManifest, digestOf(graph.manifest))
  }
  await assert.rejects(registryGraph(graph.reference, imageDigest, read))
  await assert.rejects(registryGraph(graph.reference, digestOf(graph.config), async reference => {
    const value = await read(reference)
    return value === graph.config ? Buffer.from('altered config') : value
  }))
})

test('prebuilt packaging carries accepted API resource bytes into the official Eve host without an overlay checkout', async () => {
  const work = await mkdtemp(join(tmpdir(), 'mikka-prebuilt-eve-'))
  try {
    await mkdir(join(work, '.output/lib'), { recursive: true })
    await writeFile(join(work, '.output', resource.path), bytes)
    await writeFile(join(work, '.output/mikka-build.json'), JSON.stringify({ version: 1, revision: publicSha, overlaySha,
      deploymentId: release, preset: 'node-server', resources: [resource] }))
    await mkdir(join(work, 'apps/eve/.output/server'), { recursive: true })
    await writeFile(join(work, 'apps/eve/.output/server/index.mjs'), 'export default {}\n')
    await writeFile(join(work, 'apps/eve/.output/mikka-eve-build.json'), JSON.stringify({ version: 1, eve: '1.0.0-rc.9',
      revision: publicSha, preset: 'node-server', world: '@mikka/eve-cloudflare-world', worldVersion: '5.1.0' }))
    await cp(new URL('../cloudflare/eve-runtime/runtime', import.meta.url), join(work, 'cloudflare/eve-runtime/runtime'), { recursive: true })
    await packageEve({ root: work, preset: 'node-server' })
    await packagePrebuiltEve({ MIKKA_BUILD_REVISION: publicSha, MIKKA_UI_OVERLAY_SHA: overlaySha, MIKKA_DEPLOYMENT_ID: release }, work)
    assert.deepEqual(await readFile(join(work, '.output/cf-eve/eve', resource.path)), bytes)
    assert.deepEqual(JSON.parse(await readFile(join(work, '.output/cf-eve/eve-host.json'), 'utf8')), { version: 1,
      sourceSha: publicSha, uiSha: overlaySha, releaseId: release, uiSource: 'official' })
    await assert.rejects(readFile(join(work, '.hosted-ui/package.json')), { code: 'ENOENT' })
  } finally { await rm(work, { recursive: true, force: true }) }
})


test('runtime workflow callers pass genuine API run identity and keep the Registry username unmasked', async () => {
  for (const name of ['cloudflare-eve-image.yml', 'cloudflare-task-sandbox.yml']) {
    const workflow = await readFile(new URL('../.github/workflows/' + name, import.meta.url), 'utf8')
    assert.ok(workflow.includes('api_run_id:'))
    assert.ok(workflow.includes('api_run_attempt:'))
    assert.ok(workflow.includes('API_RUN_ID: ${{ inputs.api_run_id }}'))
    assert.ok(workflow.includes('API_RUN_ATTEMPT: ${{ inputs.api_run_attempt }}'))
    assert.ok(workflow.includes('node scripts/load-cloudflare-api-receipt.mjs'))
    assert.ok(!workflow.includes('secrets.MIKKA_API_RECEIPT'))
    assert.ok(workflow.includes('CF_RUNTIME_REGISTRY_USERNAME: ${{ vars.CF_RUNTIME_REGISTRY_USERNAME }}'))
    assert.ok(!workflow.includes('api_build_uuid'))
    assert.ok(!workflow.includes('secrets.CF_RUNTIME_REGISTRY_USERNAME'))
  }
})


test('the genuine main driver can compile the original accepted API source after main advances', () => {
  const driverSource = 'd'.repeat(40)
  const result = releaseIdentity({...env,GITHUB_SHA:driverSource,GITHUB_WORKFLOW_SHA:driverSource,RUNTIME_SOURCE_SHA:publicSha},'eve',api)
  assert.equal(result.publicSha,publicSha)
  assert.equal(result.driverSource,driverSource)
  assert.equal(result.apiRunId,runId)
  assert.throws(()=>releaseIdentity({...env,RUNTIME_SOURCE_SHA:overlaySha},'eve',api))
  assert.throws(()=>releaseIdentity({...env,GITHUB_REF:'refs/tags/mikka-release-'+publicSha},'eve',api))
})
