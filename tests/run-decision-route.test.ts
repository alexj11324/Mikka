import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let caller: { userId: string; scopeDeviceId?: string } | null = { userId: 'owner', scopeDeviceId: 'device' }
let liveRun: { botId: string | null } | null = { botId: 'bot' }
let answers: Map<string, unknown> | null = null
const queries: unknown[][] = []
const decide = mock.fn(async (..._args: unknown[]) => answers)
const scopes: unknown[] = []
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
// The real credential/transaction boundary is exercised by device-revocation.db.test.ts.
stub('../lib/device-route.ts', { withDeviceRoute: <T>(handler: T) => handler })
stub('../lib/device-link.ts', { authenticateDevice: async () => caller })
stub('../lib/db/index.ts', { pool: { query: async (_sql: string, values: unknown[]) => { queries.push(values); return { rows: liveRun ? [liveRun] : [] } } } })
stub('../lib/coordinator/decide.ts', { decide })
stub('../lib/abuse/context.ts', { hostedBillingScope: { run: (scope: unknown, work: () => unknown) => { scopes.push(scope); return work() } } })
stub('../lib/execution-settings.ts', { executionWorkspace: async (ownerId: string, botId: string | null) => `ws:${ownerId}:${botId}` })
let route: typeof import('../app/v1/runs/[runId]/decision/route')
before(async () => { route = await import('../app/v1/runs/[runId]/decision/route') })
beforeEach(() => { caller = { userId: 'owner', scopeDeviceId: 'device' }; liveRun = { botId: 'bot' }; answers = null; queries.length = 0; scopes.length = 0; decide.mock.resetCalls() })
const runId = '10000000-0000-4000-8000-000000000001'
const questions = [{ type: 'predicate', name: 'safe', instructions: 'Is it safe?' }, { type: 'choice', name: 'level', instructions: 'Pick', choices: [{ value: 'low' }, { value: 'high' }] }]
const body = { purpose: 'computer-action', input: 'click Delete', questions }
const post = (value: unknown = body) => route.POST(new Request(`https://example.test/mikka/v1/runs/${runId}/decision`, { method: 'POST', body: JSON.stringify(value) }), { params: Promise.resolve({ runId }) })

test('rejects an unauthenticated caller and a run that is not the caller\'s live run', async () => {
  caller = null
  assert.equal((await post()).status, 401)
  caller = { userId: 'owner', scopeDeviceId: 'device' }
  liveRun = null
  assert.equal((await post()).status, 409)
  assert.deepEqual(queries[0]?.slice(0, 3), [runId, 'owner', 'device'])
  assert.equal(decide.mock.callCount(), 0)
})

test('rejects a malformed body before any lookup', async () => {
  for (const value of [{ ...body, purpose: 'other' }, { ...body, purpose: 'command-action' }, { ...body, questions: [] }, { ...body, input: 'x'.repeat(16001) },
    { ...body, questions: [{ type: 'predicate', name: '1bad', instructions: 'x' }] }, null]) assert.equal((await post(value)).status, 400)
  assert.equal(queries.length, 0)
  assert.equal(decide.mock.callCount(), 0)
})

test('asks decide in the run\'s billing scope and returns its answers', async () => {
  answers = new Map<string, unknown>([['safe', { type: 'predicate', name: 'safe', probability: 0.9 }], ['level', { type: 'choice', name: 'level', choice: 'low', confidence: 0.8 }], ['gone', { type: 'refusal', name: 'gone' }]])
  const response = await post()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { answers: [{ type: 'predicate', name: 'safe', probability: 0.9 }, { type: 'choice', name: 'level', choice: 'low' }] })
  assert.deepEqual(decide.mock.calls[0]?.arguments.slice(0, 3), ['daemon-computer-action', 'click Delete', questions])
  assert.deepEqual(scopes, [{ workspaceId: 'ws:owner:bot', ownerId: 'owner' }])
})

test('no usable decision returns null answers', async () => {
  const response = await post()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { answers: null })
})
