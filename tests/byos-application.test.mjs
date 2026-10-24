// Linux acceptance: actual HTTP handlers -> owner binding -> private Go worker
// -> actual CPA Store -> TLS Infisical fake -> real isolated Postgres.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, chmod, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as httpsServer } from 'node:https'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { Pool } from 'pg'
import { streamText, isStepCount, tool, toUIMessageStream } from 'ai'
import { z } from 'zod'
import { SubscriptionRepository } from '../lib/subscription-repository.ts'
import { SubscriptionService } from '../lib/subscription-service.ts'
import { subscriptionHTTP, subscriptionCallback, subscriptionList } from '../lib/subscription-http.ts'
import { SubscriptionWorkerClient } from '../packages/daemon/src/subscription-worker-client.ts'
import { resolveAgentSubscription } from '../lib/agent-subscription.ts'
import { resolveAgentModel } from '../lib/agent-model.ts'
import { hostedSubscriptionLauncher } from '../packages/daemon/src/subscription-launcher.ts'
import { buildChildEnv } from '../packages/daemon/src/env.ts'
import { NoSandbox } from '../packages/daemon/src/agents/sandbox.ts'
import { createLogger } from '../packages/daemon/src/log.ts'

const workspaceId = '20000000-0000-4000-8000-000000000001'
const root = resolve(import.meta.dirname, '..')
test('new OAuth consent, owner-bound streaming/tool use and native launches reuse one durable connection', { timeout: 90000 }, async () => {
  assert.equal(process.platform, 'linux')
  const databaseUrl = process.env.MIKKA_BYOS_TEST_DATABASE_URL
  assert.ok(databaseUrl && new URL(databaseUrl).hostname === '127.0.0.1' && new URL(databaseUrl).pathname.endsWith('_e2e'))
  const binary = process.env.MIKKA_BYOS_FIXTURE_BINARY
  assert.ok(binary, 'build acceptance-only worker first; no production fallback')
  const directory = await mkdtemp(join(tmpdir(), 'mikka-byos-app-'))
  const sessions = []
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const secrets = new Map()
  const secretMethods = []
  let providerCalls = 0
  async function nativeProvider(request, response) {
    providerCalls++
    assert.equal(request.headers['user-agent'], 'Mikka/1.0')
    assert.ok(request.headers.authorization.startsWith('Bearer fixture-'))
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(body.stream, true)
    assert.ok(!Object.hasOwn(body, 'metadata'), 'no synthetic native identity metadata')
    const provider = request.url.endsWith('/codex') ? 'codex' : 'claude'
    if (provider === 'codex') { assert.equal(body.store, false); assert.equal(request.headers.originator, 'Mikka'); assert.equal(request.headers['chatgpt-account-id'], 'fixture-account') }
    const raw = JSON.stringify(body)
    const toolResult = provider === 'codex' ? body.input.some(item => item.type === 'function_call_output') : body.messages.some(message => Array.isArray(message.content) && message.content.some(item => item.type === 'tool_result'))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = event => response.write(`data: ${JSON.stringify(event)}\n\n`)
    if (raw.includes('ERROR')) { emit({ type: 'error', error: { message: 'fixture-access private diagnostic' } }); response.end(); return }
    const text = raw.includes('HANG') ? 'partial' : toolResult ? 'tool result accepted' : 'subscription fixture'
    const asksTool = raw.includes('TOOL') && !toolResult
    if (provider === 'claude') {
      emit({ type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
      emit({ type: 'content_block_start', index: 0, content_block: asksTool ? { type: 'tool_use', id: 'fixture-call', name: 'weather', input: {} } : { type: 'text', text: '' } })
      emit({ type: 'content_block_delta', index: 0, delta: asksTool ? { type: 'input_json_delta', partial_json: '{"city":"Oslo"}' } : { type: 'text_delta', text } })
      if (raw.includes('HANG')) return
      emit({ type: 'content_block_stop', index: 0 })
      emit({ type: 'message_delta', delta: { stop_reason: asksTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } })
      emit({ type: 'message_stop' })
    } else {
      const base = { id: 'fixture-response', model: body.model, created_at: 1 }
      emit({ type: 'response.created', response: { ...base, status: 'in_progress', output: [] } })
      const item = { type: 'function_call', id: 'fixture-item', call_id: 'fixture-call', name: 'weather', arguments: '{"city":"Oslo"}' }
      if (asksTool) {
        emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } })
        emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments })
        emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments })
        emit({ type: 'response.output_item.done', output_index: 0, item })
      } else emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'fixture-text', delta: text })
      if (raw.includes('HANG')) return
      emit({ type: 'response.completed', response: { ...base, status: 'completed', output: asksTool ? [item] : [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
    }
    response.end()
  }
  const certificate = join(directory, 'fixture-ca.crt')
  const privateKey = join(directory, 'fixture-ca.key')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey, '-out', certificate, '-days', '1', '-subj', '/CN=BYOS synthetic fixture', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' })
  const infisical = httpsServer({ key: await readFile(privateKey), cert: await readFile(certificate) }, async (request, response) => {
    try {
      if (request.url.startsWith('/provider/')) { await nativeProvider(request, response); return }
      assert.equal(request.headers.authorization, 'Bearer fixture-workload-token')
      const url = new URL(request.url, 'https://fixture.invalid')
      const name = decodeURIComponent(url.pathname.slice('/api/v4/secrets/'.length))
      assert.match(name, /^mikka-byos-[a-f0-9-]{36}$/)
      secretMethods.push(request.method)
      if (request.method === 'POST') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString())
        assert.equal(body.projectId, 'fixture-project'); assert.equal(body.secretPath, '/byos-cpa')
        if (secrets.has(name)) { response.writeHead(409).end(); return }
        secrets.set(name, body.secretValue)
      } else {
        assert.equal(request.method, 'GET'); assert.equal(url.searchParams.get('version'), '1')
        assert.equal(url.searchParams.get('includeImports'), 'false'); assert.equal(url.searchParams.get('expandSecretReferences'), 'false')
      }
      if (!secrets.has(name)) { response.writeHead(404).end(); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ secret: { secretKey: name, secretValue: secrets.get(name), secretValueHidden: false, version: 1 } }))
    } catch { response.writeHead(400).end() }
  })
  await new Promise(resolve => infisical.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${infisical.address().port}`
  const repository = new SubscriptionRepository(pool)
  let workerStarts = 0
  const service = new SubscriptionService(repository, scope => {
    workerStarts++
    return new SubscriptionWorkerClient({ binary, env: { SSL_CERT_FILE: certificate, MIKKA_BYOS_FIXTURE_UPSTREAM_ORIGIN: origin } }, { scope, databaseUrl, infisicalOrigin: origin, project: 'fixture-project', environment: 'test', path: '/byos-cpa', workloadToken: 'fixture-workload-token' })
  }, { ready: () => true, nativeIsolation: 'verified_runtime', oauth: { codex: true, claude: true } }, async provider => ({ vendor: provider === 'codex' ? 'codex' : 'claude_code', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: 0.2, resetsAt: null }] }), async (_owner, workspace) => assert.equal(workspace, workspaceId))
  const dependencies = {
    session: async request => {
      const value = request.headers.get('cookie')?.match(/fixture=([a-z-]+)/)?.[1]
      if (!value) return null
      return { userId: value === 'alice-new-session' ? 'alice' : value, sessionId: `session-${value}` }
    },
    workspace: async (_owner, workspace) => assert.equal(workspace, workspaceId),
    service: () => service
  }
  const http = subscriptionHTTP(dependencies)
  const request = (body, user = 'alice') => new Request('http://localhost/api/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `fixture=${user}` }, body: JSON.stringify(body) })
  const post = async (body, user) => { const response = await http(request(body, user)); return { status: response.status, body: await response.json() } }
  let browserServer
  let browser
  try {
    assert.equal((await http(new Request('http://localhost/api/subscriptions', { method: 'POST' }))).status, 401)
    assert.equal((await http(new Request('http://localhost/api/subscriptions', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403)
    assert.equal((await post({ action: 'connect', workspaceId, provider: 'codex', accessToken: 'never-import' })).status, 409)
    for (const provider of ['codex', 'claude']) {
      const connected = await post({ action: 'connect', workspaceId, provider })
      assert.equal(connected.status, 200)
      const { connectionId, revision, authorizationUrl } = connected.body
      const state = new URL(authorizationUrl).searchParams.get('state')
      assert.equal(new URL(authorizationUrl).searchParams.get('code_challenge_method'), 'S256')
      assert.ok(new URL(authorizationUrl).searchParams.get('code_challenge'))
      assert.equal((await post({ action: 'callback', connectionId, state, code: 'fixture-grant' }, 'bob')).status, 409)
      assert.equal((await post({ action: 'callback', connectionId, state, code: 'fixture-grant' }, 'alice-new-session')).status, 409)
      assert.equal((await post({ action: 'callback', connectionId, state, code: 'fixture-grant' })).status, 200)
      assert.equal((await post({ action: 'callback', connectionId, state, code: 'fixture-grant' })).status, 409)
      const persisted = await pool.query('select "secretName",epoch,state from byos_connections where id=$1', [connectionId])
      assert.equal(persisted.rows[0].state, 'connected')
      const stored = JSON.parse(secrets.get(persisted.rows[0].secretName))
      assert.equal(stored.ownerId, 'alice'); assert.equal(stored.payload.refresh_token, 'fixture-refresh')
      const consumerId = randomUUID()
      const route = provider === 'codex' ? 'codex_cpa' : 'claude_cpa'
      const bound = await post({ action: 'bind', connectionId, revision, consumerId, route, modelId: 'fixture-model' })
      assert.equal(bound.status, 200)
      const use = { ownerId: 'alice', workspaceId, consumerId, bindingId: bound.body.bindingId, execution: 'model' }
      const initialSecrets = secrets.size
      for (let task = 0; task < 2; task++) {
        const remembered = await repository.defaultModelBinding('alice', consumerId)
        assert.equal(remembered, bound.body.bindingId)
        const model = await resolveAgentModel({ type: 'subscription', bindingId: remembered }, { defaultModel: () => { throw new Error('paid fallback invoked') }, subscriptionModel: bindingId => resolveAgentSubscription('alice', consumerId, bindingId, service, dependencies.workspace) })
        assert.equal(await streamText({ model, prompt: 'HELLO', maxRetries: 0 }).text, 'subscription fixture')
      }
      assert.equal(secrets.size, initialSecrets, 'task reuse must not log in or store credentials again')
      let toolCalls = 0
      const model = await service.model(use)
      const result = streamText({ model, prompt: 'TOOL', maxRetries: 0, stopWhen: isStepCount(3), tools: { weather: tool({ description: 'fixture weather', inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => { toolCalls++; return { city, weather: 'snow' } } }) } })
      assert.equal(await result.text, 'tool result accepted'); assert.equal(toolCalls, 1)
      const errorModel = await service.model(use)
      const beforeFailure = providerCalls
      const failure = streamText({ model: errorModel, prompt: 'ERROR', maxRetries: 0, onError: () => {} })
      let ui = ''; for await (const part of toUIMessageStream({ stream: failure.stream, onError: () => 'subscription_generation_failed' })) ui += JSON.stringify(part)
      assert.ok(!ui.includes('fixture-access')); assert.ok(ui.includes('subscription_generation_failed'))
      assert.equal(providerCalls, beforeFailure + 1, 'no model retry or alternative paid account')
      const abort = new AbortController()
      const cancelled = streamText({ model: await service.model(use, abort.signal), prompt: 'HANG', maxRetries: 0, abortSignal: abort.signal, onError: () => {} })
      for await (const text of cancelled.textStream) { assert.equal(text, 'partial'); abort.abort(); break }
      await assert.rejects(service.model({ ...use, ownerId: 'bob' }), { code: 'binding_required' })

      const nativeRoute = provider === 'codex' ? 'codex_cli' : 'claude_code_cli'
      const native = await post({ action: 'bind', connectionId, revision, consumerId, route: nativeRoute, modelId: 'fixture-model' })
      const runtime = join(directory, `native-${provider}`); await mkdir(runtime)
      const cwd = join(runtime, 'project'); await mkdir(cwd)
      execFileSync('git', ['init', '-q', cwd])
      const binaryPath = resolve(root, `packages/daemon/test/fakes/fake-${provider === 'codex' ? 'codex' : 'claude'}-subscription.mjs`); await chmod(binaryPath, 0o755)
      const options = { runId: randomUUID(), cwd, prompt: provider === 'codex' ? 'REFRESH' : 'HANG', env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: runtime } }), log: createLogger({ level: 'silent' }) }
      const launched = await service.launchNative('alice', consumerId, native.body.bindingId, hostedSubscriptionLauncher(options, { stateDir: runtime, sandbox: new NoSandbox(), codexBinary: binaryPath, claudeBinary: binaryPath, revocationPollMs: 30 }))
      sessions.push(launched)
      if (provider === 'claude') assert.equal((await post({ action: 'disconnect', connectionId, revision })).status, 200)
      const events = []; for await (const event of launched.events()) events.push(event)
      assert.equal(events.at(-1).outcome, provider === 'codex' ? 'succeeded' : 'cancelled')
      assert.ok(!JSON.stringify(events).includes('fixture-access'))
      if (provider === 'codex') assert.equal((await post({ action: 'disconnect', connectionId, revision })).status, 200)
      await assert.rejects(service.model(use), { code: 'disconnected' })
      const stateAfter = await repository.connection('alice', connectionId)
      const reconnect = await post({ action: 'reconnect', connectionId, revision: Number(stateAfter.epoch) })
      assert.equal(reconnect.status, 200)
      const newState = new URL(reconnect.body.authorizationUrl).searchParams.get('state')
      assert.equal((await post({ action: 'callback', connectionId, state: newState, code: 'fixture-grant' })).status, 200)
      await assert.rejects(service.model(use), { code: 'stale_binding' })
      assert.ok(!(await repository.connection('alice', connectionId)).quota, 'reconnect must clear old account quota')
      if (provider === 'codex') {
        const rebound = await post({ action: 'bind', connectionId, revision: reconnect.body.revision, consumerId, route, modelId: 'fixture-model' })
        const live = streamText({ model: await service.model({ ...use, bindingId: rebound.body.bindingId }), prompt: 'HANG', maxRetries: 0, onError: () => {} })
        const uiStream = toUIMessageStream({ stream: live.stream, onError: () => 'subscription_generation_failed' })
        let revoked = false; let captured = ''
        for await (const part of uiStream) {
          captured += JSON.stringify(part)
          if (!revoked && part.type === 'text-delta') {
            revoked = true
            assert.equal((await post({ action: 'disconnect', connectionId, revision: reconnect.body.revision })).status, 200)
          }
        }
        assert.ok(revoked); assert.ok(captured.includes('subscription_generation_failed'))
        assert.ok(!captured.includes('fixture-access'))
      }
    }
    assert.ok(workerStarts > 10)
    assert.ok(secretMethods.every(method => method === 'GET' || method === 'POST'))

    // Actual Settings component in Chromium, synthetic session/provider only.
    const require = createRequire(import.meta.url)
    const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }))
    const bundle = join(directory, 'browser.js')
    await esbuild.build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{NextIntlClientProvider}from'next-intl';import{SubscriptionSettings}from'./components/settings/subscription-settings';import messages from './messages/en.json';createRoot(document.getElementById('root')).render(<NextIntlClientProvider locale="en" messages={messages}><SubscriptionSettings userKey="browser-owner" workspaceId="${workspaceId}"/></NextIntlClientProvider>);`, resolveDir: root, loader: 'tsx' }, outfile: bundle, bundle: true, platform: 'browser', format: 'iife', tsconfig: resolve(root, 'tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '""' }, logLevel: 'silent' })
    browserServer = createServer(async (incoming, outgoing) => {
      try {
        const url = `http://127.0.0.1:${browserServer.address().port}${incoming.url}`
        let response
        if (incoming.url === '/browser.js') response = new Response(await readFile(bundle), { headers: { 'content-type': 'text/javascript' } })
        else if (incoming.url.startsWith('/api/workspace')) response = Response.json({ workspace: { id: workspaceId, name: 'Fixture workspace' } })
        else if (incoming.url.startsWith('/api/subscriptions')) {
          const chunks = []; for await (const chunk of incoming) chunks.push(chunk)
          const req = new Request(url, { method: incoming.method, headers: incoming.headers, ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })
          response = incoming.url.startsWith('/api/subscriptions/callback') ? await subscriptionCallback(req, dependencies) : incoming.method === 'POST' ? await http(req) : await subscriptionList(req, dependencies)
        } else response = new Response('<!doctype html><html><body><main id="root"></main><script src="/browser.js"></script></body></html>', { headers: { 'content-type': 'text/html' } })
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch { outgoing.writeHead(500).end() }
    })
    await new Promise(resolve => browserServer.listen(0, '127.0.0.1', resolve))
    const browserOrigin = `http://127.0.0.1:${browserServer.address().port}`
    const { chromium } = await import('@playwright/test')
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    const context = await browser.newContext()
    await context.addCookies([{ name: 'fixture', value: 'browser-owner', url: browserOrigin }])
    let authorizations = 0
    await context.route('https://auth.openai.com/**', async route => {
      authorizations++
      const state = new URL(route.request().url()).searchParams.get('state')
      await route.fulfill({ status: 302, headers: { Location: `${browserOrigin}/api/subscriptions/callback?state=${state}&code=fixture-grant` }, body: '' })
    })
    const page = await context.newPage()
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(browserOrigin)
    await page.getByRole('button', { name: 'Connect subscription' }).first().click()
    await page.waitForURL('**/settings?**')
    await page.getByText('Connected', { exact: true }).waitFor()
    assert.equal(authorizations, 1)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: '/tmp/mikka-byos-phase3-browser.png', fullPage: true })
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await page.getByRole('button', { name: 'Connect subscription' }).first().waitFor()
    console.log('BYOS browser acceptance: actual Settings component -> synthetic provider redirect -> bound callback -> Infisical fixture persistence -> connected -> disconnect; no live provider requests')
  } finally {
    for (const session of sessions) await session.cancel().catch(() => {})
    if (browser) await browser.close()
    if (browserServer) await new Promise(resolve => browserServer.close(resolve))
    await new Promise(resolve => infisical.close(resolve))
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  }
})
