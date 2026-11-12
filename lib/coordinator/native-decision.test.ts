import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock, test } from 'node:test'

test('native Decisions binds both request digests and settles the workspace reservation from actual usage fields', async t => {
  const endpoint = 'https://api.openai.com/v1/decisions'
  const saved = { ...process.env }
  const oldFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = oldFetch
    for (const key of ['DECISIONS_URL', 'DECISIONS_BILLING_PROFILE', 'OPENAI_DECISIONS_API_KEY', 'DECISIONS_API_KEY']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
  process.env.DECISIONS_URL = endpoint
  process.env.DECISIONS_BILLING_PROFILE = 'openai-global-standard'
  process.env.OPENAI_DECISIONS_API_KEY = 'native-test'
  process.env.DECISIONS_API_KEY = 'old-gateway-test'
  const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
  const reservations: unknown[][] = [], settlements: unknown[][] = []
  stub('../abuse/context.ts', { hostedBillingScope: { getStore: () => ({ workspaceId: 'w', ownerId: 'o' }) } })
  stub('../default-model.ts', { cloudDecisionTarget: async () => null })
  stub('../model-admission/runtime.ts', { assertUnmanagedModelTransport: async () => {} })
  stub('../credit-shares.ts', { withSharedCredits: async (workspace: string, work: (payer: string) => unknown) => work(workspace) })
  stub('../abuse/runtime.ts', { canUseMikkaPaid: async () => {}, hostedUsage: {
    reserve: async (...args: unknown[]) => { reservations.push(args) },
    settle: async (...args: unknown[]) => { settlements.push(args) },
  } })
  stub('../abuse/alerts.ts', { checkAbuseAlerts: async () => {} })
  let calls = 0, wire = '', reads = 200
  globalThis.fetch = async (input, init) => {
    calls++
    assert.equal(String(input), endpoint)
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer native-test')
    wire = String(init?.body)
    assert.equal(JSON.parse(wire).model, 'gpt-6-luna')
    return Response.json({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'ok', probability: 1 }],
      usage: { input_tokens: 1000, output_tokens: 19, input_tokens_details: { cached_tokens: reads, cache_write_tokens: 400 } } },
      { headers: { 'x-request-id': 'req_native_receipt' } })
  }
  const { invokeDecision } = await import('./decide')
  const { DECISION_MODEL } = await import('./decision')
  const questions = [{ type: 'predicate' as const, name: 'ok', instructions: 'Test' }]
  const run = () => invokeDecision('native-test', 'sample', questions)
  const digest = (s: string) => createHash('sha256').update(s).digest('hex')
  const result = await run()
  assert.ok(result)
  assert.equal(result.answers.get('ok')?.type, 'predicate')
  assert.equal(result.execution.providerGenerationId, 'req_native_receipt')
  assert.equal(result.execution.providerRequestDigest, digest(wire))
  assert.equal(result.execution.requestDigest, digest(JSON.stringify({ ...JSON.parse(wire), model: DECISION_MODEL })))
  assert.deepEqual(reservations[0]?.slice(0, 2), ['w', DECISION_MODEL])
  assert.deepEqual(settlements[0], [reservations[0][2], 92, 1000, 19, 'req_native_receipt', { read: 200, write: 400 }])
  reads = 1000
  assert.equal(await run(), null)
  assert.equal(settlements[1][1], null)
  delete process.env.OPENAI_DECISIONS_API_KEY
  assert.equal(await run(), null)
  assert.equal(calls, 2)
  assert.equal(reservations.length, 2)
})
