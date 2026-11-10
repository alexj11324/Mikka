import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'
import type { UsableApiKey } from './model-api-keys'
import { ActionFailureError } from './action-error'
import type { ProjectExecutionSnapshot } from './project-resources/contracts'
import type { ProjectExecutionInput } from './project-resources/store'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const key = (n: number, models: string[], provider: UsableApiKey['provider'] = 'anthropic'): UsableApiKey => ({ id: id(n), ownerId: 'alice', mine: true, provider, name: null, last4: '1234', baseUrl: null, protocol: 'anthropic', responsesApi: true, models, modelsError: null })
const subscription = { id: id(9), ownerId: 'alice', connectionId: id(8), connectionRevision: 1, modelId: 'claude-sonnet-fixture' }
const repository = { repoPath: 'v2/github.com/fixture/credential-source', remoteUrl: 'https://github.com/fixture/credential-source.git', baseBranch: 'main' }
const projectSnapshot: ProjectExecutionSnapshot = { version: 1, workspaceId: id(2), projectId: null, projectRevision: null, policyRevision: 0, repositoryKey: repository.repoPath, baseBranch: repository.baseBranch, environment: null }
let projectLeaseActive = false, projectDenied = false
const requireFixtureProjectLease = (userId: string, workspaceId: string) => {
  assert.deepEqual([userId, workspaceId], ['alice', id(2)])
  if (!projectLeaseActive) throw new ActionFailureError('projectEnvironmentUnavailable')
}
mock.module(new URL('./project-resources/store.ts', import.meta.url).href, { namedExports: {
  withProjectExecution: async (input: ProjectExecutionInput, operation: (snapshot: ProjectExecutionSnapshot) => Promise<unknown>, requireExisting: boolean) => {
    assert.deepEqual(input, { userId: 'alice', workspaceId: id(2), issueId: id(20), repositoryKey: repository.repoPath, baseBranch: repository.baseBranch, runtime: 'cloud', harness: 'claude_code' })
    assert.equal(requireExisting, false)
    assert.equal(projectLeaseActive, false)
    if (projectDenied) throw new ActionFailureError('projectRepositoryDenied')
    projectLeaseActive = true
    try { return await operation(structuredClone(projectSnapshot)) } finally { projectLeaseActive = false }
  },
  requireProjectResourceLease: requireFixtureProjectLease,
  assertProjectExecutionTarget: (snapshot: ProjectExecutionSnapshot, target: Omit<ProjectExecutionInput, 'issueId' | 'baseBranch'>) => {
    requireFixtureProjectLease(target.userId, target.workspaceId)
    assert.deepEqual(target, { userId: 'alice', workspaceId: id(2), repositoryKey: repository.repoPath, runtime: 'cloud', harness: 'claude_code' })
    assert.deepEqual(snapshot, projectSnapshot)
  },
  assertFrozenProjectExecution: (frozen: ProjectExecutionSnapshot, admitted: ProjectExecutionSnapshot) => {
    requireFixtureProjectLease('alice', id(2))
    assert.deepEqual(frozen, projectSnapshot); assert.deepEqual(admitted, projectSnapshot)
  },
} })
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
  projectLeaseActive = false
  projectDenied = false
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

/** Real queue admission and credential selection; only storage reads/writes are replaced. */
function cloudQueueFixture() {
  const calls: { sql: string; args: unknown[] }[] = []
  let released = false
  const client = {
    release() { released = true },
    async query(sql: string, args: unknown[] = []) {
      calls.push({ sql, args })
      requireFixtureProjectLease(scope.ownerId, id(2))
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.startsWith('SELECT pg_advisory_xact_lock') || sql.startsWith('INSERT INTO ')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('SELECT m.')) {
        assert.deepEqual(args, [scope.botId, scope.ownerId, id(2), id(21), id(22)])
        assert.ok(sql.includes('b."ownerId"=$2 AND b."workspaceId"=$3') && sql.includes('FOR SHARE'))
        return { rows: [{ deviceId: id(23), instructions: '', harness: 'claude_code', baseBranch: repository.baseBranch }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "repoPath","remoteUrl" FROM device_repos')) {
        assert.deepEqual(args, [id(22), scope.ownerId, id(23)])
        assert.ok(sql.endsWith('FOR SHARE'))
        return { rows: [{ repoPath: repository.repoPath, remoteUrl: repository.remoteUrl }], rowCount: 1 }
      }
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
      { connect: async () => { requireFixtureProjectLease(scope.ownerId, id(2)); return client }, query: async (sql: string, args: unknown[]) => {
        calls.push({ sql, args })
        assert.equal(projectLeaseActive, false)
        assert.ok(sql.startsWith('SELECT repo."repoPath",repo."remoteUrl",a.harness,'))
        assert.ok(sql.includes('i."workspaceId"=$5') && sql.includes('i."ownershipState"=\'bound\'') && sql.includes('repo."userId"=$3'))
        assert.deepEqual(args, [id(22), id(21), scope.ownerId, id(20), id(2), null])
        return { rows: [{ ...repository, harness: 'claude_code' }], rowCount: 1 }
      } } as unknown as Pool,
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
  assert.deepEqual(await runCredentialSource(query, input), { subscription: null, apiKey: { keyId: other.id, model: subscription.modelId } }, 'the existing selector can fall back, so queue admission must enforce an explicit choice')
  const fixture = cloudQueueFixture()
  await assert.rejects(fixture.queue({ apiKeyId: selected.id }), { status: 409 })
  assert.equal(fixture.calls.some(call => call.sql.startsWith('INSERT INTO ')), false)
  assert.equal(fixture.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(fixture.released(), true)
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
  assert.deepEqual(frozen.projectExecution, projectSnapshot)
  assert.equal(projectLeaseActive, false)
  assert.equal(fixture.calls.at(-1)?.sql, 'COMMIT')
})

test('cloud queue cannot select credentials or write a Run after Project resource refusal', async () => {
  const fixture = cloudQueueFixture()
  projectDenied = true
  await assert.rejects(fixture.queue({ apiKeyId: id(4) }), { code: 'projectRepositoryDenied' })
  assert.equal(fixture.calls.length, 1, 'only the exact repository/Task preflight runs before resource admission')
  assert.equal(fixture.calls.some(call => call.sql === 'BEGIN' || call.sql.startsWith('INSERT INTO ')), false)
  assert.deepEqual(catalogReads, [])
  assert.equal(fixture.released(), false, 'a denied resource never checks out the APP write client')
  assert.equal(projectLeaseActive, false)
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
