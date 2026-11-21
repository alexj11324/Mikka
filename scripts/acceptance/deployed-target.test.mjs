import assert from 'node:assert/strict'
import test from 'node:test'
import { DEPLOYED_WORKFLOW, DeployedTargetError, deployedTargetGuard, attestDeployedTarget,
  assertDeployedTarget, publicTargetFailure } from './deployed-target.mjs'

const REPOSITORY = 'alexj11324/Mikka', API = 'https://api.github.com/repos/' + REPOSITORY
const ORIGIN = 'https://app.aspectlylabs.com', APP = 'a'.repeat(40), DRIVER = 'b'.repeat(40)
const NOW = Date.parse('2026-11-06T12:00:00Z')
const repository = () => ({ full_name: REPOSITORY, owner: { login: 'alexj11324' } })
const context = () => ({
  env: { MIKKA_ACCEPTANCE_TARGET_MODE: 'deployed-target', APPLICATION_SHA: APP,
    GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_OWNER: 'alexj11324',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: REPOSITORY + '/' + DEPLOYED_WORKFLOW + '@refs/heads/main',
    GITHUB_SHA: DRIVER, GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '2',
    GH_TOKEN: 'SYNTHETIC_GITHUB_ONLY' },
  event: { repository: repository(), inputs: { application_sha: APP } },
})

function fixture() {
  const { env, event } = context(), calls = []
  const state = {
    driver: { id: 20, run_attempt: 2, repository: repository(), head_repository: repository(),
      url: API + '/actions/runs/20', path: DEPLOYED_WORKFLOW, event: 'workflow_dispatch',
      head_branch: 'main', head_sha: DRIVER, status: 'in_progress', conclusion: null },
    issue: { number: 1415, url: API + '/issues/1415', repository_url: API, state: 'open' },
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
      value = { [API + '/actions/runs/20']: state.driver, [API + '/issues/1415']: state.issue }[url.href]
      assert.ok(value, 'no current-main, Web deploy or unbound GitHub request: ' + url.pathname)
    } else {
      assert.equal(url.origin, ORIGIN); assert.equal(url.pathname, '/mikka/api/version')
      assert.equal(headers.get('authorization'), null); value = state.version
    }
    return Response.json(value)
  }
  return { env, event, state, calls, fetchImpl,
    boundary: callback => { boundary = callback },
    attest() { return attestDeployedTarget({ env, event, fetchImpl, now: () => NOW }) },
    recheck(attestation) { return assertDeployedTarget({ env, event, attestation, fetchImpl, now: () => NOW }) } }
}
const rejects = async (work, code, detail) => assert.rejects(work, error => {
  assert.ok(error instanceof DeployedTargetError)
  assert.equal(error.code, code); if (detail) assert.equal(error.detail, detail)
  return true
})

test('a real manual driver proves a different deployed application by its live build alone', async () => {
  const f = fixture(), proof = await f.attest()
  assert.equal(proof.driverRevision, DRIVER); assert.equal(proof.applicationSha, APP)
  assert.equal(proof.driverRunId, 20); assert.equal(proof.driverRunAttempt, 2)
  assert.equal(proof.purpose, 'production-deployed-target'); assert.equal(proof.status, 'ready')
  assert.equal(proof.executionReady, false, 'metadata proof is not business execution')
  assert.equal(f.calls.filter(row => row.path === '/mikka/api/version').length, 1)
  assert.equal(f.calls.some(row => row.origin === 'https://api.vercel.com'), false)
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
    event => { event.inputs.web_run_id = '10' }, event => { event.repository.owner.login = 'foreign' }]) {
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

test('only the live public build of the named application authorizes the target', async () => {
  const f = fixture(); f.state.version = { build: DRIVER }
  await rejects(() => f.attest(), 'target_changed', 'public_version')
  const g = fixture(), proof = await g.attest()
  g.state.version = { build: DRIVER }
  await assert.rejects(() => g.recheck(proof), error => {
    assert.deepEqual(publicTargetFailure(error), { status: 'inconclusive', code: 'target_changed', detail: 'public_version' })
    return true
  })
})

test('legacy, foreign-driver and forged target attestations cannot enter a consumer', async () => {
  const f = fixture(), proof = await f.attest()
  for (const patch of [{ purpose: 'production-readiness' }, { targetMode: undefined },
    { driverRevision: APP }, { driverRunId: 21 }, { driverRunAttempt: 3 },
    { applicationSha: DRIVER }, { checkedAt: new Date(NOW + 1).toISOString() }]) {
    const count = f.calls.length
    await rejects(() => f.recheck({ ...proof, ...patch }), 'target_attestation')
    assert.equal(f.calls.length, count, 'invalid file cannot cause live access')
  }
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
