import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { HOSTED_CHOICE } from '../bot-model-menu-view'
import { ActionFailureError } from '../action-error'
import type { BotSubscriptionChoice } from '../bot-model-choice'
import type { UsableApiKey } from '../model-api-keys'

const botId = '10000000-0000-4000-8000-000000000001', workspaceId = '10000000-0000-4000-8000-000000000002'
let selected: string | null | undefined, rows: BotSubscriptionChoice[] = [], keys: UsableApiKey[] = []
let key: { keyId: string; model: string } | undefined
let fallback: { key: UsableApiKey; model: string } | null = null
const scopes: Array<{ ownerId: string; workspaceId: string }> = []
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: { query: async (sql: string, args: unknown[]) => {
  assert.match(sql, /^SELECT /, 'readiness never writes a default or clones a binding')
  if (sql.includes("to_jsonb(u)->>'hostedModelEnabled'")) {
    assert.deepEqual(args, ['alice'])
    return { rows: [{ enabled: true }] }
  }
  assert.deepEqual(args, ['alice', workspaceId, botId])
  if (key) return { rows: [{ bindingId: null, apiKeyId: key.keyId, apiKeyModel: key.model }] }
  return { rows: selected === undefined ? [] : [{ bindingId: selected, apiKeyId: null, apiKeyModel: null }] }
} } } })
mock.module(new URL('../execution-settings.ts', import.meta.url).href, { namedExports: {
  executionWorkspace: async (owner: string, bot: string | null) => {
    if (owner !== 'alice' || bot !== botId) throw new ActionFailureError('botNotFound')
    return workspaceId
  },
  ExecutionSettings: class {
    async chatModels(scope: { ownerId: string; workspaceId: string }) { scopes.push(scope); return rows }
    async chatBinding(scope: { ownerId: string; workspaceId: string }, id: string) { scopes.push(scope); return rows.find(row => row.bindingId === id) }
    async pooledBindings() { return [] }
  },
} })
mock.module(new URL('../model-api-keys.ts', import.meta.url).href, { namedExports: {
  usableApiKeys: async () => keys,
} })
mock.module(new URL('../quota-fallback.ts', import.meta.url).href, { namedExports: { quotaFallbackKey: async () => fallback } })
// The existing core hosted ledger admits an unmetered community default;
// readiness must still reject that default when no provider is configured.
mock.module(new URL('../points-fallback.ts', import.meta.url).href, { namedExports: {
  hostedPointsRefusal: async () => null, pointsFallback: async () => null,
} })
let botModelReady: typeof import('./model-ready')['botModelReady']
before(async () => { process.env.MIKKA_EDITION = 'community'; ({ botModelReady } = await import('./model-ready')) })
beforeEach(() => { selected = undefined; rows = []; keys = []; key = undefined; fallback = null; scopes.length = 0 })
function subscription(provider = 'claude', used = 0.2, age = 0): BotSubscriptionChoice {
  return { bindingId: 'fixture-binding', connectionId: 'fixture-connection', ownerId: 'alice', provider,
    modelId: 'fixture-model', quota: { vendor: provider === 'codex' ? 'codex' : 'claude_code', source: 'official', status: 'ok', plan: null,
      observedAt: new Date(Date.now() - age).toISOString(), windows: [{ kind: 'five_hour', used, resetsAt: '2099-01-01T00:00:00.000Z' }] } }
}
const savedKey = { id: 'fixture-key', ownerId: 'alice', mine: true, provider: 'deepseek', name: 'Fixture', last4: 'test', baseUrl: null, protocol: 'openai', models: ['fixture-model'], modelsError: null, responsesApi: false } satisfies UsableApiKey

test('Claude and ChatGPT choices enable only their authorized bot without a server default', async () => {
  assert.equal(await botModelReady('alice', botId), false)
  for (const provider of ['claude', 'codex']) {
    rows = [subscription(provider)]; selected = rows[0].bindingId
    assert.equal(await botModelReady('alice', botId), true)
  }
  assert.ok(scopes.every(scope => scope.ownerId === 'alice' && scope.workspaceId === workspaceId))
  assert.equal(await botModelReady('other', botId), false)
  assert.equal(await botModelReady('alice', 'other-bot'), false)
})

test('an explicit default stays unavailable even with a connected subscription', async () => {
  rows = [subscription()]; selected = HOSTED_CHOICE
  assert.equal(await botModelReady('alice', botId), false)
  selected = null
  assert.equal(await botModelReady('alice', botId), false)
  selected = 'withdrawn-binding'; rows = []
  assert.equal(await botModelReady('alice', botId), false)
})

test('known exhausted allowance is blocked; stale allowance queues its normal execution check', async () => {
  rows = [subscription('claude', 1)]; selected = rows[0].bindingId
  assert.equal(await botModelReady('alice', botId), false)
  rows = [subscription('claude', 0.2, 120_000)]
  assert.equal(await botModelReady('alice', botId), true)
  rows = [subscription('claude', 1)]; fallback = { key: savedKey, model: 'fixture-model' }
  assert.equal(await botModelReady('alice', botId), true, 'only the previously configured quota fallback can run')
})

test('a selected usable API key works; an inaccessible or unsupported key does not enable chat', async () => {
  key = { keyId: savedKey.id, model: 'fixture-model' }; keys = [savedKey]
  assert.equal(await botModelReady('alice', botId), true)
  keys = []
  assert.equal(await botModelReady('alice', botId), false)
  keys = [{ ...savedKey, models: ['another-model'] }]
  assert.equal(await botModelReady('alice', botId), false)
})
