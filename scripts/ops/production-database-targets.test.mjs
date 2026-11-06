import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectDatabaseTargets } from './production-database-targets.mjs'

const REPO = 'alexj11324/Mikka'
const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const BRANCH = 'ops/issue1415-production-database-targets'
const GH = 'https://api.github.com/repos/' + REPO
const VERCEL = 'https://api.vercel.com'
const listURL = VERCEL + '/v10/projects/' + PROJECT + '/env?decrypt=false&teamId=' + TEAM
const repository = { id: 1427517699, full_name: REPO, owner: { id: 183887963 } }
const secret = 'NEVER-REPORT-SECRET-CANARY'
function fixture(options = {}) {
  const env = {
    GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: String(repository.id),
    GITHUB_REPOSITORY_OWNER_ID: String(repository.owner.id), GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/' + BRANCH, GITHUB_SHA: '1'.repeat(40), GITHUB_RUN_ID: '123456789',
    GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'github-token-canary', VERCEL_TEAM_TOKEN: 'vercel-token-canary',
    ...options.env,
  }
  const event = { ref: env.GITHUB_REF, after: env.GITHUB_SHA, deleted: false, repository }
  const targets = [
    { id: 'env_database', key: 'DATABASE_URL', target: ['production'], updatedAt: 1794000000000, value: secret },
    { id: 'env_mikka', key: 'MIKKA_DATABASE_URL', target: 'production', updatedAt: 1794000000001, value: secret },
  ]
  const envs = [
    ...Array.from({ length: 130 }, (_, i) => ({ id: 'preview_' + i, key: 'DATABASE_URL', target: ['preview'], gitBranch: 'main', value: secret })),
    ...targets,
    { id: 'unrelated_secret', key: 'UNRELATED_SECRET', target: ['production'], value: secret },
  ]
  if (options.duplicate) envs.push({ ...targets[0], id: 'env_duplicate' })
  if (options.missing) envs.splice(envs.indexOf(targets[1]), 1)
  if (options.badId) targets[0].id = '../unrelated_secret'
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init })
    assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    const response = (body, status = 200) => {
      const result = Response.json(body, { status })
      Object.defineProperty(result, 'url', { value: url })
      return result
    }
    if (url.startsWith(GH)) {
      assert.equal(init.headers.Authorization, 'Bearer ' + env.GH_TOKEN)
      if (url === GH + '/actions/runs/' + env.GITHUB_RUN_ID) return response({
        id: Number(env.GITHUB_RUN_ID), event: 'push', head_branch: BRANCH, head_sha: env.GITHUB_SHA,
        run_attempt: 1, path: options.wrongRun ? '.github/workflows/unrelated.yml' : '.github/workflows/issue1415-production-database-targets.yml',
        status: 'in_progress', repository, head_repository: repository,
      })
      assert.equal(url, GH + '/issues/1415')
      return response({ number: 1415, state: options.issueClosed ? 'closed' : 'open', repository_url: GH })
    }
    assert.equal(new URL(url).origin, VERCEL)
    assert.equal(init.headers.Authorization, 'Bearer ' + env.VERCEL_TEAM_TOKEN)
    if (url === listURL) return response({
      envs, hiddenProductionEnvCount: options.hidden ? 1 : 0,
      ...(options.next ? { pagination: { next: 1794000000000 } } : {}),
    })
    const index = targets.findIndex(row => url === VERCEL + '/v1/projects/' + PROJECT + '/env/' + row.id + '?teamId=' + TEAM)
    assert.notEqual(index, -1, 'Only the two selected exact variable IDs may be decrypted')
    if (options.transportError) throw new Error(secret)
    if (options.httpFailure) return response({ secret }, 503)
    const row = targets[index]
    return response({
      ...row, decrypted: true,
      value: options.invalidURL ? '"' + secret + '"' :
        'postgresql://private-user:' + secret + '@ep-fixture.example.test:' + (index ? '5433' : '5432') +
        '/' + (index ? 'auth_fixture' : 'workspace_fixture') + '?sslmode=require&private=' + secret,
      ...(options.changed === 'id' ? { id: 'not_selected' } : {}),
      ...(options.changed === 'key' ? { key: 'UNRELATED_SECRET' } : {}),
      ...(options.changed === 'target' ? { target: ['preview'] } : {}),
      ...(options.changed === 'updatedAt' ? { updatedAt: row.updatedAt + 1 } : {}),
    })
  }
  return { env, event, fetchImpl, calls }
}
const inspect = f => inspectDatabaseTargets({ env: f.env, event: f.event, fetchImpl: f.fetchImpl })
const vercelCalls = f => f.calls.filter(call => call.url.startsWith(VERCEL))
function privateValuesAbsent(report) {
  const output = JSON.stringify(report)
  for (const value of [secret, 'private-user', 'sslmode', 'postgresql://', 'github-token-canary', 'vercel-token-canary',
    'env_database', 'env_mikka', 'UNRELATED_SECRET', 'preview_']) assert.equal(output.includes(value), false)
}

test('only two production IDs are decrypted after a full metadata response, and output contains only target fields', async () => {
  const f = fixture(), report = await inspect(f)
  assert.equal(report.status, 'inspected')
  assert.equal(report.businessExecutionVerified, false)
  assert.equal(report.deploymentBindingVerified, false)
  assert.equal(report.configurationScope, 'current-project-production-configuration')
  assert.equal(report.metadataComplete, true)
  assert.equal(report.selectedVariableCount, 2)
  assert.equal(report.decryptedVariableCount, 2)
  assert.deepEqual(report.targets, [
    { key: 'DATABASE_URL', host: 'ep-fixture.example.test', port: 5432, database: 'workspace_fixture', updatedAt: 1794000000000 },
    { key: 'MIKKA_DATABASE_URL', host: 'ep-fixture.example.test', port: 5433, database: 'auth_fixture', updatedAt: 1794000000001 },
  ])
  assert.equal(f.calls.length, 5)
  assert.equal(vercelCalls(f).length, 3)
  assert.equal(vercelCalls(f)[0].url, listURL)
  assert.ok(f.calls.every(call => call.method === 'GET' && !call.url.includes('app.aspectlylabs.com')))
  privateValuesAbsent(report)
})
test('production metadata must be unique and complete before any variable is decrypted', async () => {
  for (const options of [{ duplicate: true }, { missing: true }, { badId: true }, { hidden: true }, { next: true }]) {
    const f = fixture(options), report = await inspect(f)
    assert.equal(report.status, 'failed')
    assert.ok(['production_variable_not_unique', 'metadata_incomplete'].includes(report.code))
    assert.equal(report.decryptedVariableCount, 0)
    assert.equal(vercelCalls(f).length, 1)
    privateValuesAbsent(report)
  }
})
test('the fetched variable must preserve its selected key, ID, production scope and update identity', async () => {
  for (const changed of ['id', 'key', 'target', 'updatedAt']) {
    const f = fixture({ changed }), report = await inspect(f)
    assert.equal(report.status, 'failed')
    assert.equal(report.code, 'variable_identity_changed')
    assert.equal(report.targets.length, 0)
    assert.equal(vercelCalls(f).length, 2)
    privateValuesAbsent(report)
  }
})
test('invalid URL and remote failures preserve only closed codes, never response or credential text', async () => {
  for (const [options, code] of [
    [{ invalidURL: true }, 'database_url_invalid'],
    [{ transportError: true }, 'http_transport_failed'],
    [{ httpFailure: true }, 'http_status_failed'],
  ]) {
    const f = fixture(options), report = await inspect(f)
    assert.equal(report.status, 'failed')
    assert.equal(report.code, code)
    assert.equal(report.targets.length, 0)
    privateValuesAbsent(report)
  }
})
test('wrong real context, closed issue and CLI arguments cannot reach the platform API', async () => {
  for (const options of [{ env: { GITHUB_RUN_ATTEMPT: '2' } }, { env: { GITHUB_EVENT_NAME: 'pull_request' } },
    { wrongRun: true }, { issueClosed: true }]) {
    const f = fixture(options), report = await inspect(f)
    assert.equal(report.status, 'failed')
    assert.equal(vercelCalls(f).length, 0)
    privateValuesAbsent(report)
  }
  const cwd = await mkdtemp(join(tmpdir(), 'mikka-target-inspection-'))
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./production-database-targets.mjs', import.meta.url)), 'extra'], {
      cwd, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH },
    })
    assert.equal(result.status, 1)
    const report = JSON.parse(await readFile(join(cwd, 'production-database-targets-report/report.json'), 'utf8'))
    assert.equal(report.code, 'arguments_rejected')
    assert.equal(report.selectedVariableCount, 0)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
