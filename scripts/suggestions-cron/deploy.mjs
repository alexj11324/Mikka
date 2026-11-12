import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { applicationWitness, readJson } from '../device-gateway/deploy.mjs'
import { affectsWorker } from '../device-gateway/select-release.mjs'

export const WORKER = 'mikka-suggestions-cron'
export const MIKKA_URL = 'https://app.aspectlylabs.com/mikka'
const REPOSITORY = 'alexj11324/Mikka'
const CONFIG = 'cloudflare/suggestions-cron/wrangler.jsonc'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SHA = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const execute = promisify(execFile)
const fail = code => { throw new Error(code) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Only the existing scheduled Worker and its reviewed configuration may be deployed. */
export function validateConfig(text) {
  let config
  try { config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) } catch { fail('cron_config_invalid') }
  const allowed = ['$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'triggers', 'vars', 'observability']
  if (Object.keys(config).some(key => !allowed.includes(key)) || config.name !== WORKER || config.main !== 'src/index.mjs'
    || !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date ?? '')
    || config.workers_dev !== false || config.preview_urls !== false
    || JSON.stringify(config.triggers) !== JSON.stringify({ crons: ['* * * * *'] })
    || JSON.stringify(config.vars) !== JSON.stringify({})
    || JSON.stringify(config.observability) !== JSON.stringify({ enabled: true })) fail('cron_resource_change_refused')
  return config
}

/** Inspect binding metadata only. The native-synced CRON_SECRET value is never read or replaced. */
export function existingWorker(settings, subdomain, schedules) {
  if (!Array.isArray(settings?.bindings) || settings.bindings.length !== 2) fail('cron_bindings_mismatch')
  const secret = settings.bindings.find(binding => binding.name === 'CRON_SECRET')
  const origin = settings.bindings.find(binding => binding.name === 'MIKKA_URL')
  if (secret?.type !== 'secret_text' || origin?.type !== 'plain_text' || origin.text !== MIKKA_URL) fail('cron_bindings_mismatch')
  if (settings.observability?.enabled !== true) fail('cron_observability_mismatch')
  if (subdomain?.enabled !== false || subdomain?.previews_enabled !== false) fail('cron_public_url_enabled')
  if (!Array.isArray(schedules?.schedules) || schedules.schedules.length !== 1 || schedules.schedules[0].cron !== '* * * * *') fail('cron_schedule_mismatch')
}

/** These two read-only origins need different credentials; neither receives the other's bearer. */
async function releaseJson(url, token, fetchImpl) {
  if (url.origin !== 'https://api.github.com' && url.href !== MIKKA_URL + '/api/version') fail('release_read_origin_invalid')
  const headers = url.origin === 'https://api.github.com'
    ? { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
    : { 'cache-control': 'no-cache' }
  let response
  try { response = await fetchImpl(url, { headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) }) }
  catch { fail('release_read_unavailable') }
  if (!response.ok) { await response.body?.cancel(); fail('release_read_http_' + response.status) }
  try { return await response.json() } catch { fail('release_read_response_invalid') }
}

export function webDeployRun(runs, sha) {
  if (!Array.isArray(runs)) fail('web_deploy_response_invalid')
  const relevant = runs.filter(run => run.head_sha === sha && run.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run.event) && run.repository?.full_name === REPOSITORY
    && run.path === '.github/workflows/web-deploy.yml')
  const latest = relevant.sort((a, b) => b.id - a.id)[0]
  if (!latest || latest.status !== 'completed') return null
  if (latest.conclusion !== 'success') fail('web_deploy_failed')
  if (!Number.isSafeInteger(latest.id) || latest.id <= 0) fail('web_deploy_response_invalid')
  return latest.id
}

export function gitRepository(cwd = ROOT) {
  const git = async args => {
    try { return (await execute('git', args, { cwd, timeout: 30_000, maxBuffer: 2_000_000 })).stdout.trim() }
    catch { fail('release_git_read_failed') }
  }
  return {
    async refreshMain() {
      await git(['fetch', '--quiet', '--no-tags', 'https://github.com/' + REPOSITORY + '.git', 'refs/heads/main'])
      return git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    },
    async contains(ancestor, descendant) {
      if (!SHA.test(ancestor) || !SHA.test(descendant)) fail('release_sha_invalid')
      try { await execute('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, timeout: 30_000 }); return true }
      catch (error) { if (error.code === 1) return false; fail('release_git_read_failed') }
    },
    async sameInputs(before, after) {
      if (!SHA.test(before) || !SHA.test(after)) fail('release_sha_invalid')
      const changed = await git(['diff', '--no-renames', '--name-only', '-z', before, after])
      return !changed.split('\0').some(path => affectsWorker('cron', path))
    },
    async assertCheckout(sourceCommit) {
      if (await git(['rev-parse', 'HEAD']) !== sourceCommit || await git(['status', '--porcelain', '--untracked-files=no'])) fail('release_checkout_changed')
      await git(['cat-file', '-e', sourceCommit + ':cloudflare/suggestions-cron/src/index.mjs'])
    },
  }
}

export async function deployCron({ sourceCommit, accountId, cloudflareToken, vercelToken, githubToken, readPromotedWeb,
  repository = gitRepository(), configText = readFileSync(new URL('../../' + CONFIG, import.meta.url), 'utf8'),
  fetchImpl = fetch, deployWorker = wranglerDeploy, wait = sleep, maxPolls = 60, log = console.log }) {
  if (!SHA.test(sourceCommit ?? '')) fail('release_sha_invalid')
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '') || !cloudflareToken || (!readPromotedWeb && (!vercelToken || !githubToken))) fail('release_credentials_unavailable')
  validateConfig(configText)
  await repository.assertCheckout(sourceCommit)
  const cloudflare = async path => {
    const response = await readJson(new URL('/client/v4/accounts/' + accountId + '/workers/scripts/' + WORKER + '/' + path, 'https://api.cloudflare.com'), cloudflareToken, fetchImpl)
    if (response.success !== true || !response.result) fail('cloudflare_response_invalid')
    return response.result
  }
  const preflight = async () => existingWorker(...await Promise.all(['settings', 'subdomain', 'schedules'].map(cloudflare)))
  await preflight()
  const readApplication = await applicationWitness({ sourceCommit, vercelToken, readPromotedWeb, fetchImpl })

  const releaseState = async () => {
    const main = await repository.refreshMain()
    if (!SHA.test(main) || !await repository.contains(sourceCommit, main)) fail('release_source_not_main')
    if (!await repository.sameInputs(sourceCommit, main)) return { state: 'superseded' }
    const production = await readApplication()
    if (!production || !await repository.contains(sourceCommit, production.sha)) return { state: 'waiting' }
    if (!await repository.contains(production.sha, main) || !await repository.sameInputs(sourceCommit, production.sha)) fail('production_release_mismatch')
    // The protected promotion already checks the live Web, deployment and owner approval.
    if (readPromotedWeb) return { state: 'ready', production }
    const runsUrl = new URL('https://api.github.com/repos/' + REPOSITORY + '/actions/workflows/web-deploy.yml/runs')
    runsUrl.search = new URLSearchParams({ head_sha: production.sha, branch: 'main', per_page: '100' }).toString()
    const webRun = webDeployRun((await releaseJson(runsUrl, githubToken, fetchImpl)).workflow_runs, production.sha)
    if (!webRun) return { state: 'waiting' }
    const version = await releaseJson(new URL(MIKKA_URL + '/api/version'), undefined, fetchImpl)
    if (!SHA.test(version.build ?? '')) fail('production_version_invalid')
    if (version.build !== production.sha) return { state: 'waiting' }
    return { state: 'ready', production, webDeployRunId: webRun }
  }

  for (let poll = 0; poll < maxPolls; poll++) {
    const state = await releaseState()
    if (state.state === 'superseded') return { skipped: true, reason: 'newer_cron_source' }
    if (state.state === 'ready') {
      await preflight()
      // Main, the deployment and the public build are checked again immediately before the one write.
      const final = await releaseState()
      if (final.state === 'superseded') return { skipped: true, reason: 'newer_cron_source' }
      if (final.state === 'ready' && final.production.id === state.production.id) {
        await repository.assertCheckout(sourceCommit)
        const versionId = await deployWorker(sourceCommit, { accountId, cloudflareToken })
        if (!UUID.test(versionId ?? '')) fail('cron_deploy_receipt_missing')
        const { deployments } = await cloudflare('deployments')
        const versions = deployments?.[0]?.versions
        if (!Array.isArray(versions) || versions.length !== 1 || versions[0].version_id !== versionId || versions[0].percentage !== 100) fail('cron_deployment_not_active')
        await preflight()
        return { skipped: false, sourceCommit, production: final.production,
          ...(final.webDeployRunId ? { webDeployRunId: final.webDeployRunId } : {}),
          versionId, cron: '* * * * *', publicUrls: false, secretBinding: 'CRON_SECRET', observability: true }
      }
    }
    if (poll + 1 < maxPolls) { log('Waiting for Web deploy and the matching production application'); await wait(30_000) }
  }
  fail('production_release_wait_timeout')
}

async function wranglerDeploy(sourceCommit, { accountId, cloudflareToken }) {
  let stdout
  try {
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'NODE_EXTRA_CA_CERTS']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    const result = await execute(process.execPath, [fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
      'deploy', '--config', CONFIG, '--var', 'MIKKA_URL:' + MIKKA_URL, '--keep-vars', '--message', 'Mikka minute Worker ' + sourceCommit],
    { cwd: ROOT, env: { ...env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: cloudflareToken,
        CI: 'true', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' }, timeout: 180_000, maxBuffer: 2_000_000 })
    stdout = result.stdout
  } catch { fail('cron_deploy_failed_or_uncertain') }
  return stdout.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== REPOSITORY
      || process.env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) fail('reviewed_main_workflow_required')
    const report = await deployCron({ sourceCommit: process.env.GITHUB_SHA, accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN, vercelToken: process.env.VERCEL_TEAM_TOKEN,
      githubToken: process.env.GITHUB_TOKEN })
    const sourceHash = createHash('sha256').update(readFileSync(new URL('../../cloudflare/suggestions-cron/src/index.mjs', import.meta.url))).digest('hex')
    console.log(JSON.stringify({ ...report, sourceHash }))
  } catch (error) {
    console.error(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'cron_release_failed')
    process.exitCode = 1
  }
}
