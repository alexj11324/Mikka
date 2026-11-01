import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createGateway, generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { assertMvpEnvironment, REPOSITORY } from './isolated-env.mjs'
import { answerModel } from './model.mjs'
import { startMvpServices } from './services.mjs'
import { hasBoundMvpTransport, installMvpTransport, MVP_DECISION_KEY, verifyMvpTransport } from './transport.mjs'
import { createDedupeFetch } from 'next/dist/server/lib/dedupe-fetch.js'
import { createPatchedFetcher } from 'next/dist/server/lib/patch-fetch.js'

const database = 'postgresql://ci:fixture@127.0.0.1:5432/mikka_e2e'
const isolated = { CI: 'true', GITHUB_ACTIONS: 'true', MIKKA_MVP_E2E: '1', MIKKA_TEST_MODE: '1', E2E_DATABASE_URL: database, MIKKA_DATABASE_URL: database, DATABASE_URL: database }
test('fixture refuses remote targets, split databases, native runtime and every deployment', () => {
  assert.doesNotThrow(() => assertMvpEnvironment(isolated))
  for (const patch of [{ GITHUB_ACTIONS: '' }, { MIKKA_TEST_MODE: '' }, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'production' }, { VERCEL: '1' }, { MIKKA_NATIVE_COORDINATOR: '1' }, { E2E_BASE_URL: 'https://example.com' }, { DATABASE_URL: 'postgresql://127.0.0.1/business' }, { MIKKA_DATABASE_URL: `${database}?options=-csearch_path=business` }]) {
    assert.throws(() => assertMvpEnvironment({ ...isolated, ...patch }))
  }
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
  assert.throws(() => answerModel({ prompt: [{ role: 'user', content: [{ type: 'text', text: scenario.marker }] }] }, scenario), /task destination/)
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
    const request = (text, questions = OUTCOME_QUESTIONS) => ({ model: 'openai/gpt-6-luna-decisions', input: [{ role: 'user', content: [{ type: 'input_text', text }] }], questions })
    const post = async body => fetch(`${services.origin}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer mvp-synthetic-decisions' }, body: JSON.stringify(body) })
    assert.deepEqual((await (await post(request(facts('succeeded')))).json()).answers, [{ type: 'choice', name: 'outcome', choice: 'done' }])
    assert.deepEqual((await (await post(request(facts('cancelled')))).json()).answers, [{ type: 'choice', name: 'outcome', choice: 'idle' }])
    for (const invalid of [request('status: succeeded'), request(facts('running')), request(facts('succeeded'), [{ ...OUTCOME_QUESTIONS[0], choices: OUTCOME_QUESTIONS[0].choices.slice(1) }])]) {
      assert.equal((await post(invalid)).status, 500)
    }
    const evidence = await (await fetch(`${services.origin}/observations`)).json()
    assert.deepEqual(evidence.observations.filter(item => item.kind === 'outcome-request').map(item => item.status), ['succeeded', 'cancelled'])
    assert.equal(evidence.errors.length, 3)
  } finally { await services.close() }
})
