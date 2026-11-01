import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { agentRuns, agents, bots, devices } from './db/schema'
import { DEFAULT_AGENT_DEFINITION } from './agent-kit/builtin'
import { makeSnapshot } from './agent-kit/definition'
import { personalWorkerMailboxScopeMatches } from './personal-mailbox-capability'

// Real dispatch functions, controlled persistence. These tests never open a
// database or invoke a provider and do not prove FK/locking behavior.
const owner = 'synthetic-owner', botId = '28700000-0000-4000-8000-000000000011'
const workspaceId = '28700000-0000-4000-8000-000000000012', globalId = '00000000-0000-4000-8000-000000000001'
const agentId = '28700000-0000-4000-8000-000000000013', repoId = '28700000-0000-4000-8000-000000000014', issueId = '28700000-0000-4000-8000-000000000015'
const repoUrl = 'https://github.com/example/fixture.git'
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
mock.module(new URL('./db/index.ts', import.meta.url).href, { exports: { db: database, pool: { query: async () => ({ rows: [], rowCount: 0 }) }, withDatabaseClient: () => { throw Error('Factory transactions are outside the mailbox snapshot producer fixture') } } })
mock.module(new URL('./device-repositories.ts', import.meta.url).href, { exports: { ensureDeviceRepository: async (userId: string, deviceId: string, repo: string) => {
  assert.equal(userId, owner); assert.equal(deviceId, 'device'); assert.equal(repo, repoUrl)
  return { id: repoId, baseBranch: 'main' }
} } })
// This suite owns producer snapshots. Real admission/locking is tested separately against PostgreSQL.
mock.module(new URL('./run-admission-store.ts', import.meta.url).href, { exports: { acceptLocalRun: async (input: { id: string; definition: unknown }) => {
  inserted.push({ agentDefinition: input.definition }); return { runId: input.id }
} } })
mock.module(new URL('./issue-access.ts', import.meta.url).href, { exports: { requireUser: () => { throw Error('Unexpected user session lookup') }, issueForUser: async (id: string) => { assert.equal(id, owner); return { id: issueId, title: 'Fixture', content: null } } } })
mock.module(new URL('./subscription-repository.ts', import.meta.url).href, { exports: { SubscriptionRepository: class { async nativeBinding() { return { id: '28700000-0000-4000-8000-000000000018', modelId: 'fixture', route: 'codex_cli' } } } } })
const flags = ['MIKKA_PERSONAL_MAILBOX_ENABLED', 'MIKKA_BYOS_ENABLED', 'MIKKA_AGENT_KIT'] as const
const original = Object.fromEntries(flags.map(key => [key, process.env[key]]))
after(() => { for (const key of flags) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] })

test('actual personal producer freezes owned Bot workspace or explicit unbound scope and keeps flag-off old paths query-free', async () => {
  const { queueRun } = await import('./agent-runs')
  process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = '1'; delete process.env.MIKKA_BYOS_ENABLED
  for (const bot of [botId, null]) {
    await queueRun(owner, { issueId, agentId, repo: repoUrl }, bot, execution)
    assert.equal(personalWorkerMailboxScopeMatches('codex', inserted.at(-1)!.agentDefinition, { botId: bot, workspaceId: bot ? workspaceId : globalId }), true)
  }
  ownedBot = false
  const count = inserted.length
  await assert.rejects(queueRun(owner, { issueId, agentId, repo: repoUrl }, botId, execution), /runInvalid/)
  assert.equal(inserted.length, count)
  delete process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
  const lookups = botQueries
  await queueRun(owner, { issueId, agentId, repo: repoUrl }, botId, execution)
  assert.equal(botQueries, lookups)
  assert.equal((inserted.at(-1)!.agentDefinition as { mailbox?: unknown }).mailbox, undefined)
  ownedBot = true
})
test('actual cloud producer pins the existing host-authorized Bot/workspace without accepting payload namespace', async () => {
  const { queueCloudRun } = await import('./computer/queue-run')
  process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = '1'
  let snapshot: unknown
  const queries: string[] = []
  const client = { release() {}, async query(sql: string, params: unknown[] = []) {
    queries.push(sql)
    if (sql.startsWith('SELECT m."deviceId"')) {
      assert.deepEqual(params, [botId, owner, workspaceId, agentId, repoId])
      assert.ok(sql.includes('b."ownerId"=$2 AND b."workspaceId"=$3'))
      return { rows: [{ deviceId: 'device', harness: 'codex', instructions: 'Fixture', baseBranch: 'main' }] }
    }
    if (sql.startsWith('SELECT 1 FROM bots b JOIN agents')) return { rows: [{}], rowCount: 1 }
    if (sql.startsWith('INSERT INTO agent_runs')) snapshot = JSON.parse(params[9] as string)
    return { rows: [] }
  } }
  const untrusted = { workspaceId: 'forged-body-namespace' }
  await queueCloudRun({ connect: async () => client } as unknown as Parameters<typeof queueCloudRun>[0], { userId: owner, workspaceId },
    { botId, issueId, agentId, deviceRepoId: repoId, title: 'Fixture', body: '', execution, ...untrusted })
  assert.equal(personalWorkerMailboxScopeMatches('codex', snapshot, { botId, workspaceId }), true)
  assert.equal(queries.at(-1), 'COMMIT')
})
