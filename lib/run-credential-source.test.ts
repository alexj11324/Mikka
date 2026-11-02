import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'
import type { UsableApiKey } from './model-api-keys'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const key = (n: number, models: string[], provider: UsableApiKey['provider'] = 'anthropic'): UsableApiKey => ({ id: id(n), ownerId: 'alice', mine: true, provider, name: null, last4: '1234', baseUrl: null, protocol: 'anthropic', responsesApi: true, models, modelsError: null })
const subscription = { id: id(9), ownerId: 'alice', connectionId: id(8), connectionRevision: 1, modelId: 'claude-sonnet-fixture' }
let keys: UsableApiKey[], saved: { keyId: string; model: string; harnesses: string[] } | undefined
let quota: unknown, catalogOffers: boolean, sharedCatalogOffers: boolean, afterQuotaAllowed: boolean
const catalogReads: unknown[][] = []
const query = { query: async (sql: string, args: unknown[]) => {
  if (sql.startsWith('SELECT 1 FROM byos_connections')) { catalogReads.push(args); return { rowCount: (args[0] === 'bob' ? sharedCatalogOffers : catalogOffers) ? 1 : 0, rows: [] } }
  if (sql.startsWith('SELECT state,paused,epoch,quota')) return { rows: [{ state: 'connected', paused: false, epoch: '1', quota }] }
  throw new Error(`unexpected fixture query: ${sql}`)
} } as unknown as Pick<Pool, 'query'>
mock.module(new URL('./model-api-keys.ts', import.meta.url).href, { namedExports: {
  usableApiKeys: async () => keys, botApiKeyChoice: async () => saved, apiKeyAfterQuota: async () => afterQuotaAllowed,
} })
let runCredentialSource: typeof import('./run-credential-source')['runCredentialSource']
let quotaFallbackApiKey: typeof import('./run-credential-source')['quotaFallbackApiKey']
before(async () => { ({ runCredentialSource, quotaFallbackApiKey } = await import('./run-credential-source')) })
const scope = { ownerId: 'alice', botId: id(1), harness: 'claude_code', botWorkspaceId: id(2), choiceWorkspaceId: id(2) }
beforeEach(() => {
  keys = [key(3, ['deepseek-chat'], 'deepseek'), key(4, ['claude-sonnet-fixture'])]
  saved = { keyId: id(3), model: 'deepseek-chat', harnesses: ['claude_code', 'codex'] }
  quota = { vendor: 'claude_code', source: 'official', status: 'ok', plan: 'Max', windows: [{ kind: 'five_hour', used: 0.2, resetsAt: null }], observedAt: new Date().toISOString() }
  catalogOffers = true
  sharedCatalogOffers = true
  afterQuotaAllowed = true
  catalogReads.length = 0
})

for (const localLogin of [true, false]) {
  test(`${localLogin ? 'local' : 'cloud'}: an explicit subscription model survives the Bot chat's DeepSeek preference`, async () => {
    assert.deepEqual(await runCredentialSource(query, { ...scope, model: 'claude-sonnet-fixture', subscription, localLogin }), { subscription })
  })
  test(`${localLogin ? 'local' : 'cloud'}: an explicit different key is frozen with its requested model`, async () => {
    assert.deepEqual(await runCredentialSource(query, { ...scope, model: 'claude-sonnet-fixture', keyId: id(4), subscription, localLogin }), { subscription: null, apiKey: { keyId: id(4), model: 'claude-sonnet-fixture' } })
  })
}
test('a missing explicit model cannot turn into a key’s first model', async () => {
  assert.deepEqual(await runCredentialSource(query, { ...scope, model: 'missing-fixture', subscription: null }), { subscription: null })
})
test('quota fallback keeps the frozen model and ignores the Bot chat preference', async () => {
  assert.deepEqual(await quotaFallbackApiKey(query, { ...scope, model: 'claude-sonnet-fixture' }), { keyId: id(4), model: 'claude-sonnet-fixture' })
  assert.equal(await quotaFallbackApiKey(query, { ...scope, model: 'missing-fixture' }), undefined)
  assert.equal(await quotaFallbackApiKey(query, scope), undefined, 'an unknown actual model cannot authorize another model')
})
test('an exhausted Opus window does not send Sonnet to a paid key', async () => {
  quota = { ...(quota as object), windows: [{ kind: 'weekly', model: 'opus', used: 1, resetsAt: '2099-01-01T00:00:00.000Z' }, { kind: 'five_hour', used: 0.2, resetsAt: null }] }
  saved = undefined
  assert.deepEqual(await runCredentialSource(query, { ...scope, model: 'claude-sonnet-fixture', subscription }), { subscription })
})

test('Codex quota fallback requires Responses API support for the same model', async () => {
  keys = [{ ...key(5, ['gpt-fixture'], 'custom'), protocol: 'openai', responsesApi: false }, key(6, ['gpt-fixture'], 'openai')]
  assert.deepEqual(await quotaFallbackApiKey(query, { ...scope, harness: 'codex', model: 'gpt-fixture' }), { keyId: id(6), model: 'gpt-fixture' })
  keys.pop()
  assert.equal(await quotaFallbackApiKey(query, { ...scope, harness: 'codex', model: 'gpt-fixture' }), undefined)
})

for (const localLogin of [true, false]) test(`${localLogin ? 'local' : 'cloud'}: the actual shared subscription retains its supported model with quota fallback off`, async () => {
  catalogOffers = false
  afterQuotaAllowed = false
  const shared = { ...subscription, ownerId: 'bob' }
  assert.deepEqual(await runCredentialSource(query, { ...scope, model: shared.modelId, subscription: shared, localLogin }), { subscription: shared })
  assert.ok(catalogReads.some(args => args[0] === 'bob' && args[3] === shared.connectionId && args[4] === shared.connectionRevision), 'check the lender and exact connection revision')
})
test('an existing shared binding cannot claim a model outside its own catalogue', async () => {
  catalogOffers = true
  sharedCatalogOffers = false
  const shared = { ...subscription, ownerId: 'bob' }
  assert.deepEqual(await runCredentialSource(query, { ...scope, model: shared.modelId, subscription: shared }), { subscription: null, apiKey: { keyId: id(4), model: shared.modelId } })
})
test('an exhausted shared subscription respects disabled paid fallback', async () => {
  catalogOffers = false
  afterQuotaAllowed = false
  quota = { ...(quota as object), windows: [{ kind: 'five_hour', used: 1, resetsAt: '2099-01-01T00:00:00.000Z' }] }
  const shared = { ...subscription, ownerId: 'bob' }
  assert.deepEqual(await runCredentialSource(query, { ...scope, model: shared.modelId, subscription: shared }), { subscription: shared })
})
