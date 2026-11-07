import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import type { ExecutionContextSource, ExecutionFacts } from './execution-context'
import type { PoolDevice } from '../model-order-plan'

const calls = { scopes: [] as string[], devices: [] as string[], hosted: [] as string[], projections: [] as (string | undefined)[] }
let failScope = false, failDevices = false
const pool = { query: async () => ({ rows: [], rowCount: 1 }) }
const devices = async (_pool: unknown, ownerId: string): Promise<PoolDevice[]> => {
  calls.devices.push(ownerId)
  if (failDevices) throw new Error('device fixture unavailable')
  return [{ id: `device-${ownerId}`, name: `${ownerId}'s computer`, enabled: true, online: true, harnesses: [], server: false, activeRuns: 0, joinedAt: 0 }]
}
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../execution-settings.ts', { executionWorkspace: async (ownerId: string, botId: string) => {
  calls.scopes.push(`${ownerId}:${botId}`)
  if (failScope) throw new Error('scope fixture unavailable')
  return `workspace-${ownerId}-${botId}`
} })
stub('../db/index.ts', { pool })
stub('../workspace-db.ts', { workspacePool: { query: async (_sql: string, [workspaceId]: string[]) => ({ rows: [{ name: workspaceId, kind: 'team' }] }) } })
stub('../model-order.ts', {
  poolDevices: devices,
  orderView: async (query: unknown, scope: { ownerId: string; workspaceId: string }, readDevices?: () => Promise<PoolDevice[]>, projection?: 'context') => {
    calls.projections.push(projection)
    await (readDevices ? readDevices() : devices(query, scope.ownerId))
    return { location: 'local', entries: [], candidates: [], preferredHarness: 'codex', cloudReady: false, cloudModels: {} }
  },
  dispatchOrder: (entries: unknown[]) => entries,
})
stub('../model-order-plan.ts', { deviceSupport: () => 'ready' })
stub('../secrets/e2b-owner-sql.ts', { ownE2BKeySql: () => 'true' })
stub('../abuse/runtime.ts', { hostedUsage: { status: async (workspaceId: string) => { calls.hosted.push(workspaceId); return { state: 'ready' } } } })
let readExecutionFacts: typeof import('./execution-context')['readExecutionFacts']
let executionContextParts: typeof import('./execution-context')['executionContextParts']
before(async () => { ({ readExecutionFacts, executionContextParts } = await import('./execution-context')) })
beforeEach(() => { calls.scopes.length = 0; calls.devices.length = 0; calls.hosted.length = 0; calls.projections.length = 0; failScope = false; failDevices = false })

test('two display reads each get one fresh scope and one device read, including orderView', async () => {
  const first = await readExecutionFacts('alice', 'bot-a')
  await executionContextParts('alice', 'bot-a')
  assert.deepEqual(calls.scopes, ['alice:bot-a', 'alice:bot-a'])
  assert.deepEqual(calls.devices, ['alice', 'alice'])
  assert.deepEqual(calls.projections, ['context', 'context'], 'prompt facts never request the unused settings-page credential count')
  assert.equal(first.workspace?.name, 'workspace-alice-bot-a')
  assert.equal(first.devices?.[0].name, "alice's computer")
})

test('concurrent owners and bots keep independent display snapshots', async () => {
  const [alice, bob] = await Promise.all([readExecutionFacts('alice', 'bot-a'), readExecutionFacts('bob', 'bot-b')])
  assert.deepEqual(calls.scopes.sort(), ['alice:bot-a', 'bob:bot-b'])
  assert.deepEqual(calls.devices.sort(), ['alice', 'bob'])
  assert.equal(alice.workspace?.name, 'workspace-alice-bot-a')
  assert.equal(bob.workspace?.name, 'workspace-bob-bot-b')
  assert.equal(alice.devices?.[0].name, "alice's computer")
  assert.equal(bob.devices?.[0].name, "bob's computer")
  assert.deepEqual(calls.hosted.sort(), ['workspace-alice-bot-a', 'workspace-bob-bot-b'])
})

test('a rejected display read is shared only within that invocation and never poisons the next one', async () => {
  failScope = true; failDevices = true
  const failed = await readExecutionFacts('alice', 'bot-a')
  assert.deepEqual(failed, { workspace: null, devices: null, order: null, e2b: true, hosted: null })
  assert.deepEqual(calls.scopes, ['alice:bot-a'])
  assert.deepEqual(calls.devices, ['alice'])
  failScope = false; failDevices = false
  const recovered = await readExecutionFacts('alice', 'bot-a')
  assert.equal(recovered.workspace?.name, 'workspace-alice-bot-a')
  assert.equal(recovered.devices?.[0].name, "alice's computer")
  assert.deepEqual(calls.scopes, ['alice:bot-a', 'alice:bot-a'])
  assert.deepEqual(calls.devices, ['alice', 'alice'])
})

test('an explicit facts source retains its arguments and does not invoke the default sources', async () => {
  const facts: ExecutionFacts = { workspace: null, devices: [], order: null, e2b: false, hosted: 'ready' }
  const inputs: string[] = []
  const from = Object.fromEntries(Object.keys(facts).map(key => [key, async (ownerId: string, botId: string) => {
    inputs.push(`${key}:${ownerId}:${botId}`)
    return facts[key as keyof ExecutionFacts]
  }])) as ExecutionContextSource
  assert.deepEqual(await readExecutionFacts('alice', 'bot-a', from), facts)
  assert.deepEqual(inputs.sort(), ['devices', 'e2b', 'hosted', 'order', 'workspace'].map(key => `${key}:alice:bot-a`))
  assert.deepEqual(calls, { scopes: [], devices: [], hosted: [], projections: [] })
})
