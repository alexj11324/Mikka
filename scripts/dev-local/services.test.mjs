import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { generateText, jsonSchema, stepCountIs, streamText, tool } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { startLocalCron } from './cron.mjs'
import { refreshQueue } from './refresh-queue.mjs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { stopOwnedServices } from './shutdown.mjs'
import { grantLocalCredits, localDecision, localModelAnswer, localServiceRoutes, LOCAL_CRON_SECRET, LOCAL_RESEND_KEY, LOCAL_LITELLM_KEY } from './services.mjs'

test('the scripted model matches explicit /echo and /tool scripts and refuses unfamiliar prompts', () => {
  const user = text => ({ prompt: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [{ type: 'function', name: 'create_issue' }] })
  assert.deepEqual(localModelAnswer(user('/echo hello')).content, [{ type: 'text', text: 'Local model: hello' }])
  const call = localModelAnswer(user('/tool create_issue {"title":"A"}'))
  assert.equal(call.finishReason, 'tool-calls')
  assert.equal(call.content[0].toolName, 'create_issue')
  assert.deepEqual(JSON.parse(call.content[0].input), { title: 'A' })
  assert.equal(localModelAnswer(user('/tool nope {}')), null)
  assert.equal(localModelAnswer(user('unregistered free-form prompt')), null)
  const result = localModelAnswer({ ...user('/tool create_issue {"title":"A"}'), prompt: [...user('/tool create_issue {"title":"A"}').prompt, { role: 'tool', content: [{ type: 'tool-result', toolName: 'create_issue', output: { type: 'json', value: { id: 'x' } } }] }] })
  assert.equal(result.content[0].text, 'create_issue: {"id":"x"}')
})

test('decisions answer every question with a valid shape', () => {
  const answer = localDecision({ model: 'mikka-decision', input: '[fixture:decision]', questions: [
    { type: 'choice', name: 'tier', choices: [{ value: 'attention' }, { value: 'result' }] },
    { type: 'predicate', name: 'ok' },
  ] })
  assert.equal(answer.model, 'mikka-decision')
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

test('Decisions and Resend calls reach the substitutes', async t => {
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
    const target = url.hostname === 'litellm.invalid' ? `${origin}/litellm${url.pathname}` : url.hostname === 'api.resend.com' ? `${origin}/resend${url.pathname}` : null
    assert.ok(target, `unexpected request ${url.href}`)
    return fetch(new Request(target, request))
  }

  const decision = await local('https://litellm.invalid/v1/decisions', { method: 'POST', headers: { authorization: `Bearer ${LOCAL_LITELLM_KEY}` }, body: JSON.stringify({ model: 'mikka-decision', input: '[fixture:decision]', questions: [{ type: 'predicate', name: 'p' }] }) })
  assert.match(decision.headers.get('x-litellm-call-id'), /^fake-litellm-/)
  assert.equal(decision.headers.get('x-litellm-response-cost'), '0.001234')
  assert.deepEqual((await decision.json()).answers, [{ type: 'predicate', name: 'p', probability: 0.5 }])
  const rejected = await local('https://litellm.invalid/v1/decisions', { method: 'POST', headers: { authorization: 'Bearer real-looking-key' }, body: '{}' })
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

test('the local cron runs the production schedule on each quarter hour and survives failures', async () => {
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
  assert.deepEqual(runs[0], { cron: '0,15,30,45 * * * *', env: { MIKKA_URL: 'http://localhost:3000/mikka', CRON_SECRET: LOCAL_CRON_SECRET }, at: Date.UTC(2026, 10, 1, 12, 15) })
  assert.ok(logs.includes('[local-cron] /api/cron/schedules answered 502'))
  assert.equal(timers.length, 2)
  assert.equal(timers[1].ms, 15 * 60_000)
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

test('an immediate refresh includes owners registered during the previous scan', async () => {
  const owners = ['existing']
  const scanned = []
  let release
  const held = new Promise(resolve => { release = resolve })
  const refresh = refreshQueue(async () => {
    const snapshot = [...owners]
    if (!scanned.length) await held
    scanned.push(snapshot)
  })
  const periodic = refresh()
  // Let the first query capture its owner list, then register another owner.
  await Promise.resolve()
  owners.push('new-owner')
  const immediate = refresh()
  release()
  await Promise.all([periodic, immediate])
  assert.deepEqual(scanned, [['existing'], ['existing', 'new-owner']])
})

test('a failed local scan does not poison subsequent refresh requests', async () => {
  let attempts = 0
  const refresh = refreshQueue(async () => { if (++attempts === 1) throw new Error('temporary'); return 'ready' })
  await assert.rejects(refresh(), /temporary/)
  assert.equal(await refresh(), 'ready')
})

test('shutdown waits for owned child termination and closes owned resources', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);console.log("ready")'], { stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child.stdout, 'data')
  let closed = false
  await stopOwnedServices([child], [async () => { closed = true }], 1000)
  assert.equal(closed, true)
  assert.equal(child.signalCode, 'SIGTERM')
})

test('a stuck child or failing closer cannot leave the local stack running', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);console.log("ready")'], { stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child.stdout, 'data')
  const exited = once(child, 'exit')
  await stopOwnedServices([child], [() => { throw new Error('closer failed') }], 100)
  await exited
  assert.equal(child.signalCode, 'SIGKILL')
})

test('the real OpenAI-compatible provider reaches the LiteLLM substitute, tool calls included', async t => {
  const { routes } = localServiceRoutes({ log: () => {} })
  const server = createServer(async (request, response) => {
    if (!await routes(request, response, new URL(request.url, 'http://127.0.0.1'))) { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const local = (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.url, 'https://litellm.invalid/v1/chat/completions')
    return fetch(new Request(`${origin}/litellm/v1/chat/completions`, request))
  }
  // The LiteLLM client uses the same Chat Completions wire protocol.
  const model = createOpenAICompatible({ name: 'litellm', baseURL: 'https://litellm.invalid/v1', apiKey: LOCAL_LITELLM_KEY, includeUsage: true, fetch: local }).chatModel('mikka-default')
  assert.equal((await generateText({ model, prompt: '/echo ping' })).text, 'Local model: ping')
  const streamed = streamText({ model, prompt: '/echo a longer message than one chunk of the stream' })
  assert.equal(await streamed.text, 'Local model: a longer message than one chunk of the stream')
  assert.equal((await streamed.totalUsage).outputTokens, 7)
  const echo = tool({ inputSchema: jsonSchema({ type: 'object', properties: { word: { type: 'string' } } }), execute: async ({ word }) => ({ echoed: word }) })
  const called = streamText({ model, tools: { echo }, stopWhen: stepCountIs(2), prompt: '/tool echo {"word":"hi"}' })
  assert.equal(await called.text, 'echo: {"echoed":"hi"}')
  const wrongKey = createOpenAICompatible({ name: 'litellm', baseURL: 'https://litellm.invalid/v1', apiKey: 'real-looking-key', fetch: local }).chatModel('mikka-default')
  await assert.rejects(generateText({ model: wrongKey, prompt: '/echo ping', maxRetries: 0 }))
})
