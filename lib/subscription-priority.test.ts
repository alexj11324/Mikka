import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde'
import { SubscriptionService } from './subscription-service'
import { SubscriptionWorkflowModel } from './subscription-workflow-model'
import { ExecutionSettings } from './execution-settings'
import { subscriptionFixture } from '../tests/fixtures/subscription'

const priority = { codexServiceTier: 'priority' as const }
const catalogue = (supported: boolean) => ({ revision: '1', models: ['fixture-model'], priorityVersion: 1, prioritySupport: { 'fixture-model': supported } })
const encoder = new TextEncoder()
type Policy = { codexServiceTier?: 'priority' }
function modelService(route: 'codex_cpa' | 'claude_cpa', catalog: unknown, policy: Policy = {}) {
  const { use, access } = subscriptionFixture(route)
  access.connection!.quota.observedAt = new Date().toISOString()
  const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: 'custody-workspace', provider: route === 'codex_cpa' ? 'codex' as const : 'claude' as const, state: 'connected', epoch: '1', quota: access.connection!.quota, modelCatalog: catalog }
  const counts = { bindings: 0, connections: 0, memberships: 0, admissions: 0, streams: 0, workerCalls: 0 }
  const payloads: Record<string, unknown>[] = []
  const repository = {
    binding: async () => { counts.bindings++; return { ...access.binding!, modelId: 'fixture-model' } },
    connection: async () => { counts.connections++; return structuredClone(row) },
    scope: () => ({ ownerId: row.ownerId, workspaceId: row.workspaceId, connectionId: row.id, provider: row.provider }),
  } as unknown as SubscriptionService['repository']
  const worker = {
    forUse() { return this },
    call() { counts.workerCalls++; throw new Error('unexpected quota/catalogue RPC') },
    stream(_revision: number, model: string, payload: Record<string, unknown>) {
      counts.streams++; assert.equal(model, 'fixture-model'); payloads.push(structuredClone(payload))
      return new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: 'synthetic', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }) + '\n\n'))
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id: 'synthetic', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'))
        controller.close()
      } })
    },
  }
  const service = new SubscriptionService(repository, () => worker as never, { ready: () => true, nativeIsolation: 'none' }, undefined, async () => { counts.memberships++ }, async () => { counts.admissions++ }, undefined, policy)
  return { service, use, row, counts, payloads }
}
async function request(f: ReturnType<typeof modelService>, providerOptions?: Record<string, Record<string, string>>) {
  const model = await f.service.model(f.use)
  const result = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'unchanged' }] }], ...(providerOptions ? { providerOptions } : {}) })
  await Array.fromAsync(result.stream as unknown as AsyncIterable<unknown>)
  assert.equal(f.counts.streams, 1)
  assert.equal(f.counts.workerCalls, 0)
  return f.payloads[0]
}

test('priority changes only the requested tier and adds no model RPC or authorization reads', async () => {
  const ordinary = modelService('codex_cpa', catalogue(true))
  const fast = modelService('codex_cpa', catalogue(true), priority)
  const original = await request(ordinary), actual = await request(fast)
  assert.equal(actual.service_tier, 'priority')
  const { service_tier: _tier, ...rest } = actual
  assert.deepEqual(rest, original)
  assert.deepEqual(fast.counts, ordinary.counts)
  assert.deepEqual(fast.counts, { bindings: 4, connections: 6, memberships: 3, admissions: 2, streams: 1, workerCalls: 0 })
})

for (const [name, value] of [
  ['unsupported', catalogue(false)],
  ['old catalogue', { revision: '1', models: ['fixture-model'] }],
  ['different epoch', { ...catalogue(true), revision: '2' }],
  ['different model', { ...catalogue(true), models: ['another-model'] }],
  ['missing catalogue', null],
  ['malformed evidence', { ...catalogue(true), prioritySupport: { 'fixture-model': 'synthetic-private-value' } }],
  ['unrecognized version', { ...catalogue(true), priorityVersion: 2 }],
] as const) {
  test('priority is omitted with ' + name + ' without retrying or refreshing the catalogue', async () => {
    const f = modelService('codex_cpa', value, priority)
    const payload = await request(f)
    assert.equal(Object.hasOwn(payload, 'service_tier'), false)
    assert.equal(f.counts.workerCalls, 0)
  })
}

test('provider options cannot opt an ordinary subscription call into priority', async () => {
  const f = modelService('codex_cpa', catalogue(true))
  const payload = await request(f, { mikkaSubscription: { service_tier: 'priority' } })
  assert.equal(Object.hasOwn(payload, 'service_tier'), false)
})
test('the Coordinator policy leaves Claude request semantics unchanged', async () => {
  const ordinary = modelService('claude_cpa', catalogue(true)), fast = modelService('claude_cpa', catalogue(true), priority)
  assert.deepEqual(await request(fast), await request(ordinary))
  assert.deepEqual(fast.counts, ordinary.counts)
})
test('fresh access revocation still wins after priority model construction', async () => {
  const f = modelService('codex_cpa', catalogue(true), priority)
  const model = await f.service.model(f.use)
  f.row.state = 'disconnected'
  await assert.rejects(async () => await model.doStream({ prompt: [] }), { code: 'disconnected' })
  assert.equal(f.counts.streams, 0)
})

const id = (n: number) => '10000000-0000-4000-8000-' + String(n).padStart(12, '0')
const selection = { type: 'subscription' as const, bindingId: id(3), ownerId: 'alice', consumerId: id(1), workspaceId: id(2), connectionId: id(4), connectionRevision: 7, modelId: 'gpt-6-luna', route: 'codex_cpa' as const }
test('priority survives Workflow serde for a hosted chat bot without changing the frozen binding', () => {
  assert.equal(Object.hasOwn(selection, 'coordinator'), false)
  const model = new SubscriptionWorkflowModel(selection, priority)
  const value = SubscriptionWorkflowModel[WORKFLOW_SERIALIZE](model)
  assert.deepEqual(value, { selection, requestPolicy: priority })
  const restored = SubscriptionWorkflowModel[WORKFLOW_DESERIALIZE](JSON.parse(JSON.stringify(value)))
  assert.deepEqual(SubscriptionWorkflowModel[WORKFLOW_SERIALIZE](restored), value)
  const old = SubscriptionWorkflowModel[WORKFLOW_DESERIALIZE](selection)
  assert.deepEqual(SubscriptionWorkflowModel[WORKFLOW_SERIALIZE](old), selection)
})
test('Workflow and service policy reject arbitrary fields or tier strings', () => {
  assert.throws(() => SubscriptionWorkflowModel[WORKFLOW_DESERIALIZE]({ selection, requestPolicy: { codexServiceTier: 'synthetic-private-value' } }))
  assert.throws(() => SubscriptionWorkflowModel[WORKFLOW_DESERIALIZE]({ selection, requestPolicy: { codexServiceTier: 'priority', apiKey: 'synthetic-private-value' } }))
  assert.throws(() => modelService('codex_cpa', catalogue(true), { codexServiceTier: 'fast' } as unknown as Policy))
})

test('the same account catalogue read preserves known true/false and leaves missing capabilities unknown', async () => {
  const f = modelService('codex_cpa', null)
  const response = [{ id: 'one', name: 'One', prioritySupported: true }, { id: 'two', name: 'Two', prioritySupported: false }, { id: 'three', name: 'Three' }]
  const service = new SubscriptionService(f.service.repository, () => ({ call: async () => response }) as never, { ready: () => true, nativeIsolation: 'none' })
  assert.deepEqual(await service.models(f.use.ownerId, f.row.id), response)
  response[0] = { id: 'one', name: 'One', prioritySupported: 'synthetic-private-value' } as never
  await assert.rejects(service.models(f.use.ownerId, f.row.id), { code: 'backend_unavailable' })
})

test('existing catalogue transaction stores priority evidence with the same epoch fence and update', async () => {
  const statements: { sql: string; values?: unknown[] }[] = []
  const connection = { id: id(4), epoch: '7', provider: 'codex', workspaceId: id(2) }
  const client = { query: async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values })
    return sql.startsWith('SELECT id,') ? { rowCount: 1, rows: [{ id: connection.id, modelSettings: null }] } : { rowCount: 1, rows: [] }
  }, release() {} }
  const pool = { query: async () => ({ rowCount: 1, rows: [connection] }), connect: async () => client }
  const settings = new ExecutionSettings(pool as never)
  settings.botModels = async () => []
  await settings.refreshBotModels({ ownerId: 'alice', workspaceId: id(2) }, id(4), async () => [
    { id: 'gpt-6-luna', name: 'Luna', prioritySupported: true },
    { id: 'gpt-6-sol', name: 'Sol', prioritySupported: false },
    { id: 'other', name: 'Unknown' },
  ])
  const writes = statements.filter(s => s.sql.startsWith('UPDATE byos_connections'))
  assert.equal(writes.length, 1)
  const saved = JSON.parse(String(writes[0].values![1]))
  assert.deepEqual(saved, { revision: '7', models: ['gpt-6-luna', 'gpt-6-sol', 'other'], priorityVersion: 1, prioritySupport: { 'gpt-6-luna': true, 'gpt-6-sol': false } })
  const fence = statements.find(s => s.sql.includes('FOR UPDATE'))!
  assert.deepEqual(fence.values, [id(4), 'alice', '7'])
  assert.equal(statements.at(-1)!.sql, 'COMMIT')
})
