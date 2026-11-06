import assert from 'node:assert/strict'
import test from 'node:test'
import { DEPLOYED_WORKFLOW, DeployedTargetError, deployedTargetGuard, attestDeployedTarget,
  assertDeployedTarget, publicTargetFailure } from './deployed-target.mjs'
import { PROJECT, TEAM, PRODUCTION_ALIAS } from '../ops/deployment-regression.mjs'

const REPOSITORY = 'alexj11324/Mikka', API = 'https://api.github.com/repos/' + REPOSITORY
const ORIGIN = 'https://' + PRODUCTION_ALIAS, APP = 'a'.repeat(40), DRIVER = 'b'.repeat(40)
const DEPLOYMENT = 'dpl_SyntheticTargetOnly', NOW = Date.parse('2026-11-06T12:00:00Z')
const repository = () => ({ full_name: REPOSITORY, owner: { login: 'alexj11324' } })
const context = () => ({
  env: { MIKKA_ACCEPTANCE_TARGET_MODE: 'deployed-target', APPLICATION_SHA: APP,
    WEB_DEPLOY_RUN_ID: '10', VERCEL_DEPLOYMENT_ID: DEPLOYMENT,
    GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_OWNER: 'alexj11324',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: REPOSITORY + '/' + DEPLOYED_WORKFLOW + '@refs/heads/main',
    GITHUB_SHA: DRIVER, GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '2',
    GH_TOKEN: 'SYNTHETIC_GITHUB_ONLY', VERCEL_TEAM_TOKEN: 'SYNTHETIC_VERCEL_ONLY' },
  event: { repository: repository(), inputs: { application_sha: APP, web_run_id: '10', deployment_id: DEPLOYMENT } },
})

function fixture() {
  const { env, event } = context(), calls = []
  const state = {
    driver: { id: 20, run_attempt: 2, repository: repository(), head_repository: repository(),
      url: API + '/actions/runs/20', path: DEPLOYED_WORKFLOW, event: 'workflow_dispatch',
      head_branch: 'main', head_sha: DRIVER, status: 'in_progress', conclusion: null },
    issue: { number: 1415, url: API + '/issues/1415', repository_url: API, state: 'open' },
    web: { id: 10, run_attempt: 1, name: 'Web deploy', path: '.github/workflows/web-deploy.yml',
      url: API + '/actions/runs/10', repository: repository(), head_repository: repository(),
      event: 'push', head_branch: 'main', head_sha: APP, status: 'completed', conclusion: 'success' },
    jobs: { total_count: 1, jobs: [{ id: 30, run_id: 10, name: 'deploy', head_sha: APP,
      status: 'completed', conclusion: 'success', steps: [
        'Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
        'Verify the public production version before releasing the deployment queue',
      ].map(name => ({ name, status: 'completed', conclusion: 'success' })) }] },
    alias: { alias: PRODUCTION_ALIAS, projectId: PROJECT, deploymentId: DEPLOYMENT, updatedAt: NOW - 1000 },
    deployment: { id: DEPLOYMENT, projectId: PROJECT, teamId: TEAM,
      gitSource: { sha: APP }, readyState: 'READY', target: 'production' },
    version: { build: APP },
  }
  let boundary
  const fetchImpl = async (input, init) => {
    const url = new URL(input), headers = new Headers(init.headers)
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
    assert.equal(init.body, undefined); assert.equal(headers.get('cookie'), null)
    calls.push({ origin: url.origin, path: url.pathname, search: url.search })
    if (boundary) { const result = await boundary(url, init); if (result) return result }
    let value
    if (url.origin === 'https://api.github.com') {
      assert.equal(headers.get('authorization'), 'Bearer ' + env.GH_TOKEN)
      const paths = { [API + '/actions/runs/20']: state.driver, [API + '/issues/1415']: state.issue,
        [API + '/actions/runs/10']: state.web,
        [API + '/actions/runs/10/attempts/' + state.web.run_attempt + '/jobs?per_page=100']: state.jobs }
      value = paths[url.href]
      assert.ok(value, 'no current-main or unbound GitHub request: ' + url.pathname)
    } else if (url.origin === 'https://api.vercel.com') {
      assert.equal(headers.get('authorization'), 'Bearer ' + env.VERCEL_TEAM_TOKEN)
      assert.equal(url.searchParams.get('teamId'), TEAM)
      value = url.pathname === '/v4/aliases/' + PRODUCTION_ALIAS ? state.alias
        : url.pathname === '/v13/deployments/' + DEPLOYMENT ? state.deployment : null
      assert.ok(value)
    } else {
      assert.equal(url.origin, ORIGIN); assert.equal(url.pathname, '/mikka/api/version')
      assert.equal(headers.get('authorization'), null); value = state.version
    }
    return Response.json(value)
  }
  return { env, event, state, calls, fetchImpl, now: () => NOW,
    boundary: callback => { boundary = callback },
    attest() { return attestDeployedTarget({ env, event, fetchImpl, now: () => NOW }) },
    recheck(attestation) { return assertDeployedTarget({ env, event, attestation, fetchImpl, now: () => NOW }) } }
}
const rejects = async (work, code, detail) => assert.rejects(work, error => {
  assert.ok(error instanceof DeployedTargetError)
  assert.equal(error.code, code); if (detail) assert.equal(error.detail, detail)
  return true
})

test('a real manual driver proves a different deployed application without reading current main', async () => {
  const f = fixture(), proof = await f.attest()
  assert.equal(proof.driverRevision, DRIVER); assert.equal(proof.applicationSha, APP)
  assert.equal(proof.driverRunId, 20); assert.equal(proof.driverRunAttempt, 2)
  assert.equal(proof.webDeployRunId, 10); assert.equal(proof.webDeployJobId, 30)
  assert.equal(proof.purpose, 'production-deployed-target'); assert.equal(proof.status, 'ready')
  assert.equal(proof.executionReady, false, 'metadata proof is not business execution')
  assert.equal(f.calls.filter(row => row.path === '/mikka/api/version').length, 2)
  assert.equal(f.calls.filter(row => row.path.startsWith('/v4/')).length, 2)
  const before = f.calls.length
  assert.deepEqual(await f.recheck(proof), proof)
  assert.equal(f.calls.length, before * 2, 'a saved attestation does not replace live metadata checks')
})

test('explicit mode binds real repository, workflow dispatch, exact inputs and driver identity', () => {
  for (const [key, value] of Object.entries({ MIKKA_ACCEPTANCE_TARGET_MODE: 'automatic',
    GITHUB_REPOSITORY: 'foreign/Mikka', GITHUB_REPOSITORY_OWNER: 'foreign',
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/ops/test',
    GITHUB_WORKFLOW_REF: REPOSITORY + '/.github/workflows/read-cache-production.yml@refs/heads/main',
    GITHUB_RUN_ID: '020', GITHUB_RUN_ATTEMPT: '0', APPLICATION_SHA: DRIVER })) {
    const c = context(); c.env[key] = value
    assert.throws(() => deployedTargetGuard(c.env, c.event), DeployedTargetError)
  }
  for (const change of [event => { event.inputs.extra = 'x' },
    event => { event.inputs.web_run_id = 10 }, event => { event.repository.owner.login = 'foreign' }]) {
    const c = context(); change(c.event)
    assert.throws(() => deployedTargetGuard(c.env, c.event), DeployedTargetError)
  }
})

test('environment claims cannot replace actual driver metadata or an open issue', async () => {
  for (const patch of [{ run_attempt: 1 }, { head_sha: APP }, { event: 'push' },
    { path: '.github/workflows/read-cache-production.yml' }, { head_branch: 'ops' },
    { repository: { full_name: REPOSITORY, owner: { login: 'foreign' } } }]) {
    const f = fixture(); Object.assign(f.state.driver, patch)
    await rejects(() => f.attest(), 'target_driver', 'driver_metadata')
    assert.equal(f.calls.length, 1)
  }
  const f = fixture(); f.state.issue.state = 'closed'
  await rejects(() => f.attest(), 'target_issue', 'issue_closed')
  assert.equal(f.calls.some(row => row.origin === ORIGIN), false)
})

test('only an actually executed successful normal main Web publication authorizes the target', async () => {
  for (const patch of [{ event: 'workflow_dispatch' }, { head_sha: DRIVER }, { head_branch: 'ops' },
    { path: '.github/workflows/other.yml' }, { conclusion: 'failure' }]) {
    const f = fixture(); Object.assign(f.state.web, patch)
    await rejects(() => f.attest(), 'target_web', 'web_metadata')
  }
  for (let index = 0; index < 3; index++) {
    const f = fixture(); f.state.jobs.jobs[0].steps[index].conclusion = 'skipped'
    await rejects(() => f.attest(), 'target_web', 'web_steps')
  }
  for (const change of [f => { f.state.jobs.total_count = 2 },
    f => { f.state.jobs.jobs[0].head_sha = DRIVER },
    f => { f.state.jobs.jobs.push({ ...f.state.jobs.jobs[0], id: 31 }); f.state.jobs.total_count = 2 }]) {
    const f = fixture(); change(f)
    await rejects(() => f.attest(), 'target_web', 'web_jobs')
  }
})

test('provider identity and both alias/version observations remain pinned', async () => {
  for (const patch of [{ id: 'dpl_Other' }, { projectId: 'prj_Other' }, { readyState: 'BUILDING' },
    { gitSource: { sha: DRIVER } }, { meta: { githubCommitSha: DRIVER } }, { teamId: 'team_Other' }]) {
    const f = fixture(); Object.assign(f.state.deployment, patch)
    await rejects(() => f.attest(), 'target_changed', 'deployment')
  }
  for (const channel of ['alias', 'version']) {
    const f = fixture(); let count = 0
    f.boundary(url => {
      if (channel === 'alias' && url.pathname.startsWith('/v4/') && ++count === 2)
        return Response.json({ ...f.state.alias, deploymentId: 'dpl_ChangedSameSha' })
      if (channel === 'version' && url.pathname === '/mikka/api/version' && ++count === 2)
        return Response.json({ build: DRIVER })
    })
    await rejects(() => f.attest(), 'target_changed', channel === 'alias' ? 'alias' : 'public_version')
  }
})

test('legacy, foreign-driver and forged target attestations cannot enter a consumer', async () => {
  const f = fixture(), proof = await f.attest()
  for (const patch of [{ purpose: 'production-readiness' }, { targetMode: undefined },
    { driverRevision: APP }, { driverRunId: 21 }, { driverRunAttempt: 3 },
    { webDeployRunId: 11 }, { deploymentId: 'dpl_Other' }, { checkedAt: new Date(NOW + 1).toISOString() }]) {
    const count = f.calls.length
    await rejects(() => f.recheck({ ...proof, ...patch }), 'target_attestation')
    assert.equal(f.calls.length, count, 'invalid file cannot cause live access')
  }
})

test('a same-SHA redeployment or a different Web run attempt is inconclusive on recheck', async () => {
  const f = fixture(), proof = await f.attest()
  f.state.alias.deploymentId = 'dpl_OtherSameSha'
  await assert.rejects(() => f.recheck(proof), error => {
    assert.deepEqual(publicTargetFailure(error), { status: 'inconclusive', code: 'target_changed', detail: 'alias' })
    return true
  })
  f.state.alias.deploymentId = DEPLOYMENT; f.state.web.run_attempt = 2
  await rejects(() => f.recheck(proof), 'target_changed', 'web_attempt')
})

test('transport errors retain their cause privately while the public failure stays closed', async () => {
  const f = fixture(), secret = 'SYNTHETIC_PRIVATE_BOUNDARY_VALUE', cause = new Error(secret)
  f.boundary(() => { throw cause })
  await assert.rejects(() => f.attest(), error => {
    assert.equal(error.cause, cause)
    assert.deepEqual(publicTargetFailure(error), { status: 'blocked', code: 'target_unproven', detail: 'transport' })
    assert.equal(JSON.stringify(publicTargetFailure(error)).includes(secret), false)
    return true
  })
  assert.deepEqual(publicTargetFailure(cause), { status: 'blocked', code: 'target_unproven', detail: 'unexpected' })
})
