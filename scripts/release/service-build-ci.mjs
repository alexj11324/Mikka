import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEnvironment, command, releaseId, verifyOverlayMain } from '../cloudflare-native-oci.mjs'
import { childEnvironment, withOverlayKey } from '../cloudflare-ci.mjs'
import { assertInputCoverage, buildContexts, registryImage, releaseManifest, serviceDigest, serviceNames, validateServiceManifest } from './service-builds.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const workflow = 'cloudflare-api-image.yml'
const repository = 'alexj11324/Mikka'
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const output = async (name, value) => { assert.ok(process.env.GITHUB_OUTPUT); await appendFile(process.env.GITHUB_OUTPUT, name + '=' + value + '\n') }

export function trustedBuildSource(env, event) {
  assert.equal(env.GITHUB_ACTIONS, 'true')
  assert.equal(env.GITHUB_REPOSITORY, repository)
  assert.equal(env.GITHUB_REPOSITORY_ID, '1427517699')
  assert.equal(env.GITHUB_ACTOR_ID, '183887963')
  assert.equal(env.GITHUB_ACTOR, 'alexj11324')
  assert.equal(env.GITHUB_TRIGGERING_ACTOR, 'alexj11324')
  // The existing protected publication environment only permits main. PR
  // qualification stays credential-free; do not simulate another event/ref.
  assert.equal(env.GITHUB_EVENT_NAME, 'push')
  assert.equal(env.GITHUB_REF, 'refs/heads/main')
  assert.equal(event.ref, 'refs/heads/main')
  const source = env.GITHUB_SHA
  assert.equal(event.after, source)
  assert.match(source ?? '', /^[a-f0-9]{40}$/)
  assert.equal(env.GITHUB_WORKFLOW_REF, repository + '/.github/workflows/' + workflow + '@' + env.GITHUB_REF)
  assert.match(env.GITHUB_WORKFLOW_SHA ?? '', /^[a-f0-9]{40}$/)
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA)
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] ?? '', /^[1-9][0-9]*$/)
  return source
}

async function source() {
  const revision = trustedBuildSource(process.env, await readJson(process.env.GITHUB_EVENT_PATH))
  assert.equal(git(['rev-parse', 'HEAD']), revision)
  git(['diff', '--quiet', 'HEAD', '--'])
  return revision
}

async function github(path, missing = false) {
  assert.ok(process.env.GH_TOKEN)
  const result = await fetch('https://api.github.com/repos/' + repository + '/' + path, { redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: 'Bearer ' + process.env.GH_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'mikka-service-build' } })
  if (missing && result.status === 404) { await result.body?.cancel(); return null }
  assert.equal(result.status, 200, 'GitHub build provenance unavailable')
  return result.json()
}

export function checkedServiceCache(name, receipt, run, jobs, artifact) {
  validateServiceManifest(name, receipt)
  assert.equal(receipt.build.workflow, workflow)
  for (const field of ['repository', 'head_repository']) {
    assert.equal(run[field]?.id, 1427517699)
    assert.equal(run[field].full_name, repository)
    assert.equal(run[field].private, false)
    assert.equal(run[field].fork, false)
  }
  assert.equal(run.path, '.github/workflows/' + workflow)
  assert.equal(run.event, 'push')
  assert.equal(run.head_branch, 'main')
  assert.equal(run.status, 'completed')
  assert.equal(run.actor?.id, 183887963)
  assert.equal(run.triggering_actor?.id, 183887963)
  assert.equal(run.head_sha, receipt.sourceCommit)
  assert.equal(String(run.id), receipt.build.runId)
  assert.equal(String(run.run_attempt), receipt.build.runAttempt)
  const selected = jobs.filter(job => job.name === 'service-build (' + name + ')')
  assert.equal(selected.length, 1)
  const [job] = selected
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success')
  assert.equal(String(job.run_id), receipt.build.runId); assert.equal(String(job.run_attempt), receipt.build.runAttempt)
  for (const step of ['Build and verify service', 'Publish immutable service image', 'Upload service artifact', 'Upload service cache receipt']) {
    assert.deepEqual(job.steps.filter(value => value.name === step).map(value => value.conclusion), ['success'])
  }
  assert.equal(String(artifact.id), receipt.build.artifactId)
  assert.equal(artifact.name, 'service-' + name + '-' + receipt.build.runId + '-' + receipt.build.runAttempt)
  assert.equal(artifact.expired, false)
  assert.equal(artifact.workflow_run?.id, run.id)
  assert.equal(artifact.workflow_run?.head_sha, receipt.sourceCommit)
  assert.equal(artifact.workflow_run?.repository_id, 1427517699)
  assert.equal(artifact.workflow_run?.head_repository_id, 1427517699)
  return receipt
}

async function readCacheArtifact(artifact) {
  assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128 * 1024)
  const link = await fetch('https://api.github.com/repos/' + repository + '/actions/artifacts/' + artifact.id + '/zip', {
    redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { authorization: 'Bearer ' + process.env.GH_TOKEN,
      accept: 'application/vnd.github+json', 'user-agent': 'mikka-service-build' } })
  assert.equal(link.status, 302)
  const target = new URL(link.headers.get('location'))
  assert.equal(target.protocol, 'https:'); assert.ok(!target.username && !target.password)
  assert.ok(target.hostname.endsWith('.blob.core.windows.net') || target.hostname.endsWith('.githubusercontent.com') || target.hostname.endsWith('.actions.githubusercontent.com'))
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(30000) })
  assert.equal(response.status, 200)
  const archive = Buffer.from(await response.arrayBuffer())
  assert.equal(archive.length, artifact.size_in_bytes); assert.equal(hash(archive), artifact.digest)
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'mikka-service-cache-'))
  try {
    const file = join(directory, 'receipt.zip'); await writeFile(file, archive, { mode: 0o600, flag: 'wx' })
    assert.deepEqual(execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 1024 }).trim().split('\n'), ['service-receipt.json'])
    return JSON.parse(execFileSync('unzip', ['-p', file, 'service-receipt.json'], { encoding: 'utf8', maxBuffer: 128 * 1024 }))
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function cachedService(name, context, image) {
  const artifactName = 'service-cache-' + name + '-' + context.contextDigest.slice(7)
  const { artifacts } = await github('actions/artifacts?per_page=100&name=' + artifactName)
  for (const artifact of artifacts) {
    if (artifact.name !== artifactName || artifact.expired || artifact.workflow_run?.repository_id !== 1427517699
      || artifact.workflow_run?.head_repository_id !== 1427517699) continue
    const origin = await github('actions/runs/' + artifact.workflow_run.id)
    if (origin.actor?.id !== 183887963 || origin.triggering_actor?.id !== 183887963
      || origin.path !== '.github/workflows/' + workflow || origin.event !== 'push' || origin.head_branch !== 'main') continue
    const receipt = await readCacheArtifact(artifact)
    if (receipt.contextDigest !== context.contextDigest || (context.kind === 'container' && receipt.imageDigest !== image?.imageDigest)) continue
    // A matching image built on an unmerged branch is not a main release source.
    try { git(['merge-base', '--is-ancestor', receipt.sourceCommit, 'HEAD']) }
    catch { continue }
    const path = 'actions/runs/' + receipt.build.runId + '/attempts/' + receipt.build.runAttempt
    assert.equal(String(artifact.workflow_run.id), receipt.build.runId)
    const run = await github(path)
    if (run.status !== 'completed') continue
    const { jobs } = await github(path + '/jobs?per_page=100')
    const original = await github('actions/artifacts/' + receipt.build.artifactId, true)
    if (!original || original.expired) continue
    checkedServiceCache(name, receipt, run, jobs, original)
    return { ...receipt, reused: true }
  }
  return null
}

async function plan(directory) {
  await source(); await assertInputCoverage()
  const context = await buildContexts({ overlayCommit: process.env.OVERLAY_SHA,
    publicSettings: JSON.parse(process.env.API_PUBLIC_BUILD_SETTINGS || '{}') })
  assert.match(context.overlayCommit ?? '', /^[a-f0-9]{40}$/)
  const matrix = [], cached = {}
  for (const name of serviceNames) {
    const next = context.services[name]
    let image = null
    if (next.kind === 'container') {
      image = await registryImage({ account: process.env.CLOUDFLARE_ACCOUNT_ID, repository: next.repository,
        contextDigest: next.contextDigest, username: process.env.CF_RUNTIME_REGISTRY_USERNAME, password: process.env.CF_RUNTIME_REGISTRY_PASSWORD })
    }
    const prior = next.kind === 'worker' || image ? await cachedService(name, next, image) : null
    if (prior) cached[name] = prior
    else matrix.push({ service: name })
    console.log(JSON.stringify({ service: name, contextDigest: next.contextDigest,
      result: prior ? 'exists: reuse' : image ? 'existing image lacks live original proof: rebuild' : 'build required' }))
  }
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'build-plan.json'), JSON.stringify(context) + '\n')
  await writeFile(join(directory, 'cached-services.json'), JSON.stringify(cached) + '\n')
  await output('matrix', JSON.stringify({ include: matrix }))
  await output('changed', String(matrix.length > 0))
  await output('litellm_reused', String(Boolean(cached.litellm)))
}

async function install(service, context) {
  if (['api', 'web'].includes(service)) {
    assert.match(context.overlayCommit ?? '', /^[a-f0-9]{40}$/)
    await withOverlayKey(process.env, async env => {
      const overlay = join(root, '.hosted-ui')
      command('git', ['init', '--quiet', overlay], { env, stage: 'OVERLAY_INIT' })
      command('git', ['fetch', '--quiet', '--no-tags', 'git@github.com:alexj11324/mikka-hosted-ui.git', context.overlayCommit], { cwd: overlay, env, stage: 'OVERLAY_FETCH' })
      command('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: overlay, env, stage: 'OVERLAY_CHECKOUT' })
      verifyOverlayMain(overlay, context.overlayCommit, env)
    })
  }
  const env = childEnvironment(process.env, context.sourceCommit, context.overlayCommit)
  command('corepack', ['pnpm', 'install', '--frozen-lockfile', ...(['task', 'world', 'litellm'].includes(service) ? ['--ignore-scripts'] : [])], { env, stage: 'SERVICE_INSTALL' })
  if (['api', 'web'].includes(service)) command('corepack', ['pnpm', '--dir', '.hosted-ui', 'install', '--ignore-workspace', '--prod', '--ignore-scripts', '--frozen-lockfile'], { env, stage: 'OVERLAY_INSTALL' })
  const local = { api: 'cloudflare/api/ingress', task: 'cloudflare/task-sandbox', litellm: 'cloudflare/litellm' }[service]
  if (local) command('npm', ['ci', '--ignore-scripts', '--prefix', local], { env, stage: 'WORKER_INSTALL' })
}

/** Docker sees only declared task inputs, including its image qualification test. */
export async function stageContext(directory, files, sourceDirectory = root) {
  await mkdir(directory, { recursive: true })
  for (const file of files) {
    assert.ok(!file.startsWith('/') && !file.split('/').includes('..'))
    await mkdir(dirname(join(directory, file)), { recursive: true })
    await cp(join(sourceDirectory, file), join(directory, file), { dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
  }
  return directory
}

async function bundle(directory, configPath, filename, env) {
  const configuration = resolve(root, configPath)
  const config = await readJson(configuration)
  const target = join(directory, 'bundle-' + basename(filename, '.mjs'))
  const spec = { name: 'mikka-service-build', main: resolve(dirname(configuration), config.main),
    compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    workers_dev: false, preview_urls: false }
  const configFile = join(directory, basename(filename) + '.json')
  await writeFile(configFile, JSON.stringify(spec))
  command('corepack', ['pnpm', 'exec', 'wrangler', 'deploy', '--dry-run', '--config', configFile, '--outdir', target], { env, stage: 'SERVICE_WORKER_BUNDLE' })
  const emitted = join(target, basename(spec.main).replace(/\.[^.]+$/, '.js'))
  await mkdir(dirname(join(directory, filename)), { recursive: true })
  await cp(emitted, join(directory, filename))
  await rm(configFile); await rm(target, { recursive: true })
}

async function build(service, planFile, directory) {
  const revision = await source(), context = await readJson(planFile), input = context.services[service]
  assert.ok(input && serviceNames.includes(service)); assert.equal(context.sourceCommit, revision)
  await install(service, context)
  await mkdir(directory, { recursive: true })
  const release = releaseId(revision, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT)
  const env = ['api', 'web'].includes(service) ? buildEnvironment(process.env, revision, context.overlayCommit, release)
    : { ...childEnvironment(process.env, revision, revision), NITRO_PRESET: 'node-server', WORKFLOW_TARGET_WORLD: '@workflow/world-postgres', MIKKA_DEPLOYMENT_ID: release, MIKKA_BUILD_BYOS_WORKER: '1' }
  if (!['api', 'web'].includes(service)) { delete env.MIKKA_UI_OVERLAY_DIR; delete env.MIKKA_UI_OVERLAY_SHA }
  const run = (bin, args, stage) => command(bin, args, { env, stage })
  const tag = 'mikka-' + service + ':' + input.contextDigest.slice(7)
  const artifacts = {}
  const artifact = async (name, path) => { artifacts[name] = { path, digest: hash(await readFile(join(directory, path))) } }
  if (service === 'api' || service === 'web') {
    run('node', ['scripts/build-subscription-worker.mjs'], 'SUBSCRIPTION_WORKER')
    run('corepack', ['pnpm', 'generate:agent-ui'], 'AGENT_UI')
    run('node', ['apps/frontend/scripts/build.mjs', 'web'], 'FRONTEND')
    run('node', ['scripts/release/hosted-ui.mjs', 'audit', 'apps/frontend/dist/web'], 'WEB_AUDIT')
  }
  if (service === 'api') {
    run('node', ['apps/api/scripts/build.mjs'], 'API')
    run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--load', '--build-context', 'release=' + join(root, '.output'),
      '--build-arg', 'MIKKA_BUILD_REVISION=' + revision, '--build-arg', 'MIKKA_UI_OVERLAY_SHA=' + context.overlayCommit,
      '--build-arg', 'MIKKA_DEPLOYMENT_ID=' + release, '--label', 'com.mikka.context=' + input.contextDigest,
      '-t', tag, '-f', 'cloudflare/api/Dockerfile', 'cloudflare/api'], 'API_IMAGE')
    const { ingressConfig } = await import('../../cloudflare/api/ingress/config.mjs')
    const configFile = join(directory, 'api-config.json')
    await writeFile(configFile, JSON.stringify(ingressConfig({ release, image: 'registry.cloudflare.com/' + '0'.repeat(32) + '/mikka-api@sha256:' + '0'.repeat(64), origin: 'https://mikka.invalid' })))
    await bundle(directory, configFile, 'workers/api-ingress.mjs', env)
    await rm(configFile)
    await artifact('ingress', 'workers/api-ingress.mjs')
    await cp(join(root, 'apps/api/generated/routes.json'), join(directory, 'routes.json'))
    await artifact('routes', 'routes.json')
  } else if (service === 'web') {
    const { prepareRelease, gatewayConfig } = await import('../../cloudflare/web/prepare.mjs')
    const prepared = await prepareRelease({ id: release, assets: join(root, 'apps/frontend/dist/web'), api: 'mikka-build-api', cloud: 'mikka-build-cloud', sourceSha: revision, overlaySha: context.overlayCommit }, directory)
    const configFile = join(directory, 'web-config.json')
    await writeFile(configFile, JSON.stringify(prepared))
    const packaged = join(directory, 'web-package'); await mkdir(packaged)
    await cp(prepared.assets.directory, join(packaged, 'site'), { recursive: true })
    await mkdir(join(packaged, 'proof')); await cp(join(root, 'apps/frontend/dist/web/renderer-manifest.json'), join(packaged, 'proof/renderer-manifest.json'))
    run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', join(directory, 'web.tar.gz'), '-C', packaged, 'site', 'proof'], 'WEB_ARCHIVE')
    await bundle(directory, configFile, 'workers/web.mjs', env)
    await artifact('assets', 'web.tar.gz'); await artifact('worker', 'workers/web.mjs')
    await writeFile(configFile, JSON.stringify(gatewayConfig({ current: release, retained: [release] })))
    await bundle(directory, configFile, 'workers/app-gateway.mjs', env)
    await artifact('gateway', 'workers/app-gateway.mjs')
    await rm(configFile); await rm(packaged, { recursive: true }); await rm(prepared.assets.directory, { recursive: true })
  } else if (service === 'eve') {
    run('node', ['scripts/build-subscription-worker.mjs'], 'SUBSCRIPTION_WORKER')
    run('bash', ['scripts/build-cloudflare-eve-image.sh', '--independent'], 'EVE_OFFLINE_COMPILE')
    run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--load', '--label', 'org.opencontainers.image.revision=' + revision,
      '--label', 'com.mikka.context=' + input.contextDigest, '-t', tag, '-f', 'cloudflare/eve-runtime/Dockerfile', '.'], 'EVE_IMAGE')
    await bundle(directory, 'cloudflare/eve-runtime/wrangler.jsonc', 'workers/eve-runtime.mjs', env)
    await artifact('worker', 'workers/eve-runtime.mjs')
  } else if (service === 'task') {
    const tests = (await readdir(join(root, 'cloudflare/task-sandbox'))).filter(file => file.endsWith('.test.mjs')).map(file => 'cloudflare/task-sandbox/' + file)
    run('node', ['--test', ...tests], 'TASK_TESTS')
    run('python3', ['cloudflare/task-sandbox/native-history.test.py'], 'TASK_HISTORY')
    const dockerContext = await stageContext(join(directory, 'docker-context'), input.files)
    run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--load', '--label', 'org.opencontainers.image.revision=' + revision,
      '--label', 'com.mikka.context=' + input.contextDigest, '-t', tag, '-f', join(dockerContext, 'cloudflare/task-sandbox/Dockerfile'), dockerContext], 'TASK_IMAGE')
    await rm(dockerContext, { recursive: true })
    run('bash', ['scripts/release/verify-task-image.sh', tag], 'TASK_VERIFY')
    await bundle(directory, 'cloudflare/task-sandbox/wrangler.jsonc', 'workers/task-sandbox.mjs', env)
    await artifact('worker', 'workers/task-sandbox.mjs')
  } else if (service === 'litellm') {
    run('docker', ['buildx', 'build', '--platform', 'linux/amd64', '--load', '--label', 'org.opencontainers.image.revision=' + revision,
      '--label', 'com.mikka.context=' + input.contextDigest, '-t', tag, 'deploy/litellm'], 'LITELLM_IMAGE')
    run('bash', ['deploy/litellm/offline-check.sh', tag], 'LITELLM_OFFLINE')
    run('bash', ['deploy/litellm/conversion-check.sh', tag], 'LITELLM_PROTOCOLS')
    await bundle(directory, 'cloudflare/litellm/wrangler.jsonc', 'workers/litellm.mjs', env)
    await artifact('worker', 'workers/litellm.mjs')
  } else {
    const outputDirectory = join(directory, 'modules')
    run('corepack', ['pnpm', 'exec', 'wrangler', 'deploy', '--dry-run', '--config', 'packages/eve-cloudflare-world/wrangler.jsonc', '--outdir', outputDirectory], 'WORLD_BUNDLE')
    await rm(join(outputDirectory, 'README.md'), { force: true })
    await writeFile(join(directory, 'source.txt'), revision + '\n')
    const files = []
    async function visit(path) {
      for (const item of await readdir(join(directory, path), { withFileTypes: true })) {
        const file = path + '/' + item.name
        if (item.isDirectory()) await visit(file)
        else { assert.ok(item.isFile()); files.push(file) }
      }
    }
    await visit('modules'); assert.ok(files.length)
    const checksums = []
    for (const file of [...files.sort(), 'source.txt']) checksums.push(hash(await readFile(join(directory, file))).slice(7) + '  ' + file)
    await writeFile(join(directory, 'SHA256SUMS'), checksums.join('\n') + '\n')
    await artifact('worker', 'SHA256SUMS')
  }
  const receipt = { service, kind: input.kind, contextDigest: input.contextDigest, sourceCommit: revision,
    overlayCommit: ['api', 'web'].includes(service) ? context.overlayCommit : null, release,
    artifacts, reused: false, build: { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, workflow },
    ...(input.kind === 'container' ? { localTag: tag, repository: input.repository } : {}) }
  if (input.kind === 'container') {
    receipt.localImageId = command('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { env, stage: 'SERVICE_IMAGE_ID', encoding: 'utf8' }).trim()
    assert.match(receipt.localImageId, /^sha256:[a-f0-9]{64}$/)
  }
  await writeFile(join(directory, 'service-receipt.json'), JSON.stringify(receipt) + '\n')
}

async function publish(directory) {
  await source()
  const path = join(directory, 'service-receipt.json'), receipt = await readJson(path)
  if (receipt.kind === 'container') {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID
    assert.match(account ?? '', /^[a-f0-9]{32}$/)
    const registryTag = 'registry.cloudflare.com/' + account + '/' + receipt.repository + ':' + receipt.contextDigest.slice(7)
    const config = await mkdtemp(join(process.env.RUNNER_TEMP, 'mikka-service-registry-'))
    const env = { ...childEnvironment(process.env, receipt.sourceCommit, receipt.overlayCommit ?? receipt.sourceCommit), DOCKER_CONFIG: config }
    try {
      command('docker', ['login', 'registry.cloudflare.com', '--username', process.env.CF_RUNTIME_REGISTRY_USERNAME, '--password-stdin'], { env, input: process.env.CF_RUNTIME_REGISTRY_PASSWORD, stage: 'SERVICE_REGISTRY_LOGIN' })
      command('docker', ['tag', receipt.localImageId, registryTag], { env, stage: 'SERVICE_REGISTRY_TAG' })
      command('docker', ['push', registryTag], { env, stage: 'SERVICE_REGISTRY_PUSH' })
      const image = await registryImage({ account, repository: receipt.repository, contextDigest: receipt.contextDigest,
        username: process.env.CF_RUNTIME_REGISTRY_USERNAME, password: process.env.CF_RUNTIME_REGISTRY_PASSWORD })
      assert.ok(image, 'Published image is absent from the registry')
      const refs = command('docker', ['image', 'inspect', registryTag, '--format', '{{json .RepoDigests}}'], { env, stage: 'SERVICE_REGISTRY_VERIFY', encoding: 'utf8' })
      assert.ok(JSON.parse(refs).includes(image.image), 'Registry digest differs from the built image')
      Object.assign(receipt, { image: image.image, imageDigest: image.imageDigest })
    } finally { await rm(config, { recursive: true, force: true }) }
    delete receipt.localTag; delete receipt.repository
  }
  await writeFile(path, JSON.stringify(receipt) + '\n')
}

async function finish(planDirectory, resultDirectory, destination) {
  await source()
  const context = await readJson(join(planDirectory, 'build-plan.json'))
  const cached = await readJson(join(planDirectory, 'cached-services.json'))
  const { artifacts } = await github('actions/runs/' + process.env.GITHUB_RUN_ID + '/artifacts?per_page=100')
  const published = { ...cached }
  for (const item of await readdir(resultDirectory, { withFileTypes: true })) {
    if (!item.isDirectory()) continue
    const receipt = await readJson(join(resultDirectory, item.name, 'service-receipt.json'))
    const name = receipt.service; assert.ok(serviceNames.includes(name) && !published[name])
    const matches = artifacts.filter(artifact => artifact.name === 'service-' + name + '-' + process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT && !artifact.expired)
    assert.equal(matches.length, 1)
    receipt.build.artifactId = String(matches[0].id)
    for (const artifact of Object.values(receipt.artifacts)) assert.equal(hash(await readFile(join(resultDirectory, item.name, artifact.path))), artifact.digest)
    delete receipt.service; published[name] = receipt
  }
  const manifest = releaseManifest(context, published)
  await writeFile(destination, JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ sourceCommit: manifest.sourceCommit, services: Object.fromEntries(Object.entries(manifest.services).map(([name, value]) => [name, { digest: value.digest, reused: value.reused }])) }))
}

async function recordCache(directory, destination, artifactId) {
  await source()
  assert.match(artifactId ?? '', /^[1-9][0-9]*$/)
  const receipt = await readJson(join(directory, 'service-receipt.json'))
  const name = receipt.service; delete receipt.service
  receipt.build.artifactId = artifactId
  receipt.digest = serviceDigest(receipt)
  validateServiceManifest(name, receipt)
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'service-receipt.json'), JSON.stringify(receipt) + '\n')
  await output('cache_name', 'service-cache-' + name + '-' + receipt.contextDigest.slice(7))
}

async function qualifyCachedLiteLlm(planDirectory, pull) {
  const revision = await source()
  const receipt = (await readJson(join(planDirectory, 'cached-services.json'))).litellm
  validateServiceManifest('litellm', receipt)
  const env = childEnvironment(process.env, revision, revision)
  if (pull) {
    const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'mikka-qualification-registry-'))
    const dockerEnv = { ...env, DOCKER_CONFIG: directory }
    try {
      command('docker', ['login', 'registry.cloudflare.com', '--username', process.env.CF_RUNTIME_REGISTRY_USERNAME, '--password-stdin'],
        { env: dockerEnv, input: process.env.CF_RUNTIME_REGISTRY_PASSWORD, stage: 'QUALIFICATION_REGISTRY_LOGIN' })
      command('docker', ['pull', '--platform', 'linux/amd64', receipt.image], { env: dockerEnv, stage: 'QUALIFICATION_IMAGE_PULL' })
      const local = command('docker', ['image', 'inspect', receipt.image, '--format', '{{.Id}}'], { env: dockerEnv, encoding: 'utf8', stage: 'QUALIFICATION_IMAGE_ID' }).trim()
      assert.equal(local, receipt.localImageId, 'Qualification must use the originally built platform image')
    } finally { await rm(directory, { recursive: true, force: true }) }
    return
  }
  command('corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], { env, stage: 'QUALIFICATION_INSTALL' })
  command('bash', ['deploy/litellm/offline-check.sh', receipt.image], { env, stage: 'LITELLM_OFFLINE' })
  command('bash', ['deploy/litellm/conversion-check.sh', receipt.image], { env, stage: 'LITELLM_PROTOCOLS' })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2)
  if (action === 'plan') await plan(...args)
  else if (action === 'build') await build(...args)
  else if (action === 'publish') await publish(...args)
  else if (action === 'finish') await finish(...args)
  else if (action === 'record-cache') await recordCache(...args)
  else if (action === 'qualify-pull') await qualifyCachedLiteLlm(args[0], true)
  else if (action === 'qualify') await qualifyCachedLiteLlm(args[0], false)
  else throw new Error('Usage: service-build-ci.mjs plan | build | publish | finish | record-cache | qualify-pull | qualify')
}
