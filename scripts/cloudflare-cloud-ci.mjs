import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hasGitHubOrigin } from './cloudflare-source.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = 'alexj11324/Mikka'
const privateRepository = 'alexj11324/mikka-cloud'
const fullSha = /^[a-f0-9]{40}$/
const fail = code => { throw new Error(code) }
const git = (cwd, ...args) => gitWithEnv(cwd, process.env, args)
const gitWithEnv = (cwd, env, args) => execFileSync('git', args, {
  cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
}).trim()

function hasOrigin(directory, expected) {
  return hasGitHubOrigin(git(directory, 'remote', 'get-url', 'origin'), expected)
}

export function sourceContext(env, publicSource) {
  if (env.WORKERS_CI !== '1') fail('CLOUD_PUBLIC_CI_PROVIDER_REQUIRED')
  if (!fullSha.test(publicSource) || env.WORKERS_CI_COMMIT_SHA !== publicSource) fail('CLOUD_PUBLIC_CI_SOURCE_MISMATCH')
  if (!fullSha.test(env.MIKKA_CLOUD_SOURCE_SHA ?? '')) fail('CLOUD_PUBLIC_CI_PRIVATE_PIN_REQUIRED')
  if (!env.WORKERS_CI_BRANCH || /[\s\x00-\x1f]/.test(env.WORKERS_CI_BRANCH) || env.WORKERS_CI_BRANCH.startsWith('-')) fail('CLOUD_PUBLIC_CI_BRANCH_INVALID')
  if (!env.WORKERS_CI_BUILD_UUID || /[\r\n]/.test(env.WORKERS_CI_BUILD_UUID)) fail('CLOUD_PUBLIC_CI_BUILD_ID_REQUIRED')
  return {
    provider: 'cloudflare-workers-builds', repository, publicSource,
    privateSource: env.MIKKA_CLOUD_SOURCE_SHA,
    branch: env.WORKERS_CI_BRANCH, buildId: env.WORKERS_CI_BUILD_UUID,
  }
}

export async function runCloudCi({ env = process.env, verify = false, publicRoot = root } = {}) {
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
  if (!receipt?.excluded && (receipt?.context?.sha !== context.privateSource || receipt.context.publicSource !== context.publicSource ||
      receipt.context.repository !== repository || receipt.context.buildId !== context.buildId || receipt.context.branch !== context.branch ||
      receipt.context.provider !== context.provider || receipt.publication !== 'none')) fail('CLOUD_PUBLIC_CI_RECEIPT_SOURCE_MISMATCH')
  console.log(JSON.stringify({ result: receipt?.excluded ? 'evidence-branch-excluded' : verify ? 'verified' : 'passed', context, publication: 'none' }))
  if (verify && !receipt?.excluded) console.log(`MIKKA_CF_CLOUD_CI_RECEIPT=${JSON.stringify({ version: 1, context, receipt, publication: 'none' })}`)
  return { context, receipt }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...extra] = process.argv.slice(2)
    if (!['build', 'verify'].includes(action) || extra.length) fail('CLOUD_PUBLIC_CI_ARGUMENT_INVALID')
    await runCloudCi({ verify: action === 'verify' })
  } catch (error) {
    console.error(/^CLOUD_PUBLIC_CI_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'CLOUD_PUBLIC_CI_FAILED')
    process.exitCode = 1
  }
}
