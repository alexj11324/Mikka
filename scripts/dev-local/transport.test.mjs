import assert from 'node:assert/strict'
import test from 'node:test'
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

test('only GitHub, and the gateway and Resend without a real key, go to the local fake', () => {
  assert.equal(devLocalTarget('https://api.github.com/repos/mikka-e2e/core-loop/installation?x=1', local), 'http://127.0.0.1:3191/github/repos/mikka-e2e/core-loop/installation?x=1')
  assert.equal(devLocalTarget('https://ai-gateway.vercel.sh/v1/decisions', { ...local, AI_GATEWAY_API_KEY: 'mvp-synthetic-decisions' }), 'http://127.0.0.1:3191/gateway/v1/decisions')
  assert.equal(devLocalTarget('https://ai-gateway.vercel.sh/v4/ai/language-model', { ...local, AI_GATEWAY_API_KEY: 'mvp-synthetic-decisions' }), 'http://127.0.0.1:3191/gateway/v4/ai/language-model')
  assert.equal(devLocalTarget('https://ai-gateway.vercel.sh/v1/decisions', { ...local, AI_GATEWAY_API_KEY: 'a-real-key' }), null)
  assert.equal(devLocalTarget('https://ai-gateway.vercel.sh/v4/ai/language-model', local), null)
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
    await fetch('https://api.deepseek.com/v1/models')
  } finally { restore() }
  assert.deepEqual(seen, ['http://127.0.0.1:3191/github/user/4242', 'https://api.deepseek.com/v1/models'])
})
