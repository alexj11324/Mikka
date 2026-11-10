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
mock.module(new URL('./computer/native-run-binding.ts', import.meta.url).href, { namedExports: {
  nativeRunBinding: async () => ({ ...subscription, workspaceId: id(2), consumerId: id(21), route: 'claude_code_cli' }),
} })
mock.module(new URL('./resource-access/creation-defaults.ts', import.meta.url).href, { namedExports: {
  // Resource-default preferences are covered by resource-access.db.test.ts.
  // These credential-selection cases explicitly start a private owner Thread.
  prepareNewThreadVisibility: async (_query: unknown, ownerId: string, workspaceId: string) => {
    assert.equal(ownerId, 'alice'); assert.equal(workspaceId, id(2))
    return 'private'
  },
} })
mock.module(new URL('./workspace-db.ts', import.meta.url).href, { namedExports: {
  // These source-selection cases have no Profile. Import the full storage
  // boundary, but fail if they unexpectedly start Workspace authorization.
  workspaceDb: {
    select: () => { throw new Error('Unexpected Workspace selection in credential-source fixture') },
    transaction: async () => { throw new Error('Unexpected Workspace transaction in credential-source fixture') },
  },
  workspacePool: { query: async (sql: string, args: unknown[]) => {
    if (sql.includes('from mikka_workspaces w')) {
      assert.match(sql, /^select w\.kind,l\."organizationId",p\."modelCredentialSharing",p\."mcpSharing",p\."allowedModelProviders"/)
      assert.match(sql.trim(), /where w\.id=\$1$/)
      assert.deepEqual(args, [id(2)])
      // This exact Team Workspace has no Organization. The production
      // resource-policy reader still runs; no unrelated query is authorized.
      return { rows: [{ kind: 'team', organizationId: null, modelCredentialSharing: null, mcpSharing: null, allowedModelProviders: null }], rowCount: 1 }
    }
    if (sql.startsWith("SELECT to_jsonb(p)->'modelPolicy'")) {
      assert.deepEqual(args, [id(2)]); return { rows: [], rowCount: 0 }
    }
    assert.match(sql, /FROM mikka_workspace_members/)
    assert.deepEqual(args, [id(2), ['alice']])
    return { rows: [{ userId: 'alice' }], rowCount: 1 }
  } },
} })
let runCredentialSource: typeof import('./run-credential-source')['runCredentialSource']
let quotaFallbackApiKey: typeof import('./run-credential-source')['quotaFallbackApiKey']
let queueCloudRun: typeof import('./computer/queue-run')['queueCloudRun']
before(async () => {
  ({ runCredentialSource, quotaFallbackApiKey } = await import('./run-credential-source'))
  ;({ queueCloudRun } = await import('./computer/queue-run'))
})
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

for (const localLogin of [true, false]) test(`${localLogin ? 'local' : 'cloud'}: a borrowed subscription is refused without reading its model or quota`, async () => {
  catalogOffers = false
  afterQuotaAllowed = false
  const shared = { ...subscription, ownerId: 'bob' }
  await assert.rejects(runCredentialSource(query, { ...scope, model: shared.modelId, subscription: shared, localLogin }), { code: 'executionAccountUnavailable' })
  assert.equal(catalogReads.length, 0)
})
test('an existing shared binding cannot claim a model outside its own catalogue', async () => {
  catalogOffers = true
  sharedCatalogOffers = false
  const shared = { ...subscription, ownerId: 'bob' }
  await assert.rejects(runCredentialSource(query, { ...scope, model: shared.modelId, subscription: shared }), { code: 'executionAccountUnavailable' })
  assert.equal(catalogReads.length, 0)
})
test('an exhausted shared subscription respects disabled paid fallback', async () => {
  catalogOffers = false
  afterQuotaAllowed = false
  quota = { ...(quota as object), windows: [{ kind: 'five_hour', used: 1, resetsAt: '2099-01-01T00:00:00.000Z' }] }
  const shared = { ...subscription, ownerId: 'bob' }
  await assert.rejects(runCredentialSource(query, { ...scope, model: shared.modelId, subscription: shared }), { code: 'executionAccountUnavailable' })
  assert.equal(catalogReads.length, 0)
})

/** Real queue admission and credential selection; only storage reads/writes are replaced. */
function cloudQueueFixture(taskAccess = true) {
  const calls: { sql: string; args: unknown[] }[] = []
  let released = false
  const client = {
    release() { released = true },
    async query(statement: string | { text: string }, args: unknown[] = []) {
      const sql = typeof statement === 'string' ? statement : statement.text
      calls.push({ sql, args })
      if (sql.startsWith('with recursive ancestry as (')) {
        assert.deepEqual(args.slice(0, 2), ['task', id(20)], 'only this fixture Task enters the ACL lock')
        if (sql.includes('select p.kind,p.id from resource_access_policies')) {
          assert.match(sql, /order by p\.kind,p\.id for share of p$/)
          return { rows: taskAccess ? [{ kind: 'task', id: id(20) }] : [], rowCount: taskAccess ? 1 : 0 }
        }
        assert.match(sql, /mikka_resource_acl_allowed\('account',/)
        assert.deepEqual(args.slice(2), ['alice', taskAccess ? [`task:${id(20)}`] : [],
          JSON.stringify([{ kind: 'task', id: id(20), workspaceId: id(2), action: 'canSteer', position: 0 }])])
        return { rows: taskAccess ? [{ allowed: true }] : [], rowCount: taskAccess ? 1 : 0 }
      }
      if (sql === 'SELECT mikka_resource_personal_resources_allowed($1,$2::uuid,$3) AS allowed') {
        assert.deepEqual(args, ['task', id(20), 'alice'])
        return { rows: [{ allowed: taskAccess }], rowCount: 1 }
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.startsWith('SELECT pg_advisory_xact_lock') || sql.startsWith('INSERT INTO ')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('SELECT m.')) return { rows: [{ deviceId: id(23), instructions: '', harness: 'claude_code', baseBranch: 'main' }], rowCount: 1 }
      // Keep real identity freezing in these queue tests: all resources belong
      // to the active requester, and only keys still in the fixture exist.
      if (sql.startsWith('SELECT "ownerId","workspaceId" FROM bots')) {
        assert.equal(args[0], scope.botId)
        return { rows: [{ ownerId: scope.ownerId, workspaceId: id(2) }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "ownerId",kind,enabled FROM devices')) {
        assert.equal(args[0], id(23))
        return { rows: [{ ownerId: scope.ownerId, kind: 'cloud', enabled: true }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT k."ownerId"')) {
        assert.equal(args[1], id(2))
        const selected = keys.find(key => key.id === args[0])
        return { rows: selected ? [{ ownerId: selected.ownerId, shared: false }] : [], rowCount: Number(Boolean(selected)) }
      }
      if (sql.startsWith('SELECT 1 FROM user_e2b_keys')) {
        assert.equal(args[0], scope.ownerId)
        return { rows: [{ present: true }], rowCount: 1 }
      }
      return query.query(sql, args)
    },
  }
  return {
    calls, released: () => released,
    queue: (selection: { apiKeyId?: string; subscriptionBindingId?: string }) => queueCloudRun(
      { connect: async () => client } as unknown as Pool,
      { userId: scope.ownerId, workspaceId: id(2) },
      { botId: scope.botId, issueId: id(20), agentId: id(21), deviceRepoId: id(22), title: 'Keep selected source', body: '', model: subscription.modelId, readOnly: true, ...selection },
    ),
  }
}

test('cloud queue rejects a selected key removed after preflight instead of freezing another key for that model', async () => {
  const selected = key(5, [subscription.modelId]), other = key(6, [subscription.modelId])
  keys = [other, selected]
  catalogOffers = false
  const input = { ...scope, model: subscription.modelId, keyId: selected.id, subscription }
  assert.deepEqual(await runCredentialSource(query, input), { subscription: null, apiKey: { keyId: selected.id, model: subscription.modelId } })
  // The selected key is withdrawn while the provider is waking the computer.
  keys = [other]
  await assert.rejects(runCredentialSource(query, input), { code: 'executionModelUnknown' })
  const fixture = cloudQueueFixture()
  await assert.rejects(fixture.queue({ apiKeyId: selected.id }), { code: 'executionModelUnknown' })
  assert.equal(fixture.calls.some(call => call.sql.startsWith('INSERT INTO ')), false)
  assert.equal(fixture.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(fixture.released(), true)
})

test('a credential selection cannot authorize a Task missing from its exact ACL scope', async () => {
  const fixture = cloudQueueFixture(false)
  await assert.rejects(fixture.queue({ apiKeyId: id(4) }), { code: 'issueNotFound' })
  assert.equal(fixture.calls.some(call => call.sql.startsWith('SELECT k.') || call.sql.startsWith('INSERT INTO ')), false)
  assert.equal(fixture.calls.at(-1)?.sql, 'ROLLBACK')
})

test('cloud queue freezes the explicitly selected key when another key also offers the model', async () => {
  const selected = key(5, [subscription.modelId])
  keys = [key(6, [subscription.modelId]), selected]
  const fixture = cloudQueueFixture()
  await fixture.queue({ apiKeyId: selected.id })
  const inserted = fixture.calls.find(call => call.sql.startsWith('INSERT INTO agent_runs'))!
  const frozen = JSON.parse(inserted.args[9] as string)
  assert.deepEqual(frozen.apiKey, { keyId: selected.id, model: subscription.modelId })
  assert.equal(frozen.executionIdentity.billingAccount.model.resourceId, selected.id)
  assert.equal(frozen.subscription, undefined)
  assert.equal(fixture.calls.at(-1)?.sql, 'COMMIT')
})

test('cloud queue still permits an explicitly selected subscription to use its authorized quota fallback', async () => {
  quota = { ...(quota as object), windows: [{ kind: 'five_hour', used: 1, resetsAt: '2099-01-01T00:00:00.000Z' }] }
  const fixture = cloudQueueFixture()
  await fixture.queue({ subscriptionBindingId: subscription.id })
  const inserted = fixture.calls.find(call => call.sql.startsWith('INSERT INTO agent_runs'))!
  const frozen = JSON.parse(inserted.args[9] as string)
  assert.deepEqual(frozen.apiKey, { keyId: id(4), model: subscription.modelId })
  assert.equal(frozen.executionIdentity.billingAccount.model.resourceId, id(4))
  assert.equal(frozen.subscription, undefined)
  assert.equal(fixture.calls.at(-1)?.sql, 'COMMIT')
})
