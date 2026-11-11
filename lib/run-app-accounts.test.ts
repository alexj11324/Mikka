import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
const scope = { userId: 'owner', botId: 'owned-bot', runId: 'owned-run', toolkit: 'hubspot' }
const initialTool = { slug: 'HUBSPOT_LIST_CONTACTS', name: 'List contacts', version: 'fixture-v1', tags: ['readOnlyHint'], toolkit: { slug: 'hubspot' },
  inputParameters: { type: 'object', properties: { account_id: { type: 'string' } } as Record<string, { type: string }>, additionalProperties: false } }
const accounts = [
  { id: 'first', userId: 'owner', toolkit: { slug: 'hubspot' }, status: 'ACTIVE', isDisabled: false, createdAt: '2026-01-01' },
  { id: 'second', userId: 'owner', toolkit: { slug: 'hubspot' }, status: 'ACTIVE', isDisabled: false, createdAt: '2026-02-01' },
  { id: 'foreign', userId: 'other-owner', toolkit: { slug: 'hubspot' }, status: 'ACTIVE', isDisabled: false, createdAt: '2026-03-01' },
]
let chosen: string | null, rows = structuredClone(accounts), definition = structuredClone(initialTool), allowed = true, live = true, disableDuringDecision = false
const sent: { connectedAccountId?: string; arguments: Record<string, unknown> }[] = [], owners: string[] = [], authorityChecks: unknown[][] = []
const client = {
  connectedAccounts: { list: async (query: { userIds: string[] }) => { owners.push(query.userIds[0]); return { items: rows.filter(row => query.userIds.includes(row.userId)) } } },
  tools: { getRawComposioTools: async () => [definition], getRawComposioToolBySlug: async () => definition,
    execute: async (_slug: string, call: typeof sent[number]) => { sent.push(call); return { successful: true, data: { id: 'contact' } } } },
}
stub('./composio.ts', { getComposio: () => client })
stub('./composio-account-store.ts', { chosenComposioDefault: async () => chosen })
stub('./db/index.ts', { db: {}, pool: {} })
stub('./execution-identity.ts', { activeExecutionIdentity: async (...args: unknown[]) => { authorityChecks.push(args); if (!live) throw Error('revoked'); return { workspaceId: 'owned-workspace' } } })
stub('./operations/write-judgment.ts', { serverWriteJudge: () => async () => { throw Error('No model call in this fixture') } })
stub('./operations/write-setting-layers.ts', { readWriteSettingLayers: async () => {
  if (disableDuringDecision) rows.find(row => row.id === 'second')!.isDisabled = true
  return { workspace: { hubspot: 'allow' } }
} })
stub('./pending-action-store.ts', { proposeAppToolCall: async () => { throw Error('No write in this fixture') } })
stub('./app-policy/store.ts', { botMayUseApp: async () => allowed })
stub('./plugins/catalog.ts', { composioToolkitLister: () => async () => ({ items: [] }), isNoAuthToolkit: async () => false })
const { runAppEntry } = await import('./app-tools-server')
const entry = () => runAppEntry(scope)!
beforeEach(() => { chosen = 'first'; rows = structuredClone(accounts); definition = structuredClone(initialTool); allowed = live = true; disableDuringDecision = false; sent.length = owners.length = authorityChecks.length = 0 })

test('a native tool can explicitly use the second authorized account instead of its default', async () => {
  const current = entry(), listed = await current.list()
  assert.ok(Object.hasOwn(listed[0].inputSchema.properties, 'mikka_account_id'))
  const metadata = (listed[0].inputSchema.properties.mikka_account_id as { description: string }).description
  assert.match(metadata, /"id":"second"/)
  assert.match(metadata, /Current default\/sole account: "first"/)
  assert.doesNotMatch(metadata, /foreign|other-owner/)
  assert.deepEqual(await current.call(definition.slug, { mikka_account_id: 'second', account_id: 'provider-business-id' }), { data: { id: 'contact' } })
  assert.equal(sent[0].connectedAccountId, 'second')
  assert.deepEqual(sent[0].arguments, { account_id: 'provider-business-id' })
  assert.ok(owners.every(owner => owner === scope.userId))
  assert.deepEqual(authorityChecks.map(call => call.slice(1)), [[scope.runId, scope.userId]])
})

test('an explicit second account works without a default; ambiguous omission only returns owned choices', async () => {
  chosen = null
  const current = entry(), missing = await current.call(definition.slug, {}) as { error: string; accounts: { id: string }[] }
  assert.equal(missing.error, 'integrationAccountSelectionRequired')
  assert.deepEqual(missing.accounts.map(row => row.id), ['first', 'second'])
  assert.equal(sent.length, 0)
  await current.call(definition.slug, { mikka_account_id: 'second' })
  assert.equal(sent[0].connectedAccountId, 'second')
})

test('foreign, unknown, disabled and malformed account selectors never fall back to the default', async () => {
  rows.find(row => row.id === 'second')!.isDisabled = true
  for (const selector of ['foreign', 'missing', 'second', '', 42]) {
    const result = await entry().call(definition.slug, { mikka_account_id: selector }) as { error: string }
    assert.ok(['integrationAccountSelectionRequired', 'invalidIntegrationInput'].includes(result.error))
  }
  assert.equal(sent.length, 0)
})

test('omitting the metadata preserves the existing chosen default', async () => {
  await entry().call(definition.slug, { account_id: 'business-record' })
  assert.equal(sent[0].connectedAccountId, 'first')
  assert.deepEqual(sent[0].arguments, { account_id: 'business-record' })
})

test('native selection preserves current workspace permission and run authority checks', async () => {
  allowed = false
  assert.deepEqual(await entry().call(definition.slug, { mikka_account_id: 'second' }), { error: 'integrationBlockedByWorkspace' })
  allowed = true; live = false
  assert.deepEqual(await entry().call(definition.slug, { mikka_account_id: 'second' }), { error: 'integrationActionFailed' })
  assert.equal(sent.length, 0)
})

test('an account disabled after selection is revalidated at use without switching to the default', async () => {
  disableDuringDecision = true
  assert.deepEqual(await entry().call(definition.slug, { mikka_account_id: 'second' }), { error: 'integrationActionFailed' })
  assert.equal(sent.length, 0)
})

test('a provider field colliding with native metadata remains in business arguments inside the explicit envelope', async () => {
  definition.inputParameters.properties = { mikka_account_id: { type: 'string' } }
  const current = entry(), listed = await current.list()
  assert.deepEqual(listed[0].inputSchema.properties.arguments, definition.inputParameters)
  await current.call(definition.slug, { mikka_account_id: 'second', arguments: { mikka_account_id: 'business-record' } })
  assert.equal(sent[0].connectedAccountId, 'second')
  assert.deepEqual(sent[0].arguments, { mikka_account_id: 'business-record' })
})
