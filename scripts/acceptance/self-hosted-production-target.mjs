// Exact current main, live at /mikka/api/version, before the existing smoke credentials.
// Per-service releases publish no Web deploy run: the live build is the release proof.

export const CORE_MODE = 'self-hosted-core'
export const CORE_WORKFLOW = '.github/workflows/self-hosted-production.yml'
export const CORE_BUSINESS_ISSUES = Object.freeze([1560, 1561, 1562, 1556, 1826])
// Inbox and Memory can use the exact read-only source proof without selecting Core's
// credential/device business checks or permitting an Infisical account read.
export const CORE_ISSUES = Object.freeze([...CORE_BUSINESS_ISSUES, 1820, 1821])
export const CORE_ORIGIN = 'https://app.aspectlylabs.com'
const REPOSITORY = 'alexj11324/Mikka'
const API = 'https://api.github.com/repos/' + REPOSITORY
const SHA = /^[a-f0-9]{40}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const integerText = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && positive(Number(value))
const codes = new Set(['core_configuration', 'core_driver', 'core_issue', 'core_target_changed', 'core_attestation', 'core_read_failed'])
const details = new Set(['mode', 'repository', 'workflow', 'event', 'identity', 'token', 'driver', 'issue', 'main', 'version', 'attestation', 'transport', 'response'])

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
export const coreBusinessSelected = proof => proof?.status === 'ready' && proof.readable === true
  && Array.isArray(proof.openIssues) && proof.openIssues.some(issue => CORE_BUSINESS_ISSUES.includes(issue))

export function coreProductionGuard(env, event) {
  check(env.MIKKA_ACCEPTANCE_TARGET_MODE === CORE_MODE, 'core_configuration', 'mode')
  check(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REPOSITORY_OWNER === 'alexj11324'
    && event?.repository?.full_name === REPOSITORY && event.repository.owner?.login === 'alexj11324', 'core_configuration', 'repository')
  check(env.GITHUB_WORKFLOW_REF === REPOSITORY + '/' + CORE_WORKFLOW + '@refs/heads/main', 'core_configuration', 'workflow')
  check(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main', 'core_configuration', 'event')
  check(SHA.test(env.GITHUB_SHA ?? '') && integerText(env.GITHUB_RUN_ID) && integerText(env.GITHUB_RUN_ATTEMPT), 'core_configuration', 'identity')
  return { targetMode: CORE_MODE, applicationSha: env.GITHUB_SHA, driverRevision: env.GITHUB_SHA,
    driverRunId: Number(env.GITHUB_RUN_ID), driverRunAttempt: Number(env.GITHUB_RUN_ATTEMPT) }
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
    && driver.event === 'workflow_dispatch' && driver.head_branch === 'main' && driver.head_sha === guard.driverRevision
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
  return { ...base, status: 'ready', readable: true }
}

export async function assertCoreProductionTarget({ env = process.env, event, attestation, fetchImpl = fetch, now = Date.now } = {}) {
  const guard = coreProductionGuard(env, event), age = now() - Date.parse(attestation?.checkedAt)
  check(attestation?.purpose === 'self-hosted-core-production' && attestation.status === 'ready' && attestation.readable === true
    && Number.isFinite(age) && age >= 0 && age <= 300_000
    && Object.entries(guard).every(([key, value]) => attestation[key] === value), 'core_attestation', 'attestation')
  const fresh = await attestCoreProduction({ env, event, fetchImpl, now })
  check(fresh.status === 'ready', 'core_issue', 'issue')
  return fresh
}
