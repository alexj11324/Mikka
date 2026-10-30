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
import { subscriptionHTTP, subscriptionCallback, subscriptionList, subscriptionUsage } from '../lib/subscription-http.ts'
import { subscriptionNativeHTTP } from '../lib/subscription-native-http.ts'
import { SubscriptionWorkerClient } from '../packages/daemon/src/subscription-worker-client.ts'
import { resolveAgentSubscription } from '../lib/agent-subscription.ts'
import { resolveAgentModel } from '../lib/agent-model.ts'
import { hostedSubscriptionLauncher } from '../packages/daemon/src/subscription-launcher.ts'
import { buildChildEnv } from '../packages/daemon/src/env.ts'
import { NoSandbox } from '../packages/daemon/src/agents/sandbox.ts'
import { ToolApprovalGate } from '../packages/daemon/src/agents/tool-approval.ts'
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
  const blockedDeletes = new Set()
  let providerCalls = 0
  const devices = new Map()
  const deviceVerifier = 'v'.repeat(43)
  const deviceChallenge = (await import('node:crypto')).createHash('sha256').update(deviceVerifier).digest('base64url')
  async function oauthProvider(request, response) {
    assert.equal(request.headers['user-agent'], 'Mikka/1.0')
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    if (request.url.endsWith('/deviceauth/usercode')) {
      assert.equal(JSON.parse(raw).client_id, 'app_EMoamEEZ73f0CkXaXp7hrann')
      const id = randomUUID(); devices.set(id, 0)
      response.end(JSON.stringify({ device_auth_id: id, user_code: 'ABCD-EFGH', interval: '5' })); return
    }
    if (request.url.endsWith('/deviceauth/token')) {
      const body = JSON.parse(raw); assert.equal(body.user_code, 'ABCD-EFGH'); assert.ok(devices.has(body.device_auth_id))
      const count = devices.get(body.device_auth_id); devices.set(body.device_auth_id, count + 1)
      if (!count) { response.writeHead(403).end(); return }
      response.end(JSON.stringify({ authorization_code: 'fixture-grant', code_verifier: deviceVerifier, code_challenge: deviceChallenge })); return
    }
    const codex = request.url.includes('/codex/')
    const body = codex ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)
    assert.equal(body.code, 'fixture-grant'); assert.equal(body.grant_type, 'authorization_code')
    assert.equal(body.redirect_uri, codex ? 'https://auth.openai.com/deviceauth/callback' : 'http://localhost:54545/callback')
    assert.equal(body.code_verifier.length, 43)
    if (!codex) assert.equal(body.state.length, 43)
    const claims = Buffer.from(JSON.stringify({ email: 'fixture@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'plus' } })).toString('base64url')
    response.end(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: `e30.${claims}.fixture`, expires_in: 7200, account: { uuid: 'fixture-account', email_address: 'fixture@example.invalid' }, organization: { uuid: 'fixture-org', name: 'Fixture' } }))
  }
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
      if (request.url.startsWith('/quota/')) { assert.ok(request.headers.authorization.startsWith('Bearer fixture-'));response.end(JSON.stringify(request.url.endsWith('/codex') ? {credits:{has_credits:false,unlimited:false},rate_limit:{primary_window:{used_percent:20,limit_window_seconds:18000}}} : {extra_usage:{is_enabled:false},five_hour:{utilization:20}}));return }
      if (request.url.startsWith('/oauth/')) { await oauthProvider(request, response); return }
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
      } else if(request.method==='DELETE') {
        const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(body.secretPath,'/byos-cpa');assert.equal(body.projectId,'fixture-project');if(blockedDeletes.has(name)){response.writeHead(503).end();return};secrets.delete(name);response.writeHead(204).end();return
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
    return new SubscriptionWorkerClient({ binary, env: { SSL_CERT_FILE: certificate, MIKKA_BYOS_FIXTURE_UPSTREAM_ORIGIN: origin } }, { scope, databaseUrl, infisicalOrigin: origin, project: 'fixture-project', environment: 'test', path: '/byos-cpa', workloadToken: 'fixture-workload-token',accessPath:'/byos-cpa',accessToken:'fixture-workload-token' })
  }, { ready: () => true, nativeIsolation: 'verified_runtime', oauth: { codex: true, claude: true } }, undefined, async (_owner, workspace) => assert.equal(workspace, workspaceId))
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
  const readyPoll = async connectionId => { await pool.query('update byos_oauth_attempts set "nextPollAt"=now()-interval \'1 second\' where "connectionId"=$1', [connectionId]) }
  const finishAttempt = async (connectionId, attempt) => {
    if (attempt.flow === 'device') {
      await readyPoll(connectionId); assert.equal((await post({ action: 'poll', connectionId, state: attempt.state })).body.pending, true)
      await readyPoll(connectionId); return post({ action: 'poll', connectionId, state: attempt.state })
    }
    return post({ action: 'callback', connectionId, state: attempt.state, callbackUrl: `http://localhost:54545/callback?code=fixture-grant&state=${attempt.state}` })
  }
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
      const state = connected.body.state
      const completion = provider === 'codex' ? { action: 'poll', connectionId, state } : { action: 'callback', connectionId, state, callbackUrl: `http://localhost:54545/callback?code=fixture-grant&state=${state}` }
      if (provider === 'codex') {
        assert.equal(connected.body.flow, 'device'); assert.equal(authorizationUrl, 'https://auth.openai.com/codex/device'); assert.equal(connected.body.userCode, 'ABCD-EFGH')
        assert.ok(!JSON.stringify(connected.body).includes('device_auth_id'))
      } else {
        assert.equal(new URL(authorizationUrl).searchParams.get('redirect_uri'), 'http://localhost:54545/callback')
        assert.equal(new URL(authorizationUrl).searchParams.get('code_challenge_method'), 'S256')
        assert.equal((await post({ ...completion, callbackUrl: `${completion.callbackUrl}&state=${state}` })).status, 409)
        assert.equal((await post({ action: 'callback', connectionId, state, code: 'fixture-grant' })).status, 409, 'raw code acquisition not exposed')
      }
      assert.equal((await post(completion, 'bob')).status, 409)
      assert.equal((await post(completion, 'alice-new-session')).status, 409)
      if (provider === 'codex') {
        assert.equal((await post(completion)).status, 409, 'early polling refused')
        await readyPoll(connectionId)
        assert.equal((await post(completion)).body.pending, true)
        await readyPoll(connectionId)
      }
      assert.equal((await post(completion)).status, 200)
      assert.equal((await post(completion)).status, 409)
      const persisted = await pool.query('select "secretName",epoch,state from byos_connections where id=$1', [connectionId])
      assert.equal(persisted.rows[0].state, 'connected')
      const usage = async user => { const response = await subscriptionUsage(new Request(`http://localhost/api/subscriptions/usage?workspace=${workspaceId}`, { headers: { cookie: `fixture=${user}` } }), dependencies); return { status: response.status, text: await response.text() } }
      const read = await usage('alice')
      assert.equal(read.status, 200)
      assert.ok(!/fixture-|Bearer|access_token/.test(read.text), 'usage exported a credential')
      const row = JSON.parse(read.text).connections.find(item => item.id === connectionId)
      assert.deepEqual({ status: row.status, windows: row.windows }, { status: 'ok', windows: [{ kind: 'five_hour', remaining: 80, resetsAt: null }] })
      assert.deepEqual(JSON.parse((await usage('bob')).text).connections, [], 'usage is owner-scoped')
      const listed = await (await subscriptionList(new Request(`http://localhost/api/subscriptions?workspace=${workspaceId}`, { headers: { cookie: 'fixture=alice' } }), dependencies)).json()
      const entry = listed.connections.find(item => item.id === connectionId)
      assert.equal(entry.account, row.account, 'list keeps the email a usage read stored')
      assert.deepEqual(entry.bots, [])
      const stored = JSON.parse(secrets.get(persisted.rows[0].secretName))
      assert.equal(stored.ownerId, 'alice'); assert.equal(stored.payload.refresh_token, 'fixture-refresh')
      const consumerId = randomUUID()
      const route = provider === 'codex' ? 'codex_cpa' : 'claude_cpa'
      const bound = await post({ action: 'bind', connectionId, revision, consumerId, route, modelId: 'fixture-model' })
      assert.equal(bound.status, 200)
      const use = { ownerId: 'alice', workspaceId, consumerId, bindingId: bound.body.bindingId, execution: 'model' }
      const initialSecretCreates = secretMethods.filter(method => method === 'POST').length
      for (let task = 0; task < 2; task++) {
        const remembered = await repository.defaultModelBinding('alice', consumerId)
        assert.equal(remembered, bound.body.bindingId)
        const model = await resolveAgentModel({ type: 'subscription', bindingId: remembered }, { defaultModel: () => { throw new Error('paid fallback invoked') }, subscriptionModel: bindingId => resolveAgentSubscription('alice', consumerId, bindingId, service, dependencies.workspace) })
        assert.equal(await streamText({ model, prompt: 'HELLO', maxRetries: 0 }).text, 'subscription fixture')
      }
      assert.equal(secretMethods.filter(method => method === 'POST').length, initialSecretCreates, 'task reuse must not log in or store credentials again')
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
      // The actual hosted-device HTTP boundary uses the immutable run ledger,
      // actual service/private worker and real Postgres, not nativeAuth export.
      const deviceId=randomUUID(),agentId=randomUUID()
      const nativeHarnesses = JSON.stringify([{ harness: provider === 'codex' ? 'codex' : 'claude_code', installed: true, subscriptionBroker: true }])
      await pool.query('insert into devices(id,"ownerId",name,harnesses) values($1,\'alice\',\'native fixture\',$2::jsonb)',[deviceId,nativeHarnesses])
      await pool.query('insert into agents(id,"userId",harness,name,"deviceId") values($1,\'alice\',$2,$3,$4)',[agentId,provider==='codex'?'codex':'claude_code',`native-${agentId}`,deviceId])
      const agentBinding=await post({action:'bind',connectionId,revision,consumerId:agentId,route:nativeRoute,modelId:'fixture-model'})
      assert.equal(agentBinding.status,200)
      assert.equal((await repository.nativeBinding('alice',agentId,provider==='codex'?'codex':'claude_code')).id,agentBinding.body.bindingId)
      const nativeHTTP=subscriptionNativeHTTP({authorize:async request=>request.headers.get('authorization')==='Bearer fixture-device'?{userId:'alice',workspaceId:null}:request.headers.get('authorization')==='Bearer fixture-other'?{userId:'bob',workspaceId:null}:null,service:()=>service})
      const nativePost=(runId,body,token='fixture-device',targetDevice=deviceId)=>nativeHTTP(new Request('http://localhost/v1/native',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)}),{params:Promise.resolve({deviceId:targetDevice,runId})})
      const noLoginCreates=secretMethods.filter(method=>method==='POST').length
      for(let task=0;task<2;task++){
        const runId=randomUUID()
        await pool.query('insert into agent_runs(id,"userId","agentId","deviceId",status,"leaseExpiresAt") values($1,\'alice\',$2,$3,\'running\',now()+interval \'1 minute\')',[runId,agentId,deviceId])
        await pool.query('insert into byos_native_runs("runId","bindingId") values($1,$2)',[runId,agentBinding.body.bindingId])
        const contextResponse=await nativePost(runId,{action:'context'})
        assert.equal(contextResponse.status,200)
        const metadata=await contextResponse.json();assert.equal(metadata.route,nativeRoute);assert.equal(metadata.revision,revision);assert.ok(!JSON.stringify(metadata).includes('accessToken'));assert.ok(!JSON.stringify(metadata).includes('fixture-access'))
        const payload={path:provider==='codex'?'/responses':'/v1/messages',headers:{'user-agent':'Mikka/1.0',originator:'Mikka',authorization:'Bearer caller-placeholder'},body:provider==='codex'?{model:'fixture-model',stream:true,store:false,input:[{role:'user',content:'HELLO'}]}:{model:'fixture-model',stream:true,max_tokens:16,messages:[{role:'user',content:'HELLO'}]}}
        const nativeResponse=await nativePost(runId,{action:'request',payload});assert.equal(nativeResponse.status,200);const output=await nativeResponse.text();assert.ok(output.includes('subscription fixture'));assert.ok(!output.includes('fixture-access'))
        const before=providerCalls
        await pool.query('update devices set enabled=false where id=$1',[deviceId])
        assert.equal((await nativePost(runId,{action:'context'})).status,409)
        await pool.query("update devices set enabled=true,harnesses='[]'::jsonb where id=$1",[deviceId])
        assert.equal((await nativePost(runId,{action:'context'})).status,409)
        await pool.query('update devices set harnesses=$2::jsonb where id=$1',[deviceId,nativeHarnesses])
        assert.equal((await nativePost(runId,{action:'context'},'fixture-other')).status,409)
        assert.equal((await nativePost(runId,{action:'context'},'fixture-device',randomUUID())).status,409)
        assert.equal((await nativePost(runId,{action:'request',payload:{...payload,body:{...payload.body,model:'another-model'}}})).status,409)
        await pool.query('update agent_runs set "stopRequestedAt"=now() where id=$1',[runId])
        assert.equal((await nativePost(runId,{action:'context'})).status,409)
        assert.equal(providerCalls,before)
        await pool.query('delete from agent_runs where id=$1',[runId])
      }
      assert.equal(secretMethods.filter(method=>method==='POST').length,noLoginCreates,'hosted tasks must reuse the original OAuth connection')
      await pool.query('delete from agents where id=$1',[agentId]);await pool.query('delete from devices where id=$1',[deviceId])
      const native = await post({ action: 'bind', connectionId, revision, consumerId, route: nativeRoute, modelId: 'fixture-model' })
      const runtime = join(directory, `native-${provider}`); await mkdir(runtime)
      const cwd = join(runtime, 'project'); await mkdir(cwd)
      execFileSync('git', ['init', '-q', cwd])
      const binaryPath = resolve(root, `packages/daemon/test/fakes/fake-${provider === 'codex' ? 'codex' : 'claude'}-subscription.mjs`); await chmod(binaryPath, 0o755)
      const options = { runId: randomUUID(), cwd, prompt: provider === 'codex' ? 'REFRESH' : 'HANG', env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: runtime } }), log: createLogger({ level: 'silent' }) }
      // This case exercises account custody with synthetic CLIs. Install a
      // host-scoped gate without approving any tool operation; production
      // assignments obtain their gate from the authenticated server link.
      options.toolApproval = new ToolApprovalGate(options.runId, { permission: () => 'deny', ask: async () => 'deny', isLive: () => true })
      const launched = await service.launchNative('alice', consumerId, native.body.bindingId, hostedSubscriptionLauncher(options, { stateDir: runtime, sandbox: new NoSandbox(), codexBinary: binaryPath, claudeBinary: binaryPath, revocationPollMs: 30 }))
      sessions.push(launched)
      if (provider === 'claude') assert.equal((await post({ action: 'disconnect', connectionId, revision })).status, 200)
      const events = []; for await (const event of launched.events()) events.push(event)
      assert.equal(events.at(-1).outcome, provider === 'codex' ? 'succeeded' : 'cancelled')
      assert.ok(!JSON.stringify(events).includes('fixture-access'))
      if (provider === 'codex') assert.equal((await post({ action: 'disconnect', connectionId, revision })).status, 200)
      await assert.rejects(service.model(use), { code: 'disconnected' })
      const stateAfter = await repository.connection('alice', connectionId)
      assert.equal(stateAfter.accountLabel, 'fixture@example.invalid', 'a disconnected row keeps its email')
      const reconnect = await post({ action: 'reconnect', connectionId, revision: Number(stateAfter.epoch) })
      assert.equal(reconnect.status, 200)
      assert.equal((await repository.connection('alice', connectionId)).accountLabel, null, 'a new sign-in must not show the old email')
      assert.equal((await finishAttempt(connectionId, reconnect.body)).status, 200)
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
    assert.ok(secretMethods.every(method => method === 'GET' || method === 'POST' || method === 'DELETE'))

    // Cron fairness: two persistently failing connections must not starve a third.
    const fairness = []
    for (let i = 0; i < 3; i++) {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
      const name = `mikka-byos-${randomUUID()}`
      await pool.query(`insert into byos_connections(id,"ownerId","workspaceId",provider,state) values($1,'fairness-owner',$2,'codex','disconnected')`, [id, workspaceId])
      await pool.query(`insert into byos_secret_artifacts(name,"connectionId","ownerId","workspaceId",provider,kind,"notBefore","publishedAt","createStarted","createSettled") values($1,$2,'fairness-owner',$3,'codex','grant',now(),now(),true,true)`, [name,id,workspaceId])
      secrets.set(name, 'synthetic-fairness-value'); if(i<2) blockedDeletes.add(name); fairness.push(name)
    }
    for(let pass=0;pass<4;pass++) await service.cleanupBatch()
    assert.ok(!secrets.has(fairness[2]), 'two failed connections starved later cleanup')
    for(const name of fairness) blockedDeletes.delete(name)
    for(let pass=0;pass<4;pass++) await service.cleanupBatch()
    // 移除: a pending (never finished) connection is fenced, then gone from the list for good.
    const abandoned = await post({ action: 'connect', workspaceId, provider: 'claude' })
    assert.equal(abandoned.status, 200)
    const listedIds = async () => (await (await subscriptionList(new Request(`http://localhost/api/subscriptions?workspace=${workspaceId}`, { headers: { cookie: 'fixture=alice' } }), dependencies)).json()).connections.map(item => item.id)
    assert.ok((await listedIds()).includes(abandoned.body.connectionId))
    assert.equal((await post({ action: 'remove', connectionId: abandoned.body.connectionId, revision: abandoned.body.revision }, 'bob')).status, 409, 'another owner cannot remove it')
    const removed = await post({ action: 'remove', connectionId: abandoned.body.connectionId, revision: abandoned.body.revision })
    assert.equal(removed.status, 200)
    assert.ok(!(await listedIds()).includes(abandoned.body.connectionId), '移除 left the row listed')
    const gone = await pool.query('select state,"removedAt" from byos_connections where id=$1', [abandoned.body.connectionId])
    assert.equal(gone.rows[0].state, 'disconnected'); assert.ok(gone.rows[0].removedAt)
    if (process.env.MIKKA_BYOS_BACKEND_ONLY === '1') { console.log('Backend-only acceptance complete; browser acceptance intentionally not run'); return }
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
          response = incoming.url.startsWith('/api/subscriptions/callback') ? await subscriptionCallback(req, dependencies) : incoming.method === 'POST' ? await http(req) : incoming.url.startsWith('/api/subscriptions/usage') ? await subscriptionUsage(req, dependencies) : await subscriptionList(req, dependencies)
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
    let claudeCallback
    await context.route('https://auth.openai.com/**', async route => {
      authorizations++; assert.equal(route.request().url(), 'https://auth.openai.com/codex/device')
      await route.fulfill({ body: '<html><body>Official device page fixture: enter ABCD-EFGH</body></html>' })
    })
    await context.route('https://claude.ai/**', async route => {
      authorizations++
      const query = new URL(route.request().url()).searchParams
      assert.equal(query.get('redirect_uri'), 'http://localhost:54545/callback')
      claudeCallback = `http://localhost:54545/callback?code=fixture-grant&state=${query.get('state')}`
      await route.fulfill({ body: '<html><body>Official authorization fixture; registered loopback callback would appear in address bar.</body></html>' })
    })
    const page = await context.newPage()
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(browserOrigin)
    assert.equal((await subscriptionCallback(new Request(`${browserOrigin}/api/subscriptions/callback?code=fixture-grant&state=${'x'.repeat(43)}`), dependencies)).status, 410)
    await page.getByRole('button', { name: 'Connect subscription' }).first().click()
    await page.getByLabel('Device authorization code').waitFor()
    const popupPromise = context.waitForEvent('page')
    await page.getByRole('link', { name: 'Open official sign-in page' }).click()
    const popup = await popupPromise; await popup.waitForLoadState(); await popup.close()
    await page.waitForTimeout(5200)
    await page.getByRole('button', { name: 'Check authorization' }).click()
    await page.getByRole('status').waitFor()
    await page.waitForTimeout(5200)
    await page.getByRole('button', { name: 'Check authorization' }).click()
    await page.getByText('Connected', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await page.getByRole('button', { name: 'Connect subscription' }).last().click()
    const claudePopupPromise = context.waitForEvent('page')
    await page.getByRole('link', { name: 'Open official sign-in page' }).click()
    const claudePopup = await claudePopupPromise; await claudePopup.waitForLoadState(); await claudePopup.close()
    assert.ok(claudeCallback)
    await page.getByLabel('Complete callback URL').fill(claudeCallback)
    await page.getByRole('button', { name: 'Check authorization' }).click()
    await page.getByText('Connected', { exact: true }).waitFor()
    assert.equal(authorizations, 2); assert.deepEqual(errors, [])
    await page.screenshot({ path: '/tmp/mikka-byos-oauth-review-browser.png', fullPage: true })
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    console.log('BYOS browser acceptance: actual Settings -> CPA device pending/complete + registered Claude callback URL handoff -> owner-bound persistence -> disconnect; synthetic providers only')

  } finally {
    for (const session of sessions) await session.cancel().catch(() => {})
    if (browser) await browser.close()
    if (browserServer) await new Promise(resolve => browserServer.close(resolve))
    await new Promise(resolve => infisical.close(resolve))
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  }
})
