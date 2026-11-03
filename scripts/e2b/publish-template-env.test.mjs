import assert from 'node:assert/strict'
import test from 'node:test'
import { currentWorkerSha, pairEnv, publish } from './publish-template-env.mjs'

const SHA = 'a'.repeat(40)

const report = harness => ({ harness, installed: true, version: null, models: ['fixture-model'] })
const MODELS = { desktop: [report('claude_code'), report('codex')], claude: [report('claude_code')], codex: [report('codex')] }
const TEMPLATES = { desktop: 'tpl1', claude: 'tpl2', codex: 'tpl3' }
const CATALOGUE = JSON.stringify({ version: 1, workerSha: SHA, templates: Object.fromEntries(Object.keys(TEMPLATES).map(kind => [kind, { templateId: TEMPLATES[kind], models: MODELS[kind] }])) })
const STORED = { MIKKA_CLOUD_TEMPLATE_MODELS: CATALOGUE, E2B_BYO_COMPUTER_TEMPLATE: 'tpl1', E2B_CLAUDE_TEMPLATE: 'tpl2', E2B_CODEX_TEMPLATE: 'tpl3', MIKKA_CLOUD_WORKER_SHA: SHA }

function fakeVercel({ inFlight = 0, stored = STORED, redeploy = 'READY', commit } = {}) {
  const calls = []
  let listings = 0
  const fetchImpl = async (url, init) => {
    const path = url.pathname, method = init.method
    calls.push({ method, path, search: url.search, body: init.body && JSON.parse(init.body) })
    const json = (body) => ({ ok: true, status: 200, json: async () => body })
    if (method === 'POST' && path.endsWith('/env')) return json({ created: [] })
    if (path.endsWith('/env')) return json({ envs: Object.keys(stored).map((key) => ({ id: `id-${key}`, key, target: ['production'] })) })
    if (path.includes('/env/id-')) return json({ value: stored[path.split('/env/id-')[1]] })
    if (path === '/v6/deployments') return json({ deployments: [
      ...(listings++ < inFlight ? [{ uid: 'dpl_new', name: 'mikka', state: 'BUILDING' }] : []),
      { uid: 'dpl_live', name: 'mikka', state: 'READY', meta: { githubCommitSha: commit } }] })
    if (method === 'POST' && path === '/v13/deployments') return json({ id: 'dpl_redeploy' })
    if (path === '/v13/deployments/dpl_redeploy') return json({ readyState: redeploy, meta: { githubCommitSha: commit } })
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { fetchImpl, calls }
}

const run = (fake, extra = {}) => publish({ token: 't', templates: TEMPLATES, sourceSha: SHA, models: MODELS, fetchImpl: fake.fetchImpl, wait: async () => {}, log: () => {}, ...extra })

test('every template and the worker hash go to production in one upsert, then production is redeployed', async () => {
  const fake = fakeVercel()
  assert.deepEqual(await run(fake), { deploymentId: 'dpl_redeploy' })
  const writes = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/env'))
  assert.equal(writes.length, 1)
  assert.match(writes[0].search, /upsert=true/)
  assert.deepEqual(writes[0].body.map((e) => [e.key, e.value, e.target]), [
    ['E2B_BYO_COMPUTER_TEMPLATE', 'tpl1', ['production']], ['E2B_CLAUDE_TEMPLATE', 'tpl2', ['production']],
    ['E2B_CODEX_TEMPLATE', 'tpl3', ['production']], ['MIKKA_CLOUD_WORKER_SHA', SHA, ['production']], ['MIKKA_CLOUD_TEMPLATE_MODELS', CATALOGUE, ['production']]])
  const redeploy = fake.calls.find((c) => c.method === 'POST' && c.path === '/v13/deployments')
  assert.deepEqual(redeploy.body, { name: 'mikka', deploymentId: 'dpl_live', target: 'production' })
})

test('waits for a production build already running before redeploying', async () => {
  const fake = fakeVercel({ inFlight: 2 })
  await run(fake)
  assert.equal(fake.calls.filter((c) => c.path === '/v6/deployments').length, 3)
})

test('stops before redeploying when the env did not take', async () => {
  const fake = fakeVercel({ stored: { ...STORED, E2B_CODEX_TEMPLATE: 'old' } })
  await assert.rejects(run(fake), /env_not_updated E2B_CODEX_TEMPLATE/)
  assert.ok(!fake.calls.some((c) => c.path === '/v13/deployments'))
})

test('a failed redeploy fails the run', async () => {
  await assert.rejects(run(fakeVercel({ redeploy: 'ERROR' })), /redeploy_error/)
})

test('refuses a short SHA, an odd or a missing template id before any write', () => {
  assert.throws(() => pairEnv({ templates: TEMPLATES, sourceSha: 'abc1234' }), /source_sha_invalid/)
  assert.throws(() => pairEnv({ templates: { ...TEMPLATES, claude: 'a/b' }, sourceSha: SHA }), /template_id_invalid claude/)
  assert.throws(() => pairEnv({ templates: { desktop: 'tpl1', claude: 'tpl2' }, sourceSha: SHA }), /template_id_invalid codex/)
})

test('reads production\'s current worker hash, empty when unset', async () => {
  assert.equal(await currentWorkerSha({ token: 't', fetchImpl: fakeVercel().fetchImpl }), SHA)
  assert.equal(await currentWorkerSha({ token: 't', fetchImpl: fakeVercel({ stored: {} }).fetchImpl }), '')
})

test('refuses publishing a template without measured models before any write', () => {
  assert.throws(() => pairEnv({ templates: TEMPLATES, sourceSha: SHA }), /template_models_invalid/)
  assert.throws(() => pairEnv({ templates: TEMPLATES, sourceSha: SHA, models: { ...MODELS, desktop: [report('codex')] } }), /template_models_missing desktop claude_code/)
})

test('official runtime publishes source, worker and measured capabilities together, redeploying the exact Git commit', async () => {
  const sourceCommit = 'b'.repeat(40), templates = { desktop: 'desktop', claude: 'claude', codex: 'codex' }
  const officialEnv = pairEnv({ templates, sourceSha: SHA, models: MODELS })
  const stored = Object.fromEntries(officialEnv.map(row => [row.key, row.value]))
  stored.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = sourceCommit
  const fake = fakeVercel({ stored, commit: sourceCommit })
  await run(fake, { templates, sourceCommit })
  const writes = fake.calls.filter(row => row.method === 'POST' && row.path.endsWith('/env'))
  assert.equal(writes.length, 1)
  assert.ok(writes[0].body.some(row => row.key === 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT' && row.value === sourceCommit))
})

test('official runtime cannot redeploy a READY application from a different commit', async () => {
  const sourceCommit = 'b'.repeat(40), templates = { desktop: 'desktop', claude: 'claude', codex: 'codex' }
  const stored = Object.fromEntries(pairEnv({ templates, sourceSha: SHA, models: MODELS }).map(row => [row.key, row.value]))
  stored.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = sourceCommit
  const fake = fakeVercel({ stored, commit: 'c'.repeat(40) })
  await assert.rejects(run(fake, { templates, sourceCommit }), /no_ready_production_deployment/)
  assert.ok(!fake.calls.some(row => row.method === 'POST' && row.path === '/v13/deployments'))
})

test('official runtime refuses custom templates and invalid commits before writing production', async () => {
  for (const extra of [{ sourceCommit: 'short' }, { sourceCommit: 'b'.repeat(40) }]) {
    const fake = fakeVercel()
    await assert.rejects(run(fake, extra), /official_(source_commit|template)_invalid/)
    assert.equal(fake.calls.length, 0)
  }
})
