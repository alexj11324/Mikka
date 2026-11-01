import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGateway, generateText, streamText } from 'ai'
import { LOCAL_GATEWAY_KEY, LOCAL_RESEND_KEY, localServicesChildEnv, localServicesEnabled, localServicesOrigin } from './local-mode.mjs'
import { assertLoopbackOrigin, installLocalTransport, localRoute } from './local-transport.mjs'
import { grantLocalCredits, localDecision, localModelAnswer, startLocalServices } from './local-services.mjs'

const LOCAL = 'postgresql://e2e:local@127.0.0.1:5432/mikka_e2e'
const local = (extra = {}) => ({ MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: LOCAL, MIKKA_DATABASE_URL: LOCAL, DATABASE_URL: LOCAL, ...extra })

test('local services follow the shared local test-account mode and never run on a deployment', () => {
  assert.equal(localServicesEnabled(local()), true)
  assert.equal(localServicesEnabled(local({ MIKKA_LOCAL_TEST_ACCOUNTS: undefined })), false)
  assert.equal(localServicesEnabled(local({ DATABASE_URL: 'postgresql://u:p@db.example.com/mikka_e2e' })), false)
  assert.equal(localServicesEnabled(local({ MIKKA_DATABASE_URL: 'postgresql://u:p@127.0.0.1/mikka' })), false)
  assert.equal(localServicesEnabled(local({ NODE_ENV: 'production' })), false)
  assert.equal(localServicesEnabled(local({ VERCEL: '1' })), false)
  assert.equal(localServicesEnabled(local({ VERCEL_ENV: 'preview' })), false)
  assert.equal(localServicesEnabled(local({ MIKKA_LOCAL_SERVICES: '0' })), false)
})

test('the child environment holds placeholders and the preload only', () => {
  const env = localServicesChildEnv(local({ NODE_OPTIONS: '--use-openssl-ca' }), '/repo/scripts/dev/local-preload.mjs')
  assert.deepEqual(env, {
    MIKKA_LOCAL_SERVICES_ORIGIN: 'http://127.0.0.1:3192',
    AI_GATEWAY_API_KEY: LOCAL_GATEWAY_KEY,
    RESEND_API_KEY: LOCAL_RESEND_KEY,
    NODE_OPTIONS: '--use-openssl-ca --import=/repo/scripts/dev/local-preload.mjs',
  })
  assert.equal(localServicesOrigin({ MIKKA_LOCAL_SERVICES_PORT: '4100' }), 'http://127.0.0.1:4100')
  assert.throws(() => localServicesOrigin({ MIKKA_LOCAL_SERVICES_PORT: '80' }))
})

test('only the substituted cloud endpoints are rerouted, to loopback only', () => {
  const origin = 'http://127.0.0.1:3192'
  assert.equal(localRoute('https://ai-gateway.vercel.sh/v4/ai/language-model', origin), `${origin}/gateway/v4/ai/language-model`)
  assert.equal(localRoute('https://ai-gateway.vercel.sh/v1/decisions', origin), `${origin}/gateway/v1/decisions`)
  assert.equal(localRoute('https://api.resend.com/emails', origin), `${origin}/resend/emails`)
  assert.equal(localRoute('https://api.resend.com/domains', origin), null)
  assert.equal(localRoute('https://api.github.com/user', origin), null)
  assert.equal(localRoute('http://ai-gateway.vercel.sh/v1/decisions', origin), null)
  for (const bad of ['https://127.0.0.1:3192', 'http://example.com:3192', 'http://127.0.0.1:3192/x', 'http://u:p@127.0.0.1:3192'])
    assert.throws(() => assertLoopbackOrigin(bad))
})

test('the scripted model echoes, calls a registered tool on /tool and reports tool results', () => {
  const user = text => ({ prompt: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [{ type: 'function', name: 'create_issue' }] })
  assert.deepEqual(localModelAnswer(user('hello')).content, [{ type: 'text', text: 'Local model: hello' }])
  const call = localModelAnswer(user('/tool create_issue {"title":"A"}'))
  assert.equal(call.finishReason, 'tool-calls')
  assert.equal(call.content[0].toolName, 'create_issue')
  assert.deepEqual(JSON.parse(call.content[0].input), { title: 'A' })
  assert.match(localModelAnswer(user('/tool nope {}')).content[0].text, /no tool named nope/)
  const result = localModelAnswer({ prompt: [{ role: 'tool', content: [{ type: 'tool-result', toolName: 'create_issue', output: { type: 'json', value: { id: 'x' } } }] }] })
  assert.equal(result.content[0].text, 'create_issue: {"id":"x"}')
})

test('decisions answer every question with a valid shape', () => {
  const answer = localDecision({ model: 'm', questions: [
    { type: 'choice', name: 'tier', choices: [{ value: 'attention' }, { value: 'result' }] },
    { type: 'predicate', name: 'ok' },
  ] })
  assert.equal(answer.model, 'm')
  assert.match(answer.provider_metadata.gateway.generationId, /^local-/)
  assert.deepEqual(answer.answers, [{ type: 'choice', name: 'tier', choice: 'attention' }, { type: 'predicate', name: 'ok', probability: 0.5 }])
})

test('credit grant covers every workspace once', async () => {
  const calls = []
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return sql.startsWith('SELECT') ? { rows: [{ id: 'a' }, { id: 'b' }] } : { rowCount: 2 } } }
  assert.equal(await grantLocalCredits(pool), 2)
  assert.match(calls[1].sql, /INSERT INTO hosted_verifications .* ON CONFLICT DO NOTHING/)
  assert.match(calls[2].sql, /INSERT INTO hosted_allowances .* ON CONFLICT DO NOTHING/)
  assert.deepEqual(calls[1].params, [['a', 'b']])
  const empty = { query: async () => ({ rows: [] }) }
  assert.equal(await grantLocalCredits(empty), 0)
})

test('the real AI SDK gateway provider and the Resend call reach the local services', async t => {
  const env = local({ MIKKA_LOCAL_SERVICES_PORT: String(20000 + Math.floor(Math.random() * 20000)) })
  const services = await startLocalServices({ env, credits: false, log: () => {} })
  const restore = installLocalTransport(services.origin)
  t.after(async () => { restore(); await services.close() })

  // The provider's own default endpoint, exactly as production code builds it.
  const gateway = createGateway({ apiKey: LOCAL_GATEWAY_KEY })
  const generated = await generateText({ model: gateway('deepseek/deepseek-v4.1-flash'), prompt: 'ping' })
  assert.equal(generated.text, 'Local model: ping')
  assert.match(generated.providerMetadata.gateway.generationId, /^local-/)
  const streamed = streamText({ model: gateway('deepseek/deepseek-v4.1-flash'), prompt: 'a longer message than one chunk of the stream' })
  assert.equal(await streamed.text, 'Local model: a longer message than one chunk of the stream')

  const rejected = await fetch('https://ai-gateway.vercel.sh/v1/decisions', { method: 'POST', headers: { authorization: 'Bearer real-looking-key' }, body: '{}' })
  assert.equal(rejected.status, 401)

  const sent = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${LOCAL_RESEND_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'Mikka <noreply@example.com>', to: ['dev@example.com'], subject: 'Verify', text: 'Verify\n\nhttp://localhost:3000/mikka/api/auth/verify-email?token=t' }),
  })
  assert.equal(sent.status, 200)
  assert.equal(typeof (await sent.json()).id, 'string')
  const outbox = await (await fetch(`${services.origin}/mail.json`)).json()
  assert.equal(outbox.messages.length, 1)
  assert.deepEqual(outbox.messages[0].to, ['dev@example.com'])
  assert.match(await (await fetch(`${services.origin}/mail`)).text(), /<a href="http:\/\/localhost:3000\/mikka\/api\/auth\/verify-email\?token=t">/)
})

test('the services refuse to start outside local mode', async () => {
  await assert.rejects(startLocalServices({ env: local({ MIKKA_LOCAL_TEST_ACCOUNTS: '0' }), credits: false, log: () => {} }), /local test-account mode/)
})
