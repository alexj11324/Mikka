import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { buildEnvironment, productionSha, verifyProductionBuild, PRODUCTION_VERSION_URL, REQUIRED } from './web-deploy.mjs'

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
