import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { childEnvironment } from './cloudflare-ci.mjs'
import { command, releaseId, validateArtifacts } from './cloudflare-native-oci.mjs'
import { hasGitHubOrigin } from './cloudflare-source.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = /^[a-f0-9]{40}$/
const digest = /^sha256:[a-f0-9]{64}$/
const workflows = { eve: 'cloudflare-eve-image.yml', task: 'cloudflare-task-sandbox.yml' }
const repositories = { eve: 'mikka-eve', task: 'mikka-native-task' }
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const output = (bin, args, options) => command(bin, args, { ...options, encoding: 'utf8' }).trim()

export function releaseIdentity(env, workload, api) {
  assert.ok(Object.hasOwn(workflows, workload))
  assert.equal(env.GITHUB_REPOSITORY, 'alexj11324/Mikka')
  assert.equal(env.GITHUB_REPOSITORY_ID, '1427517699')
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(env.GITHUB_REF, 'refs/heads/main')
  assert.match(env.GITHUB_SHA ?? '', sha)
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA)
  assert.equal(env.GITHUB_ACTOR, 'alexj11324')
  assert.equal(env.GITHUB_ACTOR_ID, '183887963')
  assert.equal(env.GITHUB_TRIGGERING_ACTOR, 'alexj11324')
  assert.equal(env.GITHUB_WORKFLOW_REF, 'alexj11324/Mikka/.github/workflows/' + workflows[workload] + '@refs/heads/main')
  for (const value of [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT]) assert.match(value ?? '', /^[1-9][0-9]*$/)
  assert.equal(api.version, 1)
  assert.equal(api.provider, 'github-actions')
  assert.equal(api.repository, 'alexj11324/Mikka')
  assert.equal(api.repositoryId, '1427517699')
  assert.equal(api.ref, 'refs/heads/main')
  assert.equal(api.workflowRef, 'alexj11324/Mikka/.github/workflows/cloudflare-api-image.yml@refs/heads/main')
  assert.equal(api.workflowSha, api.publicSha)
  assert.equal(api.actor, 'alexj11324')
  assert.equal(api.actorId, '183887963')
  assert.equal(api.triggeringActor, 'alexj11324')
  assert.equal(api.publication, 'registry-only')
  assert.equal(api.production, false)
  assert.equal(api.publicSha, env.GITHUB_SHA)
  assert.equal(api.privateSha, env.OVERLAY_SHA)
  assert.match(api.privateSha, sha)
  for (const name of ['runId', 'runAttempt']) assert.match(api[name] ?? '', /^[1-9][0-9]*$/)
  assert.equal(api.runId, env.API_RUN_ID)
  assert.equal(api.runAttempt, env.API_RUN_ATTEMPT)
  assert.equal(api.buildId, api.runId + '-' + api.runAttempt)
  assert.equal(api.release, releaseId(api.publicSha, api.runId, api.runAttempt))
  assert.match(api.digest, digest)
  assert.equal(api.digest, env.API_IMAGE_DIGEST)
  assert.match(api.localImageId, digest)
  assert.match(api.webRenderer, /^[a-f0-9]{64}$/)
  validateArtifacts(api)
  assert.match(api.publicBuildSettingsSha256 ?? '', /^[a-f0-9]{64}$/)
  assert.equal(createHash('sha256').update(JSON.stringify(api.publicBuildSettings)).digest('hex'), api.publicBuildSettingsSha256)
  assert.equal(api.publicBuildSettings.publicSha, api.publicSha)
  assert.equal(api.publicBuildSettings.privateSha, api.privateSha)
  assert.equal(api.publicBuildSettings.publication, 'registry-only')
  assert.match(api.image, /^registry\.cloudflare\.com\/[a-f0-9]{32}\/mikka-api@sha256:[a-f0-9]{64}$/)
  assert.equal(api.image.split('@')[1], api.digest)
  assert.deepEqual(api.overlayCheckout, { repository: 'alexj11324/mikka-hosted-ui', requestedSha: api.privateSha, actualSha: api.privateSha })
  assert.equal(api.offlineVerification, 'buildkit-network-none')
  return { version: 1, provider: 'github-actions', repository: env.GITHUB_REPOSITORY, workload,
    publicSha: api.publicSha, overlaySha: api.privateSha, apiProvider: api.provider, apiRunId: api.runId,
    apiRunAttempt: api.runAttempt, apiBuildId: api.buildId, apiImage: api.image,
    release: api.release, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT }
}

export function checkedResource(resource) {
  const path = resource?.path
  assert.ok(typeof path === 'string' && path.length > 0 && !posix.isAbsolute(path) && posix.normalize(path) === path)
  // Only portable relative files may be restored beneath the disposable API output.
  // oxlint-disable-next-line no-control-regex -- Reject control bytes in restored resource paths.
  assert.ok(!path.includes('\\') && !/[\u0000-\u001f\u007f]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git' && part !== '.env' && !part.startsWith('.env.')))
  assert.ok(Number.isSafeInteger(resource.bytes) && resource.bytes >= 0)
  assert.match(resource.sha256 ?? '', /^[a-f0-9]{64}$/)
  return path
}

export function verifyApiPayload(api, release, app) {
  for (const field of ['publicSha', 'privateSha', 'buildId', 'release', 'webRenderer', 'workerDigest', 'webArchiveSha256', 'webArchiveBytes']) {
    assert.deepEqual(release[field], api[field], 'API supplemental identity differs')
  }
  assert.equal(app.version, 1)
  assert.equal(app.revision, api.publicSha)
  assert.equal(app.overlaySha, api.privateSha)
  assert.equal(app.deploymentId, api.release)
  assert.equal(app.preset, 'node-server')
  assert.ok(Array.isArray(app.resources) && app.resources.length > 0)
  const paths = app.resources.map(checkedResource)
  assert.equal(new Set(paths).size, paths.length, 'duplicate API resource')
  return app.resources
}

export async function verifyResources(directory, resources) {
  const canonical = await realpath(directory)
  for (const resource of resources) {
    const path = join(directory, checkedResource(resource))
    assert.ok((await realpath(path)).startsWith(canonical + '/'), 'API resource escapes the output')
    assert.ok((await lstat(path)).isFile(), 'API resource must be a regular file')
    const bytes = await readFile(path)
    assert.equal(bytes.length, resource.bytes)
    assert.equal(hash(bytes), 'sha256:' + resource.sha256, 'API resource bytes differ')
  }
}

export async function registryGraph(reference, localImageId, read) {
  const rootBytes = await read(reference, 'manifest')
  const rootDigest = hash(rootBytes)
  assert.equal(rootDigest, reference.split('@')[1])
  let manifest = JSON.parse(rootBytes)
  assert.equal(manifest.schemaVersion, 2)
  let imageManifest = rootDigest
  if (Array.isArray(manifest.manifests)) {
    assert.ok(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(manifest.mediaType))
    const matches = manifest.manifests.filter(value => value.platform?.os === 'linux' && value.platform.architecture === 'amd64'
      && !value.artifactType && value.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest')
    assert.equal(matches.length, 1)
    const selected = matches[0]
    assert.match(selected.digest, digest)
    const bytes = await read(reference.split('@')[0] + '@' + selected.digest, 'manifest')
    assert.equal(bytes.length, selected.size)
    assert.equal(hash(bytes), selected.digest)
    imageManifest = selected.digest
    manifest = JSON.parse(bytes)
  }
  assert.equal(manifest.schemaVersion, 2)
  assert.ok(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(manifest.mediaType))
  assert.match(manifest.config?.digest ?? '', digest)
  assert.ok(['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'].includes(manifest.config.mediaType))
  const configBytes = await read(reference.split('@')[0] + '@' + manifest.config.digest, 'config')
  assert.equal(hash(configBytes), manifest.config.digest)
  assert.equal(configBytes.length, manifest.config.size)
  const config = JSON.parse(configBytes)
  assert.equal(config.os, 'linux')
  assert.equal(config.architecture, 'amd64')
  assert.ok([rootDigest, imageManifest, manifest.config.digest].includes(localImageId), 'tested image differs from Registry graph')
  return { rootDigest, imageManifest, imageConfig: manifest.config.digest, config }
}

function registryReader(env) {
  assert.ok(env.CF_RUNTIME_REGISTRY_USERNAME && env.CF_RUNTIME_REGISTRY_PASSWORD)
  return async (reference, kind) => {
    const match = /^registry\.cloudflare\.com\/([a-f0-9]{32}\/mikka-[a-z0-9-]+)@(sha256:[a-f0-9]{64})$/.exec(reference)
    assert.ok(match)
    const response = await fetch('https://registry.cloudflare.com/v2/' + match[1] + '/' + (kind === 'config' ? 'blobs/' : 'manifests/') + match[2], {
      redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Basic ' + Buffer.from(env.CF_RUNTIME_REGISTRY_USERNAME + ':' + env.CF_RUNTIME_REGISTRY_PASSWORD).toString('base64'),
        Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' },
    })
    assert.equal(response.status, 200, 'Registry metadata read failed')
    return Buffer.from(await response.arrayBuffer())
  }
}

async function githubEnvironment(env, values) {
  assert.ok(env.GITHUB_ENV)
  for (const [name, value] of Object.entries(values)) {
    assert.ok(typeof value === 'string' && !/[\r\n]/.test(value))
    await appendFile(env.GITHUB_ENV, name + '=' + value + '\n')
  }
}

function identity(env, workload) {
  const api = JSON.parse(env.MIKKA_API_RECEIPT)
  const receipt = releaseIdentity(env, workload, api)
  const tools = { ...childEnvironment(env, receipt.publicSha, receipt.overlaySha), DOCKER_CONFIG: env.DOCKER_CONFIG }
  assert.equal(output('git', ['rev-parse', 'HEAD'], { env: tools, stage: 'RUNTIME_SOURCE' }), receipt.publicSha)
  assert.ok(hasGitHubOrigin(output('git', ['remote', 'get-url', 'origin'], { env: tools, stage: 'RUNTIME_ORIGIN' }), 'alexj11324/Mikka'))
  assert.equal(output('git', ['diff', '--name-only', 'HEAD', '--'], { env: tools, stage: 'RUNTIME_CLEAN_SOURCE' }), '')
  const main = output('git', ['ls-remote', 'origin', 'refs/heads/main'], { env: tools, stage: 'RUNTIME_MAIN_SOURCE' })
  assert.equal(main.split(/\s+/)[0], receipt.publicSha, 'public main advanced')
  return { api, receipt, tools }
}

async function prepare(env, workload) {
  const { api, receipt, tools } = identity(env, workload)
  const directory = await mkdtemp(join(env.RUNNER_TEMP, 'mikka-runtime-registry-'))
  tools.DOCKER_CONFIG = directory
  await githubEnvironment(env, { DOCKER_CONFIG: directory })
  command('docker', ['login', 'registry.cloudflare.com', '--username', env.CF_RUNTIME_REGISTRY_USERNAME, '--password-stdin'],
    { env: tools, input: env.CF_RUNTIME_REGISTRY_PASSWORD, stdio: ['pipe', 'pipe', 'pipe'], stage: 'RUNTIME_REGISTRY_LOGIN' })
  const graph = await registryGraph(api.image, api.localImageId, registryReader(env))
  assert.equal(graph.config.config?.Labels?.['org.opencontainers.image.revision'], api.publicSha)
  if (workload === 'eve') {
    command('docker', ['pull', '--platform', 'linux/amd64', api.image], { env: tools, stage: 'RUNTIME_API_PULL' })
    const container = output('docker', ['create', '--platform', 'linux/amd64', api.image], { env: tools, stage: 'RUNTIME_API_CREATE' })
    try {
      const destination = join(root, '.output')
      await mkdir(destination)
      command('docker', ['cp', container + ':/app/mikka-build.json', join(destination, 'mikka-build.json')], { env: tools, stage: 'RUNTIME_API_MANIFEST' })
      command('docker', ['cp', container + ':/mikka-release/release.json', join(directory, 'release.json')], { env: tools, stage: 'RUNTIME_API_IDENTITY' })
      const app = JSON.parse(await readFile(join(destination, 'mikka-build.json'), 'utf8'))
      const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))
      const resources = verifyApiPayload(api, release, app)
      for (const resource of resources) {
        const target = join(destination, resource.path)
        await mkdir(dirname(target), { recursive: true })
        command('docker', ['cp', container + ':/app/' + resource.path, target], { env: tools, stage: 'RUNTIME_API_RESOURCE' })
        await verifyResources(destination, [resource])
      }
    } finally { command('docker', ['rm', container], { env: tools, stage: 'RUNTIME_API_REMOVE' }) }
  }
  await githubEnvironment(env, { MIKKA_BUILD_REVISION: receipt.publicSha, NEXT_PUBLIC_MIKKA_BUILD: receipt.publicSha,
    MIKKA_UI_OVERLAY_SHA: receipt.overlaySha, MIKKA_DEPLOYMENT_ID: receipt.release,
    MIKKA_EDITION: 'cloud', MIKKA_DEPLOYMENT_STAGE: 'production', MIKKA_DEPLOYMENT_ENVIRONMENT: 'production', NITRO_PRESET: 'node-server' })
}

export async function packagePrebuiltEve(env, work = root) {
  const app = JSON.parse(await readFile(join(work, '.output/mikka-build.json'), 'utf8'))
  assert.equal(app.revision, env.MIKKA_BUILD_REVISION)
  assert.equal(app.overlaySha, env.MIKKA_UI_OVERLAY_SHA)
  assert.equal(app.deploymentId, env.MIKKA_DEPLOYMENT_ID)
  await verifyResources(join(work, '.output'), app.resources)
  const { packageCloudflareEveHost } = await import('./package-cf-eve-host.mjs')
  return packageCloudflareEveHost({ root: work, sourceSha: app.revision, uiSha: app.overlaySha, releaseId: app.deploymentId, uiSource: 'official' })
}

async function publish(env, workload) {
  const { api, receipt, tools } = identity(env, workload)
  const tag = repositories[workload] + ':' + receipt.release
  const image = JSON.parse(output('docker', ['image', 'inspect', tag, '--format', '{{json .}}'], { env: tools, stage: 'RUNTIME_TESTED_IMAGE' }))
  assert.match(env.RUNTIME_TESTED_IMAGE_ID ?? '', digest)
  assert.equal(image.Id, env.RUNTIME_TESTED_IMAGE_ID)
  const labels = { 'org.opencontainers.image.revision': receipt.publicSha, 'com.mikka.overlay': receipt.overlaySha, 'com.mikka.release': receipt.release }
  for (const [name, value] of Object.entries(labels)) assert.equal(image.Config.Labels[name], value)
  const name = api.image.split('/mikka-api@')[0] + '/' + repositories[workload]
  command('docker', ['tag', image.Id, name + ':' + receipt.release], { env: tools, stage: 'RUNTIME_REGISTRY_TAG' })
  command('docker', ['push', name + ':' + receipt.release], { env: tools, stage: 'RUNTIME_REGISTRY_PUSH' })
  const refs = JSON.parse(output('docker', ['image', 'inspect', name + ':' + receipt.release, '--format', '{{json .RepoDigests}}'], { env: tools, stage: 'RUNTIME_REGISTRY_DIGEST' }))
  const matches = [...new Set(refs.filter(value => value.startsWith(name + '@')))]
  assert.equal(matches.length, 1)
  const reference = matches[0]
  const graph = await registryGraph(reference, image.Id, registryReader(env))
  for (const [key, value] of Object.entries(labels)) assert.equal(graph.config.config?.Labels?.[key], value)
  const result = { ...receipt, localImageId: image.Id, reference, registryDigest: graph.rootDigest,
    offlineVerification: 'docker-network-none', publication: 'registry-only', production: false }
  await writeFile(join(env.RUNNER_TEMP, 'runtime-' + workload + '-receipt.json'), JSON.stringify(result) + '\n', { mode: 0o600 })
  console.log('MIKKA_GITHUB_RUNTIME_OCI_RECEIPT=' + JSON.stringify(result))
}

async function cleanup(env) {
  if (!env.DOCKER_CONFIG) return
  const path = resolve(env.DOCKER_CONFIG)
  assert.ok(path.startsWith(resolve(env.RUNNER_TEMP) + '/mikka-runtime-registry-'))
  await rm(path, { recursive: true, force: true })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'prepare') await prepare(process.env, process.argv[3])
    else if (process.argv[2] === 'publish') await publish(process.env, process.argv[3])
    else if (process.argv[2] === 'package-prebuilt-eve') await packagePrebuiltEve(process.env)
    else if (process.argv[2] === 'cleanup') await cleanup(process.env)
    else assert.fail('unknown runtime release operation')
  } catch (error) {
    const location = /cloudflare-runtime-release\.mjs:(\d+:\d+)/.exec(error.stack ?? '')?.[1]
    console.error('RUNTIME_RELEASE_FAILED', { name: error.name, code: error.code, location })
    process.exitCode = 1
  }
}
