import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasGitHubOrigin } from './cloudflare-source.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA = /^[a-f0-9]{40}$/
const BASE_STAGES = ['public-install', 'private-install', 'script-tests']
const fail = code => { throw new Error(code) }

function command(bin, args, { cwd = root, env = process.env, capture = false } = {}) {
  try {
    const output = execFileSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    return capture ? output.trim() : undefined
  } catch {
    // Private source diagnostics can include source text and build credentials.
    fail('CI_COMMAND_FAILED')
  }
}
const git = (args, cwd = root, env = process.env) => command('git', args, { cwd, env, capture: true })

export function sourceContext(env, publicSha, privateSha) {
  if (!SHA.test(publicSha ?? '') || !SHA.test(privateSha ?? '')) fail('CI_SOURCE_SHA_REQUIRED')
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'alexj11324/Mikka'
      || env.GITHUB_REPOSITORY_ID !== '1427517699') fail('CI_PUBLIC_GITHUB_CONTEXT_REQUIRED')
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') fail('CI_MANUAL_MAIN_REQUIRED')
  if (env.GITHUB_SHA !== publicSha || env.GITHUB_WORKFLOW_SHA !== publicSha) fail('CI_PUBLIC_SOURCE_MISMATCH')
  if (env.GITHUB_WORKFLOW_REF !== 'alexj11324/Mikka/.github/workflows/cloudflare-api-image.yml@refs/heads/main') fail('CI_WORKFLOW_REQUIRED')
  if (env.GITHUB_ACTOR_ID !== '183887963' || env.GITHUB_ACTOR !== 'alexj11324'
      || env.GITHUB_TRIGGERING_ACTOR !== 'alexj11324') fail('CI_RELEASE_OWNER_REQUIRED')
  if (env.OVERLAY_SHA !== privateSha) fail('CI_OVERLAY_SOURCE_MISMATCH')
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) if (!/^[1-9][0-9]*$/.test(env[name] ?? '')) fail('CI_BUILD_ID_REQUIRED')
  return { provider: 'github-actions', repository: env.GITHUB_REPOSITORY, repositoryId: env.GITHUB_REPOSITORY_ID,
    publicSha, privateSha, branch: 'main', ref: env.GITHUB_REF, workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    buildId: env.GITHUB_RUN_ID + '-' + env.GITHUB_RUN_ATTEMPT, actor: env.GITHUB_ACTOR,
    actorId: env.GITHUB_ACTOR_ID, triggeringActor: env.GITHUB_TRIGGERING_ACTOR }
}

export function childEnvironment(env, publicSha, privateSha) {
  if (!SHA.test(publicSha) || !SHA.test(privateSha)) fail('CI_SOURCE_SHA_REQUIRED')
  const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
  return {
    ...Object.fromEntries(names.filter(name => env[name] !== undefined).map(name => [name, env[name]])),
    // oxlint-disable-next-line no-control-regex -- Restrict Docker access to a local socket without control bytes.
    ...(/^unix:\/\/\/[^\s\x00-\x1f\x7f]+$/.test(env.DOCKER_HOST ?? '') ? { DOCKER_HOST: env.DOCKER_HOST } : {}),
    CI: 'true', NODE_OPTIONS: '--max-old-space-size=6144', ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    MIKKA_BUILD_REVISION: publicSha, NEXT_PUBLIC_MIKKA_BUILD: publicSha,
    MIKKA_UI_OVERLAY_SHA: privateSha, MIKKA_UI_OVERLAY_DIR: join(root, '.hosted-ui'),
  }
}

export async function withOverlayKey(env, action) {
  if (!env.HOSTED_UI_READ_KEY) fail('CI_OVERLAY_READ_KEY_REQUIRED')
  const directory = await mkdtemp(join(tmpdir(), 'mikka-overlay-key-'))
  try {
    const key = join(directory, 'key')
    const hosts = join(directory, 'known_hosts')
    await writeFile(key, env.HOSTED_UI_READ_KEY.trim() + '\n', { mode: 0o600 })
    const response = await fetch('https://api.github.com/meta', { redirect: 'error', signal: AbortSignal.timeout(20000) })
    if (!response.ok) fail('CI_GITHUB_HOST_KEYS_UNAVAILABLE')
    const keys = (await response.json()).ssh_keys
    if (!Array.isArray(keys) || !keys.length || keys.some(value => !/^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+$/.test(value))) fail('CI_GITHUB_HOST_KEYS_INVALID')
    await writeFile(hosts, keys.map(value => 'github.com ' + value).join('\n') + '\n', { mode: 0o600 })
    return await action({ ...env, GIT_SSH_COMMAND: `ssh -i '${key}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${hosts}'` })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function validateReceipt(receipt, context) {
  if (receipt?.version !== 1 || receipt.publication !== 'none' || receipt.publicSha !== context.publicSha
      || receipt.privateSha !== context.privateSha || receipt.provider !== context.provider) fail('CI_RECEIPT_INVALID')
  for (const [name, value] of Object.entries(context)) if (receipt.context?.[name] !== value) fail('CI_RECEIPT_SOURCE_MISMATCH')
  if (receipt.overlayCheckout?.repository !== 'alexj11324/mikka-hosted-ui'
      || receipt.overlayCheckout.requestedSha !== context.privateSha
      || receipt.overlayCheckout.actualSha !== context.privateSha) fail('CI_OVERLAY_RECEIPT_MISMATCH')
  if (receipt.target !== 'native-api') fail('CI_BUILD_TARGET_INVALID')
  if (receipt.stages?.length !== BASE_STAGES.length || receipt.stages.some((step, index) => step.name !== BASE_STAGES[index] || step.exit !== 0)) fail('CI_RECEIPT_GATE_INCOMPLETE')
  return receipt
}

async function verifyReceipt(context) {
  const receipt = JSON.parse(await readFile(join(root, '.cloudflare-ci/receipt.json'), 'utf8'))
  validateReceipt(receipt, context)
  if (git(['rev-parse', 'HEAD']) !== receipt.publicSha || git(['rev-parse', 'HEAD'], join(root, '.hosted-ui')) !== context.privateSha) fail('CI_CHECKOUT_CHANGED')
  for (const directory of [root, join(root, '.hosted-ui')]) git(['diff', '--quiet', 'HEAD', '--'], directory)
  console.log('MIKKA_GITHUB_API_SOURCE_RECEIPT=' + JSON.stringify(receipt))
  return receipt
}

export async function runCi({ env = process.env, verify = false } = {}) {
  if (!process.version.startsWith('v24.')) fail('CI_NODE_24_REQUIRED')
  const publicSha = git(['rev-parse', 'HEAD'])
  const context = sourceContext(env, publicSha, env.OVERLAY_SHA)
  if (verify) return verifyReceipt(context)
  git(['diff', '--quiet', 'HEAD', '--'])
  if (!hasGitHubOrigin(git(['remote', 'get-url', 'origin']), 'alexj11324/Mikka')) fail('CI_PUBLIC_REPOSITORY_REQUIRED')
  const overlay = join(root, '.hosted-ui')
  await withOverlayKey(env, async keyEnv => {
    command('git', ['init', '--quiet', overlay], { env: keyEnv })
    command('git', ['fetch', '--quiet', '--depth=1', 'git@github.com:alexj11324/mikka-hosted-ui.git', context.privateSha], { cwd: overlay, env: keyEnv })
    command('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: overlay, env: keyEnv })
  })
  if (git(['rev-parse', 'HEAD'], overlay) !== context.privateSha) fail('CI_OVERLAY_SOURCE_MISMATCH')
  const childEnv = childEnvironment(env, publicSha, context.privateSha)
  for (const directory of [root, overlay]) {
    if (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).packageManager !== 'pnpm@10.34.3') fail('CI_PNPM_PIN_MISMATCH')
  }
  const definitions = [
    ['corepack', ['pnpm', 'install', '--frozen-lockfile']],
    ['corepack', ['pnpm', '--dir', '.hosted-ui', 'install', '--ignore-workspace', '--prod', '--ignore-scripts', '--frozen-lockfile']],
    ['node', ['--test', 'scripts/cloudflare-ci.test.mjs', 'scripts/cloudflare-native-oci.test.mjs', 'scripts/cloudflare-cloud-ci.test.mjs', 'scripts/cloudflare-runtime-release.test.mjs']],
  ]
  const stages = []
  for (const [index, [bin, args]] of definitions.entries()) {
    console.log(JSON.stringify({ stage: BASE_STAGES[index], status: 'started' }))
    command(bin, args, { env: childEnv })
    stages.push({ name: BASE_STAGES[index], exit: 0 })
    console.log(JSON.stringify({ stage: BASE_STAGES[index], status: 'passed' }))
  }
  const receipt = { version: 1, context, publicSha, privateSha: context.privateSha, provider: context.provider,
    overlayCheckout: { repository: 'alexj11324/mikka-hosted-ui', requestedSha: context.privateSha, actualSha: context.privateSha },
    workRoot: root, target: 'native-api', stages, node: process.version, packageManager: 'pnpm@10.34.3', publication: 'none' }
  await mkdir(join(root, '.cloudflare-ci'), { recursive: true })
  await writeFile(join(root, '.cloudflare-ci/receipt.json'), JSON.stringify(receipt) + '\n', { mode: 0o600 })
  return verifyReceipt(context)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!['build', 'verify'].includes(process.argv[2]) || process.argv.length !== 3) fail('CI_ARGUMENT_INVALID')
    await runCi({ verify: process.argv[2] === 'verify' })
  } catch (error) {
    console.error(/^CI_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'CI_BUILD_FAILED')
    process.exitCode = 1
  }
}
