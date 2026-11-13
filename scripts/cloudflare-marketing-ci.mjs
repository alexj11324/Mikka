import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { command } from './cloudflare-native-oci.mjs'
import { hasGitHubOrigin } from './cloudflare-source.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = 'alexj11324/Mikka', privateRepository = 'alexj11324/mikka-web'
const sha = /^[a-f0-9]{40}$/, positive = /^[1-9][0-9]*$/
const workflow = 'alexj11324/Mikka/.github/workflows/marketing-build.yml@refs/heads/main'
const archiveName = 'marketing-worker.tgz'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (cwd, args, env) => command('git', args, { cwd, env, stage: 'MARKETING_SOURCE', encoding: 'utf8', timeout: 120000 }).trim()

export function sourceContext(env, publicSource) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'MARKETING_PUBLIC_CI_PROVIDER_REQUIRED')
  assert.equal(env.GITHUB_REPOSITORY, repository, 'MARKETING_PUBLIC_CI_REPOSITORY_REQUIRED')
  assert.equal(env.GITHUB_REPOSITORY_ID, '1427517699', 'MARKETING_PUBLIC_CI_REPOSITORY_REQUIRED')
  assert.equal(env.GITHUB_REPOSITORY_OWNER_ID, '183887963', 'MARKETING_PUBLIC_CI_REPOSITORY_REQUIRED')
  assert.equal(env.GITHUB_ACTOR_ID, '183887963', 'MARKETING_PUBLIC_CI_ACTOR_REQUIRED')
  assert.equal(env.GITHUB_ACTOR, 'alexj11324', 'MARKETING_PUBLIC_CI_ACTOR_REQUIRED')
  assert.equal(env.GITHUB_TRIGGERING_ACTOR, 'alexj11324', 'MARKETING_PUBLIC_CI_ACTOR_REQUIRED')
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'MARKETING_PUBLIC_CI_MAIN_REQUIRED')
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'MARKETING_PUBLIC_CI_EVENT_REQUIRED')
  assert.equal(env.GITHUB_WORKFLOW_REF, workflow, 'MARKETING_PUBLIC_CI_WORKFLOW_REQUIRED')
  assert.ok(sha.test(publicSource) && env.GITHUB_SHA === publicSource, 'MARKETING_PUBLIC_CI_SOURCE_MISMATCH')
  assert.match(env.MIKKA_MARKETING_SOURCE_SHA ?? '', sha, 'MARKETING_PUBLIC_CI_PRIVATE_PIN_REQUIRED')
  assert.match(env.GITHUB_RUN_ID ?? '', positive, 'MARKETING_PUBLIC_CI_RUN_REQUIRED')
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', positive, 'MARKETING_PUBLIC_CI_ATTEMPT_REQUIRED')
  return { provider: 'github-actions', repository, publicSource, privateRepository,
    privateSource: env.MIKKA_MARKETING_SOURCE_SHA, ref: env.GITHUB_REF, workflowRef: env.GITHUB_WORKFLOW_REF,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT }
}

export function buildEnvironment(env) {
  const names = ['PATH', 'HOME', 'USER', 'TMPDIR', 'XDG_RUNTIME_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
  return { ...Object.fromEntries(names.filter(name => env[name] !== undefined).map(name => [name, env[name]])),
    CI: 'true', NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' }
}

export async function runMarketingCi({ env = process.env, verify = false, publicRoot = root } = {}) {
  if (!verify) assert.ok(process.version.startsWith('v24.'), 'MARKETING_PUBLIC_CI_NODE_24_REQUIRED')
  publicRoot = await realpath(publicRoot)
  assert.ok(git(publicRoot, ['rev-parse', '--show-toplevel']) === publicRoot
    && hasGitHubOrigin(git(publicRoot, ['remote', 'get-url', 'origin']), repository), 'MARKETING_PUBLIC_CI_REPOSITORY_REQUIRED')
  const context = sourceContext(env, git(publicRoot, ['rev-parse', 'HEAD']))
  const source = join(publicRoot, '.mikka-web'), output = join(publicRoot, '.cloudflare-marketing')
  const childEnv = buildEnvironment(env)
  if (!existsSync(source)) {
    assert.ok(!verify, 'MARKETING_PUBLIC_CI_CHECKOUT_REQUIRED')
    await mkdir(source, { mode: 0o700 })
    git(source, ['init', '--quiet'])
    git(source, ['remote', 'add', 'origin', `https://github.com/${privateRepository}.git`])
    const fetchEnv = env.MIKKA_MARKETING_READ_TOKEN ? { ...childEnv, GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + env.MIKKA_MARKETING_READ_TOKEN).toString('base64') } : childEnv
    git(source, ['fetch', '--depth=1', 'origin', context.privateSource], fetchEnv)
    git(source, ['checkout', '--detach', 'FETCH_HEAD'])
  }
  const checkSource = () => assert.ok(hasGitHubOrigin(git(source, ['remote', 'get-url', 'origin']), privateRepository)
    && git(source, ['rev-parse', '--show-toplevel']) === source && git(source, ['rev-parse', 'HEAD']) === context.privateSource
    && git(source, ['status', '--porcelain', '--untracked-files=no']) === ''
    && git(publicRoot, ['rev-parse', 'HEAD']) === context.publicSource, 'MARKETING_PUBLIC_CI_CHECKOUT_MISMATCH')
  assert.equal(await realpath(source), source, 'MARKETING_PUBLIC_CI_CHECKOUT_MISMATCH')
  checkSource()
  if (!verify) {
    assert.equal(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).packageManager, 'pnpm@10.34.3')
    await rm(output, { recursive: true, force: true })
    await mkdir(output, { mode: 0o700 })
    for (const [stage, args] of [
      ['INSTALL', ['install', '--ignore-workspace', '--frozen-lockfile']],
      ['ASSET_TESTS', ['exec', 'node', '--test', 'scripts/marketing-release-asset.test.mjs']],
      ['ATTRIBUTION_TESTS', ['test:attribution']], ['INDEXNOW_TESTS', ['test:indexnow']],
      ['TYPECHECK', ['typecheck']], ['BUILD', ['build:cloudflare']], ['WORKER_TESTS', ['test:cloudflare']],
      ['BUNDLE', ['exec', 'wrangler', 'deploy', '--dry-run', '--env=', '--outdir', join(output, 'compiled')]],
    ]) command('corepack', ['pnpm', ...args], { cwd: source, env: childEnv, stage: 'MARKETING_' + stage })
    const { stageBundle } = await import(pathToFileURL(join(source, 'scripts/marketing-release-asset.mjs')).href)
    await stageBundle(join(output, 'compiled/worker.js'), join(source, '.open-next/assets'),
      join(source, '.open-next/mikka-release.json'), join(output, 'staged'), context.privateSource)
    command('tar', ['-czf', join(output, archiveName), '-C', join(output, 'staged'), '.'], { env: childEnv, stage: 'MARKETING_ARCHIVE' })
    checkSource()
    const bytes = await readFile(join(output, archiveName))
    await writeFile(join(output, 'receipt.json'), JSON.stringify({ version: 1, context,
      archive: { name: archiveName, sha256: hash(bytes), bytes: bytes.length, retention: 'private-github-release' }, publication: 'none' }) + '\n', { mode: 0o600 })
  }
  const receipt = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'))
  assert.equal(receipt.version, 1)
  assert.deepEqual(receipt.context, context, 'MARKETING_PUBLIC_CI_RECEIPT_SOURCE_MISMATCH')
  assert.ok(['none', 'private-github-release'].includes(receipt.publication))
  assert.equal(receipt.archive.name, archiveName)
  assert.equal(receipt.archive.retention, 'private-github-release')
  const bytes = await readFile(join(output, archiveName))
  assert.ok(bytes.length > 0 && receipt.archive.bytes === bytes.length && receipt.archive.sha256 === hash(bytes), 'MARKETING_PUBLIC_CI_ARCHIVE_MISMATCH')
  console.log('MIKKA_GHA_MARKETING_RECEIPT=' + JSON.stringify(receipt))
  return receipt
}

export async function publishMarketingCi({ env = process.env, publicRoot = root } = {}) {
  const receipt = await runMarketingCi({ env, verify: true, publicRoot })
  assert.equal(receipt.publication, 'none', 'MARKETING_PUBLIC_CI_ALREADY_PUBLISHED')
  const output = join(publicRoot, '.cloudflare-marketing')
  await writeFile(join(output, 'marketing-worker.sha256'), receipt.archive.sha256 + '  ' + archiveName + '\n', { mode: 0o600 })
  const { publish } = await import(pathToFileURL(join(publicRoot, '.mikka-web/scripts/marketing-release-asset.mjs')).href)
  const privateRelease = await publish(output, { ...env, MIKKA_PUBLIC_SOURCE_SHA: receipt.context.publicSource }, join(publicRoot, '.mikka-web'))
  assert.equal(privateRelease.sha256, receipt.archive.sha256)
  assert.equal(privateRelease.bytes, receipt.archive.bytes)
  receipt.publication = 'private-github-release'
  receipt.privateRelease = privateRelease
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt) + '\n', { mode: 0o600 })
  console.log('MIKKA_GHA_MARKETING_RECEIPT=' + JSON.stringify(receipt))
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...extra] = process.argv.slice(2)
  if (!['build', 'verify', 'publish'].includes(action) || extra.length) throw Error('MARKETING_PUBLIC_CI_ARGUMENT_INVALID')
  const operation = action === 'publish' ? publishMarketingCi() : runMarketingCi({ verify: action === 'verify' })
  operation.catch(error => {
    console.error(/^(?:MARKETING_PUBLIC_CI_|CF_OCI_STAGE_)[A-Z0-9_]+$/.test(error.message) ? error.message : 'MARKETING_PUBLIC_CI_FAILED')
    process.exitCode = 1
  })
}
