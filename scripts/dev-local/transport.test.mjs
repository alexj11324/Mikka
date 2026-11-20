import assert from 'node:assert/strict'
import test from 'node:test'
import { FAKE_MODEL_KEY } from '../../tests/fakes/litellm.mjs'
import { localModelEnvironment } from './model-environment.mjs'
import { LOCAL_LITELLM_KEY, LOCAL_LITELLM_URL } from './services.mjs'
import { devLocalMode } from './guard.mjs'
import { devLocalTarget, installDevLocalTransport } from './transport.mjs'

const db = 'postgres://dev:pw@127.0.0.1:5432/mikka_dev_e2e'
const local = { MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: db, MIKKA_DATABASE_URL: db, DATABASE_URL: db }

test('dev:local holds only in local test-account mode, off any deployment or production build', () => {
  assert.equal(devLocalMode(local), true)
  assert.equal(devLocalMode({ ...local, MIKKA_LOCAL_TEST_ACCOUNTS: undefined }), false)
  assert.equal(devLocalMode({ ...local, E2E_DATABASE_URL: undefined }), false)
  assert.equal(devLocalMode({ ...local, DATABASE_URL: 'postgres://dev:pw@db.example.com:5432/mikka_dev_e2e' }), false)
  assert.equal(devLocalMode({ ...local, MIKKA_DATABASE_URL: 'postgres://dev:pw@127.0.0.1:5432/orvilo_mvp' }), false)
  assert.equal(devLocalMode({ ...local, VERCEL: '1' }), false)
  assert.equal(devLocalMode({ ...local, VERCEL_ENV: 'preview' }), false)
  assert.equal(devLocalMode({ ...local, NODE_ENV: 'production' }), false)
})

test('only GitHub and the explicitly synthetic LiteLLM and Resend go to the local fake', () => {
  assert.equal(devLocalTarget('https://api.github.com/repos/mikka-e2e/core-loop/installation?x=1', local), 'http://127.0.0.1:3191/github/repos/mikka-e2e/core-loop/installation?x=1')
  for (const path of ['/v1/decisions', '/v1/chat/completions']) {
    const url = LOCAL_LITELLM_URL + path
    assert.equal(devLocalTarget(url, { ...local, MIKKA_LITELLM_URL: LOCAL_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: LOCAL_LITELLM_KEY }), url)
    assert.equal(devLocalTarget(url, { ...local, MIKKA_LITELLM_URL: LOCAL_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: 'real-key' }), null)
  }
  assert.equal(devLocalTarget('https://api.resend.com/emails', { ...local, RESEND_API_KEY: 'mikka-local-outbox' }), 'http://127.0.0.1:3191/resend/emails')
  assert.equal(devLocalTarget('https://api.resend.com/emails', { ...local, RESEND_API_KEY: 're_real' }), null)
  assert.equal(devLocalTarget('https://api.resend.com/domains', { ...local, RESEND_API_KEY: 'mikka-local-outbox' }), null)
  assert.equal(devLocalTarget('https://api.deepseek.com/v1/chat/completions', local), null)
  assert.equal(devLocalTarget('https://github.com/login/oauth/authorize', local), null)
})

test('the transport refuses to install outside dev:local and rewrites only matched requests', async () => {
  assert.throws(() => installDevLocalTransport({ ...local, VERCEL_ENV: 'production' }, async () => new Response()), /dev:local needs/)
  const seen = []
  const restore = installDevLocalTransport(local, async request => { seen.push(request.url); return new Response('ok') })
  try {
    await fetch('https://api.github.com/user/4242')
    await fetch('https://api.deepseek.com/v1/models', { headers: { authorization: `Bearer ${FAKE_MODEL_KEY}` } })
  } finally { restore() }
  assert.deepEqual(seen, ['http://127.0.0.1:3191/github/user/4242', 'http://127.0.0.1:3191/litellm/v1/models'])
})

test('scripted acceptance refuses all live inference, preserving model-selection validation', async () => {
  const seen = []
  const restore = installDevLocalTransport(local, async request => { seen.push(request.url); return new Response('ok') })
  try {
    for (const [url, method, body] of [
      ['https://api.deepseek.com/v1/chat/completions', 'POST', { model: 'deepseek-v4-pro' }],
      ['https://api.deepseek.com/anthropic/v1/messages', 'POST', { model: 'deepseek-v4-pro' }],
      ['https://ai-gateway.vercel.sh/v1/responses', 'POST', { model: 'deepseek/deepseek-v4-pro' }],
      ['http://127.0.0.1:3000/mikka/api/mobile/model', 'PUT', { bot: null, id: 'apikey:fixture:deepseek-v4-pro' }],
    ]) await assert.rejects(() => fetch(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), /Flash-only test policy/)
    assert.deepEqual(seen, [], 'A rejected Pro request must never reach upstream fetch')
    await assert.rejects(() => fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'deepseek-flash' }) }), /unstubbed external request/)
    assert.equal(seen.length, 0)
  } finally { restore() }
})


test('scripted configuration overwrites inherited model keys and live mode requires deliberate manual configuration', () => {
  assert.deepEqual(localModelEnvironment({ MIKKA_LITELLM_URL: 'https://real.invalid', MIKKA_LITELLM_MASTER_KEY: 'inherited', DEEPSEEK_API_KEY: 'inherited' }), {
    MIKKA_LITELLM_URL: LOCAL_LITELLM_URL, MIKKA_LITELLM_MASTER_KEY: LOCAL_LITELLM_KEY, DEEPSEEK_API_KEY: FAKE_MODEL_KEY,
  })
  const manual = { MIKKA_LOCAL_LIVE_MODELS: '1', MIKKA_LITELLM_URL: 'https://manual.invalid', MIKKA_LITELLM_MASTER_KEY: 'explicit', DEEPSEEK_API_KEY: 'explicit' }
  assert.equal(localModelEnvironment(manual).MIKKA_LITELLM_URL, manual.MIKKA_LITELLM_URL)
  for (const flags of [{ CI: '1' }, { GITHUB_ACTIONS: 'true' }, { LOCAL_LOOP_ITEMS: '1' }, { MIKKA_LOCAL_LOOP: '1' }]) assert.throws(() => localModelEnvironment({ ...manual, ...flags }), /forbidden/)
  assert.throws(() => localModelEnvironment({ MIKKA_LOCAL_LIVE_MODELS: '1' }), /requires an explicit/)
})
