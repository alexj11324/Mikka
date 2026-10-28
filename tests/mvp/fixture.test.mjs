import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createGateway, generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { assertMvpEnvironment, REPOSITORY } from './isolated-env.mjs'
import { answerModel } from './model.mjs'
import { startMvpServices } from './services.mjs'

const database = 'postgresql://ci:fixture@127.0.0.1:5432/mikka_e2e'
const isolated = { CI: 'true', GITHUB_ACTIONS: 'true', MIKKA_MVP_E2E: '1', MIKKA_TEST_MODE: '1', E2E_DATABASE_URL: database, MIKKA_DATABASE_URL: database, DATABASE_URL: database }
test('fixture refuses remote targets, split databases, native runtime and every deployment', () => {
  assert.doesNotThrow(() => assertMvpEnvironment(isolated))
  for (const patch of [{ GITHUB_ACTIONS: '' }, { MIKKA_TEST_MODE: '' }, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'production' }, { VERCEL: '1' }, { MIKKA_NATIVE_COORDINATOR: '1' }, { E2E_BASE_URL: 'https://example.com' }, { DATABASE_URL: 'postgresql://127.0.0.1/business' }, { MIKKA_DATABASE_URL: `${database}?options=-csearch_path=business` }]) {
    assert.throws(() => assertMvpEnvironment({ ...isolated, ...patch }))
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
