/** An explicit acceptance target; it never changes the release/current-main gates. */
import { ORIGIN, REPOSITORY, successfulRelease } from './project-decisions.mjs'
import { api as vercelRead, activeAlias, PROJECT, PRODUCTION_ALIAS, TEAM } from '../ops/deployment-regression.mjs'

export const DEPLOYED_TARGET_MODE = 'deployed-target'
export const DEPLOYED_WORKFLOW = '.github/workflows/issue1415-deployed-production.yml'
const API = 'https://api.github.com/repos/' + REPOSITORY
const OWNER = 'alexj11324'
const SHA = /^[a-f0-9]{40}$/
const DEPLOYMENT = /^dpl_[A-Za-z0-9]+$/
const CODES = new Set(['target_configuration', 'target_driver', 'target_issue', 'target_web',
  'target_attestation', 'target_changed', 'target_unproven'])
const DETAILS = new Set(['mode', 'repository', 'event', 'workflow', 'driver_identity', 'inputs', 'credentials',
  'driver_metadata', 'issue_metadata', 'issue_closed', 'web_metadata', 'web_jobs', 'web_steps', 'web_attempt',
  'attestation_identity', 'attestation_shape', 'public_version', 'alias', 'deployment', 'transport', 'response', 'unexpected'])

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
  check(inputs && Object.keys(inputs).sort().join(',') === 'application_sha,deployment_id,web_run_id'
    && SHA.test(inputs.application_sha ?? '') && integerText(inputs.web_run_id)
    && DEPLOYMENT.test(inputs.deployment_id ?? '') && inputs.application_sha === env.APPLICATION_SHA
    && inputs.web_run_id === env.WEB_DEPLOY_RUN_ID && inputs.deployment_id === env.VERCEL_DEPLOYMENT_ID,
  'target_configuration', 'inputs')
  return { targetMode: DEPLOYED_TARGET_MODE, trigger: 'workflow_dispatch', mode: 'readonly',
    applicationSha: inputs.application_sha, driverRevision: env.GITHUB_SHA,
    driverRunId: Number(env.GITHUB_RUN_ID), driverRunAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    webDeployRunId: Number(inputs.web_run_id), deploymentId: inputs.deployment_id }
}

function readers(env, fetchImpl) {
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0
    && typeof env.VERCEL_TEAM_TOKEN === 'string' && env.VERCEL_TEAM_TOKEN.length > 0,
  'target_configuration', 'credentials')
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
  return { github: path => json(API + path, true), version: () => json(ORIGIN + '/mikka/api/version'),
    vercel: async path => {
      try { return await vercelRead(path, { token: env.VERCEL_TEAM_TOKEN, fetchImpl }) }
      catch (cause) { throw new DeployedTargetError('target_unproven', { detail: 'transport', cause }) }
    } }
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

export async function webPublication(read, guard) {
  const run = await read.github('/actions/runs/' + guard.webDeployRunId)
  check(run?.id === guard.webDeployRunId && positive(run.run_attempt) && run.event === 'push'
    && run.repository?.full_name === REPOSITORY && run.repository.owner?.login === OWNER
    && run.url === API + '/actions/runs/' + guard.webDeployRunId
    && successfulRelease([run], guard.applicationSha, 'web') !== null,
  'target_web', 'web_metadata')
  const result = await read.github('/actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs?per_page=100')
  const jobs = result?.jobs
  check(Array.isArray(jobs) && result.total_count === jobs.length, 'target_web', 'web_jobs')
  const matches = jobs.filter(job => job.name === 'deploy' && job.run_id === run.id && job.head_sha === guard.applicationSha)
  const job = matches[0]
  check(matches.length === 1 && positive(job.id) && job.status === 'completed' && job.conclusion === 'success',
    'target_web', 'web_jobs')
  const steps = ['Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
    'Verify the public production version before releasing the deployment queue']
  check(steps.every(name => job.steps?.filter(step => step.name === name
    && step.status === 'completed' && step.conclusion === 'success').length === 1), 'target_web', 'web_steps')
  return { webAttempt: run.run_attempt, webDeployJobId: job.id }
}

export async function verifyVercelDeploymentState(read, guard) {
  const pin = async () => check((await read.version())?.build === guard.applicationSha, 'target_changed', 'public_version')
  const alias = async () => {
    let value
    try { value = activeAlias(await read.vercel('/v4/aliases/' + PRODUCTION_ALIAS)) }
    catch (cause) {
      if (cause instanceof DeployedTargetError) throw cause
      throw new DeployedTargetError('target_unproven', { detail: 'alias', cause })
    }
    check(value.deploymentId === guard.deploymentId, 'target_changed', 'alias')
  }
  await pin(); await alias()
  const value = await read.vercel('/v13/deployments/' + encodeURIComponent(guard.deploymentId))
  const id = value?.id ?? value?.uid
  const project = value?.projectId ?? value?.project?.id
  const sha = value?.gitSource?.sha ?? value?.meta?.githubCommitSha
  check(id === guard.deploymentId && project === PROJECT && value.readyState === 'READY' && value.target === 'production'
    && sha === guard.applicationSha
    && (!value.projectId || !value.project?.id || value.projectId === value.project.id)
    && (!value.meta?.githubCommitSha || value.meta.githubCommitSha === sha)
    && (!value.teamId || value.teamId === TEAM) && (!value.ownerId || value.ownerId === TEAM),
  'target_changed', 'deployment')
  await pin(); await alias()
}

/** No current-main comparison: the successful normal Web run and active immutable deployment are the target proof. */
export async function attestDeployedTarget({ env = process.env, event, fetchImpl = fetch, now = Date.now } = {}) {
  const guard = deployedTargetGuard(env, event), read = readers(env, fetchImpl)
  await driverAndIssue(read, guard)
  const publication = await webPublication(read, guard)
  await verifyVercelDeploymentState(read, guard)
  return { purpose: 'production-deployed-target', repository: REPOSITORY, ...guard, ...publication,
    projectId: PROJECT, teamId: TEAM, issueNumber: 1415, issueState: 'open', status: 'ready',
    metadataReadAuthorized: true, readable: true, executionReady: false, checkedAt: new Date(now()).toISOString() }
}

/** A file cannot grant authority. Bind it to this real driver, then repeat the live read-only proof. */
export async function assertDeployedTarget({ env = process.env, event, attestation, fetchImpl = fetch, now = Date.now } = {}) {
  const guard = deployedTargetGuard(env, event)
  check(Object.entries(guard).every(([key, value]) => attestation?.[key] === value),
    'target_attestation', 'attestation_identity')
  check(attestation?.purpose === 'production-deployed-target' && attestation.repository === REPOSITORY
    && attestation.projectId === PROJECT && attestation.teamId === TEAM && attestation.issueNumber === 1415
    && attestation.issueState === 'open' && attestation.status === 'ready'
    && attestation.metadataReadAuthorized === true && attestation.readable === true && attestation.executionReady === false
    && positive(attestation.webAttempt) && positive(attestation.webDeployJobId)
    && Number.isFinite(Date.parse(attestation.checkedAt)) && Date.parse(attestation.checkedAt) <= now(),
  'target_attestation', 'attestation_shape')
  const current = await attestDeployedTarget({ env, event, fetchImpl, now })
  check(current.webAttempt === attestation.webAttempt && current.webDeployJobId === attestation.webDeployJobId,
    'target_changed', 'web_attempt')
  return current
}
