import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { affectsWorker } from './select-release.mjs'
import { parsePromotionRecord, readWebAuthority } from '../release/cloudflare-promoted-web.mjs'

export const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
export const TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
export const ALIAS = 'app.aspectlylabs.com'
export const WORKER = 'mikka-device-gateway'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CONFIG = 'cloudflare/device-gateway/wrangler.jsonc'
const SHA = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const execute = promisify(execFile)
const fail = code => { throw new Error(code) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Read-only provider calls never echo response bodies or transport errors. */
export async function readJson(url, token, fetchImpl = fetch) {
  if (!['https://api.cloudflare.com', 'https://api.vercel.com'].includes(url.origin)) fail('provider_origin_invalid')
  let response
  try { response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) }) }
  catch { fail('provider_read_unavailable') }
  if (!response.ok) fail(`provider_read_http_${response.status}`)
  try { return await response.json() } catch { fail('provider_response_invalid') }
}

/** No migration, new binding, new Worker name or other resource is permitted. */
export function validateConfig(text) {
  let config
  try { config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) } catch { fail('gateway_config_invalid') }
  const allowed = ['$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'observability', 'durable_objects', 'migrations']
  if (Object.keys(config).some(key => !allowed.includes(key)) || config.name !== WORKER || config.main !== 'src/index.ts'
    || JSON.stringify(config.durable_objects) !== JSON.stringify({ bindings: [{ name: 'DEVICE_SESSION', class_name: 'DeviceSession' }] })
    || JSON.stringify(config.migrations) !== JSON.stringify([{ tag: 'v1', new_sqlite_classes: ['DeviceSession'] }])) fail('gateway_resource_change_refused')
  return config
}

/** API settings contain binding metadata; the secret's value is neither needed nor read back. */
export function existingWorker(settings, service) {
  if (!Array.isArray(settings?.bindings) || settings.bindings.length !== 2) fail('gateway_bindings_mismatch')
  const session = settings.bindings.find(binding => binding.name === 'DEVICE_SESSION')
  const secret = settings.bindings.find(binding => binding.name === 'GATEWAY_PUSH_SECRET')
  if (session?.type !== 'durable_object_namespace' || session.class_name !== 'DeviceSession'
    || !/^[a-f0-9]{32}$/.test(session.namespace_id ?? '')
    || (session.script_name && session.script_name !== WORKER) || session.environment || session.dispatch_namespace
    || secret?.type !== 'secret_text') fail('gateway_bindings_mismatch')
  // Wrangler reads this exact service metadata to decide whether to apply v1.
  // Requiring v1 already applied prevents creation of another namespace.
  if (service?.default_environment?.script?.migration_tag !== 'v1') fail('gateway_existing_migration_required')
  return session.namespace_id
}

export function productionDeployment(alias, deployment) {
  if (alias?.alias !== ALIAS || alias.projectId !== PROJECT || alias.redirect || alias.deletedAt
    || !/^dpl_[A-Za-z0-9]+$/.test(alias.deploymentId ?? '') || deployment?.id !== alias.deploymentId
    || deployment.projectId !== PROJECT || deployment.target !== 'production'
    || (deployment.ownerId && deployment.ownerId !== TEAM)
    || deployment.meta?.githubOrg !== 'alexj11324' || deployment.meta?.githubRepo !== 'Mikka') fail('production_identity_mismatch')
  const sha = deployment.gitSource?.sha ?? deployment.meta?.githubCommitSha
  if (!SHA.test(sha ?? '') || (deployment.meta?.githubCommitSha && deployment.meta.githubCommitSha !== sha)) fail('production_source_invalid')
  if (deployment.readyState !== 'READY' || deployment.aliasAssigned !== true || deployment.aliasError) return null
  return { id: deployment.id, sha }
}

/** The protected private caller revalidates its immutable promotion and authority on every read. */
export async function applicationWitness({ sourceCommit, vercelToken, readPromotedWeb, fetchImpl = fetch }) {
  if (!SHA.test(sourceCommit ?? '')) fail('release_sha_invalid')
  if (readPromotedWeb !== undefined) {
    if (typeof readPromotedWeb !== 'function') fail('production_promotion_invalid')
    let verified
    return async () => {
      const raw = JSON.stringify(await readPromotedWeb())
      const record = parsePromotionRecord(raw)
      if (record.product !== sourceCommit || (verified !== undefined && raw !== verified)) fail('production_promotion_changed')
      verified = raw
      return { id: record.releasePin, sha: record.product }
    }
  }
  if (!vercelToken) fail('release_credentials_unavailable')
  const legacy = async () => {
    const current = await readWebAuthority(fetchImpl)
    if (current.provider !== 'vercel') fail('production_legacy_origin_inactive')
    return current
  }
  await legacy()
  const vercel = path => {
    const url = new URL(path, 'https://api.vercel.com')
    url.searchParams.set('teamId', TEAM)
    return readJson(url, vercelToken, fetchImpl)
  }
  const project = await vercel(`/v9/projects/${PROJECT}`)
  if (project.id !== PROJECT || project.accountId !== TEAM || project.link?.type !== 'github'
    || String(project.link.repoId) !== '1427517699') fail('production_project_mismatch')

  return async () => {
    const current = await legacy()
    const alias = await vercel(`/v4/aliases/${ALIAS}?projectId=${PROJECT}`)
    if (!/^dpl_[A-Za-z0-9]+$/.test(alias.deploymentId ?? '')) fail('production_identity_mismatch')
    const production = productionDeployment(alias, await vercel(`/v13/deployments/${alias.deploymentId}`))
    return production?.sha === current.sha ? production : null
  }
}

export function gitRepository(cwd = ROOT) {
  const git = async args => {
    try { return (await execute('git', args, { cwd, timeout: 30_000, maxBuffer: 2_000_000 })).stdout.trim() }
    catch { fail('release_git_read_failed') }
  }
  return {
    async refreshMain() {
      // Public repo, no stored Git credential. Fetch only the reviewed main ref.
      await git(['fetch', '--quiet', '--no-tags', 'https://github.com/alexj11324/Mikka.git', 'refs/heads/main'])
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
      return !changed.split('\0').some(file => affectsWorker('device', file))
    },
    async assertCheckout(sourceCommit) {
      if (await git(['rev-parse', 'HEAD']) !== sourceCommit || await git(['status', '--porcelain', '--untracked-files=no'])) fail('release_checkout_changed')
      // The initial release must include the server presence fix in the same PR.
      await git(['cat-file', '-e', `${sourceCommit}:lib/device-presence.ts`])
    },
  }
}

/** Wait for the app first: repairing the socket before presence ships makes idle devices look offline. */
export async function deployGateway({ sourceCommit, accountId, cloudflareToken, vercelToken, readPromotedWeb, repository = gitRepository(),
  configText = readFileSync(new URL(`../../${CONFIG}`, import.meta.url), 'utf8'), fetchImpl = fetch,
  deployWorker = wranglerDeploy, wait = sleep, maxPolls = 60, log = console.log }) {
  if (!SHA.test(sourceCommit ?? '')) fail('release_sha_invalid')
  if (!/^[a-f0-9]{32}$/.test(accountId ?? '') || !cloudflareToken) fail('release_credentials_unavailable')
  validateConfig(configText)
  await repository.assertCheckout(sourceCommit)
  const cloudflare = async path => {
    const response = await readJson(new URL(`/client/v4/accounts/${accountId}/workers/${path}`, 'https://api.cloudflare.com'), cloudflareToken, fetchImpl)
    if (response.success !== true || !response.result) fail('cloudflare_response_invalid')
    return response.result
  }
  const preflight = async () => existingWorker(await cloudflare(`scripts/${WORKER}/settings`), await cloudflare(`services/${WORKER}`))
  const namespaceId = await preflight()
  const readApplication = await applicationWitness({ sourceCommit, vercelToken, readPromotedWeb, fetchImpl })

  const releaseState = async () => {
    const main = await repository.refreshMain()
    if (!SHA.test(main) || !await repository.contains(sourceCommit, main)) fail('release_source_not_main')
    if (!await repository.sameInputs(sourceCommit, main)) return { state: 'superseded' }
    const production = await readApplication()
    if (!production || !await repository.contains(sourceCommit, production.sha)) return { state: 'waiting' }
    if (!await repository.contains(production.sha, main) || !await repository.sameInputs(sourceCommit, production.sha)) fail('production_release_mismatch')
    return { state: 'ready', production, main }
  }
  for (let poll = 0; poll < maxPolls; poll++) {
    const state = await releaseState()
    if (state.state === 'superseded') return { skipped: true, reason: 'newer_gateway_source' }
    if (state.state === 'ready') {
      if (await preflight() !== namespaceId) fail('gateway_namespace_changed')
      // Recheck the alias and refreshed main immediately before the sole write.
      const final = await releaseState()
      if (final.state === 'superseded') return { skipped: true, reason: 'newer_gateway_source' }
      if (final.state === 'ready' && final.production.id === state.production.id) {
        await repository.assertCheckout(sourceCommit)
        const versionId = await deployWorker(sourceCommit, { accountId, cloudflareToken })
        if (!UUID.test(versionId ?? '')) fail('gateway_deploy_receipt_missing')
        const { deployments } = await cloudflare(`scripts/${WORKER}/deployments`)
        const versions = deployments?.[0]?.versions
        if (!Array.isArray(versions) || versions.length !== 1 || versions[0].version_id !== versionId || versions[0].percentage !== 100) fail('gateway_deployment_not_active')
        if (await preflight() !== namespaceId) fail('gateway_namespace_changed_after_deploy')
        return { skipped: false, sourceCommit, production: final.production, versionId, namespaceId }
      }
    }
    if (poll + 1 < maxPolls) { log('Waiting for the fixed application on the existing production alias'); await wait(30_000) }
  }
  fail('production_release_wait_timeout')
}

async function wranglerDeploy(sourceCommit, { accountId, cloudflareToken }) {
  let stdout
  try {
    // Credentials stay in the child environment; no Vercel token/OIDC bearer is passed to Wrangler.
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'NODE_EXTRA_CA_CERTS']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    const result = await execute(process.execPath, [fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
      'deploy', '--config', CONFIG, '--keep-vars', '--message', `Mikka device gateway ${sourceCommit}`],
    { cwd: ROOT, env: { ...env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: cloudflareToken, CI: 'true', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' }, timeout: 180_000, maxBuffer: 2_000_000 })
    stdout = result.stdout
  } catch { fail('gateway_deploy_failed_or_uncertain') }
  // Do not retry an uncertain provider write, or dump arbitrary CLI output.
  return stdout.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'alexj11324/Mikka'
      || process.env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) fail('reviewed_main_workflow_required')
    const report = await deployGateway({ sourceCommit: process.env.GITHUB_SHA, accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN, vercelToken: process.env.VERCEL_TEAM_TOKEN })
    console.log(JSON.stringify(report))
  } catch (error) {
    console.error(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'gateway_release_failed')
    process.exitCode = 1
  }
}
