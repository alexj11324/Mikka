import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { agentRuns } from './db/schema'
import { remoteKey } from '@mikka/protocol/repository'

// Exercise the actual infrastructure-retry writer with controlled persistence.
// No PostgreSQL, credentials, models or network calls are used.
const botId = '28700000-0000-4000-8000-000000000011'
const lost = { id: '28700000-0000-4000-8000-000000000041', userId: 'synthetic-owner', botId,
  agentId: 'agent', deviceId: 'device', deviceRepoId: 'repository', issueId: 'issue',
  status: 'running', kind: 'implement', prompt: 'Already authorized task', baseBranch: 'main',
  attempt: 1, stopRequestedAt: null, leaseExpiresAt: new Date(0) }
let inserted: Record<string, unknown> | undefined
const events: { botId?: string | null }[] = [], revoked: string[] = []
const tx = {
  execute: async () => ({ rows: [] }),
  update(table: unknown) { assert.equal(table, agentRuns); return { set() { return { where() { return { returning: async () => [{ id: lost.id }] } } } } } },
  insert(table: unknown) { assert.equal(table, agentRuns); return { values: async (value: Record<string, unknown>) => { inserted = value } } },
}
const database = {
  execute: async () => ({ rows: [] }),
  select(fields?: Record<string, unknown>) {
    const selection = {
      from() { return selection }, where() { return selection }, innerJoin() { return selection },
      limit: async () => !fields ? [lost] : 'remoteUrl' in fields ? [{ remoteUrl: 'https://github.com/synthetic/fixture.git', repoPath: remoteKey('https://github.com/synthetic/fixture.git') }] : 'harness' in fields ? [{ harness: 'codex' }] : [],
      // A run only retries where a machine can take it: one online server with Codex (允许自动调度 on by default).
      orderBy: async () => [{ deviceId: 'other-device', harnesses: [{ harness: 'codex', installed: true }], deviceType: 'server', autoSchedule: null }],
    }
    return selection
  },
  transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
}
mock.module(new URL('./db/index.ts', import.meta.url).href, { exports: { db: database, pool: { query: () => { throw Error('Unexpected raw database query in per-owner retry fixture') } } } })
mock.module(new URL('./coordinator-event-store.ts', import.meta.url).href, { exports: {
  recordCoordinatorEvent: async (_tx: unknown, event: { botId?: string | null }) => { events.push(event) },
} })
mock.module(new URL('./coordinator/wake.ts', import.meta.url).href, { exports: { wakeCoordinator: () => { throw Error('Unexpected wake') } } })
mock.module(new URL('./mcp/worker.ts', import.meta.url).href, { exports: { revokeRunTokens: async (id: string) => { revoked.push(id) } } })
mock.module(new URL('./device-repositories.ts', import.meta.url).href, { exports: { ensureDeviceRepository: async () => ({ id: 'other-repository' }) } })

test('actual reclaim writer carries the trusted private Bot into a new attempt instead of falling back to default namespace', async () => {
  const { reclaimLostRuns } = await import('./run-leases')
  await reclaimLostRuns(lost.userId)
  assert.ok(inserted)
  assert.equal(inserted.botId, botId)
  assert.equal(inserted.userId, lost.userId)
  assert.equal(inserted.retryOf, lost.id)
  assert.equal(inserted.attempt, 2)
  assert.equal(inserted.status, 'queued')
  assert.equal(inserted.deviceId, 'other-device')
  assert.deepEqual(revoked, [lost.id])
  assert.equal(events[0].botId, botId)
})
