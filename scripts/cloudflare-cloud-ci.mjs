import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hasGitHubOrigin } from './cloudflare-source.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = 'alexj11324/Mikka'
const privateRepository = 'alexj11324/mikka-cloud'
const workflowRef = `${repository}/.github/workflows/cloud-services-ci.yml@refs/heads/main`
const fullSha = /^[a-f0-9]{40}$/
const stages = [
  'platform', 'github-source-download',
  'submodule', 'install-private', 'install-public', 'browser-install', 'browser-platform', 'ops-python', 'ops-contracts',
  'typecheck-core', 'typecheck-models', 'typecheck-ui', 'postgres17-core-models-and-eve',
  'vercel-build', 'vercel-startup', 'browser-capture',
  'node-build', 'artifact-check', 'worker-dry-run', 'docker-build', 'image-postgres-runtime',
  'current-public-postgres17',
]
const fail = code => { throw new Error(code) }
const git = (cwd, ...args) => gitWithEnv(cwd, process.env, args)
const gitWithEnv = (cwd, env, args) => execFileSync('git', args, {
  cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
}).trim()
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

function hasOrigin(directory, expected) {
  return hasGitHubOrigin(git(directory, 'remote', 'get-url', 'origin'), expected)
}

export function sourceContext(env, publicSource) {
  if (env.GITHUB_ACTIONS !== 'true') fail('CLOUD_PUBLIC_CI_PROVIDER_REQUIRED')
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REPOSITORY_ID !== '1427517699') fail('CLOUD_PUBLIC_CI_REPOSITORY_REQUIRED')
  if (!fullSha.test(publicSource) || env.GITHUB_SHA !== publicSource || env.GITHUB_WORKFLOW_SHA !== publicSource) fail('CLOUD_PUBLIC_CI_SOURCE_MISMATCH')
  if (!fullSha.test(env.MIKKA_CLOUD_SOURCE_SHA ?? '')) fail('CLOUD_PUBLIC_CI_PRIVATE_PIN_REQUIRED')
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
      env.GITHUB_REF_NAME !== 'main' || env.GITHUB_WORKFLOW_REF !== workflowRef) fail('CLOUD_PUBLIC_CI_WORKFLOW_REQUIRED')
  if (env.GITHUB_ACTOR_ID !== '183887963') fail('CLOUD_PUBLIC_CI_ACTOR_REQUIRED')
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) fail('CLOUD_PUBLIC_CI_BUILD_ID_REQUIRED')
  return {
    provider: 'github-actions', repository, publicSource,
    privateSource: env.MIKKA_CLOUD_SOURCE_SHA,
    branch: 'main', ref: env.GITHUB_REF, workflowRef, workflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, actorId: env.GITHUB_ACTOR_ID,
    buildId: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  }
}

export function verifyPublicReceipt(receipt, context) {
  const { privateSource, ...publicContext } = context
  const innerContext = { ...publicContext, sha: privateSource }
  if (!exactKeys(receipt, ['version', 'context', 'publicMainCompatibilitySha', 'stages', 'artifactSha256',
    'databaseIntegration', 'imageRuntimeExecutor', 'publication', 'qualifiedArtifact']) || receipt.version !== 1 || receipt.publication !== 'none' ||
      !exactKeys(receipt.context, Object.keys(innerContext)) || Object.keys(innerContext).some(key => receipt.context[key] !== innerContext[key])) fail('CLOUD_PUBLIC_CI_RECEIPT_SOURCE_MISMATCH')
  if (!fullSha.test(receipt.publicMainCompatibilitySha ?? '') || !/^[a-f0-9]{64}$/.test(receipt.artifactSha256 ?? '') ||
      receipt.databaseIntegration !== 'isolated-postgresql-17-core-models-and-eve' || receipt.imageRuntimeExecutor !== 'image-files-node24' ||
      !Array.isArray(receipt.stages) || receipt.stages.length !== stages.length ||
      stages.some((name, index) => !exactKeys(receipt.stages[index], ['name', 'exit']) || receipt.stages[index].name !== name || receipt.stages[index].exit !== 0)) fail('CLOUD_PUBLIC_CI_RECEIPT_INVALID')
  verifyQualifiedArtifact(receipt.qualifiedArtifact, context)
  return receipt
}

export function verifyQualifiedArtifact(artifact, context) {
  if (!exactKeys(artifact, ['privateSource', 'modelSource', 'publicSource', 'runId', 'runAttempt', 'workerDigest', 'githubWebhookDigest', 'localImageId', 'manifestSha256']) ||
      artifact.privateSource !== context.privateSource || artifact.publicSource !== context.publicSource ||
      artifact.runId !== context.runId || artifact.runAttempt !== context.runAttempt || !fullSha.test(artifact.modelSource ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.localImageId ?? '') ||
      ![artifact.workerDigest, artifact.githubWebhookDigest, artifact.manifestSha256].every(value => /^[a-f0-9]{64}$/.test(value ?? ''))) fail('CLOUD_PUBLIC_CI_ARTIFACT_INVALID')
  return artifact
}

export function verifyPublishedArtifact(artifact, receipt, context) {
  const { image, reference, registryDigest, ...qualified } = artifact ?? {}
  verifyQualifiedArtifact(qualified, context)
  if (Object.keys(qualified).some(key => qualified[key] !== receipt.qualifiedArtifact[key]) || image !== reference ||
      !/^registry\.cloudflare\.com\/d8f6630c7869111a5139bc5ed4d24ace\/mikka-cloud-services@sha256:[a-f0-9]{64}$/.test(reference ?? '') ||
      reference.split('@')[1] !== registryDigest) fail('CLOUD_PUBLIC_CI_PUBLICATION_INVALID')
  return artifact
}

export async function runCloudCi({ env = process.env, verify = false, publish = false, publicRoot = root } = {}) {
  verify ||= publish
  publicRoot = await realpath(publicRoot)
  if (git(publicRoot, 'rev-parse', '--show-toplevel') !== publicRoot || !hasOrigin(publicRoot, repository)) fail('CLOUD_PUBLIC_CI_REPOSITORY_REQUIRED')
  const context = sourceContext(env, git(publicRoot, 'rev-parse', 'HEAD'))
  const privateRoot = resolve(publicRoot, '.mikka-cloud')
  if (!existsSync(privateRoot)) {
    if (verify) fail('CLOUD_PUBLIC_CI_PRIVATE_CHECKOUT_REQUIRED')
    await mkdir(privateRoot)
    git(privateRoot, 'init')
    git(privateRoot, 'remote', 'add', 'origin', `https://github.com/${privateRepository}.git`)
    const fetchEnv = env.MIKKA_CLOUD_READ_TOKEN ? {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.MIKKA_CLOUD_READ_TOKEN}`).toString('base64')}`,
    } : process.env
    gitWithEnv(privateRoot, fetchEnv, ['fetch', '--depth=1', 'origin', context.privateSource])
    git(privateRoot, 'checkout', '--detach', context.privateSource)
  }
  if (await realpath(privateRoot) !== privateRoot || git(privateRoot, 'rev-parse', '--show-toplevel') !== privateRoot ||
      !hasOrigin(privateRoot, privateRepository) || git(privateRoot, 'rev-parse', 'HEAD') !== context.privateSource ||
      git(privateRoot, 'status', '--porcelain', '--untracked-files=no') !== '') fail('CLOUD_PUBLIC_CI_PRIVATE_SOURCE_MISMATCH')
  git(privateRoot, 'ls-files', '--error-unmatch', 'scripts/cloudflare-ci.mjs')
  const { runCi } = await import(pathToFileURL(resolve(privateRoot, 'scripts/cloudflare-ci.mjs')).href)
  const receipt = await runCi({ env, verify, publicRoot, publicSource: context.publicSource })
  if (git(publicRoot, 'rev-parse', 'HEAD') !== context.publicSource || git(privateRoot, 'rev-parse', 'HEAD') !== context.privateSource) fail('CLOUD_PUBLIC_CI_SOURCE_CHANGED')
  verifyPublicReceipt(receipt, context)
  console.log(JSON.stringify({ result: verify ? 'verified' : 'passed', context, publication: 'none' }))
  if (publish) {
    if (!env.RUNNER_TEMP) fail('CLOUD_PUBLIC_CI_RUNNER_TEMP_REQUIRED')
    const { publishQualifiedCloud } = await import(pathToFileURL(resolve(privateRoot, 'scripts/cloudflare-ci-publish.mjs')).href)
    const published = await publishQualifiedCloud({ env, publicRoot, publicSource: context.publicSource })
    verifyPublicReceipt(published.receipt, context)
    if (JSON.stringify(published.receipt) !== JSON.stringify(receipt)) fail('CLOUD_PUBLIC_CI_RECEIPT_CHANGED')
    const cloudArtifact = verifyPublishedArtifact(published.cloudArtifact, receipt, context)
    if (git(publicRoot, 'rev-parse', 'HEAD') !== context.publicSource || git(privateRoot, 'rev-parse', 'HEAD') !== context.privateSource) fail('CLOUD_PUBLIC_CI_SOURCE_CHANGED')
    const artifact = { version: 1, context, receipt, cloudArtifact, publication: 'registry-only' }
    const artifactPath = resolve(env.RUNNER_TEMP, 'cloud-services-ci-receipt', 'receipt.json')
    await mkdir(dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, JSON.stringify(artifact) + '\n', { mode: 0o600 })
    console.log(`MIKKA_GITHUB_CLOUD_CI_RECEIPT=${JSON.stringify(artifact)}`)
  }
  return { context, receipt }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...extra] = process.argv.slice(2)
    if (!['build', 'verify', 'publish'].includes(action) || extra.length) fail('CLOUD_PUBLIC_CI_ARGUMENT_INVALID')
    await runCloudCi({ verify: action !== 'build', publish: action === 'publish' })
  } catch (error) {
    console.error(/^CLOUD_PUBLIC_CI_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'CLOUD_PUBLIC_CI_FAILED')
    process.exitCode = 1
  }
}
