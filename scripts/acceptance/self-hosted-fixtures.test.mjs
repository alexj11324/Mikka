import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { assertFixtureEnvironment } from './self-hosted-services.mjs'
import { createModelFixture } from './self-hosted-model.mjs'

const fixture = {
  MIKKA_SELF_HOSTED_ACCEPTANCE: '1', BETTER_AUTH_URL: 'http://localhost:3000',
  MIKKA_EXPECTED_REVISION: '1'.repeat(40),
  MIKKA_DATABASE_URL: 'postgres://mikka:isolated@postgres:5432/mikka',
  DATABASE_URL: 'postgres://mikka:isolated@postgres:5432/mikka',
  SMTP_URL: 'smtp://mailpit:1025', S3_ENDPOINT: 'http://minio:9000', S3_BUCKET: 'mikka-selfhost-ci',
  S3_ACCESS_KEY_ID: 'selfhost-ci', S3_SECRET_ACCESS_KEY: Buffer.alloc(32, 1).toString('base64'), S3_REGION: 'us-east-1',
  MIKKA_DEFAULT_MODEL_BASE_URL: 'http://model:8080/v1', MIKKA_DEFAULT_MODEL_API_KEY: 'synthetic-selfhost-only', MIKKA_DEFAULT_MODEL_ID: 'selfhost-ci',
}

test('the mutating driver refuses public origins, remote databases, cloud credentials and real model targets', () => {
  assert.doesNotThrow(() => assertFixtureEnvironment(fixture))
  for (const overrides of [
    { MIKKA_SELF_HOSTED_ACCEPTANCE: undefined }, { BETTER_AUTH_URL: 'https://app.aspectlylabs.com' },
    { MIKKA_EDITION: 'cloud' }, { MIKKA_EXPECTED_REVISION: 'main' },
    { MIKKA_DATABASE_URL: 'postgres://mikka:isolated@production.example.test:5432/mikka' },
    { DATABASE_URL: 'postgres://mikka:isolated@postgres:5432/other' },
    { SMTP_URL: 'smtp://external.example.test:1025' }, { S3_ENDPOINT: 'https://storage.example.test' },
    { MIKKA_DEFAULT_MODEL_BASE_URL: 'https://api.openai.com/v1' },
    { MIKKA_DEFAULT_MODEL_API_KEY: 'real-key' }, { VERCEL: '1' }, { AI_GATEWAY_API_KEY: 'real-key' },
    { GITHUB_APP_PRIVATE_KEY: 'real-key' }, { DEVICE_GATEWAY_URL: 'https://gateway.example.test' },
  ]) assert.throws(() => assertFixtureEnvironment({ ...fixture, ...overrides }))
})

test('the isolated model supports ordinary and streaming OpenAI requests with explicit synthetic receipts', async t => {
  const server = createModelFixture().listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (body, authorization = 'Bearer synthetic-selfhost-only') => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const response = await call({ model: 'selfhost-ci', messages: [{ role: 'user', content: 'selfhost_turn_01' }] })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'SELF_HOSTED_REPLY_01')
  const stream = await call({ model: 'selfhost-ci', messages: [{ role: 'user', content: 'selfhost_turn_02' }], stream: true })
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  const chunks = (await stream.text()).split('\n\n').filter(Boolean)
  assert.equal(JSON.parse(chunks[0].slice(6)).choices[0].delta.content, 'SELF_HOSTED_REPLY_02')
  assert.equal(JSON.parse(chunks[1].slice(6)).choices[0].finish_reason, 'stop')
  assert.equal(chunks[2], 'data: [DONE]')
  const refused = await call({ model: 'selfhost-ci', messages: [] }, 'Bearer other')
  assert.equal(refused.status, 400); await refused.body.cancel()
  assert.deepEqual(await (await fetch(`${base}/evidence`)).json(), { synthetic: true, calls: 2, turns: ['01', '02'] })
})
