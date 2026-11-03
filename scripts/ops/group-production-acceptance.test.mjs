import assert from 'node:assert/strict'
import test from 'node:test'
import { runGroupProductionAcceptance } from './group-production-acceptance.mjs'

const env = { MIKKA_TEST_ACCOUNT_EMAIL: 'alexjiang20232024@gmail.com', MIKKA_TEST_ACCOUNT_PASSWORD: 'synthetic-credential', GROUP_ACCEPTANCE_DEPLOYMENT: 'dpl_fixture', GROUP_ACCEPTANCE_REVISION: 'a'.repeat(40) }
const forbidden = async () => { throw Error('must not make a request') }

test('production driver requires an authorized test identity and fixed deployment before any I/O', async () => {
  await assert.rejects(runGroupProductionAcceptance({ env: {}, fetchImpl: forbidden }), /account_required/)
  await assert.rejects(runGroupProductionAcceptance({ env: { ...env, MIKKA_TEST_ACCOUNT_EMAIL: 'stranger@example.com' }, fetchImpl: forbidden }), /account_required/)
  await assert.rejects(runGroupProductionAcceptance({ env: { ...env, GROUP_ACCEPTANCE_REVISION: 'main' }, fetchImpl: forbidden }), /fixed_deployment/)
  await assert.rejects(runGroupProductionAcceptance({ env: { ...env, GROUP_ACCEPTANCE_TASK_TIMEOUT_MS: 'NaN' }, fetchImpl: forbidden }), /timeout_invalid/)
  await assert.rejects(runGroupProductionAcceptance({ env: { ...env, GROUP_ACCEPTANCE_STOP_TIMEOUT_MS: '3600000' }, fetchImpl: forbidden }), /timeout_invalid/)
  for (const origin of ['https://example.com', 'https://app.aspectlylabs.com/other', 'https://name:pass@app.aspectlylabs.com', 'https://app.aspectlylabs.com?token=x']) {
    await assert.rejects(runGroupProductionAcceptance({ env: { ...env, GROUP_ACCEPTANCE_ORIGIN: origin }, fetchImpl: forbidden }), /origin_rejected/)
  }
})

test('a moving deployment is rejected before login or fixture writes', async () => {
  const calls = []
  const result = await runGroupProductionAcceptance({ env, fetchImpl: async (url, init) => { calls.push([String(url), init.method]); return Response.json({ build: 'dpl_other' }) } })
  assert.equal(result.status, 'fail'); assert.equal(result.error, 'acceptance_deployment_changed')
  assert.deepEqual(calls, [['https://app.aspectlylabs.com/mikka/api/version', 'GET']])
})

test('a different authenticated identity is rejected and only the transient session is signed out', async () => {
  const paths = []
  const result = await runGroupProductionAcceptance({ env, fetchImpl: async url => {
    const path = new URL(url).pathname; paths.push(path)
    if (path.endsWith('/version')) return Response.json({ build: env.GROUP_ACCEPTANCE_DEPLOYMENT })
    if (path.endsWith('/sign-in/email')) return Response.json({}, { headers: { 'set-cookie': 'synthetic=session; Path=/' } })
    if (path.endsWith('/get-session')) return Response.json({ user: { email: 'someone-else@example.com' } })
    if (path.endsWith('/sign-out')) return Response.json({})
    assert.fail('must not create fixtures for the wrong identity')
  } })
  assert.equal(result.error, 'acceptance_session_identity')
  assert.equal(paths.at(-1), '/mikka/api/auth/sign-out')
  assert.ok(!JSON.stringify(result).includes('synthetic-credential'))
})

test('unavailable Flash stops before a prompt; hosted fallback is not selected and fixture IDs are retained', async () => {
  const calls = []
  let role
  const result = await runGroupProductionAcceptance({ env, fetchImpl: async (url, init) => {
    const path = new URL(url).pathname; calls.push([path, init.method])
    if (path.endsWith('/version')) return Response.json({ build: env.GROUP_ACCEPTANCE_DEPLOYMENT })
    if (path.endsWith('/sign-in/email')) return Response.json({}, { headers: { 'set-cookie': 'synthetic=session; Path=/' } })
    if (path.endsWith('/get-session')) return Response.json({ user: { id: 'fixture-owner', email: env.MIKKA_TEST_ACCOUNT_EMAIL } })
    if (path === '/mikka/api/bots') return Response.json(init.method === 'GET' ? [{ id: 'existing', workspaceId: 'workspace' }] : { id: 'new-owned-bot', workspaceId: 'workspace' })
    if (path === '/mikka/api/bots/new-owned-bot') {
      if (init.method === 'PATCH') role = JSON.parse(init.body).publicRole
      return Response.json({ id: 'new-owned-bot', publicRole: role })
    }
    if (path.endsWith('/model')) return Response.json({ groups: [{ kind: 'hosted', options: [{ id: 'hosted', modelId: '', provider: 'mikka' }] }] })
    if (path.endsWith('/sign-out')) return Response.json({})
    assert.fail('no prompt or unrelated mutation is allowed after unavailable Flash')
  } })
  assert.equal(result.error, 'acceptance_flash_model_unavailable')
  assert.deepEqual(result.bots, [{ id: 'new-owned-bot', role: 'UI', modelId: null }])
  assert.ok(!calls.some(([path, method]) => path.endsWith('/model') && method === 'PUT'))
})
