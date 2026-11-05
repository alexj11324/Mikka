import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { currentWorkerSha, pairEnv, publish, PROJECT, TEAM } from './publish-template-env.mjs'
import * as webRelease from '../release/web-deploy.mjs'

const SHA = 'a'.repeat(40), COMMIT = 'b'.repeat(40), OTHER = 'c'.repeat(40)
const report = harness => ({ harness, installed: true, version: null, models: ['fixture-model'] })
const MODELS = { desktop: [report('claude_code'), report('codex')], claude: [report('claude_code')], codex: [report('codex')] }
const TEMPLATES = { desktop: 'desktop', claude: 'claude', codex: 'codex' }
const STORED = Object.fromEntries(pairEnv({ templates: TEMPLATES, sourceSha: SHA, models: MODELS }).map(row => [row.key, row.value]))
STORED.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = COMMIT

function fixture(options = {}) {
  const calls = [], logs = [], stored = options.stored ?? STORED
  let wrote = false, mainReads = 0, uncertain = options.uncertainPost === true
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET'
    calls.push({ origin: url.origin, method, path: url.pathname, search: url.search, body: init.body && JSON.parse(init.body) })
    if (url.origin === 'https://api.github.com') {
      assert.equal(method, 'GET')
      assert.equal(init.headers.authorization, 'Bearer github-read-fixture')
      mainReads++
      return Response.json({ object: { type: 'commit', sha: mainReads > 1 ? options.afterReadsMain ?? options.currentMain ?? COMMIT : options.currentMain ?? COMMIT } })
    }
    if (url.origin === 'https://app.aspectlylabs.com') {
      assert.equal(init.headers.authorization, undefined)
      return Response.json({ build: options.publicBuild ?? COMMIT })
    }
    assert.equal(url.origin, 'https://api.vercel.com')
    assert.equal(url.searchParams.get('teamId'), TEAM)
    assert.equal(init.headers.authorization, 'Bearer vercel-fixture')
    if (url.pathname.startsWith('/v4/aliases/')) {
      assert.equal(url.searchParams.get('projectId'), PROJECT)
      return Response.json({ deploymentId: 'dpl_live' })
    }
    if (url.pathname === '/v13/deployments/dpl_live') return Response.json({ meta: { githubCommitSha: options.aliasBuild ?? COMMIT } })
    if (method === 'POST' && url.pathname.endsWith('/env')) {
      wrote = true
      if (uncertain) { uncertain = false; throw Error('fixture response lost after mutation') }
      if (options.postStatus) return new Response('private-response-marker', { status: options.postStatus })
      return Response.json({ created: [] })
    }
    const source = wrote || options.unchanged ? stored : options.before ?? { ...stored, MIKKA_CLOUD_WORKER_SHA: OTHER }
    if (url.pathname.endsWith('/env')) return Response.json({ envs: Object.keys(stored).flatMap(key => [
      { id: `preview-${key}`, key, target: ['preview'] },
      { id: `branch-${key}`, key, target: ['production'], gitBranch: 'other' },
      { id: `id-${key}`, key, target: ['production'] },
    ]) })
    if (url.pathname.includes('/env/id-')) return Response.json({ value: source[url.pathname.split('/env/id-')[1]] })
    assert.fail(`unexpected release request ${method} ${url.pathname}`)
  }
  const run = extra => publish({ token: 'vercel-fixture', githubToken: 'github-read-fixture', templates: TEMPLATES,
    sourceSha: SHA, sourceCommit: COMMIT, models: MODELS, fetchImpl, log: message => logs.push(message), ...extra })
  return { calls, logs, fetchImpl, run }
}

test('official templates, worker, source and measured capabilities go to production in one verified upsert', async () => {
  const fake = fixture()
  assert.deepEqual(await fake.run(), { changed: true, requiresWebBuild: true, sourceCommit: COMMIT, workerSha: SHA })
  const writes = fake.calls.filter(call => call.method === 'POST')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, `/v10/projects/${PROJECT}/env`)
  assert.match(writes[0].search, /upsert=true/)
  assert.deepEqual(writes[0].body.map(row => [row.key, row.value, row.target]), Object.entries(STORED).map(([key, value]) => [key, value, ['production']]))
  assert.equal(fake.calls.filter(call => call.path.includes('/env/id-')).length, 12, 'read each exact production value before and after the write')
  assert.doesNotMatch(fake.logs.join('\n'), /fixture-model|vercel-fixture|github-read-fixture/)
})

test('runtime configuration never asks Vercel to rebuild source; the caller must use Web deploy', async () => {
  const fake = fixture()
  await fake.run()
  assert.equal(fake.calls.filter(call => call.method === 'POST' && call.path === '/v13/deployments').length, 0)
  assert.equal(fake.calls.filter(call => call.method === 'POST' && call.path.endsWith('/env')).length, 1)
})

test('an explicit refresh still requires a Web build after an earlier env write succeeded', async () => {
  const fake = fixture({ unchanged: true })
  assert.deepEqual(await fake.run(), { changed: false, requiresWebBuild: true, sourceCommit: COMMIT, workerSha: SHA })
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0)
})

test('a readback mismatch fails before the caller can build', async () => {
  const fake = fixture({ stored: { ...STORED, E2B_CODEX_TEMPLATE: 'old' } })
  await assert.rejects(fake.run(), /env_not_updated E2B_CODEX_TEMPLATE/)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
})

test('an uncertain mutation is never retried; an explicit rerun reads it and still requires a build', async () => {
  const fake = fixture({ uncertainPost: true })
  await assert.rejects(fake.run(), error => {
    assert.match(error.message, /vercel_api_unavailable POST/)
    assert.doesNotMatch(error.message, /fixture response lost after mutation/)
    return true
  })
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal((await fake.run()).requiresWebBuild, true)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
})

test('an HTTP mutation error has one attempt and never exposes the response body', async () => {
  const fake = fixture({ postStatus: 503 })
  await assert.rejects(fake.run(), error => {
    assert.match(error.message, /vercel_api_http_503 POST/)
    assert.doesNotMatch(error.message, /private-response-marker/)
    return true
  })
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
})

test('main advancing during configuration reads prevents the single env mutation', async () => {
  const fake = fixture({ afterReadsMain: OTHER })
  await assert.rejects(fake.run(), /mainChanged/)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0)
})

test('obsolete refreshes fail even when their old runtime env already matches', async () => {
  const fake = fixture({ unchanged: true, currentMain: OTHER })
  await assert.rejects(fake.run(), /mainChanged/)
  assert.equal(fake.calls.filter(call => call.origin === 'https://api.vercel.com').length, 0)
})

test('a different serving alias or public version prevents every configuration write', async () => {
  for (const options of [{ aliasBuild: OTHER }, { publicBuild: OTHER }]) {
    const fake = fixture(options)
    await assert.rejects(fake.run(), /production_source_changed/)
    assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0)
  }
})

test('does not search past a newer application for an older matching READY deployment', async () => {
  const fake = fixture({ aliasBuild: OTHER })
  await assert.rejects(fake.run(), /production_source_changed/)
  assert.equal(fake.calls.filter(call => call.path === '/v6/deployments').length, 0)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0)
})

test('refuses missing or short source identities and custom official templates before requests', async () => {
  for (const extra of [{ sourceCommit: undefined }, { sourceCommit: 'short' }, { templates: { ...TEMPLATES, codex: 'private-old' } }]) {
    const fake = fixture()
    await assert.rejects(fake.run(extra), /official_(source_commit|template)_invalid/)
    assert.equal(fake.calls.length, 0)
  }
})

test('pair validation still rejects short worker SHA, odd or missing template IDs and unmeasured harnesses', () => {
  assert.throws(() => pairEnv({ templates: TEMPLATES, sourceSha: 'abc1234' }), /source_sha_invalid/)
  assert.throws(() => pairEnv({ templates: { ...TEMPLATES, claude: 'a/b' }, sourceSha: SHA }), /template_id_invalid claude/)
  assert.throws(() => pairEnv({ templates: { desktop: 'tpl1', claude: 'tpl2' }, sourceSha: SHA }), /template_id_invalid codex/)
  assert.throws(() => pairEnv({ templates: TEMPLATES, sourceSha: SHA }), /template_models_invalid/)
  assert.throws(() => pairEnv({ templates: TEMPLATES, sourceSha: SHA, models: { ...MODELS, desktop: [report('codex')] } }), /template_models_missing desktop claude_code/)
})

test('reads only the exact production worker hash and returns empty when unset', async () => {
  assert.equal(await currentWorkerSha({ token: 'vercel-fixture', fetchImpl: fixture({ unchanged: true }).fetchImpl }), SHA)
  assert.equal(await currentWorkerSha({ token: 'vercel-fixture', fetchImpl: fixture({ stored: {} }).fetchImpl }), '')
})

test('GitHub-only build timeline waits for source upload before the single runtime env publication', async () => {
  let elapsed = 0, wrote = false
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET'
    calls.push({ origin: url.origin, path: url.pathname, method, at: elapsed })
    if (url.origin === 'https://api.github.com') {
      if (url.pathname.endsWith('/git/ref/heads/main')) return Response.json({ object: { type: 'commit', sha: COMMIT } })
      if (url.pathname.endsWith('/actions/workflows/web-deploy.yml/runs')) return Response.json({ workflow_runs: [{
        id: 70, run_attempt: 1, head_sha: COMMIT, head_branch: 'main', path: '.github/workflows/web-deploy.yml',
        repository: { full_name: 'alexj11324/Mikka' }, head_repository: { full_name: 'alexj11324/Mikka' }, event: 'push',
        status: elapsed < 200 ? 'in_progress' : 'completed', conclusion: elapsed < 200 ? null : 'success',
      }] })
      assert.equal(url.pathname, '/repos/alexj11324/Mikka/actions/runs/70/attempts/1/jobs')
      return Response.json({ total_count: 1, jobs: [{ name: 'deploy', head_sha: COMMIT, status: 'completed', conclusion: 'success',
        steps: ['Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
          'Verify the public production version before releasing the deployment queue'].map(name => ({ name, status: 'completed', conclusion: 'success' })),
      }] })
    }
    if (url.origin === 'https://app.aspectlylabs.com') return Response.json({ build: elapsed < 300 ? OTHER : COMMIT })
    assert.equal(url.origin, 'https://api.vercel.com')
    if (method === 'POST' && url.pathname.endsWith('/env')) { wrote = true; return Response.json({ created: [] }) }
    const values = wrote ? STORED : { ...STORED, MIKKA_CLOUD_WORKER_SHA: OTHER }
    if (url.pathname.endsWith('/env')) return Response.json({ envs: Object.keys(values).map(key => ({ id: `id-${key}`, key, target: ['production'] })) })
    if (url.pathname.includes('/env/id-')) return Response.json({ value: values[url.pathname.split('/env/id-')[1]] })
    // Reproduce the observed gap: while GitHub is building there is NO Vercel
    // in-flight deployment, only the previous READY application. The legacy
    // orchestration fails production_source_changed here without waiting.
    if (url.pathname === '/v6/deployments') return Response.json({ deployments: [{ uid: 'dpl_live', name: 'mikka', state: 'READY',
      meta: { githubCommitSha: elapsed < 300 ? OTHER : COMMIT } }] })
    if (url.pathname.startsWith('/v4/aliases/')) return Response.json({ deploymentId: 'dpl_live' })
    if (url.pathname === '/v13/deployments/dpl_live') return Response.json({ meta: { githubCommitSha: elapsed < 300 ? OTHER : COMMIT } })
    assert.fail(`unexpected publication ${method} ${url.pathname}`)
  }
  // Run the same fixture with either checkout's actual orchestration. The
  // workflow contract test separately requires the new lock-free await step.
  const workflow = readFileSync(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
  if (workflow.includes('\n  await-web:')) await webRelease.waitForWebDeployment({ expectedBuild: COMMIT, token: 'github-read-fixture',
    fetchImpl, now: () => elapsed, wait: async ms => { elapsed += ms }, intervalMs: 100, maxWaitMs: 500 })
  const result = await publish({ token: 'vercel-fixture', githubToken: 'github-read-fixture', templates: TEMPLATES, sourceSha: SHA,
    sourceCommit: COMMIT, models: MODELS, fetchImpl, log: () => {}, wait: async ms => { elapsed += ms } })
  assert.equal(result.requiresWebBuild, true)
  assert.equal(elapsed, 300)
  assert.deepEqual(calls.filter(call => call.method === 'POST'), [{ origin: 'https://api.vercel.com', path: `/v10/projects/${PROJECT}/env`, method: 'POST', at: 300 }])
})
