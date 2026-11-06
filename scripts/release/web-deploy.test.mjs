import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, matchesGlob } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildEnvironment, productionSha, verifyProductionBuild, PRODUCTION_VERSION_URL, REQUIRED,
  assertCurrentMain, waitForWebDeployment, deploymentPlan, runtimeRefreshRequired, RUNTIME_RELEASE_PATHS } from './web-deploy.mjs'

const SHA = 'a'.repeat(40)
const pulled = [
  'VERCEL="1"',
  'VERCEL_ENV="production"',
  'VERCEL_GIT_COMMIT_REF=""',
  'DATABASE_URL="postgres://u:p@db.example/app"',
  'MIKKA_DATABASE_URL=""',
  'NEXT_PUBLIC_POSTHOG_KEY=""',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=""',
  'MIKKA_BUILD_BYOS_WORKER="1"',
  'NEXT_PUBLIC_COMPUTER_ENABLED="1"',
  'BETTER_AUTH_SECRET=""',
  'BETTER_AUTH_URL="https://app.example"',
  'NOTE="a \\"quoted\\" value"',
].join('\n')
const job = { GITHUB_SHA: SHA, MIKKA_DATABASE_URL: 'postgres://u:p@db.example/app', NEXT_PUBLIC_POSTHOG_KEY: 'phc_x', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_x', BETTER_AUTH_SECRET: 's3cret', BETTER_AUTH_URL: 'https://other.example', UNRELATED_JOB_SECRET: 'x' }
const read = text => Object.fromEntries(text.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), JSON.parse(line.slice(i + 1))] }))

test('fills sensitive build values from the job and pins the main Git identity', () => {
  const env = read(buildEnvironment(pulled, job))
  assert.equal(env.MIKKA_DATABASE_URL, job.MIKKA_DATABASE_URL)
  assert.equal(env.NEXT_PUBLIC_POSTHOG_KEY, 'phc_x')
  assert.equal(env.VERCEL_GIT_COMMIT_REF, 'main')
  assert.equal(env.VERCEL_GIT_COMMIT_SHA, SHA)
  assert.equal(env.NOTE, 'a "quoted" value')
  assert.equal(env.BETTER_AUTH_URL, 'https://app.example', 'a value Vercel returned is kept')
  assert.equal(env.UNRELATED_JOB_SECRET, undefined, 'keys production does not define are not added')
  for (const key of REQUIRED) assert.ok(env[key], key)
})

test('refuses a build with a missing value and names only the variable', () => {
  assert.throws(() => buildEnvironment(pulled, { ...job, NEXT_PUBLIC_POSTHOG_KEY: '' }), error => {
    assert.equal(error.message, 'webDeploy:missing:NEXT_PUBLIC_POSTHOG_KEY')
    assert.doesNotMatch(error.message, /postgres|pk_live/)
    return true
  })
  assert.throws(() => buildEnvironment(pulled.replace('VERCEL_ENV="production"', 'VERCEL_ENV="preview"'), job), /productionEnvironmentRequired/)
  assert.throws(() => buildEnvironment(pulled, { ...job, GITHUB_SHA: 'main' }), /commitShaRequired/)
})

test('reads the commit production serves through the alias', async () => {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    if (String(url).includes('/v4/aliases/')) return Response.json({ deploymentId: 'dpl_abc' })
    return Response.json({ meta: { githubCommitSha: SHA } })
  }
  assert.equal(await productionSha({ token: 't', fetchImpl }), SHA)
  assert.match(calls[1], /\/v13\/deployments\/dpl_abc\?teamId=team_/)
})

test('public verification waits through an HTTP error and the previous build before recording the exact build', async t => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, cache: request.headers['cache-control'], authorization: request.headers.authorization })
    response.setHeader('content-type', 'application/json')
    if (requests.length === 1) { response.writeHead(503).end('{"build":"' + SHA + '"}'); return }
    response.end(JSON.stringify({ build: requests.length === 2 ? 'b'.repeat(40) : SHA }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const result = await verifyProductionBuild({ expectedBuild: SHA, intervalMs: 5, maxWaitMs: 2_000,
    fetchImpl: (url, init) => {
      assert.equal(url, PRODUCTION_VERSION_URL)
      assert.equal(init.cache, 'no-store')
      return fetch(origin + '/mikka/api/version', init)
    } })
  assert.equal(result.build, SHA)
  assert.equal(result.status, 200)
  assert.equal(result.attempts, 3)
  assert.ok(Number.isFinite(Date.parse(result.verifiedAt)))
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ({ path: '/mikka/api/version', cache: 'no-cache', authorization: undefined })))
})

test('a different public build cannot pass just because its deployment is READY', async () => {
  let elapsed = 0, calls = 0
  await assert.rejects(verifyProductionBuild({ expectedBuild: SHA, maxWaitMs: 60, intervalMs: 20,
    now: () => elapsed, wait: async ms => { elapsed += ms },
    fetchImpl: async () => { calls++; return Response.json({ build: 'b'.repeat(40) }) } }),
  /productionVersionUnverified:expected=a{40}:status=200:build=b{40}:attempts=3/)
  assert.equal(calls, 3)
  assert.equal(elapsed, 60)
})

test('invalid responses and network failures stay bounded and never copy response bodies into errors', async () => {
  for (const fetchImpl of [async () => Response.json({ build: 'untrusted-response-marker' }),
    async () => new Response('untrusted-response-marker', { status: 200 }),
    async () => { throw Error('untrusted-response-marker') }]) {
    let elapsed = 0
    await assert.rejects(verifyProductionBuild({ expectedBuild: SHA, maxWaitMs: 40, intervalMs: 20,
      now: () => elapsed, wait: async ms => { elapsed += ms }, fetchImpl }), error => {
      assert.match(error.message, /productionVersionUnverified/)
      assert.doesNotMatch(error.message, /untrusted-response-marker/)
      return true
    })
    assert.equal(elapsed, 40)
  }
})

test('a moving branch name or invalid budget fails before sending a public request', async () => {
  const fetchImpl = () => { throw Error('must not send a request') }
  await assert.rejects(verifyProductionBuild({ expectedBuild: 'main', fetchImpl }), /commitShaRequired/)
  await assert.rejects(verifyProductionBuild({ expectedBuild: SHA, fetchImpl, maxWaitMs: 0 }), /invalidVerificationWait/)
})

test('an exact response arriving after the monotonic verification deadline cannot pass', async () => {
  let elapsed = 0
  await assert.rejects(verifyProductionBuild({ expectedBuild: SHA, maxWaitMs: 60,
    now: () => elapsed, wait: async () => { throw Error('the deadline has already elapsed') },
    fetchImpl: async () => { elapsed = 61; return Response.json({ build: SHA }) } }), /productionVersionUnverified/)
})

const OTHER = 'b'.repeat(40)
const webRun = overrides => ({ id: 70, run_attempt: 2, head_sha: SHA, head_branch: 'main', path: '.github/workflows/web-deploy.yml',
  repository: { full_name: 'alexj11324/Mikka' }, head_repository: { full_name: 'alexj11324/Mikka' },
  event: 'push', status: 'completed', conclusion: 'success', ...overrides })
const buildJob = overrides => ({ name: 'deploy', head_sha: SHA, status: 'completed', conclusion: 'success',
  steps: ['Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
    'Verify the public production version before releasing the deployment queue'].map(name => ({ name, status: 'completed', conclusion: 'success' })), ...overrides })

function webFixture({ main = () => SHA, runs = () => [webRun()], job = buildJob(), version = () => SHA, overlay = () => undefined, budget = 500 } = {}) {
  let elapsed = 0
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    calls.push({ path: url.pathname, origin: url.origin, method: init.method ?? 'GET', at: elapsed })
    assert.equal(init.redirect, 'error')
    if (url.origin === 'https://api.github.com') {
      assert.equal(init.headers.authorization, 'Bearer read-only-fixture')
      if (url.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { type: 'commit', sha: main(elapsed) } })
      if (url.pathname.endsWith('/actions/workflows/web-deploy.yml/runs')) {
        assert.equal(url.searchParams.get('head_sha'), SHA)
        assert.equal(url.searchParams.get('branch'), 'main')
        return Response.json({ workflow_runs: runs(elapsed) })
      }
      assert.equal(url.pathname, '/repos/alexj11324/Mikka/actions/runs/70/attempts/2/jobs')
      return Response.json({ total_count: 1, jobs: [job] })
    }
    assert.equal(input, PRODUCTION_VERSION_URL)
    assert.equal(init.headers.authorization, undefined)
    assert.equal(init.cache, 'no-store')
    return Response.json({ build: version(elapsed, value => { elapsed = value }), overlaySha: overlay(elapsed) })
  }
  return { calls, run: extra => waitForWebDeployment({ expectedBuild: SHA, token: 'read-only-fixture', fetchImpl,
    now: () => elapsed, wait: async ms => { elapsed += ms }, intervalMs: 100, maxWaitMs: budget, ...extra }), elapsed: () => elapsed }
}

test('waits for a GitHub build while Vercel still only serves the older READY source', async () => {
  const fixture = webFixture({ runs: elapsed => [webRun(elapsed < 200 ? { status: 'in_progress', conclusion: null } : {})],
    version: elapsed => elapsed < 300 ? OTHER : SHA })
  const result = await fixture.run()
  assert.equal(result.sourceCommit, SHA)
  assert.equal(result.webRunId, 70)
  assert.equal(result.webAttempt, 2)
  assert.equal(result.publicBuild, SHA)
  assert.equal(fixture.elapsed(), 300)
  assert.deepEqual(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').map(call => call.at), [200, 300])
  assert.ok(fixture.calls.every(call => call.method === 'GET'))
  assert.ok(fixture.calls.every(call => call.origin !== 'https://api.vercel.com'), 'the lock-free wait does not inspect Vercel build states or mutate configuration')
})

test('main advancing while waiting rejects the obsolete source before another workflow or public read', async () => {
  const fixture = webFixture({ main: elapsed => elapsed >= 100 ? OTHER : SHA, runs: () => [webRun({ status: 'in_progress', conclusion: null })] })
  await assert.rejects(fixture.run(), /mainChanged/)
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/runs')).length, 1)
  assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
})

test('the latest exact Web attempt must succeed; an older success cannot hide its failure or cancellation', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    const fixture = webFixture({ runs: () => [webRun({ id: 69, run_attempt: 1 }), webRun({ conclusion })] })
    await assert.rejects(fixture.run(), /matchingWebRunFailed:70/)
    assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
  }
})

test('a docs-only skipped build or incomplete upload never passes even if public already has that SHA', async () => {
  for (const index of [0, 1, 2]) {
    const job = buildJob()
    job.steps[index].conclusion = 'skipped'
    const fixture = webFixture({ job })
    await assert.rejects(fixture.run(), /matchingWebBuildSkippedOrIncomplete/)
    assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
  }
})

test('another repository, branch or workflow cannot stand in for the matching main Web run', async () => {
  for (const wrong of [{ repository: { full_name: 'other/Mikka' } }, { head_repository: { full_name: 'fork/Mikka' } },
    { path: '.github/workflows/e2b-official-runtime.yml' }, { head_sha: OTHER }, { head_branch: 'other' }]) {
    const fixture = webFixture({ runs: () => [webRun(wrong)], budget: 200 })
    await assert.rejects(fixture.run(), /matchingWebDeploymentTimedOut/)
    assert.equal(fixture.elapsed(), 200)
    assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
  }
})

test('a successful Web run with an old public build has a finite monotonic wait', async () => {
  const fixture = webFixture({ version: () => OTHER, budget: 250 })
  await assert.rejects(fixture.run(), /matchingWebDeploymentTimedOut/)
  assert.equal(fixture.elapsed(), 250)
  assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 3)
})

test('a matching public response after the deadline cannot admit the runtime mutation', async () => {
  const fixture = webFixture({ version: (_elapsed, advance) => { advance(501); return SHA } })
  await assert.rejects(fixture.run(), /matchingWebDeploymentTimedOut/)
})

test('the final read-only fence also rejects a main change during public verification', async () => {
  const fixture = webFixture({ main: elapsed => elapsed ? OTHER : SHA, version: (_elapsed, advance) => { advance(1); return SHA } })
  await assert.rejects(fixture.run(), /mainChanged/)
})

test('invalid source, missing identity or invalid wait fails without any network request', async () => {
  const fetchImpl = async () => assert.fail('no request for an invalid release')
  await assert.rejects(assertCurrentMain({ expectedBuild: 'main', token: 't', fetchImpl }), /commitShaRequired/)
  await assert.rejects(assertCurrentMain({ expectedBuild: SHA, fetchImpl }), /githubTokenRequired/)
  await assert.rejects(waitForWebDeployment({ expectedBuild: SHA, token: 't', maxWaitMs: 0, fetchImpl }), /invalidVerificationWait/)
})

test('GitHub errors do not expose response bodies or transport messages', async () => {
  for (const fetchImpl of [async () => new Response('private-response-marker', { status: 403 }),
    async () => new Response('private-response-marker'), async () => { throw Error('private-response-marker') }]) {
    await assert.rejects(assertCurrentMain({ expectedBuild: SHA, token: 't', fetchImpl }), error => {
      assert.match(error.message, /webDeploy:github/)
      assert.doesNotMatch(error.message, /private-response-marker/)
      return true
    })
  }
})

test('explicit runtime refresh always builds while ordinary docs-only classification is preserved', async () => {
  const noRead = async () => assert.fail('runtime refresh must bypass docs/same-SHA skip')
  assert.deepEqual(await deploymentPlan({ expectedBuild: SHA, runtimeRefresh: true, fetchImpl: noRead, classify: noRead }),
    { skip: false, reason: 'verified runtime refresh' })
  let classified = 0
  const result = await deploymentPlan({ expectedBuild: SHA, token: 't',
    fetchImpl: async url => Response.json(String(url).includes('/aliases/') ? { deploymentId: 'dpl_old' } : { meta: { githubCommitSha: OTHER } }),
    classify: env => { classified++; assert.equal(env.VERCEL_GIT_COMMIT_SHA, SHA); assert.equal(env.VERCEL_GIT_PREVIOUS_SHA, OTHER); return { skip: true, reason: 'docs only' } } })
  assert.deepEqual(result, { skip: true, reason: 'docs only' })
  assert.equal(classified, 1)
})

test('both release paths use one non-cancelling pending queue, and the Web wait remains outside it', () => {
  const web = readFileSync(new URL('../../.github/workflows/web-deploy.yml', import.meta.url), 'utf8')
  const e2b = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(web, /^concurrency:/m, 'caller and reusable job must not acquire the same group twice')
  assert.match(web, /\n    concurrency:\n(?:[^\n]*\n)*?      group: web-deploy-production\n      cancel-in-progress: false\n      queue: max\n/)
  assert.equal((web.match(/group: web-deploy-production/g) ?? []).length, 1)
  const callerQueue = e2b.slice(e2b.indexOf('\nconcurrency:'), e2b.indexOf('\njobs:'))
  assert.match(callerQueue, /cancel-in-progress: false\n  queue: max/)
  assert.match(callerQueue, /e2b-official-runtime-release/)
  assert.doesNotMatch(callerQueue, /web-deploy-production/)
  const waitJob = e2b.slice(e2b.indexOf('\n  await-web:'), e2b.indexOf('\n  subscriptions:'))
  assert.match(waitJob, /actions: read/)
  assert.match(waitJob, /node scripts\/release\/web-deploy\.mjs await-web/)
  assert.doesNotMatch(waitJob, /concurrency:|id-token:|Infisical|publish-template-env\.mjs/)
  assert.match(e2b, /publish:\n    needs: \[validate, await-web, subscriptions\]/)
  assert.match(e2b, /uses: \.\/\.github\/workflows\/web-deploy\.yml/)
  assert.match(e2b, /runtime-refresh: true/)
  assert.match(e2b, /workflow_dispatch:\n    inputs:\n      runtime-refresh:\n        description: [^\n]+\n        type: boolean\n        default: false/)
  assert.match(e2b, /if \[ "\$RUNTIME_REFRESH" = true \] \|\| \[ "\$wanted" != "\$live" \]; then echo "changed=true"/)
  assert.match(e2b, /validate:\n    needs: \[test, check\]\n    if: needs\.check\.outputs\.changed == 'true'/)
  assert.match(e2b, /runtime-worker-sha: \$\{\{ needs\.validate\.outputs\.source-sha \}\}/)
  assert.match(e2b, /runtime-template-models: \$\{\{ needs\.validate\.outputs\.template-models \}\}/)
  const checkJob = e2b.slice(e2b.indexOf('\n  check:'), e2b.indexOf('\n  validate:'))
  assert.match(checkJob, /fetch-depth: 0/)
  const checkGuard = checkJob.indexOf('node scripts/release/web-deploy.mjs main')
  assert.ok(checkGuard >= 0 && checkGuard < checkJob.indexOf('uses: Infisical/'))
  assert.match(checkJob, /RUNTIME_REFRESH: \$\{\{ steps\.control\.outputs\.refresh \}\}/)
  for (const path of RUNTIME_RELEASE_PATHS) assert.ok(e2b.includes(`      - '${path}'`), `main push filter must include ${path}`)
  assert.match(web, /workflow_call:/)
  assert.match(web, /RUNTIME_REFRESH: \$\{\{ inputs\.runtime-refresh \|\| inputs\.overlay-refresh \|\| github\.event_name == 'push' \}\}/)
  // queue:max is GitHub's documented queue contract, not a locally simulated
  // scheduler. Stale jobs still need the main fences regardless of queue order.
})

test('runtime env, build and upload are ordered under the same job with fixed identity and source fences', () => {
  const web = readFileSync(new URL('../../.github/workflows/web-deploy.yml', import.meta.url), 'utf8')
  const publisher = readFileSync(new URL('../e2b/publish-template-env.mjs', import.meta.url), 'utf8')
  const firstGuard = web.indexOf('node scripts/release/web-deploy.mjs main')
  const envWrite = web.indexOf('run: node scripts/e2b/publish-template-env.mjs')
  const build = web.indexOf('run: node scripts/release/build-vercel.mjs')
  const finalGuard = web.lastIndexOf('node scripts/release/web-deploy.mjs main')
  const upload = web.indexOf('deploy --prebuilt --prod')
  assert.ok(firstGuard > 0 && firstGuard < web.indexOf('uses: Infisical/'))
  assert.ok(firstGuard < envWrite && envWrite < build && build < finalGuard && finalGuard < upload)
  assert.doesNotMatch(publisher, /forceNew|method: 'POST'[^\n]*deployments/)
  assert.deepEqual([...new Set([...web.matchAll(/identity-id: (.+)/g)].map(match => match[1]))], ['2cf9fa19-b9db-4c08-8ca0-b31859f2cbac'])
  assert.deepEqual([...new Set([...web.matchAll(/oidc-audience: (.+)/g)].map(match => match[1]))], ['mikka-infisical'])
  assert.deepEqual([...new Set([...web.matchAll(/project-id: (.+)/g)].map(match => match[1]))], ['89850d6a-f020-4936-863e-df77380dfe40'])
})

test('the actual dispatch comparison only bypasses unchanged-hash optimization when explicitly requested', () => {
  const e2b = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
  const condition = e2b.split('\n').find(line => line.trim().startsWith('if [ "$RUNTIME_REFRESH"'))?.trim()
  assert.ok(condition)
  const dir = mkdtempSync(join(tmpdir(), 'runtime-dispatch-'))
  try {
    for (const [refresh, live, changed] of [['', SHA, false], ['false', SHA, false], ['true', SHA, true], ['false', OTHER, true]]) {
      const output = join(dir, `${refresh || 'push'}-${live}`)
      execFileSync('bash', ['-euc', condition], { env: { PATH: process.env.PATH, RUNTIME_REFRESH: refresh, wanted: SHA, live, GITHUB_OUTPUT: output } })
      assert.equal(readFileSync(output, 'utf8'), `changed=${changed}\n`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('release-control refresh validates both immutable push endpoints and never assumes missing history is unchanged', () => {
  const valid = { expectedBuild: SHA, eventName: 'push', event: { before: OTHER, after: SHA, ref: 'refs/heads/main' } }
  for (const event of [{ ...valid.event, before: undefined }, { ...valid.event, before: 'main' }, { ...valid.event, before: '0'.repeat(40) },
    { ...valid.event, after: OTHER }, { ...valid.event, ref: 'refs/heads/other' }]) {
    assert.throws(() => runtimeRefreshRequired({ ...valid, event }, () => assert.fail('invalid source must not reach Git')), /invalidPushSource/)
  }
  assert.throws(() => runtimeRefreshRequired(valid, () => { throw Error('missing history') }), /releaseControlDiffUnavailable/)
  assert.throws(() => runtimeRefreshRequired(valid, () => null), /releaseControlDiffUnavailable/)
  for (const path of RUNTIME_RELEASE_PATHS) assert.equal(runtimeRefreshRequired(valid, () => [path]), true)
  assert.equal(runtimeRefreshRequired(valid, () => ['docs/change.md', 'scripts/release/web-deploy.test.mjs']), false)
})

test('manual runtime refresh defaults off and does not make pull requests eligible', () => {
  const noGit = () => assert.fail('non-push events do not compare Git endpoints')
  assert.equal(runtimeRefreshRequired({ expectedBuild: SHA, eventName: 'workflow_dispatch' }, noGit), false)
  assert.equal(runtimeRefreshRequired({ expectedBuild: SHA, eventName: 'workflow_dispatch', explicit: true }, noGit), true)
  assert.equal(runtimeRefreshRequired({ expectedBuild: SHA, eventName: 'pull_request', explicit: true }, noGit), false)
})

test('real Git and the production CLI compare the entire push, preserve docs-only skip and reject unavailable before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-control-git-'))
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Release fixture', '-c', 'user.email=release@example.invalid', 'commit', '-qm', 'fixture']); return git(['rev-parse', 'HEAD']) }
  const run = (before, after) => {
    const eventPath = join(dir, '.git/event.json'), output = join(dir, '.git/output.txt')
    writeFileSync(eventPath, JSON.stringify({ before, after, ref: 'refs/heads/main' }))
    rmSync(output, { force: true })
    execFileSync(process.execPath, [fileURLToPath(new URL('./web-deploy.mjs', import.meta.url)), 'runtime-refresh'], {
      cwd: dir, env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: after, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return readFileSync(output, 'utf8')
  }
  try {
    git(['init', '-q', '-b', 'main'])
    mkdirSync(join(dir, '.github/workflows'), { recursive: true }); mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, '.github/workflows/web-deploy.yml'), 'name: before\n')
    writeFileSync(join(dir, 'docs/change.md'), 'before\n')
    const before = commit()
    writeFileSync(join(dir, '.github/workflows/web-deploy.yml'), 'name: changed\n'); commit()
    writeFileSync(join(dir, 'docs/change.md'), 'last commit only changes docs\n')
    const after = commit()
    assert.equal(run(before, after), 'refresh=true\n', 'a control change earlier in a multi-commit push is included')
    writeFileSync(join(dir, 'docs/change.md'), 'only docs this push\n')
    const docsAfter = commit()
    assert.equal(run(after, docsAfter), 'refresh=false\n')
    assert.throws(() => run('f'.repeat(40), docsAfter), error => {
      assert.match(String(error.stderr), /webDeploy:releaseControlDiffUnavailable/)
      return true
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function desktopWebFixture({ version = () => OTHER, overlay = () => undefined, main = () => OTHER, budget = 500,
  comparison = (base, head) => ({ url: `https://api.github.com/repos/alexj11324/Mikka/compare/${base}...${head}`,
    base_commit: { sha: base }, merge_base_commit: { sha: base }, status: 'ahead', ahead_by: 1, behind_by: 0 }),
  runs = build => [webRun({ head_sha: build })], job = build => buildJob({ head_sha: build }),
} = {}) {
  let elapsed = 0, activeBuild = null
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    calls.push({ url: String(url), method: init.method ?? 'GET', at: elapsed })
    assert.equal(init.redirect, 'error')
    if (url.origin === 'https://app.aspectlylabs.com') {
      assert.equal(String(url), PRODUCTION_VERSION_URL)
      assert.equal(init.headers.authorization, undefined)
      assert.equal(init.cache, 'no-store')
      activeBuild = version(elapsed, value => { elapsed = value })
      return Response.json({ build: activeBuild, overlaySha: overlay(elapsed) })
    }
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(init.headers.authorization, 'Bearer read-only-fixture')
    if (url.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { type: 'commit', sha: main(elapsed) } })
    if (url.pathname.includes('/compare/')) {
      const [base, head] = url.pathname.split('/compare/')[1].split('...')
      return Response.json(comparison(base, head, elapsed))
    }
    if (url.pathname.endsWith('/actions/workflows/web-deploy.yml/runs')) {
      assert.equal(url.searchParams.get('head_sha'), activeBuild)
      assert.equal(url.searchParams.get('branch'), 'main')
      return Response.json({ workflow_runs: runs(activeBuild, elapsed) })
    }
    const match = /^\/repos\/alexj11324\/Mikka\/actions\/runs\/(70|71)\/attempts\/2\/jobs$/.exec(url.pathname)
    assert.ok(match)
    return Response.json({ total_count: 1, jobs: [job(activeBuild, elapsed, Number(match[1]))] })
  }
  return { calls, run: extra => waitForWebDeployment({ expectedBuild: SHA, allowDescendant: true,
    token: 'read-only-fixture', fetchImpl, now: () => elapsed,
    wait: async ms => { elapsed += ms }, intervalMs: 100, maxWaitMs: budget, ...extra }),
  elapsed: () => elapsed }
}

test('desktop release accepts a deployed descendant while preserving its own source identity', async () => {
  const fixture = desktopWebFixture()
  const result = await fixture.run()
  assert.equal(result.sourceCommit, SHA)
  assert.equal(result.publicBuild, OTHER)
  assert.equal(result.webRunId, 70)
  assert.equal(result.webAttempt, 2)
  assert.ok(fixture.calls.every(call => call.method === 'GET'))
  assert.equal(fixture.calls.some(call => call.url.includes('/git/ref/heads/main')), false,
    'an unrelated later main commit does not invalidate an already deployed descendant')
})

test('desktop releases supersede only the same ref and documentation does not cancel a release', () => {
  const desktop = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8')
  assert.ok(desktop.includes("\nconcurrency:\n  group: ${{ github.ref == 'refs/heads/main' && 'desktop-release' || format('desktop-release-{0}', github.ref) }}\n  cancel-in-progress: true\n"))
  assert.match(desktop, /run: node scripts\/release\/web-deploy\.mjs await-desktop-web/)
  assert.doesNotMatch(desktop, /run: node scripts\/release\/web-deploy\.mjs await-web(?:\s|$)/)
  const paths = [...desktop.slice(desktop.indexOf('\n  push:'), desktop.indexOf('\n  workflow_dispatch:'))
    .matchAll(/^\s+- '([^']+)'$/gm)].map(match => match[1])
  assert.ok(paths.length > 0)
  for (const file of ['docs/operations/web-runtime.md', 'docs/acceptance/issue-1415/final-evidence.md',
    'docs/acceptance/issue-1415/final-report.md', 'README.md', 'README.zh-CN.md',
    'docs/assets/architecture-dark.svg', 'docs/assets/architecture-light.svg',
    'docs/assets/architecture-zh-dark.svg', 'docs/assets/architecture-zh-light.svg']) {
    assert.equal(paths.some(pattern => matchesGlob(file, pattern)), false, file)
  }
})

test('real Git ancestry admits the same source or descendants and never an older or divergent Web', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-web-ancestry-'))
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = text => {
    writeFileSync(join(dir, 'fixture.txt'), text)
    git(['add', '.'])
    git(['-c', 'user.name=Release fixture', '-c', 'user.email=release@example.invalid', 'commit', '-qm', text])
    return git(['rev-parse', 'HEAD'])
  }
  try {
    git(['init', '-q', '-b', 'main'])
    const older = commit('older'), desktop = commit('desktop'), descendant = commit('deployed descendant')
    git(['checkout', '-qb', 'other', older])
    const divergent = commit('unrelated branch')
    const comparison = (base, head) => {
      const [behind, ahead] = git(['rev-list', '--left-right', '--count', base + '...' + head]).split(/\s+/).map(Number)
      return { url: 'https://api.github.com/repos/alexj11324/Mikka/compare/' + base + '...' + head,
        base_commit: { sha: git(['rev-parse', base]) }, merge_base_commit: { sha: git(['merge-base', base, head]) },
        status: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'identical',
        ahead_by: ahead, behind_by: behind }
    }
    for (const [candidate, allowed] of [[desktop, true], [descendant, true], [older, false], [divergent, false]]) {
      const fixture = desktopWebFixture({ version: () => candidate, comparison, budget: 200 })
      if (allowed) {
        const result = await fixture.run({ expectedBuild: desktop })
        assert.equal(result.sourceCommit, desktop)
        assert.equal(result.publicBuild, candidate)
      } else {
        await assert.rejects(fixture.run({ expectedBuild: desktop }), /matchingWebDeploymentTimedOut/)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unbound or malformed GitHub comparison cannot admit a desktop release', async () => {
  for (const patch of [
    { url: 'https://api.github.com/repos/other/Mikka/compare/' + SHA + '...' + OTHER },
    { url: 'https://api.github.com/repos/alexj11324/Mikka/compare/' + SHA + '...' + 'c'.repeat(40) },
    { base_commit: { sha: OTHER } }, { merge_base_commit: {} },
    { status: 'unknown' }, { ahead_by: -1 }, { behind_by: null },
  ]) {
    const fixture = desktopWebFixture({ comparison: (base, head) => ({
      url: 'https://api.github.com/repos/alexj11324/Mikka/compare/' + base + '...' + head,
      base_commit: { sha: base }, merge_base_commit: { sha: base }, status: 'ahead', ahead_by: 1, behind_by: 0,
      ...patch,
    }) })
    await assert.rejects(fixture.run(), /invalidCommitComparison/)
  }
})

test('desktop waits for a newer compatible Web instead of stopping at its obsolete failed build', async () => {
  const fixture = desktopWebFixture({ version: elapsed => elapsed < 100 ? 'c'.repeat(40) : OTHER,
    comparison: (base, head) => ({
      url: 'https://api.github.com/repos/alexj11324/Mikka/compare/' + base + '...' + head,
      base_commit: { sha: base }, merge_base_commit: { sha: head === OTHER ? base : head },
      status: head === OTHER ? 'ahead' : 'behind', ahead_by: head === OTHER ? 1 : 0, behind_by: head === OTHER ? 0 : 1,
    }) })
  const result = await fixture.run()
  assert.equal(result.publicBuild, OTHER)
  assert.equal(fixture.elapsed(), 100)
  assert.equal(fixture.calls.some(call => call.url.includes('head_sha=' + SHA)), false,
    'the failed obsolete Web source is not treated as evidence for the live candidate')
})

test('a changed public candidate is reverified before the desktop can be released', async () => {
  let publicReads = 0
  const later = 'c'.repeat(40)
  const fixture = desktopWebFixture({
    version: () => ++publicReads === 1 ? OTHER : later,
    runs: build => [webRun({ head_sha: build, id: build === OTHER ? 70 : 71 })],
  })
  const result = await fixture.run()
  assert.equal(result.publicBuild, later)
  assert.equal(result.webRunId, 71)
  assert.equal(fixture.elapsed(), 100)
  assert.ok(fixture.calls.some(call => call.url.includes('/compare/' + SHA + '...' + later)))
})

test('descendant mode retains successful same-source Web build, upload and public verification gates', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    const fixture = desktopWebFixture({ runs: build => [webRun({ head_sha: build, conclusion })] })
    await assert.rejects(fixture.run(), /matchingWebRunFailed:70/)
  }
  for (const step of [0, 1, 2]) {
    const fixture = desktopWebFixture({ job: build => {
      const job = buildJob({ head_sha: build })
      job.steps[step].conclusion = 'skipped'
      return job
    } })
    await assert.rejects(fixture.run(), /matchingWebBuildSkippedOrIncomplete/)
  }
  const foreign = desktopWebFixture({ runs: build => [webRun({ head_sha: build,
    repository: { full_name: 'fork/Mikka' } })], budget: 200 })
  await assert.rejects(foreign.run(), /matchingWebDeploymentTimedOut/)
})

test('desktop verification cannot succeed after its deadline or start without a GitHub identity', async () => {
  const expired = desktopWebFixture({ version: (_elapsed, advance) => { advance(501); return OTHER } })
  await assert.rejects(expired.run(), /matchingWebDeploymentTimedOut/)
  const missing = desktopWebFixture()
  await assert.rejects(missing.run({ token: undefined }), /githubTokenRequired/)
  assert.equal(missing.calls.length, 0)
})

test('private-push dispatch waits through an older overlay on an otherwise valid desktop descendant', async () => {
  const fixture = desktopWebFixture({ overlay: elapsed => elapsed < 200 ? OTHER : SHA })
  const result = await fixture.run({ expectedOverlay: SHA })
  assert.equal(result.publicBuild, OTHER)
  assert.equal(fixture.elapsed(), 200)
  const mismatch = desktopWebFixture({ overlay: () => OTHER, budget: 250 })
  await assert.rejects(mismatch.run({ expectedOverlay: SHA }), /matchingWebDeploymentTimedOut/)
})
test('private-push exact-source wait keeps matching overlay behavior', async () => {
  const fixture = webFixture({ overlay: elapsed => elapsed < 200 ? OTHER : SHA })
  assert.equal((await fixture.run({ expectedOverlay: SHA })).publicBuild, SHA)
  assert.equal(fixture.elapsed(), 200)
})
