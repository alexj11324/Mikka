import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { childEnvironment, sourceContext, validateReceipt, withOverlayKey } from './cloudflare-ci.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA = /^[a-f0-9]{40}$/
const BUILD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const ACCOUNT = /^[a-f0-9]{32}$/
const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const git = (cwd, ...args) => stdout('git', args, { cwd, stage: 'SOURCE_CHECKOUT', timeout: 30000 })

export function releaseId(publicSha, buildUUID) {
  if (!SHA.test(publicSha) || !BUILD_ID.test(buildUUID)) fail('CF_OCI_RELEASE_ID_INVALID')
  const run = BigInt('0x' + buildUUID.replaceAll('-', '').slice(0, 12)).toString(10)
  const id = publicSha.slice(0, 12) + '-' + run + '-1'
  if (id.length > 32) fail('CF_OCI_RELEASE_ID_TOO_LONG')
  return id
}

export function releaseSelection(env, receipt, { publish = false } = {}) {
  const sourceSha = env.WORKERS_CI_COMMIT_SHA
  const context = sourceContext(env, sourceSha, env.MIKKA_CF_RELEASE_OVERLAY_SHA)
  if (context.provider !== 'cloudflare-workers-builds' || context.branch !== 'main'
      || !BUILD_ID.test(context.buildId)) fail('CF_OCI_TRUSTED_MAIN_REQUIRED')
  if (receipt?.version !== 1 || receipt.publication !== 'none' || receipt.target !== 'native-api'
      || !SHA.test(receipt.publicSha ?? '') || !SHA.test(context.privateSha ?? '')
      || receipt.publicSha !== context.publicSha
      || receipt.context?.privateSha !== context.privateSha
      || receipt.context?.buildId !== context.buildId
      || receipt.context?.branch !== 'main') fail('CF_OCI_SOURCE_RECEIPT_MISMATCH')
  if (env.MIKKA_CF_RELEASE_PUBLIC_SHA !== receipt.publicSha
      || env.MIKKA_CF_RELEASE_OVERLAY_SHA !== context.privateSha) fail('CF_OCI_OPERATOR_SELECTION_MISMATCH')
  if (publish && env.MIKKA_CF_RELEASE_MODE !== 'registry-only') fail('CF_OCI_EXPLICIT_PUBLICATION_REQUIRED')
  return { context, publicSha: receipt.publicSha, privateSha: context.privateSha, id: releaseId(receipt.publicSha, context.buildId) }
}

export function buildEnvironment(env, publicSha, privateSha, id) {
  const mandatory = ['NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY']
  for (const key of mandatory) if (!env[key] || /[\r\n]/.test(env[key])) fail('CF_OCI_PUBLIC_BUILD_VALUE_REQUIRED')
  if (!/^pk_(?:live|test)_/.test(env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)) fail('CF_OCI_STRIPE_PUBLIC_KEY_INVALID')
  if (!['0', '1'].includes(env.NEXT_PUBLIC_COMPUTER_ENABLED)) fail('CF_OCI_COMPUTER_BUILD_SETTING_INVALID')
  return {
    ...childEnvironment(env, publicSha, privateSha),
    MIKKA_EDITION: 'cloud', MIKKA_DEPLOYMENT_STAGE: 'production', MIKKA_DEPLOYMENT_ENVIRONMENT: 'production',
    MIKKA_BUILD_BYOS_WORKER: '1', NITRO_PRESET: 'node-server',
    MIKKA_UI_OVERLAY_DIR: '.hosted-ui',
    MIKKA_DEPLOYMENT_ID: id, NEXT_PUBLIC_POSTHOG_KEY: env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    NEXT_PUBLIC_COMPUTER_ENABLED: env.NEXT_PUBLIC_COMPUTER_ENABLED,
  }
}

export function redactOutput(value, env) {
  // oxlint-disable-next-line no-control-regex -- Strip ANSI escape sequences from subprocess diagnostics.
  let output = String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  output = output
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*[^\r\n]+/gi, '[REDACTED HEADER]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/(\b(?:[A-Za-z0-9_]*(?:token|secret|password|api[_-]?key|credential)[A-Za-z0-9_]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/(\bNEXT_PUBLIC_COMPUTER_ENABLED["']?\s*(?:[:=,]|\b(?:was|is|expected|received)\b)\s*["']?)[01]\b/gi, '$1[REDACTED]')
    .replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, '://[REDACTED]@')
  const values = Object.entries(env).filter(([name, value]) => name !== 'NEXT_PUBLIC_COMPUTER_ENABLED'
    && /NEXT_PUBLIC_|TOKEN|SECRET|PASSWORD|KEY|AUTH|COOKIE|CREDENTIAL/i.test(name)
    && typeof value === 'string' && value).flatMap(([, value]) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length)
  for (const value of values) output = output.split(value).join('[REDACTED]')
  // oxlint-disable-next-line no-control-regex -- Remove nonprinting bytes from subprocess diagnostics.
  return output.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(-6000)
}

export function command(bin, args, options = {}) {
  const { cwd = root, env = process.env, stage, ...rest } = options
  if (!/^[A-Z][A-Z0-9_]*$/.test(stage ?? '')) fail('CF_OCI_STAGE_REQUIRED')
  console.log('MIKKA_CF_OCI_STAGE=' + JSON.stringify({ stage, status: 'started' }))
  let output
  try {
    output = execFileSync(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000, maxBuffer: 16 * 1024 * 1024, ...rest })
  } catch (error) {
    const detail = redactOutput(String(error.stdout ?? '') + '\n' + String(error.stderr ?? ''), { ...process.env, ...env })
    console.error('MIKKA_CF_OCI_STAGE=' + JSON.stringify({ stage, status: 'failed', exit: error.status ?? null,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : null, detail }))
    fail('CF_OCI_STAGE_' + stage + '_FAILED')
  }
  console.log('MIKKA_CF_OCI_STAGE=' + JSON.stringify({ stage, status: 'passed' }))
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
    id: selected.id, tag, localImageId: imageId, webRenderer: manifest.rendererBuild,
    ...validateArtifacts(payload.metadata), offlineVerification: 'buildkit-network-none', publication: 'none' }
  await writeFile(join(root, '.cloudflare-ci/oci-prepared.json'), JSON.stringify(result) + '\n', { mode: 0o600 })
  console.log('MIKKA_CF_OCI_PREPARED=' + JSON.stringify({ publicSha: result.publicSha, privateSha: result.privateSha, buildId: selected.context.buildId,
    release: result.id, localImageId: result.localImageId, webRenderer: result.webRenderer,
    ...validateArtifacts(result), offlineVerification: result.offlineVerification, publication: 'none' }))
}

async function publish() {
  const { selected } = await readSelection(process.env)
  releaseSelection(process.env, JSON.parse(await readFile(join(root, '.cloudflare-ci/receipt.json'), 'utf8')), { publish: true })
  const data = JSON.parse(await readFile(join(root, '.cloudflare-ci/oci-prepared.json'), 'utf8'))
  const record = validatePrepared(data, selected)
  if (!ACCOUNT.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '')) fail('CF_OCI_ACCOUNT_REQUIRED')
  assertCurrentRefs(selected, await currentRefs())
  const registry = 'registry.cloudflare.com/' + process.env.CLOUDFLARE_ACCOUNT_ID
  const dockerEnv = childEnvironment(process.env, selected.publicSha, selected.privateSha)
  command('docker', ['tag', record.localImageId, registry + '/' + record.tag], { env: dockerEnv, stage: 'REGISTRY_TAG' })
  // Wrangler authenticates with the Cloudflare Workers Builds deploy token, not GitHub Actions/OIDC.
  const publishEnv = { ...dockerEnv, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID }
  command('corepack', ['pnpm', 'exec', 'wrangler', 'containers', 'push', record.tag], { cwd: root, env: publishEnv, stage: 'REGISTRY_PUSH' })
  const refs = stdout('docker', ['image', 'inspect', registry + '/' + record.tag, '--format', '{{range .RepoDigests}}{{println .}}{{end}}'], { env: dockerEnv, stage: 'REGISTRY_DIGEST' })
  const verified = digestFromRepoDigests(refs, process.env.CLOUDFLARE_ACCOUNT_ID, selected.id)
  assertCurrentRefs(selected, await currentRefs())
  console.log('MIKKA_CF_OCI_RECEIPT=' + JSON.stringify({ version: 1, provider: selected.context.provider, ...verified,
    overlayCheckout: { repository: 'alexj11324/mikka-hosted-ui', requestedSha: selected.privateSha, actualSha: selected.privateSha },
    publicSha: selected.publicSha, privateSha: selected.privateSha, buildId: selected.context.buildId,
    localImageId: record.localImageId, webRenderer: record.webRenderer,
    ...validateArtifacts(record), offlineVerification: record.offlineVerification, publication: 'registry-only', production: false }))
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
