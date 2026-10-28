import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { agentRuns, agents, bots, devices, repositorySettings, runPublications, taskRequestBindings } from './db/schema'
import { DEFAULT_AGENT_DEFINITION } from './agent-kit/builtin'
import { makeSnapshot } from './agent-kit/definition'
import { personalWorkerMailboxScopeMatches } from './personal-mailbox-capability'

// Real dispatch functions, controlled persistence. These tests never open a
// database or invoke a provider and do not prove FK/locking behavior.
const owner = 'synthetic-owner', botId = '28700000-0000-4000-8000-000000000011'
const workspaceId = '28700000-0000-4000-8000-000000000012', globalId = '00000000-0000-4000-8000-000000000001'
const agentId = '28700000-0000-4000-8000-000000000013', repoId = '28700000-0000-4000-8000-000000000014', issueId = '28700000-0000-4000-8000-000000000015', deviceId = '28700000-0000-4000-8000-000000000019'
const execution = { status: 'running' as const, id: '28700000-0000-4000-8000-000000000016', snapshot: makeSnapshot('28700000-0000-4000-8000-000000000017', 1, { ...DEFAULT_AGENT_DEFINITION, tools: ['mailbox_inbox'] }, 'HOST', { harness: 'ai_sdk', model: 'synthetic' }) }
let ownedBot = true, botQueries = 0
const inserted: Record<string, unknown>[] = []
const database = {
  select() {
    let table: unknown
    const rows = () => {
      if (table === agents) return [{ id: agentId, deviceId, harness: 'codex', instructions: 'Fixture' }]
      if (table === devices) return [{ id: deviceId, enabled: true, harnesses: [{ harness: 'codex', installed: true }] }]
      if (table === taskRequestBindings || table === runPublications) return []
      if (table === repositorySettings) return [{ push: { approved: true, remote: 'origin', approvedByUserId: owner, approvedAt: '2026-10-28T00:00:00.000Z' } }]
      assert.equal(table, bots); botQueries++; return ownedBot ? [{ workspaceId }] : []
    }
    const query = { from(value: unknown) { table = value; return query }, where() { return query }, orderBy() { return query }, async limit() { return rows() } }; return query
  },
  insert(table: unknown) { return { async values(row: Record<string, unknown>) { if (table === agentRuns) inserted.push(row) } } },
  async execute() {},
  async transaction(fn: (tx: unknown) => Promise<unknown>) { return fn(database) },
}
mock.module(new URL('./db/index.ts', import.meta.url).href, { exports: { db: database, pool: {} } })
mock.module(new URL('./issue-access.ts', import.meta.url).href, { exports: { requireUser: () => { throw Error('Unexpected user session lookup') }, issueForUser: async (id: string) => { assert.equal(id, owner); return { id: issueId, userId: owner, scope: 'personal', title: 'Fixture', content: { type: 'doc', content: [] } } } } })
mock.module(new URL('./device-repositories.ts', import.meta.url).href, { exports: { ensureDeviceRepository: async () => ({ id: repoId, baseBranch: 'main', repoPath: 'v2/github.com/owner/repo', remoteUrl: 'https://github.com/owner/repo.git' }) } })
mock.module(new URL('./task-identifier-server.ts', import.meta.url).href, { exports: { taskIdentifiers: async () => new Map([[issueId, 'MIK-1']]) } })
mock.module(new URL('./subscription-repository.ts', import.meta.url).href, { exports: { SubscriptionRepository: class { async nativeBinding() { return { id: '28700000-0000-4000-8000-000000000018', modelId: 'fixture', route: 'codex_cli' } } } } })
const flags = ['MIKKA_PERSONAL_MAILBOX_ENABLED', 'MIKKA_BYOS_ENABLED', 'MIKKA_AGENT_KIT'] as const
const original = Object.fromEntries(flags.map(key => [key, process.env[key]]))
after(() => { for (const key of flags) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] })

test('actual personal producer freezes owned Bot workspace or explicit unbound scope and keeps flag-off old paths query-free', async () => {
  const { queueRun } = await import('./agent-runs')
  process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = '1'; delete process.env.MIKKA_BYOS_ENABLED
  for (const bot of [botId, null]) {
    await queueRun(owner, { issueId, agentId, repo: 'owner/repo' }, bot, execution)
    assert.equal(personalWorkerMailboxScopeMatches('codex', inserted.at(-1)!.agentDefinition, { botId: bot, workspaceId: bot ? workspaceId : globalId }), true)
  }
  ownedBot = false
  const count = inserted.length
  await assert.rejects(queueRun(owner, { issueId, agentId, repo: 'owner/repo' }, botId, execution), /runInvalid/)
  assert.equal(inserted.length, count)
  delete process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
  const lookups = botQueries
  await queueRun(owner, { issueId, agentId, repo: 'owner/repo' }, botId, execution)
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
    if (sql.startsWith('INSERT INTO agent_runs')) snapshot = JSON.parse(params[9] as string)
    return { rows: [] }
  } }
  const untrusted = { workspaceId: 'forged-body-namespace' }
  await queueCloudRun({ connect: async () => client } as unknown as Parameters<typeof queueCloudRun>[0], { userId: owner, workspaceId },
    { botId, issueId, agentId, deviceRepoId: repoId, title: 'Fixture', body: '', execution, ...untrusted })
  assert.equal(personalWorkerMailboxScopeMatches('codex', snapshot, { botId, workspaceId }), true)
  assert.equal(queries.at(-1), 'COMMIT')
})
