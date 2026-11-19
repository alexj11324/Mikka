/** An explicit acceptance target; it never changes the release/current-main gates.
 * Per-service releases publish no Web deploy run: the live /mikka/api/version
 * build is the whole target proof. */
import { ORIGIN, REPOSITORY } from './project-decisions.mjs'

export const DEPLOYED_TARGET_MODE = 'deployed-target'
export const DEPLOYED_WORKFLOW = '.github/workflows/issue1415-deployed-production.yml'
const API = 'https://api.github.com/repos/' + REPOSITORY
const OWNER = 'alexj11324'
const SHA = /^[a-f0-9]{40}$/
const CODES = new Set(['target_configuration', 'target_driver', 'target_issue',
  'target_attestation', 'target_changed', 'target_unproven'])
const DETAILS = new Set(['mode', 'repository', 'event', 'workflow', 'driver_identity', 'inputs', 'credentials',
  'driver_metadata', 'issue_metadata', 'issue_closed',
  'attestation_identity', 'attestation_shape', 'public_version', 'transport', 'response', 'unexpected'])

export class DeployedTargetError extends Error {
  constructor(code, { detail = 'unexpected', cause } = {}) {
    const safe = CODES.has(code) ? code : 'target_unproven'
    super(safe, cause === undefined ? undefined : { cause })
    this.name = 'DeployedTargetError'; this.code = safe
    this.detail = DETAILS.has(detail) ? detail : 'unexpected'
    this.status = safe === 'target_changed' ? 'inconclusive' : 'blocked'
  }
}
const check = (ok, code, detail) => { if (!ok) throw new DeployedTargetError(code, { detail }) }
export function publicTargetFailure(error) {
  return error instanceof DeployedTargetError
    ? { status: error.status, code: error.code, detail: error.detail }
    : { status: 'blocked', code: 'target_unproven', detail: 'unexpected' }
}
const positive = value => Number.isSafeInteger(value) && value > 0
const integerText = value => typeof value === 'string' && /^[1-9]\d*$/.test(value)
  && positive(Number(value)) && String(Number(value)) === value

/** The real dispatch and the application under test are deliberately different identities. */
export function deployedTargetGuard(env, event) {
  check(env.MIKKA_ACCEPTANCE_TARGET_MODE === DEPLOYED_TARGET_MODE, 'target_configuration', 'mode')
  check(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REPOSITORY_OWNER === OWNER
    && event?.repository?.full_name === REPOSITORY && event.repository.owner?.login === OWNER,
  'target_configuration', 'repository')
  check(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main',
    'target_configuration', 'event')
  check(env.GITHUB_WORKFLOW_REF === REPOSITORY + '/' + DEPLOYED_WORKFLOW + '@refs/heads/main',
    'target_configuration', 'workflow')
  check(SHA.test(env.GITHUB_SHA ?? '') && integerText(env.GITHUB_RUN_ID) && integerText(env.GITHUB_RUN_ATTEMPT),
    'target_configuration', 'driver_identity')
  const inputs = event?.inputs
  check(inputs && Object.keys(inputs).join(',') === 'application_sha'
    && SHA.test(inputs.application_sha ?? '') && inputs.application_sha === env.APPLICATION_SHA,
  'target_configuration', 'inputs')
  return { targetMode: DEPLOYED_TARGET_MODE, trigger: 'workflow_dispatch', mode: 'readonly',
    applicationSha: inputs.application_sha, driverRevision: env.GITHUB_SHA,
    driverRunId: Number(env.GITHUB_RUN_ID), driverRunAttempt: Number(env.GITHUB_RUN_ATTEMPT) }
}

function readers(env, fetchImpl) {
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'target_configuration', 'credentials')
  const json = async (url, github = false) => {
    let response
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json', 'cache-control': 'no-store',
          ...(github ? { authorization: 'Bearer ' + env.GH_TOKEN } : {}) } })
    } catch (cause) { throw new DeployedTargetError('target_unproven', { detail: 'transport', cause }) }
    check(response.ok && !response.redirected && (!response.url || new URL(response.url).origin === new URL(url).origin),
      'target_unproven', 'response')
    try { return await response.json() }
    catch (cause) { throw new DeployedTargetError('target_unproven', { detail: 'response', cause }) }
  }
  return { github: path => json(API + path, true), version: () => json(ORIGIN + '/mikka/api/version') }
}

async function driverAndIssue(read, guard) {
  const driver = await read.github('/actions/runs/' + guard.driverRunId)
  check(driver?.id === guard.driverRunId && driver.run_attempt === guard.driverRunAttempt
    && driver.repository?.full_name === REPOSITORY && driver.repository.owner?.login === OWNER
    && driver.head_repository?.full_name === REPOSITORY && driver.head_repository.owner?.login === OWNER
    && driver.url === API + '/actions/runs/' + guard.driverRunId
    && driver.path === DEPLOYED_WORKFLOW && driver.event === 'workflow_dispatch'
    && driver.head_branch === 'main' && driver.head_sha === guard.driverRevision
    && driver.status === 'in_progress' && driver.conclusion === null,
  'target_driver', 'driver_metadata')
  const issue = await read.github('/issues/1415')
  check(issue?.number === 1415 && issue.url === API + '/issues/1415' && issue.repository_url === API
    && !issue.pull_request && ['open', 'closed'].includes(issue.state), 'target_issue', 'issue_metadata')
  check(issue.state === 'open', 'target_issue', 'issue_closed')
}

export async function verifyLiveBuild(read, guard) {
  check((await read.version())?.build === guard.applicationSha, 'target_changed', 'public_version')
}

/** No current-main comparison: the live public build is the target proof. */
export async function attestDeployedTarget({ env = process.env, event, fetchImpl = fetch, now = Date.now } = {}) {
  const guard = deployedTargetGuard(env, event), read = readers(env, fetchImpl)
  await driverAndIssue(read, guard)
  await verifyLiveBuild(read, guard)
  return { purpose: 'production-deployed-target', repository: REPOSITORY, ...guard,
    issueNumber: 1415, issueState: 'open', status: 'ready',
    metadataReadAuthorized: true, readable: true, executionReady: false, checkedAt: new Date(now()).toISOString() }
}

/** A file cannot grant authority. Bind it to this real driver, then repeat the live read-only proof. */
export async function assertDeployedTarget({ env = process.env, event, attestation, fetchImpl = fetch, now = Date.now } = {}) {
  const guard = deployedTargetGuard(env, event)
  check(Object.entries(guard).every(([key, value]) => attestation?.[key] === value),
    'target_attestation', 'attestation_identity')
  check(attestation?.purpose === 'production-deployed-target' && attestation.repository === REPOSITORY
    && attestation.issueNumber === 1415
    && attestation.issueState === 'open' && attestation.status === 'ready'
    && attestation.metadataReadAuthorized === true && attestation.readable === true && attestation.executionReady === false
    && Number.isFinite(Date.parse(attestation.checkedAt)) && Date.parse(attestation.checkedAt) <= now(),
  'target_attestation', 'attestation_shape')
  return attestDeployedTarget({ env, event, fetchImpl, now })
}
