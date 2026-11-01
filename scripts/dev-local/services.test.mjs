import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createGateway, generateText, streamText } from 'ai'
import { MVP_DECISION_KEY } from '../../tests/mvp/transport.mjs'
import { startLocalCron } from './cron.mjs'
import { grantLocalCredits, localDecision, localModelAnswer, localServiceRoutes, LOCAL_CRON_SECRET, LOCAL_RESEND_KEY } from './services.mjs'

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
  assert.equal(await grantLocalCredits({ query: async () => ({ rows: [] }) }), 0)
})

test('the real AI SDK gateway provider and a Resend call reach the substitutes', async t => {
  const { routes } = localServiceRoutes({ log: () => {} })
  const server = createServer(async (request, response) => {
    if (!await routes(request, response, new URL(request.url, 'http://127.0.0.1'))) { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  // What scripts/dev-local/transport.mjs does, pointed at this server.
  const local = (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const target = url.hostname === 'ai-gateway.vercel.sh' ? `${origin}/gateway${url.pathname}` : url.hostname === 'api.resend.com' ? `${origin}/resend${url.pathname}` : null
    assert.ok(target, `unexpected request ${url.href}`)
    return fetch(new Request(target, request))
  }

  // The provider's own default endpoint, as production code builds it.
  const gateway = createGateway({ apiKey: MVP_DECISION_KEY, fetch: local })
  const generated = await generateText({ model: gateway('deepseek/deepseek-v4.1-flash'), prompt: 'ping' })
  assert.equal(generated.text, 'Local model: ping')
  assert.match(generated.providerMetadata.gateway.generationId, /^local-/)
  const streamed = streamText({ model: gateway('deepseek/deepseek-v4.1-flash'), prompt: 'a longer message than one chunk of the stream' })
  assert.equal(await streamed.text, 'Local model: a longer message than one chunk of the stream')

  const decision = await local('https://ai-gateway.vercel.sh/v1/decisions', { method: 'POST', headers: { authorization: `Bearer ${MVP_DECISION_KEY}` }, body: JSON.stringify({ model: 'm', questions: [{ type: 'predicate', name: 'p' }] }) })
  assert.deepEqual((await decision.json()).answers, [{ type: 'predicate', name: 'p', probability: 0.5 }])
  const rejected = await local('https://ai-gateway.vercel.sh/v1/decisions', { method: 'POST', headers: { authorization: 'Bearer real-looking-key' }, body: '{}' })
  assert.equal(rejected.status, 401)

  const sent = await local('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${LOCAL_RESEND_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'Mikka <noreply@example.com>', to: ['dev@example.com'], subject: 'Verify', text: 'Verify\n\nhttp://localhost:3000/mikka/api/auth/verify-email?token=t' }),
  })
  assert.equal(sent.status, 200)
  assert.equal(typeof (await sent.json()).id, 'string')
  const outbox = await (await fetch(`${origin}/mail.json`)).json()
  assert.deepEqual(outbox.messages.map(mail => mail.to), [['dev@example.com']])
  assert.match(await (await fetch(`${origin}/mail`)).text(), /<a href="http:\/\/localhost:3000\/mikka\/api\/auth\/verify-email\?token=t">/)
  assert.equal((await fetch(`${origin}/github/user`)).status, 404, 'other paths fall through to the MVP fake')
})

test('the local cron runs the production minute schedule on the minute and survives failures', async () => {
  const runs = [], logs = [], timers = []
  let clock = Date.UTC(2026, 10, 1, 12, 14, 30)
  const stop = startLocalCron({
    appUrl: 'http://localhost:3000/mikka', secret: LOCAL_CRON_SECRET, log: line => logs.push(line), now: () => clock,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return null },
    run: async (cron, env, _fetch, at) => { runs.push({ cron, env, at }); if (runs.length === 1) throw new Error('/api/cron/schedules answered 502') },
  })
  assert.equal(timers[0].ms, 30_000)
  clock += 30_000
  timers[0].fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(runs[0], { cron: '* * * * *', env: { MIKKA_URL: 'http://localhost:3000/mikka', CRON_SECRET: LOCAL_CRON_SECRET }, at: Date.UTC(2026, 10, 1, 12, 15) })
  assert.ok(logs.includes('[local-cron] /api/cron/schedules answered 502'))
  assert.equal(timers.length, 2)
  assert.equal(timers[1].ms, 60_000)
  stop()
})

test('the local workspace secrets key is created once, private, and reused', async t => {
  const { mkdtemp, rm, stat, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { localSecretsKey } = await import('./secrets-key.mjs')
  const directory = join(await mkdtemp(join(tmpdir(), 'mikka-dev-local-')), 'state')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const key = localSecretsKey(directory)
  assert.match(key, /^[a-f\d]{64}$/)
  assert.equal(localSecretsKey(directory), key)
  assert.equal((await stat(join(directory, 'workspace-secrets-key'))).mode & 0o777, 0o600)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  await writeFile(join(directory, 'workspace-secrets-key'), 'not a key\n')
  assert.notEqual(localSecretsKey(directory), key, 'an unusable file is replaced')
})
