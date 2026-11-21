import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock, test } from 'node:test'

test('LiteLLM Decisions sends its configured alias and settles workspace usage from the proxy receipt', async t => {
  const endpoint = 'https://litellm.example/v1/decisions'
  const saved = { ...process.env }
  const oldFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = oldFetch
    for (const key of ['MIKKA_LITELLM_URL', 'MIKKA_LITELLM_MASTER_KEY']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  process.env.MIKKA_LITELLM_URL = 'https://litellm.example/v1'
  process.env.MIKKA_LITELLM_MASTER_KEY = 'proxy-test'
  const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
  const reservations: unknown[][] = [], settlements: unknown[][] = []
  stub('../abuse/context.ts', { hostedBillingScope: { getStore: () => ({ workspaceId: 'w', ownerId: 'o' }) } })
  stub('../model-admission/runtime.ts', { assertLiteLLMModelTransport: async () => {} })
  stub('../credit-shares.ts', { withSharedCredits: async (workspace: string, work: (payer: string) => unknown) => work(workspace) })
  stub('../abuse/runtime.ts', { canUseMikkaPaid: async () => {}, hostedUsage: {
    reserve: async (...args: unknown[]) => { reservations.push(args) },
    settle: async (...args: unknown[]) => { settlements.push(args) },
  } })
  stub('../abuse/alerts.ts', { checkAbuseAlerts: async () => {} })
  let calls = 0, wire = '', cost: string | undefined = '0.000092'
  globalThis.fetch = async (input, init) => {
    calls++
    assert.equal(String(input), endpoint)
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer proxy-test')
    wire = String(init?.body)
    assert.equal(JSON.parse(wire).model, 'mikka-decision')
    return Response.json({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'ok', probability: 1 }],
      usage: { input_tokens: 1000, output_tokens: 19, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 400 } } },
      { headers: { 'x-litellm-call-id': 'proxy_call_receipt', ...(cost === undefined ? {} : { 'x-litellm-response-cost': cost }) } })
  }
  const { invokeDecision } = await import('./decide')
  const { DECISION_MODEL } = await import('./decision')
  const questions = [{ type: 'predicate' as const, name: 'ok', instructions: 'Test' }]
  const run = () => invokeDecision('native-test', 'sample', questions)
  const digest = (s: string) => createHash('sha256').update(s).digest('hex')
  const result = await run()
  assert.ok(result)
  assert.equal(result.answers.get('ok')?.type, 'predicate')
  assert.equal(result.execution.providerGenerationId, 'proxy_call_receipt')
  assert.equal(result.execution.requestDigest, digest(wire))
  assert.deepEqual(reservations[0]?.slice(0, 2), ['w', DECISION_MODEL])
  assert.deepEqual(settlements[0], [reservations[0][2], 92, 1000, 19, 'proxy_call_receipt', { read: 200, write: 400 }])
  cost = undefined
  assert.equal(await run(), null)
  assert.equal(settlements[1][1], null)
  delete process.env.MIKKA_LITELLM_MASTER_KEY
  assert.equal(await run(), null)
  assert.equal(calls, 2)
  assert.equal(reservations.length, 2)
})
