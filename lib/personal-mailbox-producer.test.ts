import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { agentRuns, agents, bots, devices } from './db/schema'
import { DEFAULT_AGENT_DEFINITION } from './agent-kit/builtin'
import { makeSnapshot } from './agent-kit/definition'
import { personalWorkerMailboxScopeMatches } from './personal-mailbox-capability'
import { overrideDeploymentSwitch } from './deployment-switches'
import { ActionFailureError } from './action-error'
import type { ProjectExecutionSnapshot } from './project-resources/contracts'
import type { ProjectExecutionInput } from './project-resources/store'

// Real dispatch functions, controlled persistence. These tests never open a
// database or invoke a provider and do not prove FK/locking behavior.
const owner = 'synthetic-owner', botId = '28700000-0000-4000-8000-000000000011'
const workspaceId = '28700000-0000-4000-8000-000000000012'
const agentId = '28700000-0000-4000-8000-000000000013', repoId = '28700000-0000-4000-8000-000000000014', issueId = '28700000-0000-4000-8000-000000000015'
const connectionId = '28700000-0000-4000-8000-000000000019'
before(async () => {
  const workspaceModule = await import('./workspace-db')
  mock.module(new URL('./workspace-db.ts', import.meta.url).href, { namedExports: { ...workspaceModule, workspacePool: { query: async () => ({ rows: [{ userId: owner }] }) } } })
})

const repoUrl = 'https://github.com/example/fixture.git'
// The cloud producer uses the Bot's desktop repository; the separate local
// producer above uses its explicit remote URL. No GitHub push grant is mocked.
const cloudRepository = { repoPath: '/workspace', remoteUrl: null, baseBranch: 'main' }
const projectSnapshot: ProjectExecutionSnapshot = { version: 1, workspaceId, projectId: null, projectRevision: null, policyRevision: 0, repositoryKey: null, baseBranch: cloudRepository.baseBranch, environment: null }
let projectLeaseActive = false, projectDenied = false
const requireFixtureProjectLease = (userId: string, selectedWorkspace: string) => {
  assert.deepEqual([userId, selectedWorkspace], [owner, workspaceId])
  if (!projectLeaseActive) throw new ActionFailureError('projectEnvironmentUnavailable')
}
mock.module(new URL('./project-resources/store.ts', import.meta.url).href, { namedExports: {
  withProjectExecution: async (input: ProjectExecutionInput, operation: (snapshot: ProjectExecutionSnapshot) => Promise<unknown>, requireExisting: boolean) => {
    assert.deepEqual(input, { userId: owner, workspaceId, issueId, repositoryKey: null, baseBranch: 'main', runtime: 'cloud', harness: 'codex' })
    assert.equal(requireExisting, false)
    assert.equal(projectLeaseActive, false)
    if (projectDenied) throw new ActionFailureError('projectRepositoryDenied')
    projectLeaseActive = true
    try { return await operation(structuredClone(projectSnapshot)) } finally { projectLeaseActive = false }
  },
  requireProjectResourceLease: requireFixtureProjectLease,
  assertProjectExecutionTarget: (snapshot: ProjectExecutionSnapshot, target: Omit<ProjectExecutionInput, 'issueId' | 'baseBranch'>) => {
    requireFixtureProjectLease(target.userId, target.workspaceId)
    assert.deepEqual(target, { userId: owner, workspaceId, repositoryKey: null, runtime: 'cloud', harness: 'codex' })
    assert.deepEqual(snapshot, projectSnapshot)
  },
  assertFrozenProjectExecution: (frozen: ProjectExecutionSnapshot, admitted: ProjectExecutionSnapshot) => {
    requireFixtureProjectLease(owner, workspaceId)
    assert.deepEqual(frozen, projectSnapshot); assert.deepEqual(admitted, projectSnapshot)
  },
} })
const execution = { status: 'running' as const, id: '28700000-0000-4000-8000-000000000016', snapshot: makeSnapshot('28700000-0000-4000-8000-000000000017', 1, { ...DEFAULT_AGENT_DEFINITION, tools: ['mailbox_inbox'] }, 'HOST', { harness: 'ai_sdk', model: 'synthetic' }) }
let ownedBot = true, botQueries = 0
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
  let snapshot: unknown
  const queries: string[] = []
  const client = { release() {}, async query(sql: string, params: unknown[] = []) {
    queries.push(sql)
    requireFixtureProjectLease(owner, workspaceId)
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      assert.deepEqual(params, [`computer-policy:${workspaceId}`])
      return { rows: [] }
    }
    if (sql.startsWith('SELECT m."deviceId"')) {
      assert.deepEqual(params, [botId, owner, workspaceId, agentId, repoId])
      assert.ok(sql.includes('b."ownerId"=$2 AND b."workspaceId"=$3'))
      return { rows: [{ deviceId: 'device', harness: 'codex', instructions: 'Fixture', baseBranch: 'main' }] }
    }
    if (sql.startsWith('SELECT "repoPath","remoteUrl" FROM device_repos')) {
      assert.deepEqual(params, [repoId, owner, 'device'])
      assert.ok(sql.endsWith('FOR SHARE'))
      return { rows: [cloudRepository] }
    }
    if (sql === 'SELECT subscriptions FROM workspace_personal_policies WHERE "workspaceId"=$1') {
      assert.deepEqual(params, [workspaceId])
      return { rows: [] }
    }
    if (sql === `SELECT id,"ownerId",provider,name,"baseUrl",protocol,last4,models,"modelsError","responsesApi",to_jsonb(model_api_keys)->'modelSettings' AS "modelSettings" FROM model_api_keys WHERE "ownerId"=$1 ORDER BY "createdAt",id`) {
      assert.deepEqual(params, [owner])
      return { rows: [] }
    }
    if (sql === `SELECT k.id,k."ownerId",k.provider,k.name,k."baseUrl",k.protocol,k.last4,k.models,k."modelsError",k."responsesApi",to_jsonb(k)->'modelSettings' AS "modelSettings" FROM model_api_key_shares s JOIN model_api_keys k ON k.id=s."keyId"
    WHERE s."workspaceId"=$1 AND k."ownerId"<>$2 ORDER BY s."createdAt",k.id`) {
      assert.deepEqual(params, [workspaceId, owner])
      return { rows: [] }
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
    if (sql.startsWith('SELECT 1 FROM device_repos')) {
      assert.deepEqual(params, [repoId, owner])
      assert.ok(sql.includes('"repoPath" LIKE \'v2/github.com/%\''))
      return { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('INSERT INTO agent_runs')) {
      assert.deepEqual([params[1], params[2], params[3], params[5], params[8], params[12]], [owner, issueId, agentId, repoId, botId, workspaceId])
      snapshot = JSON.parse(params[9] as string)
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO computer_run_bindings')) { assert.deepEqual(params.slice(1), [botId, workspaceId, owner]); return { rows: [] } }
    if (sql.startsWith('INSERT INTO thread_machines')) { assert.deepEqual(params.slice(1, 4), [workspaceId, owner, botId]); return { rows: [] } }
    throw new Error(`Unexpected mailbox producer query: ${sql}`)
  } }
  const queuePool = { connect: async () => { requireFixtureProjectLease(owner, workspaceId); return client }, query: async (sql: string, params: unknown[]) => {
    queries.push(sql)
    assert.equal(projectLeaseActive, false)
    assert.ok(sql.startsWith('SELECT repo."repoPath",repo."remoteUrl",a.harness,'))
    assert.ok(sql.includes('i."workspaceId"=$5') && sql.includes('i."ownershipState"=\'bound\'') && sql.includes('repo."userId"=$3'))
    assert.deepEqual(params, [repoId, agentId, owner, issueId, workspaceId, null])
    return { rows: [{ ...cloudRepository, harness: 'codex' }] }
  } } as unknown as Parameters<typeof queueCloudRun>[0]
  const untrusted = { workspaceId: 'forged-body-namespace' }
  const input = { botId, issueId, agentId, deviceRepoId: repoId, title: 'Fixture', body: '', model: 'fixture', execution, ...untrusted }
  await queueCloudRun(queuePool, { userId: owner, workspaceId }, input)
  assert.equal(personalWorkerMailboxScopeMatches('codex', snapshot, { botId, workspaceId }), true)
  assert.deepEqual((snapshot as { projectExecution: ProjectExecutionSnapshot }).projectExecution, projectSnapshot)
  assert.equal(projectLeaseActive, false)
  assert.equal(queries.at(-1), 'COMMIT')
  const beforeRefusal = queries.length, beforeSnapshot = snapshot
  projectDenied = true
  try { await assert.rejects(queueCloudRun(queuePool, { userId: owner, workspaceId }, input), { code: 'projectRepositoryDenied' }) }
  finally { projectDenied = false }
  assert.equal(queries.length, beforeRefusal + 1, 'Project refusal permits only the authorized-namespace preflight, no APP write or identity freeze')
  assert.equal(snapshot, beforeSnapshot)
  assert.equal(projectLeaseActive, false)
})
