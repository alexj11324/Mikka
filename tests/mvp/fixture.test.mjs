import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createGateway, generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { assertMvpEnvironment, REPOSITORY } from './isolated-env.mjs'
import { answerModel } from './model.mjs'
import { fixtureFailure, fixtureModelError, recordPeerFailure, readPeerFailures, observeTraceMcpFetch } from './diagnostics.mjs'
import { decisionRequestInput } from '../../lib/coordinator/decision.ts'
import { startMvpServices } from './services.mjs'
import { hasBoundMvpTransport, installMvpTransport, MVP_DECISION_KEY, verifyMvpTransport } from './transport.mjs'
import { createDedupeFetch } from 'next/dist/server/lib/dedupe-fetch.js'
import { createPatchedFetcher } from 'next/dist/server/lib/patch-fetch.js'

const database = 'postgresql://ci:fixture@127.0.0.1:5432/mikka_e2e'
const isolated = { CI: 'true', GITHUB_ACTIONS: 'true', MIKKA_MVP_E2E: '1', MIKKA_TEST_MODE: '1', E2E_DATABASE_URL: database, MIKKA_DATABASE_URL: database, DATABASE_URL: database }

test('diagnostics retain closed source provenance without messages, private paths or assertion values', () => {
  const own = fileURLToPath(new URL('./model.mjs', import.meta.url))
  const error = Object.assign(new Error('private-response-token'), { name: 'AssertionError', code: 'ERR_ASSERTION',
    actual: 'private-token', expected: 'private-cookie', cause: new Error('private-cause') })
  error.stack = `AssertionError: private-response-token\n    at privateFunction (${own}:21:3)\n    at unsafe (/other/tests/mvp/model.mjs:4:2)\n    at leak (${own}?token=private-token:2:3)`
  assert.deepEqual(fixtureFailure(error, 'subscription_answer', 'POST'), {
    handler: 'subscription_answer', method: 'POST', name: 'AssertionError', code: 'ERR_ASSERTION',
    source: [{ file: 'tests/mvp/model.mjs', line: 21, column: 3 }],
  })
  const unknown = Object.assign(new Error('private-message'), { name: 'private-name', code: 'private-code' })
  const projected = fixtureFailure(unknown, 'private-handler', 'private-method')
  assert.equal(projected.handler, 'route'); assert.equal(projected.method, 'OTHER'); assert.equal(projected.name, 'Error')
  assert.ok(!JSON.stringify(projected).includes('private'))
})

test('diagnostics preserve enumerated model tool refusals and discard arbitrary tool arguments', () => {
  const failed = fixtureModelError('MODEL_RESULT_REFUSED', 'dispatch_run', { error: 'executionAccountUnavailable', reason: 'noModels', token: 'private-token', args: { prompt: 'private prompt' } })
  const safe = fixtureFailure(failed, 'subscription_answer', 'POST')
  assert.equal(safe.code, 'MODEL_RESULT_REFUSED'); assert.equal(safe.operation, 'dispatch_run')
  assert.equal(safe.sourceCode, 'executionAccountUnavailable'); assert.equal(safe.sourceReason, 'noModels')
  assert.ok(!JSON.stringify(safe).includes('private'))
  const unexpected = fixtureFailure(fixtureModelError('private-code', 'private-operation', { error: 'private-result', reason: 'private-reason' }))
  assert.equal(unexpected.code, 'MODEL_RESULT_REFUSED')
  assert.ok(!Object.hasOwn(unexpected, 'sourceCode') && !Object.hasOwn(unexpected, 'sourceReason') && !Object.hasOwn(unexpected, 'operation'))
})

test('diagnostics preserve only closed peer failure codes and fixture source locations on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-peer-diagnostics-'))
  try {
    const error = Object.assign(new Error('SYNTHETIC_GIT_ORIGIN_REQUIRED\nprivate-command-stderr'), { code: 'ERR_ASSERTION' })
    error.stack = `AssertionError: private detail\n    at validate (${fileURLToPath(new URL('./trace-codex.mjs', import.meta.url))}:61:4)`
    recordPeerFailure(directory, error, 'git_validate')
    const file = join(directory, 'trace-peer-failures.jsonl')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.ok(!(await readFile(file, 'utf8')).includes('private'))
    assert.deepEqual(readPeerFailures(directory), [{ handler: 'synthetic_codex', method: 'RPC', name: 'Error',
      code: 'SYNTHETIC_GIT_ORIGIN_REQUIRED', operation: 'git_validate', source: [{ file: 'tests/mvp/trace-codex.mjs', line: 61, column: 4 }] }])
    await writeFile(file, JSON.stringify({ handler: 'private-route', method: 'private-method', name: 'private-name', code: 'private-code',
      source: [{ file: '/private/path', line: 1, column: 1 }], command: 'private-command' }) + '\n')
    assert.deepEqual(readPeerFailures(directory), [{ handler: 'route', method: 'OTHER', name: 'Error', source: [] }])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('diagnostics observe only the real loopback MCP headers response and preserve transport arguments and errors', async () => {
  const observed = [], calls = []
  const request = new Request('http://localhost:3100/mikka/api/mcp', { method: 'POST', body: 'private prompt', headers: { authorization: 'Bearer private-token' } })
  const options = { signal: new AbortController().signal }, response = new Response('private response', { status: 401 })
  const wrapped = observeTraceMcpFetch(async (input, init) => { calls.push([input, init]); return response }, value => observed.push(value))
  assert.equal(await wrapped(request, options), response)
  assert.equal(calls[0][0], request); assert.equal(calls[0][1], options)
  assert.equal(request.bodyUsed, false); assert.equal(response.bodyUsed, false)
  assert.equal(observed[0].route, 'mcp'); assert.equal(observed[0].method, 'POST'); assert.equal(observed[0].status, 401)
  assert.ok(Number.isFinite(observed[0].durationMs) && observed[0].durationMs >= 0)
  assert.ok(!JSON.stringify(observed).includes('private'))
  await wrapped('http://localhost:3100/mikka/api/version', options)
  assert.equal(observed.length, 1)
  const error = Object.assign(new Error('private socket detail'), { name: 'TimeoutError', code: 'ETIMEDOUT' })
  const rejected = observeTraceMcpFetch(async () => { throw error }, value => observed.push(value))
  await assert.rejects(rejected(request, options), actual => actual === error)
  assert.equal(observed[1].errorName, 'TimeoutError'); assert.equal(observed[1].code, 'ETIMEDOUT')
  assert.ok(!JSON.stringify(observed).includes('private'))
  assert.equal(await observeTraceMcpFetch(async () => response, () => { throw new Error('sink unavailable') })(request, options), response)
})

test('MCP failure diagnostics project only an enumerated method, protocol code and fixed category from a clone', async () => {
  const evidence = Promise.withResolvers()
  const packet = { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required', data: { token: 'private-token' } } }
  const response = Response.json(packet, { status: 400 })
  const options = { method: 'POST', signal: new AbortController().signal, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: { private: 'private-body' } }) }
  const wrapped = observeTraceMcpFetch(async (_input, actual) => { assert.equal(actual, options); return response }, evidence.resolve)
  assert.equal(await wrapped('http://localhost:3100/mikka/api/mcp?private=private-query', options), response)
  const value = await evidence.promise
  assert.equal(value.rpcMethod, 'notifications/initialized')
  assert.equal(value.responseType, 'application/json'); assert.equal(value.rpcErrorCode, -32000); assert.equal(value.rpcErrorClass, 'session_missing')
  assert.ok(!JSON.stringify(value).includes('private') && !JSON.stringify(value).includes(packet.error.message))
  assert.equal(response.bodyUsed, false)
  assert.deepEqual(await response.json(), packet)

  const unknown = Promise.withResolvers(), arbitrary = Response.json({ jsonrpc: '2.0', error: { code: 'private-code', message: 'private-message' } }, { status: 400 })
  const observeUnknown = observeTraceMcpFetch(async () => arbitrary, unknown.resolve)
  await observeUnknown('http://localhost:3100/mikka/api/mcp', { method: 'POST', body: JSON.stringify({ method: 'private-method' }) })
  const closed = await unknown.promise
  assert.equal(closed.rpcMethod, 'OTHER'); assert.equal(closed.rpcErrorClass, 'other'); assert.ok(!Object.hasOwn(closed, 'rpcErrorCode'))
  assert.ok(!JSON.stringify(closed).includes('private'))
  await arbitrary.body.cancel()
})

test('MCP diagnostics bound failed JSON reads and cancel a stalled clone without delaying the original response', { timeout: 5000 }, async () => {
  const large = Promise.withResolvers(), largeResponse = Response.json({ private: 'private-body'.repeat(1000) }, { status: 400 })
  assert.equal(await observeTraceMcpFetch(async () => largeResponse, large.resolve)('http://localhost:3100/mikka/api/mcp'), largeResponse)
  assert.equal((await large.promise).rpcErrorClass, 'body_limit')
  assert.equal(largeResponse.bodyUsed, false)
  await largeResponse.body.cancel()

  let cancelled = false
  const stalled = Promise.withResolvers(), response = new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 400, headers: { 'content-type': 'application/json' } })
  const returned = await observeTraceMcpFetch(async () => response, stalled.resolve)('http://localhost:3100/mikka/api/mcp')
  assert.equal(returned, response); assert.equal(response.bodyUsed, false)
  assert.equal((await stalled.promise).rpcErrorClass, 'body_deadline')
  await response.body.cancel()
  assert.equal(cancelled, true)
})

test('MCP success diagnostics never clone or consume the response body', async () => {
  const observed = [], response = Response.json({ private: 'private-success' })
  response.clone = () => { throw new Error('Success response must not be inspected') }
  assert.equal(await observeTraceMcpFetch(async () => response, value => observed.push(value))('http://localhost:3100/mikka/api/mcp', { method: 'POST', body: JSON.stringify({ method: 'initialize' }) }), response)
  assert.equal(response.bodyUsed, false)
  assert.equal(observed[0].rpcMethod, 'initialize'); assert.ok(!Object.hasOwn(observed[0], 'rpcErrorClass'))
  assert.ok(!JSON.stringify(observed).includes('private'))
})

test('GitHub fixture human merge preserves exact Git bytes and rejects unauthorized or stale heads', async () => {
  const services = await startMvpServices(0)
  const userToken = 'mikka-local-synthetic-user-token'
  const call = async (path, body, token = userToken, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${services.origin}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  const git = (cwd, ...args) => execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  try {
    const setup = await call('/scenario', { marker: `mvp-${randomUUID()}`, title: 'Real merge fixture', harness: 'any' })
    assert.equal(setup.status, 200)
    const bare = setup.body.barePath, checkout = join(dirname(bare), 'merge-checkout')
    git(dirname(bare), 'clone', bare, checkout)
    git(checkout, 'config', 'user.name', 'Fixture owner')
    git(checkout, 'config', 'user.email', 'fixture-owner@example.test')
    const repo = '/github/repos/mikka-e2e/core-loop'
    const base = git(bare, 'rev-parse', 'refs/heads/trunk')
    const branch = 'mikka/fixture-merge-1', content = 'exact handoff artifact\n'
    git(checkout, 'checkout', '-b', branch)
    await writeFile(join(checkout, 'handoff.txt'), content)
    git(checkout, 'add', 'handoff.txt')
    git(checkout, 'commit', '-m', 'Create exact handoff artifact')
    git(checkout, 'push', 'origin', branch)
    const sha = git(checkout, 'rev-parse', 'HEAD')
    const created = await call(`${repo}/pulls`, { title: 'Handoff artifact', head: branch, base: 'trunk', draft: false,
      body: `Fixture candidate\n<!-- mikka-issue:${randomUUID()} -->` })
    assert.equal(created.status, 201)
    const path = `${repo}/pulls/${created.body.number}`, input = { sha, merge_method: 'merge' }
    for (const token of ['mvp-synthetic-installation-run', 'mvp-synthetic-installation-write', 'mvp-synthetic-installation-read']) {
      assert.equal((await call(`${path}/merge`, input, token, 'PUT')).status, 403)
    }
    assert.equal((await call(`${path}/merge`, { ...input, sha: '0'.repeat(40) }, userToken, 'PUT')).status, 409)
    assert.equal(git(bare, 'rev-parse', 'refs/heads/trunk'), base, 'Rejected requests must not change the default branch')
    const merged = await call(`${path}/merge`, input, userToken, 'PUT')
    assert.equal(merged.status, 200, JSON.stringify(merged.body))
    assert.equal(merged.body.merged, true)
    assert.equal(git(bare, 'rev-parse', 'refs/heads/trunk'), merged.body.sha)
    assert.deepEqual(git(bare, 'show', '-s', '--format=%P', merged.body.sha).split(' '), [base, sha])
    assert.equal(execFileSync('git', ['--git-dir', bare, 'show', `${merged.body.sha}:handoff.txt`], { encoding: 'utf8' }), content)
    const view = await call(path)
    assert.equal(view.body.merged, true)
    assert.equal(view.body.state, 'closed')
    assert.equal(view.body.head.sha, sha)
    assert.equal(view.body.merge_commit_sha, merged.body.sha)
    assert.deepEqual(await call(`${path}/merge`, input, userToken, 'PUT'), merged, 'Repeating the same merge must not create a second commit')
    assert.equal(git(bare, 'rev-parse', 'refs/heads/trunk'), merged.body.sha)
    const observed = await call('/observations')
    assert.equal(observed.body.observations.filter(value => value.kind === 'pull-request-merged').length, 1)
    assert.deepEqual(observed.body.errors, [])
  } finally { await services.close() }
})

test('fixture refuses remote targets, split databases, native runtime and every deployment', () => {
  assert.doesNotThrow(() => assertMvpEnvironment(isolated))
  for (const patch of [{ GITHUB_ACTIONS: '' }, { MIKKA_TEST_MODE: '' }, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'production' }, { VERCEL: '1' }, { E2E_BASE_URL: 'https://example.com' }, { DATABASE_URL: 'postgresql://127.0.0.1/business' }, { MIKKA_DATABASE_URL: `${database}?options=-csearch_path=business` }]) {
    assert.throws(() => assertMvpEnvironment({ ...isolated, ...patch }))
  }
})

test('local test mode replaces only the GitHub Actions requirement (the rule: scripts/test-accounts/local-test-mode.test.mjs)', () => {
  const local = { ...isolated, CI: undefined, GITHUB_ACTIONS: undefined, MIKKA_LOCAL_TEST_ACCOUNTS: '1' }
  assert.doesNotThrow(() => assertMvpEnvironment(local))
  const remote = 'postgresql://u:p@db.example.com:5432/mikka_e2e'
  for (const patch of [{ MIKKA_LOCAL_TEST_ACCOUNTS: undefined }, { MIKKA_TEST_MODE: '' }, { VERCEL_ENV: 'preview' }, { E2E_DATABASE_URL: remote, MIKKA_DATABASE_URL: remote, DATABASE_URL: remote },
    { E2E_DATABASE_URL: 'postgresql://ci:fixture@127.0.0.1:5432/other_e2e', MIKKA_DATABASE_URL: 'postgresql://ci:fixture@127.0.0.1:5432/other_e2e', DATABASE_URL: 'postgresql://ci:fixture@127.0.0.1:5432/other_e2e' }])
    assert.throws(() => assertMvpEnvironment({ ...local, ...patch }))
})

test('synthetic MVP transport binds the active fetch path, preserves requests and refuses other external services', async () => {
  const env = { ...isolated, AI_GATEWAY_API_KEY: MVP_DECISION_KEY }
  const requests = []
  const nextPatch = Symbol.for('next-patch')
  const previousNextPatch = Object.getOwnPropertyDescriptor(globalThis, nextPatch)
  const restore = installMvpTransport(env, async (request, options) => {
    requests.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization'), body: await request.text(), redirect: options?.redirect })
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  })
  try {
    assert.equal(hasBoundMvpTransport(env), false, 'installation alone is not evidence of the active fetch path')
    assert.equal(await verifyMvpTransport(env), true)
    assert.equal(hasBoundMvpTransport(env), true)
    assert.equal(requests.length, 0, 'the transport challenge does not contact a server')
    const transport = globalThis.fetch
    // Exercise the installed Next wrapper and its opaque dedupe closure.
    // The proof must work through its real delegation, without property names.
    const noRequestStore = { getStore: () => undefined }
    globalThis.fetch = createPatchedFetcher(createDedupeFetch(transport), { workAsyncStorage: noRequestStore, workUnitAsyncStorage: noRequestStore })
    assert.equal(hasBoundMvpTransport(env), false)
    assert.equal(await verifyMvpTransport(env), true)
    assert.equal(hasBoundMvpTransport(env), true)
    await fetch('https://ai-gateway.vercel.sh/v1/decisions', {
      method: 'POST', headers: { authorization: `Bearer ${MVP_DECISION_KEY}`, 'content-type': 'application/json' }, body: '{"synthetic":true}',
    })
    await fetch(new Request('https://api.github.com/repos/mikka-e2e/core-loop/pulls?page=1', { headers: { authorization: 'Bearer initial-fixture' } }), {
      method: 'POST', headers: { authorization: 'Bearer overridden-fixture' }, body: '{"draft":true}',
    })
    await fetch('http://localhost:3100/mikka/api/test-environment')
    assert.deepEqual(requests, [
      { url: 'http://127.0.0.1:3191/decisions', method: 'POST', authorization: `Bearer ${MVP_DECISION_KEY}`, body: '{"synthetic":true}', redirect: 'error' },
      { url: 'http://127.0.0.1:3191/github/repos/mikka-e2e/core-loop/pulls?page=1', method: 'POST', authorization: 'Bearer overridden-fixture', body: '{"draft":true}', redirect: 'error' },
      { url: 'http://localhost:3100/mikka/api/test-environment', method: 'GET', authorization: null, body: '', redirect: 'error' },
    ])
    for (const url of ['https://example.invalid', 'https://ai-gateway.vercel.sh/v1/decisions?unexpected=1', 'https://api.github.com.attacker.invalid'])
      await assert.rejects(async () => fetch(url), /unstubbed external request/)
    assert.equal(requests.length, 3)
    globalThis.fetch = async (_input, options) => new Response(null, { status: 204, headers: { 'x-mikka-fixture-response': options.headers['x-mikka-fixture-challenge'] } })
    assert.equal(hasBoundMvpTransport(env), false)
    assert.equal(await verifyMvpTransport(env), false, 'echoing a public challenge cannot forge the private response')
    assert.equal(hasBoundMvpTransport(env), false)
  } finally {
    restore()
    if (previousNextPatch) Object.defineProperty(globalThis, nextPatch, previousNextPatch)
    else delete globalThis[nextPatch]
  }
})

test('scripted model fails when the UI destination was not carried into trusted model context', () => {
  const scenario = { marker: `mvp-${randomUUID()}`, deviceId: randomUUID(), title: 'task', repo: REPOSITORY }
  assert.throws(() => answerModel({ prompt: [{ role: 'user', content: [{ type: 'text', text: scenario.marker }] }] }, scenario), { code: 'MODEL_DESTINATION_MISMATCH' })
})

test('scripted model uses only the real tool results for dispatch, including exact device and issue IDs', async () => {
  const services = await startMvpServices(0)
  const originalProvider = globalThis.AI_SDK_DEFAULT_PROVIDER
  try {
    const marker = `mvp-${randomUUID()}`
    const deviceId = randomUUID()
    const issueId = randomUUID()
    const agentId = randomUUID()
    const runId = randomUUID()
    const request = async (path, input) => {
      const response = await fetch(`${services.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
      assert.equal(response.ok, true)
    }
    await request('/scenario', { marker, title: 'Fixture SDK boundary' })
    await request('/scenario/device', { deviceId })
    const calls = []
    globalThis.AI_SDK_DEFAULT_PROVIDER = createGateway({ baseURL: `${services.origin}/v1`, apiKey: 'synthetic-fixture' })
    const response = await generateText({
      model: 'fixture-model',
      prompt: `${marker}\nThe person selected device ${deviceId} in the task dialog. Use a local execution identity on exactly this device; do not substitute another device or Mikka Cloud.`,
      stopWhen: stepCountIs(5), maxRetries: 0,
      tools: {
        create_issue: tool({ inputSchema: z.object({ title: z.string(), body: z.string() }), execute: input => { calls.push({ tool: 'create_issue', input }); return { id: issueId } } }),
        list_agents: tool({ inputSchema: z.object({}), execute: () => [{ id: randomUUID(), deviceId: randomUUID(), harness: 'mock', deviceOnline: true }, { id: agentId, deviceId, harness: 'mock', deviceOnline: true }] }),
        dispatch_run: tool({ inputSchema: z.object({ issueId: z.uuid(), agentId: z.uuid(), repo: z.string() }), execute: input => { calls.push({ tool: 'dispatch_run', input }); return { runId, status: 'queued' } } }),
      },
    })
    assert.match(response.text, /你选择的电脑/)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1], { tool: 'dispatch_run', input: { issueId, agentId, repo: REPOSITORY } })
    const evidence = await (await fetch(`${services.origin}/observations`)).json()
    assert.deepEqual(evidence.errors, [])
  } finally { globalThis.AI_SDK_DEFAULT_PROVIDER = originalProvider; await services.close() }
})

test('completion model requires a real result and PR receipt, never fabricates them', () => {
  const scenario = { marker: `mvp-${randomUUID()}`, deviceId: randomUUID(), title: 'task', repo: REPOSITORY }
  const runId = randomUUID(), issueId = randomUUID()
  const request = { prompt: [
    { role: 'user', content: `${scenario.marker}\nThe person selected device ${scenario.deviceId} in the task dialog.` },
    { role: 'user', content: `[Event] Run ${runId} ended with status succeeded (submitted).` },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'get_run', output: { type: 'json', value: { id: runId, issueId, status: 'succeeded', summary: 'Actual summary' } } }, { type: 'tool-result', toolName: 'get_issue', output: { type: 'json', value: { id: issueId } } }] },
  ] }
  assert.throws(() => answerModel(request, scenario), /PR receipt/)
  request.prompt[1].content += ' https://github.com/mikka-e2e/core-loop/pull/41'
  assert.match(answerModel(request, scenario).content[0].text, /Actual summary/)
})

test('scripted Decisions accepts only the runtime triage contract and identifies synthetic receipts', async () => {
  const services = await startMvpServices(0)
  try {
    const runId = randomUUID(), eventId = randomUUID()
    const request = {
      model: 'openai/gpt-6-luna-decisions',
      input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ hostObservation: JSON.stringify({ eventId, eventKind: 'run_finished', ownerId: randomUUID(), runId, observedRun: { id: runId, status: 'succeeded' } }) }) }] }],
      questions: [{ type: 'choice', name: 'tier', choices: ['attention', 'result', 'background'].map(value => ({ value })) }],
    }
    const post = async (body, token = 'mvp-synthetic-decisions') => fetch(`${services.origin}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    const response = await post(request)
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.model, request.model)
    assert.match(result.provider_metadata.gateway.generationId, /^mvp-synthetic-/)
    assert.equal(result.provider_metadata.gateway.cost,'0.001','scripted hosted triage includes its billing receipt')
    assert.deepEqual(result.answers, [{ type: 'choice', name: 'tier', choice: 'result' }])
    for (const invalid of [{ ...request, model: 'unconfigured-model' }, { ...request, questions: [{ type: 'predicate', name: 'approved' }] }, { ...request, input: 'unexpected judgment request' }]) {
      assert.equal((await post(invalid)).status, 500)
    }
    assert.equal((await post(request, 'not-the-fixture-key')).status, 500)
    const evidence = await (await fetch(`${services.origin}/observations`)).json()
    assert.equal(evidence.observations.filter(item => item.kind === 'decision-request').length, 1)
    assert.equal(evidence.observations[0].eventId, eventId)
    assert.equal(evidence.errors.length, 4)
  } finally { await services.close() }
})

test('scripted Decisions answers an ended run\'s outcome only from the run outcome contract', async () => {
  const services = await startMvpServices(0)
  try {
    const OUTCOME_QUESTIONS = [{ type: 'choice', name: 'outcome', choices: ['done', 'blocked', 'needs_input', 'failed', 'idle'].map(value => ({ value })) }]
    const facts = (status) => ['status: ' + status, 'stop reason: none', 'attempts on this task: 1', 'task: in_review — "Add README"', 'pull requests: open', 'summary (quoted): "Opened the PR"', 'last reply (quoted): "Done"'].join('\n')
    const request = (text, questions = OUTCOME_QUESTIONS) => ({ model: 'openai/gpt-6-luna-decisions', input: decisionRequestInput(text), questions })
    const post = async body => fetch(`${services.origin}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer mvp-synthetic-decisions' }, body: JSON.stringify(body) })
    assert.deepEqual((await (await post(request(facts('succeeded')))).json()).answers, [{ type: 'choice', name: 'outcome', choice: 'done' }])
    assert.deepEqual((await (await post(request(facts('cancelled')))).json()).answers, [{ type: 'choice', name: 'outcome', choice: 'idle' }])
    for (const invalid of [request('status: succeeded'), request(facts('running')), request(facts('succeeded'), [{ ...OUTCOME_QUESTIONS[0], choices: OUTCOME_QUESTIONS[0].choices.slice(1) }]), request({ text: facts('succeeded') })]) {
      assert.equal((await post(invalid)).status, 500)
    }
    const evidence = await (await fetch(`${services.origin}/observations`)).json()
    assert.deepEqual(evidence.observations.filter(item => item.kind === 'outcome-request').map(item => item.status), ['succeeded', 'cancelled'])
    assert.equal(evidence.errors.length, 4)
  } finally { await services.close() }
})

test('scripted Decisions answers a Coordinator reply\'s phone push only from the push contract', async () => {
  const services = await startMvpServices(0)
  try {
    const PUSH_QUESTIONS = [{ type: 'choice', name: 'push', choices: ['decide', 'review', 'finished', 'briefing', 'none'].map(value => ({ value })) }]
    const evidence = (answers) => `answeredEvents: user_message (attention)\nanswersAMessageFromThePerson: ${answers}\nreply: 已在你选择的电脑上启动线程。`
    const request = (input, questions = PUSH_QUESTIONS) => ({ model: 'openai/gpt-6-luna-decisions', input, questions })
    const post = async body => fetch(`${services.origin}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer mvp-synthetic-decisions' }, body: JSON.stringify(body) })
    assert.deepEqual((await (await post(request(evidence('yes')))).json()).answers, [{ type: 'choice', name: 'push', choice: 'none' }])
    for (const invalid of [request('reply: hi'), request([{ role: 'user', content: [{ type: 'input_text', text: evidence('yes') }] }]), request(evidence('yes'), [{ ...PUSH_QUESTIONS[0], choices: PUSH_QUESTIONS[0].choices.slice(1) }])]) {
      assert.equal((await post(invalid)).status, 500)
    }
    const observed = await (await fetch(`${services.origin}/observations`)).json()
    assert.deepEqual(observed.observations.filter(item => item.kind === 'push-request').map(item => item.answersPerson), ['yes'])
    assert.equal(observed.errors.length, 3)
  } finally { await services.close() }
})
