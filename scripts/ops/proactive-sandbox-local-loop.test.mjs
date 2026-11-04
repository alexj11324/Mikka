import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import { acceptancePlan, requirePinnedSource, run, sandboxProgram, target } from './proactive-sandbox-local-loop.mjs'

// All transport responses and credentials below are synthetic. The embedded
// sandbox program is never executed, and accidental global fetches fail closed.
const originalFetch = globalThis.fetch
globalThis.fetch = () => { throw new Error('Offline contract tests forbid provider I/O') }
after(() => { globalThis.fetch = originalFetch })

const sha = 'a'.repeat(40)
const syntheticToken = 'synthetic-vercel-contract-token'
const syntheticKey = 'synthetic-deepseek-contract-key'
const syntheticCloudKey = 'synthetic-e2b-contract-key'
const projectPath = '/v9/projects/' + target.projectId
const sessionPath = '/v2/sandboxes/sessions/' + target.sessionId
const cmdId = 'cmd_offline123'
const command = (exitCode = null) => ({ id: cmdId, sessionId: target.sessionId, exitCode })
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })

function fixture(options = {}) {
  const clock = { value: 1_800_000_000_000 }
  const calls = [], reports = []
  const env = {
    GITHUB_REPOSITORY: 'alexj11324/Mikka',
    GITHUB_REF: 'refs/heads/acceptance/proactive-1157-1163',
    GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_EVENT_NAME: 'push',
    MIKKA_ACCEPTANCE_SOURCE_SHA: sha,
    VERCEL_TEAM_TOKEN: syntheticToken, DEEPSEEK_API_KEY: syntheticKey, E2B_API_KEY: syntheticCloudKey,
    ...options.env,
  }
  const fetchImpl = async (url, init) => {
    const request = { url: new URL(url), ...init, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(request)
    assert.equal(request.url.origin, target.api)
    assert.equal(request.url.searchParams.get('teamId'), target.teamId)
    const intercepted = await options.intercept?.(request, calls)
    if (intercepted !== undefined) return intercepted
    if (request.url.pathname === projectPath) return response({ id: target.projectId, name: target.projectName, accountId: target.teamId, ...options.project })
    if (request.url.pathname === sessionPath) return response({ session: {
      id: target.sessionId, projectId: target.projectId, status: 'running',
      startedAt: clock.value, timeout: target.hardTimeout + 120_000, ...options.session,
    }, routes: [] })
    if (request.url.pathname === sessionPath + '/cmd' && request.method === 'POST') return response({ command: command() })
    if (request.url.pathname === sessionPath + '/cmd/' + cmdId && request.method === 'GET') return response({ command: command(0) })
    throw new Error('Unexpected offline request')
  }
  return {
    calls, reports, env,
    execute: () => run({ env, fetchImpl, report: value => reports.push(value), now: () => clock.value,
      sleep: async ms => { clock.value += options.sleepAdvance ?? ms } }),
  }
}

test('missing credentials and incorrect runner or credential scope never submit a command', async () => {
  for (const env of [
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'someone/Mikka' }, { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_ACTIONS: undefined }, { CI: 'false' },
  ]) {
    const f = fixture({ env })
    assert.equal((await f.execute()).status, 'runner_boundary_rejected')
    assert.equal(f.calls.length, 0)
  }
  for (const name of ['VERCEL_TEAM_TOKEN', 'DEEPSEEK_API_KEY', 'E2B_API_KEY']) {
    for (const value of [undefined, '', ' ', 'invalid\ncredential']) {
      const f = fixture({ env: { [name]: value } })
      assert.equal((await f.execute()).status, 'credential_missing')
      assert.equal(f.calls.length, 0)
    }
  }
  const denied = fixture({ intercept: request => request.url.pathname === projectPath ? response({}, 403) : undefined })
  assert.equal((await denied.execute()).status, 'provider_request_rejected')
  assert.equal(denied.calls.length, 1)
  assert.equal(denied.calls[0].method, 'GET')
})

test('project, team, session and lifetime mismatches stop before submission', async () => {
  for (const project of [{ id: 'prj_other' }, { accountId: 'team_other' }, { name: 'other' }]) {
    const f = fixture({ project })
    assert.equal((await f.execute()).status, 'project_boundary_rejected')
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  }
  for (const session of [{ id: 'sbx_other' }, { projectId: 'prj_other' }, { status: 'stopped' }]) {
    const f = fixture({ session })
    assert.equal((await f.execute()).status, 'sandbox_boundary_rejected')
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  }
  for (const session of [{ timeout: 1 }, { startedAt: 'not-a-time' }]) {
    const f = fixture({ session })
    assert.equal((await f.execute()).status, 'sandbox_lifetime_insufficient')
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  }
})

test('the existing sandbox must have the full 90-minute budget plus cleanup grace remaining', async () => {
  const requiredLifetime = 91 * 60_000
  assert.equal(target.hardTimeout + acceptancePlan.cleanupGrace, requiredLifetime)
  const tooShort = fixture({ session: { timeout: requiredLifetime - 1 } })
  assert.equal((await tooShort.execute()).status, 'sandbox_lifetime_insufficient')
  assert.equal(tooShort.calls.filter(call => call.method === 'POST').length, 0)
  const enough = fixture({ session: { timeout: requiredLifetime } })
  assert.equal((await enough.execute()).status, 'passed')
  assert.equal(enough.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(enough.calls.find(call => call.method === 'POST').url.pathname, sessionPath + '/cmd')
  assert.equal(target.sessionId, 'sbx_qjiHsJWkPvJAC8afDreaZn5T4CFV')
})

test('the fixed 1–8 plan retains bounded shutdown, fresh setup and exclusive local ownership', async () => {
  assert.deepEqual(acceptancePlan, {
    items: [1, 2, 3, 4, 5, 6, 7, 8], softTimeout: 85 * 60_000, killTimeout: 88 * 60_000,
    hardTimeout: 90 * 60_000, cleanupGrace: 60_000,
  })
  assert.ok(Object.isFrozen(acceptancePlan) && Object.isFrozen(acceptancePlan.items))
  const f = fixture({ env: { LOCAL_LOOP_ITEMS: '1,2,3,7', LOCAL_LOOP_HOLD: '1' } })
  assert.equal((await f.execute()).status, 'passed')
  const post = f.calls.find(call => call.method === 'POST')
  assert.equal(post.body.timeout, 90 * 60_000)
  assert.deepEqual(post.body.env, { DEEPSEEK_API_KEY: syntheticKey, E2B_API_KEY: syntheticCloudKey })
  assert.ok(sandboxProgram.includes('const acceptancePlan = ' + JSON.stringify(acceptancePlan)))
  assert.ok(sandboxProgram.includes("LOCAL_LOOP_ITEMS: acceptancePlan.items.join(',')"))
  assert.ok(sandboxProgram.includes('setTimeout(stopChild, acceptancePlan.softTimeout)'))
  assert.ok(sandboxProgram.includes('}, acceptancePlan.killTimeout)'))
  assert.ok(sandboxProgram.includes("process.kill(-child.pid, 'SIGTERM')"))
  assert.ok(sandboxProgram.includes("process.kill(-child.pid, 'SIGKILL')"))
  assert.ok(sandboxProgram.includes('items: acceptancePlan.items'))
  assert.ok(sandboxProgram.includes("acceptance-dispatch.lock'), 'wx', 0o600"))
  assert.ok(sandboxProgram.includes("assert.ok(!process.env.MIKKA_TEST_ENVIRONMENT_FILE"))
  const spawnLine = sandboxProgram.split('\n').find(line => line.includes('child = spawn('))
  assert.ok(spawnLine?.includes('scripts/dev-local/acceptance.mjs'))
  assert.equal(spawnLine.includes('--existing'), false)
})

test('the workflow budgets 100 minutes and requires an explicit source pin before any dispatch', async () => {
  // Support both this scratch draft and its exact installed acceptance-branch layout.
  const draft = new URL('./proactive-sandbox-local-loop.workflow.yml', import.meta.url)
  const workflow = readFileSync(existsSync(draft) ? draft : new URL('../../.github/workflows/proactive-acceptance.yml', import.meta.url), 'utf8')
  assert.match(workflow, /^  timeout-minutes: 100$/m)
  assert.match(workflow, /^  cancel-in-progress: false$/m)
  assert.match(workflow, /^    branches: \[acceptance\/proactive-1157-1163\]$/m)
  const sourcePin = workflow.match(/^        MIKKA_ACCEPTANCE_SOURCE_SHA: (\S+)$/m)?.[1]
  assert.ok(sourcePin === 'REPLACE_WITH_FINAL_REVIEWED_40_CHARACTER_SOURCE_SHA' || /^[a-f0-9]{40}$/.test(sourcePin ?? ''))
  const f = fixture({ env: { MIKKA_ACCEPTANCE_SOURCE_SHA: 'REPLACE_WITH_FINAL_REVIEWED_40_CHARACTER_SOURCE_SHA' } })
  assert.equal((await f.execute()).status, 'source_sha_required')
  assert.equal(f.calls.length, 0)
})

test('only the coding and cloud credentials enter the command environment; wait:false has no logs property', async () => {
  const f = fixture({ env: { BETTER_AUTH_SECRET: 'synthetic-private-auth', DATABASE_URL: 'synthetic-private-db', NODE_OPTIONS: 'synthetic-private-options' } })
  assert.equal((await f.execute()).status, 'passed')
  const post = f.calls.find(call => call.method === 'POST')
  assert.equal(post.url.pathname, sessionPath + '/cmd')
  assert.equal(post.headers.Authorization, 'Bearer ' + syntheticToken)
  assert.equal(post.redirect, 'error')
  assert.deepEqual(post.body.env, { DEEPSEEK_API_KEY: syntheticKey, E2B_API_KEY: syntheticCloudKey })
  assert.equal(post.body.cwd, target.cwd)
  assert.equal(post.body.sudo, false)
  assert.equal(post.body.wait, false)
  assert.equal(Object.hasOwn(post.body, 'logs'), false)
  assert.equal(post.body.timeout, target.hardTimeout)
  const bodyWithoutEnv = JSON.stringify({ ...post.body, env: undefined })
  for (const secret of [syntheticToken, syntheticKey, syntheticCloudKey, 'synthetic-private-auth', 'synthetic-private-db', 'synthetic-private-options']) {
    assert.equal(bodyWithoutEnv.includes(secret), false)
    assert.equal(JSON.stringify(f.reports).includes(secret), false)
    assert.equal(post.url.href.includes(secret), false)
  }
})

test('the explicit immutable source pin reaches node eval argv[1] and rejects dirty or different source', async () => {
  for (const value of [undefined, '', 'main', 'b'.repeat(39), 'B'.repeat(40)]) {
    const f = fixture({ env: { MIKKA_ACCEPTANCE_SOURCE_SHA: value } })
    assert.equal((await f.execute()).status, 'source_sha_required')
    assert.equal(f.calls.length, 0)
  }
  const git = ({ root = target.cwd, head = sha, status = '' } = {}) => (...args) => {
    if (args.join(' ') === 'rev-parse --show-toplevel') return root
    if (args.join(' ') === 'rev-parse HEAD') return head
    if (args.join(' ') === 'status --porcelain --untracked-files=normal') return status
    throw new Error('Unexpected source check')
  }
  assert.doesNotThrow(() => requirePinnedSource(git(), sha, target.cwd))
  for (const state of [{ root: '/different' }, { head: 'b'.repeat(40) }, { status: ' M lib/example.ts' }, { status: '?? unexpected.txt' }]) {
    assert.throws(() => requirePinnedSource(git(state), sha, target.cwd), /sandbox_source_rejected/)
  }
  assert.ok(sandboxProgram.includes(requirePinnedSource.toString()), 'remote program uses the tested source guard')
  const f = fixture()
  await f.execute()
  const args = f.calls.find(call => call.method === 'POST').body.args
  assert.deepEqual(args, ['--input-type=module', '--eval', sandboxProgram, sha])
  // Verify Node's real eval argument convention with a harmless local program.
  assert.equal(execFileSync(process.execPath, [args[0], args[1], 'process.stdout.write(process.argv[1])', args[3]], { encoding: 'utf8' }), sha)
})

test('an unknown submission outcome is never submitted again or treated as success', async () => {
  const outcomes = [
    () => { throw new TypeError('synthetic lost transport') },
    () => { throw new DOMException('synthetic timeout', 'TimeoutError') },
    () => new Response('not JSON'),
    () => response({}),
    () => response({ command: { ...command(), id: 'wrong' } }),
    () => response({ command: { ...command(), sessionId: 'sbx_other' } }),
  ]
  for (const outcome of outcomes) {
    const f = fixture({ intercept: request => request.method === 'POST' ? outcome() : undefined })
    assert.deepEqual(await f.execute(), { cmdId: null, status: 'submission_unknown_no_retry', exitCode: 1 })
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(f.calls.at(-1).method, 'POST')
  }
})

test('only a bound integer zero exit passes; read-only waits are bounded and never resubmit', async () => {
  let polls = 0
  const success = fixture({ intercept: request => {
    if (!request.url.pathname.includes('/cmd/')) return undefined
    assert.equal(request.url.searchParams.get('wait'), 'true')
    polls++
    if (polls === 1) throw new DOMException('synthetic pending wait', 'TimeoutError')
    return response({ command: command(polls === 2 ? null : 0) })
  } })
  assert.deepEqual(await success.execute(), { cmdId, status: 'passed', exitCode: 0 })
  assert.equal(polls, 3)
  assert.equal(success.calls.filter(call => call.method === 'POST').length, 1)
  assert.deepEqual(success.reports, [{ cmdId, status: 'submitted' }, { cmdId, status: 'passed' }])
  for (const [value, expected] of [[7, 'failed'], ['0', 'command_response_invalid']]) {
    const f = fixture({ intercept: request => request.url.pathname.includes('/cmd/') ? response({ command: command(value) }) : undefined })
    assert.equal((await f.execute()).status, expected)
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  }
  const wrong = fixture({ intercept: request => request.url.pathname.includes('/cmd/') ? response({ command: { ...command(0), sessionId: 'sbx_other' } }) : undefined })
  assert.equal((await wrong.execute()).status, 'command_boundary_rejected')
  const timeout = fixture({ sleepAdvance: target.hardTimeout + 60_001 })
  assert.equal((await timeout.execute()).status, 'command_wait_timeout')
  assert.equal(timeout.calls.filter(call => call.method === 'POST').length, 1)
})
