import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { agentRuns, agents, bots, devices } from './db/schema'
import { DEFAULT_AGENT_DEFINITION } from './agent-kit/builtin'
import { makeSnapshot } from './agent-kit/definition'
import { personalWorkerMailboxScopeMatches } from './personal-mailbox-capability'
import { overrideDeploymentSwitch } from './deployment-switches'

// Real dispatch functions, controlled persistence. These tests never open a
// database or invoke a provider and do not prove FK/locking behavior.
const owner = 'synthetic-owner', botId = '28700000-0000-4000-8000-000000000011'
const workspaceId = '28700000-0000-4000-8000-000000000012'
const agentId = '28700000-0000-4000-8000-000000000013', repoId = '28700000-0000-4000-8000-000000000014', issueId = '28700000-0000-4000-8000-000000000015'
const connectionId = '28700000-0000-4000-8000-000000000019'
before(async () => {
  const workspaceModule = await import('./workspace-db')
  mock.module(new URL('./workspace-db.ts', import.meta.url).href, { namedExports: { ...workspaceModule, workspacePool: { query: async (sql: string) => ({ rows: sql.includes('FROM mikka_workspace_members') ? [{ userId: owner }] : sql.includes('from mikka_workspaces') ? [{ kind: 'team', organizationId: null }] : [] }) } } })
})

const repoUrl = 'https://github.com/example/fixture.git'
const execution = { status: 'running' as const, id: '28700000-0000-4000-8000-000000000016', snapshot: makeSnapshot('28700000-0000-4000-8000-000000000017', 1, { ...DEFAULT_AGENT_DEFINITION, tools: ['mailbox_inbox'] }, 'HOST', { harness: 'ai_sdk', model: 'synthetic' }) }
let ownedBot = true, botQueries = 0
let personalContext = true
mock.module(new URL('./run-context-admission.ts', import.meta.url).href, { namedExports: {
  lockRunContextAdmission: async (_query: unknown, input: { ownerId: string; workspaceId: string; issueId: string }) => {
    assert.deepEqual([input.ownerId, input.workspaceId, input.issueId], [owner, workspaceId, issueId]); return personalContext
  },
} })
const inserted: Record<string, unknown>[] = []
const database = {
  select() {
    let table: unknown
    const query = { from(value: unknown) { table = value; return query }, where() { return query }, async limit() {
      if (table === agents) return [{ id: agentId, deviceId: 'device', harness: 'codex', instructions: 'Fixture' }]
      if (table === devices) return [{ enabled: true, harnesses: [{ harness: 'codex', installed: true }] }]
      assert.equal(table, bots); botQueries++; return ownedBot ? [{ workspaceId }] : []
    } }; return query
  },
  insert(table: unknown) { assert.equal(table, agentRuns); return { async values(row: Record<string, unknown>) { inserted.push(row) } } },
}
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db: database, pool: { query: async (sql: string, params: unknown[] = []) => {
  if (sql.startsWith('SELECT "workspaceId" FROM bots')) {
    assert.deepEqual(params, [botId, owner]); assert.ok(sql.includes('"ownerId"=$2'))
    return { rows: ownedBot ? [{ workspaceId }] : [], rowCount: ownedBot ? 1 : 0 }
  }
  return { rows: [], rowCount: 0 }
} }, withDatabaseClient: () => { throw Error('Factory transactions are outside the mailbox snapshot producer fixture') } } })
mock.module(new URL('./device-repositories.ts', import.meta.url).href, { namedExports: { ensureDeviceRepository: async (userId: string, deviceId: string, repo: string) => {
  assert.equal(userId, owner); assert.equal(deviceId, 'device'); assert.equal(repo, repoUrl)
  return { id: repoId, baseBranch: 'main' }
} } })
// This suite owns producer snapshots. Real admission/locking is tested separately against PostgreSQL.
mock.module(new URL('./run-admission-store.ts', import.meta.url).href, { namedExports: { acceptLocalRun: async (input: { id: string; definition: unknown }) => {
  inserted.push({ agentDefinition: input.definition }); return { runId: input.id }
} } })
mock.module(new URL('./issue-access.ts', import.meta.url).href, { namedExports: { requireUser: () => { throw Error('Unexpected user session lookup') }, issueForUser: async (id: string) => { assert.equal(id, owner); return { id: issueId, workspaceId, ownershipState: 'bound', title: 'Fixture', content: null } } } })
mock.module(new URL('./subscription-repository.ts', import.meta.url).href, { namedExports: { SubscriptionRepository: class {
  async nativeBinding(userId: string, consumerId: string, harness: string, _bindingId?: string, namespace?: string) {
    assert.deepEqual([userId, consumerId, harness, namespace], [owner, agentId, 'codex', workspaceId])
    return { id: '28700000-0000-4000-8000-000000000018', ownerId: owner, consumerId: agentId, workspaceId, connectionId, connectionRevision: 1, modelId: 'fixture', route: 'codex_cli' }
  }
} } })
const flags = ['MIKKA_BYOS_ENABLED', 'MIKKA_AGENT_KIT'] as const
const original = Object.fromEntries(flags.map(key => [key, process.env[key]]))
after(() => { overrideDeploymentSwitch('personalMailbox', undefined); for (const key of flags) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] })

test('actual personal producer freezes the task workspace with or without a Bot and keeps mailbox-off namespace reads query-free', async () => {
  const { queueRun } = await import('./agent-runs')
  overrideDeploymentSwitch('personalMailbox', undefined); delete process.env.MIKKA_BYOS_ENABLED
  for (const bot of [botId, null]) {
    await queueRun(owner, { issueId, agentId, repo: repoUrl, model: 'fixture' }, bot, execution)
    assert.equal(personalWorkerMailboxScopeMatches('codex', inserted.at(-1)!.agentDefinition, { botId: bot, workspaceId }), true)
  }
  ownedBot = false
  const count = inserted.length
  await assert.rejects(queueRun(owner, { issueId, agentId, repo: repoUrl, model: 'fixture' }, botId, execution), { code: 'botNotFound' })
  assert.equal(inserted.length, count)
  overrideDeploymentSwitch('personalMailbox', false)
  // Identity authorization still applies with the mailbox off; only the
  // mailbox namespace projection is skipped.
  ownedBot = true
  const lookups = botQueries
  await queueRun(owner, { issueId, agentId, repo: repoUrl, model: 'fixture' }, botId, execution)
  assert.equal(botQueries, lookups)
  assert.equal((inserted.at(-1)!.agentDefinition as { mailbox?: unknown }).mailbox, undefined)
  ownedBot = true
})
test('actual cloud producer pins the existing host-authorized Bot/workspace without accepting payload namespace', async () => {
  const { queueCloudRun } = await import('./computer/queue-run')
  overrideDeploymentSwitch('personalMailbox', true)
  let snapshot: unknown, insertedPrompt: unknown
  const queries: string[] = []
  const client = { release() {}, async query(sql: string, params: unknown[] = []) {
    queries.push(sql)
    if (sql.startsWith('SELECT m."deviceId"')) {
      assert.deepEqual(params, [botId, owner, workspaceId, agentId, repoId])
      assert.ok(sql.includes('b."ownerId"=$2 AND b."workspaceId"=$3'))
      return { rows: [{ deviceId: 'device', harness: 'codex', instructions: 'PRIVATE_AGENT_INSTRUCTIONS_CANARY', baseBranch: 'main' }] }
    }
    if (sql.startsWith('SELECT "ownerId","workspaceId" FROM bots')) return { rows: [{ ownerId: owner, workspaceId }] }
    if (sql.startsWith('SELECT "ownerId",kind,enabled FROM devices')) return { rows: [{ ownerId: owner, kind: 'cloud', enabled: true }] }
    if (sql.startsWith('SELECT b."ownerId",b."workspaceId"')) return { rows: [{ ownerId: owner, workspaceId, revision: '1', modelId: 'fixture', route: 'codex_cli', shared: false }] }
    if (sql.startsWith('SELECT 1 FROM user_e2b_keys')) return { rows: [{}] }
    if (sql.startsWith('SELECT 1 FROM byos_connections c')) {
      assert.deepEqual(params, [connectionId, owner, 1, 'codex'])
      assert.ok(sql.includes('c."ownerId"=$2') && sql.includes('c.epoch=$3'))
      return { rows: [{}], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO agent_runs')) { snapshot = JSON.parse(params[9] as string); insertedPrompt = params[7] }
    return { rows: [] }
  } }
  const untrusted = { workspaceId: 'forged-body-namespace' }
  await queueCloudRun({ connect: async () => client } as unknown as Parameters<typeof queueCloudRun>[0], { userId: owner, workspaceId },
    { botId, issueId, agentId, deviceRepoId: repoId, title: 'Fixture', body: '', model: 'fixture', execution, ...untrusted })
  assert.equal(personalWorkerMailboxScopeMatches('codex', snapshot, { botId, workspaceId }), true)
  assert.equal(queries.at(-1), 'COMMIT')
  personalContext = false
  try {
    await queueCloudRun({ connect: async () => client } as unknown as Parameters<typeof queueCloudRun>[0], { userId: owner, workspaceId },
      { botId, issueId, agentId, deviceRepoId: repoId, title: 'Shared request', body: 'Shared task body', model: 'fixture', execution })
    const shared = snapshot as import('./agent-kit/worker').WorkerDefinitionSnapshot
    assert.equal(shared.contextIsolation, 'shared_clean'); assert.equal(shared.instructions, ''); assert.equal(shared.parent, null)
    assert.equal(shared.mailbox, undefined); assert.equal(shared.customMcp, undefined)
    assert.equal(shared.executionIdentity?.actor, owner); assert.equal(shared.executionIdentity?.credentialOwner, owner)
    assert.equal(shared.subscription?.modelId, 'fixture', 'an Owner keeps their legitimate direct native subscription')
    assert.ok(!JSON.stringify([shared, insertedPrompt]).includes('PRIVATE_AGENT_INSTRUCTIONS_CANARY'))
    assert.ok(typeof insertedPrompt === 'string' && insertedPrompt.includes('Shared task body'))
    assert.equal(queries.at(-1), 'COMMIT')
    const count = queries.filter(query => query.startsWith('INSERT INTO agent_runs')).length
    await assert.rejects(queueCloudRun({ connect: async () => client } as unknown as Parameters<typeof queueCloudRun>[0], { userId: owner, workspaceId },
      { botId, issueId, agentId, deviceRepoId: repoId, title: 'Shared request', body: '', model: 'fixture', agentProfile: { profileId: 'private-profile', instructions: 'PRIVATE_PROFILE_CANARY' } as never }), /private_context_authorization_required/)
    assert.equal(queries.filter(query => query.startsWith('INSERT INTO agent_runs')).length, count)
    assert.equal(queries.at(-1), 'ROLLBACK')
  } finally { personalContext = true }
})
