import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDeploymentId } from '../lib/deployment-id.mjs'
import { childEnvironment, sourceContext, validateReceipt, withOverlayKey } from './cloudflare-ci.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA = /^[a-f0-9]{40}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const ACCOUNT = /^[a-f0-9]{32}$/
const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const git = (cwd, ...args) => stdout('git', args, { cwd, stage: 'SOURCE_CHECKOUT', timeout: 30000 })

export function releaseId(publicSha, runId, runAttempt) {
  if (!SHA.test(publicSha) || !/^[1-9][0-9]*$/.test(runId ?? '') || !/^[1-9][0-9]*$/.test(runAttempt ?? '')) fail('CF_OCI_RELEASE_ID_INVALID')
  return buildDeploymentId({ sha: publicSha, runId, runAttempt })
}

export function releaseSelection(env, receipt) {
  const context = sourceContext(env, env.GITHUB_SHA, env.OVERLAY_SHA)
  validateReceipt(receipt, context)
  return { context, publicSha: context.publicSha, privateSha: context.privateSha,
    id: releaseId(context.publicSha, context.runId, context.runAttempt) }
}

export function buildEnvironment(env, publicSha, privateSha, id) {
  let settings
  try { settings = JSON.parse(env.API_PUBLIC_BUILD_SETTINGS) }
  catch { fail('CF_OCI_PUBLIC_BUILD_SETTINGS_REQUIRED') }
  const mandatory = ['NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY']
  const names = [...mandatory, 'NEXT_PUBLIC_COMPUTER_ENABLED']
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).length !== names.length
      || names.some(name => typeof settings[name] !== 'string')) fail('CF_OCI_PUBLIC_BUILD_SETTINGS_REQUIRED')
  for (const key of mandatory) if (!settings[key] || /[\r\n]/.test(settings[key])) fail('CF_OCI_PUBLIC_BUILD_VALUE_REQUIRED')
  if (!/^pk_(?:live|test)_/.test(settings.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)) fail('CF_OCI_STRIPE_PUBLIC_KEY_INVALID')
  if (!['0', '1'].includes(settings.NEXT_PUBLIC_COMPUTER_ENABLED)) fail('CF_OCI_COMPUTER_BUILD_SETTING_INVALID')
  return {
    ...childEnvironment(env, publicSha, privateSha),
    MIKKA_EDITION: 'cloud', MIKKA_DEPLOYMENT_STAGE: 'production', MIKKA_DEPLOYMENT_ENVIRONMENT: 'production',
    MIKKA_BUILD_BYOS_WORKER: '1', NITRO_PRESET: 'node-server',
    MIKKA_UI_OVERLAY_DIR: '.hosted-ui',
    MIKKA_DEPLOYMENT_ID: id, NEXT_PUBLIC_POSTHOG_KEY: settings.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: settings.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: settings.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    NEXT_PUBLIC_COMPUTER_ENABLED: settings.NEXT_PUBLIC_COMPUTER_ENABLED,
  }
}

export function command(bin, args, options = {}) {
  const { cwd = root, env = process.env, stage, ...rest } = options
  if (!/^[A-Z][A-Z0-9_]*$/.test(stage ?? '')) fail('CF_OCI_STAGE_REQUIRED')
  const started = Date.now()
  console.log('MIKKA_CF_OCI_STAGE=' + JSON.stringify({ stage, status: 'started' }))
  let output
  try {
    output = execFileSync(bin, args, { cwd, env, timeout: 900000, maxBuffer: 16 * 1024 * 1024, ...rest, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error) {
    console.error('MIKKA_CF_OCI_STAGE=' + JSON.stringify({ stage, status: 'failed', elapsedMs: Date.now() - started, exit: error.status ?? null,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : null }))
    fail('CF_OCI_STAGE_' + stage + '_FAILED')
  }
  console.log('MIKKA_CF_OCI_STAGE=' + JSON.stringify({ stage, status: 'passed', elapsedMs: Date.now() - started }))
  return output
}

export function buildProduct(work, env) {
  const commands = [
    ['SUBSCRIPTION_WORKER', 'node', ['scripts/build-subscription-worker.mjs']],
    ['AGENT_UI', 'corepack', ['pnpm', 'generate:agent-ui']],
    ['FRONTEND', 'node', ['apps/frontend/scripts/build.mjs', 'web']],
    ['API', 'node', ['apps/api/scripts/build.mjs']],
  ]
  for (const [stage, bin, args] of commands) command(bin, args, { cwd: work, env, stage })
}


function stdout(bin, args, options = {}) {
  return command(bin, args, { encoding: 'utf8', timeout: 60000, ...options }).trim()
}

export function digestFromRepoDigests(raw, account, id) {
  if (!ACCOUNT.test(account) || typeof raw !== 'string') fail('CF_OCI_DIGEST_INPUT_INVALID')
  const prefix = 'registry.cloudflare.com/' + account + '/mikka-api@'
  const digests = [...new Set(raw.split(/\s+/).filter(item => item.startsWith(prefix)).map(item => item.slice(prefix.length)))]
  if (digests.length !== 1 || !DIGEST.test(digests[0])) fail('CF_OCI_REGISTRY_DIGEST_UNVERIFIED')
  return { digest: digests[0], image: prefix + digests[0], release: id }
}

function assertCurrentRefs(receipt, current) {
  if (current.publicSha !== receipt.publicSha || current.privateSha !== receipt.privateSha) fail('CF_OCI_MAIN_ADVANCED')
}

export function validatePrepared(record, selection) {
  if (!record || record.version !== 1 || record.publication !== 'none'
      || record.context?.provider !== selection.context.provider
      || record.context?.buildId !== selection.context.buildId
      || record.publicSha !== selection.publicSha || record.privateSha !== selection.privateSha
      || record.id !== selection.id || !DIGEST.test(record.localImageId ?? '')
      || record.offlineVerification !== 'buildkit-network-none'
      || !/^[a-f0-9]{64}$/.test(record.webRenderer ?? '')) fail('CF_OCI_PREPARED_MISMATCH')
  for (const [name, value] of Object.entries(selection.context)) if (record.context?.[name] !== value) fail('CF_OCI_PREPARED_MISMATCH')
  if (record.publicBuildSettings?.publicSha !== selection.publicSha || record.publicBuildSettings?.privateSha !== selection.privateSha
      || record.publicBuildSettings?.publication !== 'registry-only'
      || hash(JSON.stringify(record.publicBuildSettings)) !== record.publicBuildSettingsSha256) fail('CF_OCI_PUBLIC_BUILD_SETTINGS_MISMATCH')
  validateArtifacts(record)
  return record
}

export function validateArtifacts(record) {
  if (!DIGEST.test(record?.workerDigest ?? '') || !/^[a-f0-9]{64}$/.test(record?.webArchiveSha256 ?? '')
      || !Number.isSafeInteger(record?.webArchiveBytes) || record.webArchiveBytes <= 0) fail('CF_OCI_ARTIFACTS_INVALID')
  return { workerDigest: record.workerDigest, webArchiveSha256: record.webArchiveSha256, webArchiveBytes: record.webArchiveBytes }
}

export function releaseDockerfile(source) {
  return source + '\nCOPY --from=artifacts --chown=node:node / /mikka-release/\n'
    + 'RUN --network=none MIKKA_BUILD_REVISION="$MIKKA_BUILD_REVISION" MIKKA_UI_OVERLAY_SHA="$MIKKA_UI_OVERLAY_SHA" MIKKA_DEPLOYMENT_ID="$MIKKA_DEPLOYMENT_ID" node start.mjs verify-image\n'
}

async function prepareArtifacts(work, selected, env, webRenderer) {
  const output = await mkdtemp(join(root, '.cloudflare-ci/release-'))
  const artifacts = join(output, 'artifacts')
  await mkdir(artifacts)
  const { prepareRelease } = await import(pathToFileURL(join(work, 'cloudflare/web/prepare.mjs')).href)
  const build = join(work, 'apps/frontend/dist/web')
  const prepared = await prepareRelease({ id: selected.id, assets: build,
    api: 'mikka-api-staging-' + selected.id, cloud: 'mikka-cloud-services-staging',
    sourceSha: selected.publicSha, overlaySha: selected.privateSha }, output)
  const input = await mkdtemp(join(output, 'site-package-'))
  await rename(prepared.assets.directory, join(input, 'site'))
  await mkdir(join(input, 'proof'))
  await copyFile(join(build, 'renderer-manifest.json'), join(input, 'proof/renderer-manifest.json'))
  const archive = join(artifacts, 'web.tar.gz')
  command('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '-czf', archive, '-C', input, 'site', 'proof'], { cwd: work, env, stage: 'WEB_ARCHIVE' })

  command('npm', ['ci', '--prefix', 'cloudflare/api/ingress', '--ignore-scripts'], { cwd: work, env, stage: 'INGRESS_INSTALL' })
  // This image selector is used only for Wrangler's dry run and never deployed.
  const placeholder = 'registry.cloudflare.com/' + '0'.repeat(32) + '/mikka-api@sha256:' + '0'.repeat(64)
  const config = join(output, 'ingress.json')
  command('node', ['cloudflare/api/ingress/config.mjs', config, selected.id, placeholder, 'https://app.aspectlylabs.com'], { cwd: work, env, stage: 'INGRESS_CONFIG' })
  const bundle = join(output, 'worker')
  command('corepack', ['pnpm', 'exec', 'wrangler', 'deploy', '--config', config, '--dry-run', '--outdir', bundle], { cwd: work, env, stage: 'INGRESS_BUNDLE' })
  const worker = await readFile(join(bundle, 'worker.js'))
  if (worker.includes(placeholder)) fail('CF_OCI_INGRESS_PLACEHOLDER_EMBEDDED')
  await writeFile(join(artifacts, 'ingress.mjs'), worker)
  const metadata = { publicSha: selected.publicSha, privateSha: selected.privateSha,
    buildId: selected.context.buildId, release: selected.id, webRenderer,
    workerDigest: 'sha256:' + hash(worker), webArchiveSha256: hash(await readFile(archive)), webArchiveBytes: (await stat(archive)).size }
  validateArtifacts(metadata)
  await writeFile(join(artifacts, 'release.json'), JSON.stringify(metadata) + '\n')
  const dockerfile = join(output, 'Dockerfile')
  await writeFile(dockerfile, releaseDockerfile(await readFile(join(work, 'cloudflare/api/Dockerfile'), 'utf8')))
  return { artifacts, dockerfile, metadata }
}

export async function readSelection(env) {
  const receipt = JSON.parse(await readFile(join(root, '.cloudflare-ci/receipt.json'), 'utf8'))
  const selected = releaseSelection(env, receipt)
  validateReceipt(receipt, selected.context)
  if (git(root, 'rev-parse', 'HEAD') !== selected.publicSha
      || git(join(root, '.hosted-ui'), 'rev-parse', 'HEAD') !== selected.privateSha) fail('CF_OCI_CHECKOUT_DRIFT')
  return { receipt, selected }
}

export async function currentRefs(env = process.env) {
  const line = stdout('git', ['ls-remote', 'origin', 'refs/heads/main'], { stage: 'PUBLIC_MAIN_REF' })
  const publicSha = /^([a-f0-9]{40})\s+refs\/heads\/main$/.exec(line)?.[1]
  const privateLine = await withOverlayKey(env, keyEnv => stdout('git', ['ls-remote', 'git@github.com:alexj11324/mikka-hosted-ui.git', 'refs/heads/main'], { env: keyEnv, stage: 'PRIVATE_MAIN_REF' }))
  const privateSha = /^([a-f0-9]{40})\s+refs\/heads\/main$/.exec(privateLine)?.[1]
  if (!publicSha || !privateSha) fail('CF_OCI_MAIN_UNAVAILABLE')
  return { publicSha, privateSha }
}

async function prepare() {
  const { selected } = await readSelection(process.env)
  const current = await currentRefs()
  assertCurrentRefs(selected, current)
  const env = buildEnvironment(process.env, selected.publicSha, selected.privateSha, selected.id)
  const publicBuildSettings = { publicSha: selected.publicSha, privateSha: selected.privateSha, publication: 'registry-only',
    NEXT_PUBLIC_POSTHOG_KEY: env.NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, NEXT_PUBLIC_COMPUTER_ENABLED: env.NEXT_PUBLIC_COMPUTER_ENABLED }
  const publicBuildSettingsSha256 = hash(JSON.stringify(publicBuildSettings))
  const work = root
  buildProduct(work, env)
  command('node', ['scripts/release/hosted-ui.mjs', 'audit', 'apps/frontend/dist/web'], { cwd: work, env, stage: 'WEB_AUDIT' })
  const evidence = JSON.parse(await readFile(join(work, '.output/mikka-build.json'), 'utf8'))
  if (evidence.preset !== 'node-server' || evidence.revision !== selected.publicSha
      || evidence.overlaySha !== selected.privateSha || evidence.deploymentId !== selected.id) fail('CF_OCI_APP_BUILD_MISMATCH')
  const manifest = JSON.parse(await readFile(join(work, 'apps/frontend/dist/web/renderer-manifest.json'), 'utf8'))
  if (!/^[a-f0-9]{64}$/.test(manifest.rendererBuild ?? '') || manifest.serverModules?.length) fail('CF_OCI_RENDERER_INVALID')
  const payload = await prepareArtifacts(work, selected, env, manifest.rendererBuild)
  const tag = 'mikka-api:' + selected.id
  command('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--load',
    '--build-context', 'release=' + join(work, '.output'),
    '--build-context', 'artifacts=' + payload.artifacts,
    '--build-arg', 'MIKKA_BUILD_REVISION=' + selected.publicSha,
    '--build-arg', 'MIKKA_UI_OVERLAY_SHA=' + selected.privateSha,
    '--build-arg', 'MIKKA_DEPLOYMENT_ID=' + selected.id,
    '-t', tag, '-f', payload.dockerfile, join(work, 'cloudflare/api')], { cwd: work, env, stage: 'DOCKER_IMAGE' })
  const imageId = stdout('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { env, stage: 'DOCKER_IMAGE_ID' })
  if (!DIGEST.test(imageId)) fail('CF_OCI_LOCAL_IMAGE_ID_INVALID')
  assertCurrentRefs(selected, await currentRefs())
  await readSelection(process.env)
  const result = { version: 1, context: selected.context, publicSha: selected.publicSha, privateSha: selected.privateSha,
    id: selected.id, tag, localImageId: imageId, webRenderer: manifest.rendererBuild, publicBuildSettings, publicBuildSettingsSha256,
    ...validateArtifacts(payload.metadata), offlineVerification: 'buildkit-network-none', publication: 'none' }
  await writeFile(join(root, '.cloudflare-ci/oci-prepared.json'), JSON.stringify(result) + '\n', { mode: 0o600 })
  console.log('MIKKA_CF_OCI_PREPARED=' + JSON.stringify({ publicSha: result.publicSha, privateSha: result.privateSha, buildId: selected.context.buildId,
    release: result.id, localImageId: result.localImageId, webRenderer: result.webRenderer,
    ...validateArtifacts(result), offlineVerification: result.offlineVerification, publication: 'none' }))
}

export function publicReceipt(receipt) {
  const result = { ...receipt }
  delete result.publicBuildSettings
  return result
}

async function publish() {
  const { selected } = await readSelection(process.env)
  const data = JSON.parse(await readFile(join(root, '.cloudflare-ci/oci-prepared.json'), 'utf8'))
  const record = validatePrepared(data, selected)
  if (!ACCOUNT.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '')) fail('CF_OCI_ACCOUNT_REQUIRED')
  assertCurrentRefs(selected, await currentRefs())
  const registry = 'registry.cloudflare.com/' + process.env.CLOUDFLARE_ACCOUNT_ID
  if (!process.env.CF_RUNTIME_REGISTRY_USERNAME || !process.env.CF_RUNTIME_REGISTRY_PASSWORD
      || !process.env.RUNNER_TEMP) fail('CF_OCI_REGISTRY_CREDENTIALS_REQUIRED')
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'mikka-api-registry-'))
  const dockerEnv = { ...childEnvironment(process.env, selected.publicSha, selected.privateSha), DOCKER_CONFIG: directory }
  try {
    command('docker', ['login', 'registry.cloudflare.com', '--username', process.env.CF_RUNTIME_REGISTRY_USERNAME, '--password-stdin'],
      { env: dockerEnv, input: process.env.CF_RUNTIME_REGISTRY_PASSWORD, stdio: ['pipe', 'pipe', 'pipe'], stage: 'REGISTRY_LOGIN' })
    command('docker', ['tag', record.localImageId, registry + '/' + record.tag], { env: dockerEnv, stage: 'REGISTRY_TAG' })
    command('docker', ['push', registry + '/' + record.tag], { env: dockerEnv, stage: 'REGISTRY_PUSH' })
    const refs = stdout('docker', ['image', 'inspect', registry + '/' + record.tag, '--format', '{{range .RepoDigests}}{{println .}}{{end}}'], { env: dockerEnv, stage: 'REGISTRY_DIGEST' })
    const verified = digestFromRepoDigests(refs, process.env.CLOUDFLARE_ACCOUNT_ID, selected.id)
    assertCurrentRefs(selected, await currentRefs())
    const receipt = { version: 1, ...selected.context, ...verified,
      overlayCheckout: { repository: 'alexj11324/mikka-hosted-ui', requestedSha: selected.privateSha, actualSha: selected.privateSha },
      localImageId: record.localImageId, webRenderer: record.webRenderer,
      ...validateArtifacts(record), publicBuildSettings: record.publicBuildSettings, publicBuildSettingsSha256: record.publicBuildSettingsSha256,
      offlineVerification: record.offlineVerification, publication: 'registry-only', production: false }
    await writeFile(join(root, '.cloudflare-ci/api-image-receipt.json'), JSON.stringify(receipt) + '\n', { mode: 0o600 })
    console.log('MIKKA_GITHUB_API_OCI_RECEIPT=' + JSON.stringify(publicReceipt(receipt)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const action = process.argv[2]
    if (action === 'prepare') await prepare()
    else if (action === 'publish') await publish()
    else fail('CF_OCI_ACTION_INVALID')
  } catch (error) {
    console.error(/^CF_OCI_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'CF_OCI_OPERATION_FAILED')
    process.exitCode = 1
  }
}
