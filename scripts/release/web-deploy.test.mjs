import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, matchesGlob } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildEnvironment, productionSha, verifyProductionBuild, PRODUCTION_VERSION_URL, REQUIRED,
  assertCurrentMain, waitForWebDeployment, webDeploymentWaitOptions, deploymentPlan } from './web-deploy.mjs'

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

function webFixture({ main = () => SHA, runs = () => [webRun()], publisher = 'active', job = buildJob(), version = () => SHA, overlay = () => undefined, budget = 500 } = {}) {
  let elapsed = 0
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    calls.push({ path: url.pathname, origin: url.origin, method: init.method ?? 'GET', at: elapsed })
    assert.equal(init.redirect, 'error')
    if (url.origin === 'https://api.github.com') {
      assert.equal(init.headers.authorization, 'Bearer read-only-fixture')
      if (url.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { type: 'commit', sha: main(elapsed) } })
      if (url.pathname.endsWith('/actions/workflows/web-deploy.yml')) return Response.json({ path: '.github/workflows/web-deploy.yml', state: publisher })
      if (url.pathname.endsWith('/actions/workflows/web-deploy.yml/runs')) {
        assert.equal(url.searchParams.get('head_sha'), SHA)
        assert.equal(url.searchParams.get('branch'), 'main')
        return Response.json({ workflow_runs: runs(elapsed) })
      }
      assert.equal(url.pathname, '/repos/alexj11324/Mikka/actions/runs/70/attempts/2/jobs')
      return Response.json({ total_count: 1, jobs: [typeof job === 'function' ? job(elapsed, value => { elapsed = value }) : job] })
    }
    assert.equal(input, PRODUCTION_VERSION_URL)
    assert.equal(init.headers.authorization, undefined)
    assert.equal(init.cache, 'no-store')
    return Response.json({ build: version(elapsed, value => { elapsed = value }), overlaySha: overlay(elapsed) })
  }
  return { calls, run: extra => waitForWebDeployment({ expectedBuild: SHA, token: 'read-only-fixture', fetchImpl,
    now: () => elapsed, wait: async ms => { elapsed += ms }, intervalMs: 100, maxWaitMs: budget, ...extra }), elapsed: () => elapsed }
}

test('a frozen publisher without a matching build cannot start paid template work', async () => {
  const f = webFixture({ runs: () => [], publisher: 'disabled_manually' })
  await assert.rejects(f.run(), /matchingWebPublisherInactive/)
  assert.equal(f.elapsed(), 0)
  assert.equal(f.calls.some(call => call.origin !== 'https://api.github.com'), false)
})

test('a qualified published build remains valid after future publication is frozen', async () => {
  const f = webFixture({ publisher: 'disabled_manually' })
  assert.equal((await f.run()).publicBuild, SHA)
  assert.equal(f.calls.some(call => call.path.endsWith('/workflows/web-deploy.yml')), false)
})

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


test('waits for completed Web step metadata to converge before accepting the public build', async () => {
  // 3c32675c run 42439514995 completed successfully while its attempt jobs API
  // still reported Upload in_progress and Verify pending (2026-11-08).
  for (const event of ['push', 'workflow_dispatch']) {
    const fixture = webFixture({ runs: () => [webRun({ event })], job: elapsed => {
      const job = buildJob()
      if (elapsed < 100) {
        Object.assign(job.steps[1], { status: 'in_progress', conclusion: null })
        Object.assign(job.steps[2], { status: 'pending', conclusion: null })
      } else if (elapsed < 200) {
        Object.assign(job.steps[2], { status: 'queued', conclusion: null })
      }
      return job
    } })
    const result = await fixture.run()
    assert.equal(result.webRunId, 70)
    assert.equal(result.webAttempt, 2)
    assert.equal(result.publicBuild, SHA)
    assert.equal(fixture.elapsed(), 200)
    assert.deepEqual(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com')
      .map(call => call.at), [200], 'public READY cannot replace pending step evidence')
    assert.ok(fixture.calls.every(call => call.method === 'GET'))
  }
})


test('pending Web step metadata shares the original deadline without reading the public build', async () => {
  const job = buildJob()
  Object.assign(job.steps[1], { status: 'in_progress', conclusion: null })
  Object.assign(job.steps[2], { status: 'pending', conclusion: null })
  const fixture = webFixture({ job, budget: 250 })
  await assert.rejects(fixture.run(), /matchingWebDeploymentTimedOut/)
  assert.equal(fixture.elapsed(), 250)
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/jobs')).length, 3)
  assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
})

test('main advancing during step metadata convergence stops before another evidence read', async () => {
  const job = buildJob()
  Object.assign(job.steps[2], { status: 'pending', conclusion: null })
  const fixture = webFixture({ job, main: elapsed => elapsed >= 100 ? OTHER : SHA })
  await assert.rejects(fixture.run(), /mainChanged/)
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/jobs')).length, 1)
  assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
})

test('step metadata that completes after the original deadline cannot admit a release', async () => {
  const fixture = webFixture({ job: (elapsed, advance) => {
    const job = buildJob()
    if (!elapsed) Object.assign(job.steps[2], { status: 'pending', conclusion: null })
    else advance(501)
    return job
  } })
  await assert.rejects(fixture.run(), /matchingWebDeploymentTimedOut/)
  assert.equal(fixture.elapsed(), 501)
  assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
})

test('pending step metadata never hides a failed, cancelled or skipped required step', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out']) {
    const job = buildJob()
    job.steps[1].conclusion = conclusion
    Object.assign(job.steps[2], { status: 'pending', conclusion: null })
    const fixture = webFixture({ job })
    await assert.rejects(fixture.run(), /matchingWebBuildSkippedOrIncomplete/, conclusion)
    assert.equal(fixture.elapsed(), 0)
    assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
  }
})

test('duplicate, missing or contradictory step evidence fails instead of waiting or accepting public READY', async () => {
  const cases = [
    ['duplicate success', job => { job.steps.push({ ...job.steps[1] }) }],
    ['success plus pending duplicate', job => { job.steps.push({ ...job.steps[1], status: 'pending', conclusion: null }) }],
    ['missing required step', job => { job.steps.splice(1, 1) }],
    ['missing steps', job => { delete job.steps }],
    ['non-array steps', job => { job.steps = {} }],
    ['unknown status', job => { Object.assign(job.steps[1], { status: 'waiting', conclusion: null }) }],
    ['completed without result', job => { job.steps[1].conclusion = null }],
    ['pending with failure', job => { Object.assign(job.steps[1], { status: 'pending', conclusion: 'failure' }) }],
    ['in-progress with success', job => { job.steps[1].status = 'in_progress' }],
    ['pending without conclusion', job => { job.steps[1].status = 'pending'; delete job.steps[1].conclusion }],
  ]
  for (const [label, change] of cases) {
    const job = buildJob()
    change(job)
    const fixture = webFixture({ job })
    await assert.rejects(fixture.run(), /matchingWebBuildSkippedOrIncomplete/, label)
    assert.equal(fixture.elapsed(), 0, label)
    assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0, label)
  }
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

test('a successful Web job waits for its required step results to catch up before reading public', async () => {
  const fixture = webFixture({ job: elapsed => {
    const job = buildJob()
    if (elapsed < 200) {
      job.steps[1] = { ...job.steps[1], status: 'in_progress', conclusion: null }
      job.steps[2] = { ...job.steps[2], status: 'pending', conclusion: null }
    }
    return job
  } })
  const result = await fixture.run()
  assert.equal(result.webRunId, 70)
  assert.equal(fixture.elapsed(), 200)
  assert.deepEqual(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').map(call => call.at), [200])
})

test('required Web step results that remain pending cannot pass and retain the finite wait', async () => {
  const job = buildJob()
  job.steps[2] = { ...job.steps[2], status: 'pending', conclusion: null }
  const fixture = webFixture({ job, budget: 250 })
  await assert.rejects(fixture.run(), /matchingWebDeploymentTimedOut/)
  assert.equal(fixture.elapsed(), 250)
  assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
})

test('pending Web step results retain the exact-main fence on every wait', async () => {
  const job = buildJob()
  job.steps[2] = { ...job.steps[2], status: 'pending', conclusion: null }
  const fixture = webFixture({ job, main: elapsed => elapsed >= 100 ? OTHER : SHA })
  await assert.rejects(fixture.run(), /mainChanged/)
  assert.equal(fixture.elapsed(), 100)
  assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0)
})

test('pending step metadata does not hide a required step that already failed or skipped', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    const job = buildJob()
    job.steps[1] = { ...job.steps[1], status: 'in_progress', conclusion: null }
    job.steps[2].conclusion = conclusion
    const fixture = webFixture({ job })
    await assert.rejects(fixture.run(), /matchingWebBuildSkippedOrIncomplete/)
    assert.equal(fixture.elapsed(), 0)
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
    + readFileSync(new URL('../../.github/workflows/e2b-runtime-release.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(web, /^concurrency:/m, 'caller and reusable job must not acquire the same group twice')
  assert.match(web, /\n    concurrency:\n(?:[^\n]*\n)*?      group: web-deploy-production\n      cancel-in-progress: false\n      queue: max\n/)
  assert.equal((web.match(/group: web-deploy-production/g) ?? []).length, 1)
  assert.doesNotMatch(e2b, /^concurrency:/m)
  const callerQueue = e2b.slice(e2b.indexOf('\n  release:'), e2b.indexOf('name: E2B serialized'))
  assert.match(callerQueue, /cancel-in-progress: false\n      queue: max/)
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
  const webReady = e2b.slice(e2b.indexOf('\n  web-ready:'), e2b.indexOf('\n  release:'))
  assert.match(webReady, /needs: check\n    if: needs\.check\.outputs\.changed == 'true'/)
  assert.match(webReady, /node scripts\/release\/web-deploy\.mjs await-web/)
  assert.doesNotMatch(webReady, /id-token:|Infisical|web-deploy-production|e2b-official-runtime-release/)
  assert.match(e2b, /release:\n    needs: \[test, check, web-ready\]\n    if: needs\.check\.outputs\.changed == 'true'/)
  assert.match(e2b, /runtime-worker-sha: \$\{\{ needs\.validate\.outputs\.source-sha \}\}/)
  assert.match(e2b, /runtime-template-models-sha256: \$\{\{ needs\.validate\.outputs\.template-models-sha256 \}\}/)
  const checkJob = e2b.slice(e2b.indexOf('\n  check:'), e2b.indexOf('\n  release:'))
  assert.match(checkJob, /fetch-depth: 0/)
  const checkGuard = checkJob.indexOf('node scripts/release/web-deploy.mjs main')
  assert.ok(checkGuard >= 0)
  assert.doesNotMatch(checkJob, /Infisical|VERCEL_TEAM_TOKEN|publish-template-env|RUNTIME_REFRESH/)
  assert.match(checkJob, /steps\.history\.outputs\.changed/)
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


function desktopWebFixture({ headers = { 'x-vercel-id': 'legacy' }, version = () => OTHER, overlay = () => undefined, main = () => OTHER, budget = 500,
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
      return Response.json({ build: activeBuild, overlaySha: overlay(elapsed) }, { headers })
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

test('desktop cannot use the legacy publisher after cutover, even if the public source is unchanged', async () => {
  for (const headers of [{}, { 'cf-ray': 'edge', 'x-mikka-gateway-version-sha256': 'a'.repeat(64) },
    { 'x-vercel-id': 'old', 'x-mikka-gateway-version-sha256': 'a'.repeat(64) }]) {
    const fixture = desktopWebFixture({ headers })
    await assert.rejects(fixture.run(), /desktopProviderRequiresReceipt/)
    assert.equal(fixture.calls.length, 1)
  }
})

test('desktop replaces obsolete preflights while preserving active signing and documentation does not trigger a release', () => {
  const desktop = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(desktop, /^concurrency:/m, 'a new workflow must not cancel a running signing job')
  const preflight = desktop.slice(desktop.indexOf('\n  preflight:'), desktop.indexOf('\n  macos:'))
  const signing = desktop.slice(desktop.indexOf('\n  macos:'))
  assert.match(preflight, /group: .*'desktop-release-preflight'.*\n      cancel-in-progress: true/)
  assert.match(signing, /group: .*'desktop-release'.*\n      cancel-in-progress: false/)
  assert.doesNotMatch(signing, /queue: max|cancel-in-progress: true/, 'keep one active signer and only the latest pending candidate')
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

test('every fromJSON of a workflow input has a fallback, since a push run has no inputs', () => {
  // A push run sees '' for every input, and GitHub evaluates `env:` expressions while validating the
  // workflow, even for a step whose `if` is false: fromJSON('') failed the whole Web deploy (#1523).
  const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/web-deploy.yml', import.meta.url)), 'utf8')
  const bare = [...workflow.matchAll(/fromJSON\(\s*inputs\.[\w-]+\s*\)/g)].map(match => match[0])
  assert.deepEqual(bare, [])
})

test('large runtime reports cross jobs only as immutable artifact files', () => {
  const files = ['e2b-template.yml', 'e2b-official-runtime.yml', 'web-deploy.yml']
    .map(name => readFileSync(new URL('../../.github/workflows/' + name, import.meta.url), 'utf8'))
  for (const text of files) {
    assert.doesNotMatch(text, /candidate-report=|release-evidence=|CANDIDATE_REPORT:|RUNTIME_RELEASE_EVIDENCE:|TEMPLATE_MODELS:/,
      'a complete report or model catalogue must not enter a job output, input, argv or environment')
  }
  const [builder, caller, web] = files
  const runtime = caller + readFileSync(new URL('../../.github/workflows/e2b-runtime-release.yml', import.meta.url), 'utf8')
  assert.match(builder, /candidate-artifact-id:.*steps\.candidates\.outputs\.artifact-id/)
  assert.match(builder, /name: e2b-candidates-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(builder, /name: e2b-candidate-build-cleanup-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(runtime, /artifact-ids: \$\{\{ needs\.validate\.outputs\.candidate-artifact-id \}\}/)
  assert.match(runtime, /name: e2b-release-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(runtime, /name: e2b-template-subscription-diagnostics-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(runtime, /name: e2b-runtime-release-cleanup-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(runtime, /runtime-release-artifact-id: \$\{\{ needs\.subscriptions\.outputs\.release-artifact-id \}\}/)
  assert.match(web, /artifact-ids: \$\{\{ inputs\.runtime-release-artifact-id \}\}/)
  for (const text of [runtime, web]) assert.match(text, /merge-multiple: true/,
    'download-artifact v4 otherwise creates a name subdirectory even for one artifact ID')
  const subscription = runtime.slice(runtime.indexOf('\n  subscriptions:'), runtime.indexOf('\n  publish:'))
  const reference = subscription.indexOf('node scripts/e2b/runtime-report.mjs reference')
  const download = subscription.indexOf('uses: actions/download-artifact@')
  const verify = subscription.indexOf('node scripts/e2b/runtime-report.mjs verify')
  assert.ok(reference > 0 && reference < download && download < verify && verify < subscription.indexOf('uses: Infisical/'))
  assert.ok(subscription.indexOf('assertReportIdentity(report') < subscription.indexOf('--publish-verified'))
  assert.ok(subscription.indexOf('assertCandidatePreserved(report, candidate)') < subscription.indexOf('--publish-verified'))
  assert.ok(subscription.indexOf('assertCandidatePreserved(report, candidate, { published: true })') > subscription.indexOf('--publish-verified'))
  const cleanup = runtime.slice(runtime.indexOf('\n  cleanup:'))
  assert.match(cleanup, /if: always\(\) && steps\.e2b-key\.outcome == 'success'/)
  assert.match(cleanup, /CANDIDATE_IDENTITIES: \$\{\{ needs\.validate\.outputs\.candidate-identities \}\}/)
  assert.doesNotMatch(cleanup, /download-artifact|candidate-artifact-id/,
    'cleanup uses independently bounded known IDs even when the full report download fails')
  assert.match(web, /name: Require one immutable runtime release artifact reference\n        if: inputs\.runtime-refresh == true/)
  assert.match(web, /name: Download the complete verified runtime release report\n        if: inputs\.runtime-refresh == true/)
})

test('duplicate required step cannot hide a failure or pending record behind one success', async () => {
  const outcomes = []
  for (const duplicate of [
    { status: 'completed', conclusion: 'failure' },
    { status: 'pending', conclusion: null },
  ]) {
    const job = buildJob()
    job.steps.push({ ...job.steps[1], ...duplicate })
    const fixture = webFixture({ job })
    const result = await fixture.run().then(() => 'accepted', error => error.message)
    outcomes.push({ status: duplicate.status, result, elapsed: fixture.elapsed(),
      publicReads: fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length })
  }
  assert.deepEqual(outcomes, [
    { status: 'completed', result: 'webDeploy:matchingWebBuildSkippedOrIncomplete', elapsed: 0, publicReads: 0 },
    { status: 'pending', result: 'webDeploy:matchingWebBuildSkippedOrIncomplete', elapsed: 0, publicReads: 0 },
  ])
})

test('runtime CLI waits beyond forty minutes for the latest Web run instead of accepting an older successful push', async () => {
  const latestSucceedsAt = 40 * 60_000 + 9_000
  const fixture = webFixture({
    // An older successful push and matching public version cannot admit the latest pending dispatch.
    runs: elapsed => [
      webRun({ id: 69, run_attempt: 1, event: 'push' }),
      webRun({ event: 'workflow_dispatch',
        ...(elapsed < latestSucceedsAt ? { status: 'in_progress', conclusion: null } : {}) }),
    ],
    version: () => SHA,
  })
  const result = await fixture.run({ ...webDeploymentWaitOptions('await-web'), intervalMs: 10_000 })
  assert.equal(result.webRunId, 70)
  assert.equal(result.webAttempt, 2)
  assert.equal(result.sourceCommit, SHA)
  assert.equal(result.publicBuild, SHA)
  assert.equal(fixture.elapsed(), 40 * 60_000 + 10_000)
  assert.deepEqual(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').map(call => call.at),
    [40 * 60_000 + 10_000], 'an older successful push cannot bypass the latest pending dispatch')
})

test('desktop CLI still times out at forty minutes while the latest Web run is pending', async () => {
  const latestSucceedsAt = 40 * 60_000 + 9_000
  const fixture = desktopWebFixture({
    runs: (build, elapsed) => [
      webRun({ head_sha: build, id: 69, run_attempt: 1, event: 'push' }),
      webRun({ head_sha: build, event: 'workflow_dispatch',
        ...(elapsed < latestSucceedsAt ? { status: 'in_progress', conclusion: null } : {}) }),
    ],
  })
  await assert.rejects(fixture.run({ ...webDeploymentWaitOptions('await-desktop-web'), intervalMs: 10_000 }),
    /matchingWebDeploymentTimedOut/)
  assert.equal(fixture.elapsed(), 40 * 60_000)
  assert.equal(fixture.calls.some(call => /\/actions\/runs\/\d+\/attempts\/\d+\/jobs/.test(call.url)), false,
    'the older successful push cannot provide build evidence while the latest dispatch is pending')
})

test('runtime CLI stops at ninety minutes while required Web step evidence remains pending without reading public', async () => {
  const job = buildJob()
  Object.assign(job.steps[2], { status: 'pending', conclusion: null })
  const fixture = webFixture({ job })
  await assert.rejects(fixture.run({ ...webDeploymentWaitOptions('await-web'), intervalMs: 10_000 }),
    /matchingWebDeploymentTimedOut/)
  assert.equal(fixture.elapsed(), 90 * 60_000)
  assert.equal(fixture.calls.filter(call => call.origin === 'https://app.aspectlylabs.com').length, 0,
    'matching public output cannot replace unfinished required Web step evidence')
})
