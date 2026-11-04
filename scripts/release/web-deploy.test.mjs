import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEnvironment, productionSha, REQUIRED } from './web-deploy.mjs'

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
