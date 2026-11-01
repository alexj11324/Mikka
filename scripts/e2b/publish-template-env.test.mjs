import assert from 'node:assert/strict'
import test from 'node:test'
import { currentWorkerSha, pairEnv, publish } from './publish-template-env.mjs'

const SHA = 'a'.repeat(40)

function fakeVercel({ inFlight = 0, stored = { E2B_BYO_COMPUTER_TEMPLATE: 'tpl1', MIKKA_CLOUD_WORKER_SHA: SHA }, redeploy = 'READY' } = {}) {
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
      { uid: 'dpl_live', name: 'mikka', state: 'READY' }] })
    if (method === 'POST' && path === '/v13/deployments') return json({ id: 'dpl_redeploy' })
    if (path === '/v13/deployments/dpl_redeploy') return json({ readyState: redeploy })
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { fetchImpl, calls }
}

const run = (fake, extra = {}) => publish({ token: 't', templateId: 'tpl1', sourceSha: SHA, fetchImpl: fake.fetchImpl, wait: async () => {}, log: () => {}, ...extra })

test('both variables go to production in one upsert, then production is redeployed', async () => {
  const fake = fakeVercel()
  assert.deepEqual(await run(fake), { deploymentId: 'dpl_redeploy' })
  const writes = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/env'))
  assert.equal(writes.length, 1)
  assert.match(writes[0].search, /upsert=true/)
  assert.deepEqual(writes[0].body.map((e) => [e.key, e.value, e.target]), [
    ['E2B_BYO_COMPUTER_TEMPLATE', 'tpl1', ['production']], ['MIKKA_CLOUD_WORKER_SHA', SHA, ['production']]])
  const redeploy = fake.calls.find((c) => c.method === 'POST' && c.path === '/v13/deployments')
  assert.deepEqual(redeploy.body, { name: 'mikka', deploymentId: 'dpl_live', target: 'production' })
})

test('waits for a production build already running before redeploying', async () => {
  const fake = fakeVercel({ inFlight: 2 })
  await run(fake)
  assert.equal(fake.calls.filter((c) => c.path === '/v6/deployments').length, 3)
})

test('stops before redeploying when the env did not take', async () => {
  const fake = fakeVercel({ stored: { E2B_BYO_COMPUTER_TEMPLATE: 'old', MIKKA_CLOUD_WORKER_SHA: SHA } })
  await assert.rejects(run(fake), /env_not_updated E2B_BYO_COMPUTER_TEMPLATE/)
  assert.ok(!fake.calls.some((c) => c.path === '/v13/deployments'))
})

test('a failed redeploy fails the run', async () => {
  await assert.rejects(run(fakeVercel({ redeploy: 'ERROR' })), /redeploy_error/)
})

test('refuses a short SHA or an odd template id before any write', () => {
  assert.throws(() => pairEnv({ templateId: 'tpl1', sourceSha: 'abc1234' }), /source_sha_invalid/)
  assert.throws(() => pairEnv({ templateId: 'a/b', sourceSha: SHA }), /template_id_invalid/)
})

test('reads production\'s current worker hash, empty when unset', async () => {
  assert.equal(await currentWorkerSha({ token: 't', fetchImpl: fakeVercel().fetchImpl }), SHA)
  assert.equal(await currentWorkerSha({ token: 't', fetchImpl: fakeVercel({ stored: {} }).fetchImpl }), '')
})
