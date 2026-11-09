// Exact current-main Web deployment, before the existing smoke credentials.
import { successfulRelease } from './project-decisions.mjs'

export const CORE_MODE = 'self-hosted-core'
export const CORE_WORKFLOW = '.github/workflows/self-hosted-production.yml'
export const CORE_ISSUES = Object.freeze([1560, 1561, 1562, 1556, 1820])
export const CORE_ORIGIN = 'https://app.aspectlylabs.com'
const REPOSITORY = 'alexj11324/Mikka'
const API = 'https://api.github.com/repos/' + REPOSITORY
const SHA = /^[a-f0-9]{40}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const integerText = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && positive(Number(value))
const codes = new Set(['core_configuration', 'core_driver', 'core_issue', 'core_release', 'core_target_changed', 'core_attestation', 'core_read_failed'])
const details = new Set(['mode', 'repository', 'workflow', 'event', 'identity', 'token', 'driver', 'issue', 'main', 'version', 'web', 'jobs', 'steps', 'attestation', 'transport', 'response'])

export class CoreProductionError extends Error {
  constructor(code, detail, options) {
    super(codes.has(code) ? code : 'core_read_failed', options)
    this.name = 'CoreProductionError'; this.code = this.message
    this.detail = details.has(detail) ? detail : 'response'
  }
}
const check = (value, code, detail) => { if (!value) throw new CoreProductionError(code, detail) }
export const coreTargetFailure = error => error instanceof CoreProductionError
  ? { code: error.code, detail: error.detail }
  : { code: 'core_read_failed', detail: 'response' }

export function coreProductionGuard(env, event) {
  check(env.MIKKA_ACCEPTANCE_TARGET_MODE === CORE_MODE, 'core_configuration', 'mode')
  check(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REPOSITORY_OWNER === 'alexj11324'
    && event?.repository?.full_name === REPOSITORY && event.repository.owner?.login === 'alexj11324', 'core_configuration', 'repository')
  check(env.GITHUB_WORKFLOW_REF === REPOSITORY + '/' + CORE_WORKFLOW + '@refs/heads/main', 'core_configuration', 'workflow')
  check(env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_REF === 'refs/heads/main'
    && event.action === 'completed', 'core_configuration', 'event')
  check(SHA.test(env.GITHUB_SHA ?? '') && integerText(env.GITHUB_RUN_ID) && integerText(env.GITHUB_RUN_ATTEMPT), 'core_configuration', 'identity')
  const release = event.workflow_run
  check(positive(release?.id) && release.repository?.full_name === REPOSITORY
    && release.head_repository?.full_name === REPOSITORY && release.event === 'push'
    && release.url === API + '/actions/runs/' + release.id
    && successfulRelease([release], env.GITHUB_SHA, 'web') !== null, 'core_configuration', 'event')
  return { targetMode: CORE_MODE, applicationSha: env.GITHUB_SHA, driverRevision: env.GITHUB_SHA,
    driverRunId: Number(env.GITHUB_RUN_ID), driverRunAttempt: Number(env.GITHUB_RUN_ATTEMPT), webDeployRunId: release.id }
}

export async function attestCoreProduction({ env = process.env, event, fetchImpl = fetch, now = Date.now } = {}) {
  const guard = coreProductionGuard(env, event)
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'core_configuration', 'token')
  const read = async (path, github = true) => {
    const url = (github ? API : CORE_ORIGIN) + path
    let response, result
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/json', 'cache-control': 'no-store', ...(github ? { authorization: 'Bearer ' + env.GH_TOKEN } : {}) } })
    } catch (cause) { throw new CoreProductionError('core_read_failed', 'transport', { cause }) }
    check(response.ok && !response.redirected && (!response.url || response.url === url), 'core_read_failed', 'response')
    try { result = await response.json() }
    catch (cause) { throw new CoreProductionError('core_read_failed', 'response', { cause }) }
    return result
  }
  const driver = await read('/actions/runs/' + guard.driverRunId)
  check(driver?.id === guard.driverRunId && driver.run_attempt === guard.driverRunAttempt
    && driver.repository?.full_name === REPOSITORY && driver.head_repository?.full_name === REPOSITORY
    && driver.url === API + '/actions/runs/' + guard.driverRunId && driver.path === CORE_WORKFLOW
    && driver.event === 'workflow_run' && driver.head_branch === 'main' && driver.head_sha === guard.driverRevision
    && driver.status === 'in_progress' && driver.conclusion === null, 'core_driver', 'driver')
  const issues = await Promise.all(CORE_ISSUES.map(async number => {
    const issue = await read('/issues/' + number)
    check(issue?.number === number && issue.url === API + '/issues/' + number && issue.repository_url === API
      && !issue.pull_request && ['open', 'closed'].includes(issue.state), 'core_issue', 'issue')
    return { number, state: issue.state }
  }))
  const openIssues = issues.filter(issue => issue.state === 'open').map(issue => issue.number)
  const base = { version: 1, purpose: 'self-hosted-core-production', ...guard, openIssues,
    checkedAt: new Date(now()).toISOString() }
  if (!openIssues.length) return { ...base, status: 'skipped', code: 'core_issues_closed', readable: false }
  const pin = async () => {
    const main = await read('/git/ref/heads/main')
    check(main?.ref === 'refs/heads/main' && main.object?.type === 'commit'
      && main.object.sha === guard.applicationSha, 'core_target_changed', 'main')
    check((await read('/mikka/api/version', false))?.build === guard.applicationSha, 'core_target_changed', 'version')
  }
  await pin()
  const release = await read('/actions/runs/' + guard.webDeployRunId)
  check(release?.id === guard.webDeployRunId && positive(release.run_attempt)
    && release.repository?.full_name === REPOSITORY && release.head_repository?.full_name === REPOSITORY
    && release.url === API + '/actions/runs/' + guard.webDeployRunId && release.event === 'push'
    && successfulRelease([release], guard.applicationSha, 'web') !== null, 'core_release', 'web')
  const jobs = await read('/actions/runs/' + release.id + '/attempts/' + release.run_attempt + '/jobs?per_page=100')
  check(Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length, 'core_release', 'jobs')
  const candidates = jobs.jobs.filter(job => job.name === 'deploy' && job.run_id === release.id && job.head_sha === guard.applicationSha)
  const job = candidates[0]
  check(candidates.length === 1 && positive(job.id) && job.status === 'completed' && job.conclusion === 'success', 'core_release', 'jobs')
  check(['Verify the official runtime stays on the cloud edition', 'Build (runs migrations last, as the Vercel build did)',
    'Upload the prebuilt output to production', 'Verify the public production version before releasing the deployment queue']
    .every(name => job.steps?.filter(step => step.name === name && step.status === 'completed' && step.conclusion === 'success').length === 1), 'core_release', 'steps')
  await pin()
  return { ...base, status: 'ready', readable: true, webAttempt: release.run_attempt, webDeployJobId: job.id }
}

export async function assertCoreProductionTarget({ env = process.env, event, attestation, fetchImpl = fetch, now = Date.now } = {}) {
  const guard = coreProductionGuard(env, event), age = now() - Date.parse(attestation?.checkedAt)
  check(attestation?.purpose === 'self-hosted-core-production' && attestation.status === 'ready' && attestation.readable === true
    && Number.isFinite(age) && age >= 0 && age <= 300_000
    && Object.entries(guard).every(([key, value]) => attestation[key] === value), 'core_attestation', 'attestation')
  const fresh = await attestCoreProduction({ env, event, fetchImpl, now })
  check(fresh.status === 'ready', 'core_issue', 'issue')
  check(fresh.webAttempt === attestation.webAttempt && fresh.webDeployJobId === attestation.webDeployJobId, 'core_target_changed', 'web')
  return fresh
}
