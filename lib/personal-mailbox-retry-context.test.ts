import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { agentRuns } from './db/schema'
import { remoteKey } from '@mikka/protocol/repository'

// Exercise the actual infrastructure-retry writer with controlled persistence.
// No PostgreSQL, credentials, models or network calls are used.
const botId = '28700000-0000-4000-8000-000000000011'
const now = new Date('2026-11-06T00:00:00.000Z')
let observedAt = now.getTime()
let scenario: 'retry' | 'queued' = 'retry'
const lost = { id: '28700000-0000-4000-8000-000000000041', userId: 'synthetic-owner', botId,
  agentId: 'agent', deviceId: 'device', deviceRepoId: 'repository', issueId: 'issue',
  status: 'running', kind: 'implement', prompt: 'Already authorized task', baseBranch: 'main',
  attempt: 1, stopRequestedAt: null, leaseExpiresAt: new Date(0) }
let inserted: Record<string, unknown> | undefined
let transactions = 0
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
      limit: async () => {
        if (!fields) return scenario === 'retry' ? [lost] : []
        if ('run' in fields && scenario === 'queued') {
          await Promise.resolve()
          observedAt = now.getTime() + 20
          return [{ run: { ...lost, status: 'queued', retryOf: 'previous-attempt' }, lastSeenAt: new Date(observedAt) }]
        }
        return 'remoteUrl' in fields ? [{ remoteUrl: 'https://github.com/synthetic/fixture.git', repoPath: remoteKey('https://github.com/synthetic/fixture.git') }] : 'harness' in fields ? [{ harness: 'codex' }] : []
      },
      // A run only retries where a machine can take it: one online server with Codex (允许自动调度 on by default).
      orderBy: async () => {
        assert.equal(scenario, 'retry', 'a device that heartbeats during the read must keep its queued run')
        await Promise.resolve()
        observedAt = now.getTime() + 20
        return [{ deviceId: 'other-device', lastSeenAt: new Date(observedAt), harnesses: [{ harness: 'codex', installed: true }], deviceType: 'server', autoSchedule: null }]
      },
    }
    return selection
  },
  transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => { transactions++; return fn(tx) },
}
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db: database, pool: { query: () => { throw Error('Unexpected raw database query in per-owner retry fixture') } } } })
mock.module(new URL('./coordinator-event-store.ts', import.meta.url).href, { namedExports: {
  recordCoordinatorEvent: async (_tx: unknown, event: { botId?: string | null }) => { events.push(event) },
} })
mock.module(new URL('./coordinator/wake.ts', import.meta.url).href, { namedExports: { wakeCoordinator: () => { throw Error('Unexpected wake') } } })
mock.module(new URL('./mcp/worker.ts', import.meta.url).href, { namedExports: { revokeRunTokens: async (id: string) => { revoked.push(id) } } })
mock.module(new URL('./device-repositories.ts', import.meta.url).href, { namedExports: { ensureDeviceRepository: async () => ({ id: 'other-repository' }) } })
// This fixture covers the legacy private-mailbox writer. Admitted repository
// recovery has real database coverage and must never run for this legacy row.
const readmit = mock.fn(async () => { throw Error('Unexpected repository admission for legacy mailbox retry') })
mock.module(new URL('./run-repository-retry.ts', import.meta.url).href, { namedExports: { readmitLostLocalRun: readmit } })
const recoveryHandoff = mock.fn(async (_pool: unknown, identity: unknown, prompt: string) => {
  assert.equal(identity, lost)
  return { prompt, briefing: '' }
})
mock.module(new URL('./factory/handoff.ts', import.meta.url).href, { namedExports: { factoryRecoveryHandoff: recoveryHandoff } })

test('actual reclaim writer keeps the trusted private Bot when the target heartbeats after the lease snapshot', async t => {
  t.mock.method(Date, 'now', () => observedAt)
  const { reclaimLostRuns } = await import('./run-leases')
  // The async device query advances the observation clock after the immutable
  // lease cutoff. The new heartbeat is current when read, not in the future.
  await reclaimLostRuns(lost.userId, now)
  assert.ok(inserted)
  assert.equal(recoveryHandoff.mock.callCount(), 1)
  assert.equal(readmit.mock.callCount(), 0)
  assert.equal(inserted.botId, botId)
  assert.equal(inserted.userId, lost.userId)
  assert.equal(inserted.retryOf, lost.id)
  assert.equal(inserted.attempt, 2)
  assert.equal(inserted.status, 'queued')
  assert.equal(inserted.deviceId, 'other-device')
  assert.deepEqual(revoked, [lost.id])
  assert.equal(events[0].botId, botId)
})

test('a heartbeat arriving during the queued-run query prevents migration or finalization', async t => {
  scenario = 'queued'
  observedAt = now.getTime()
  transactions = 0
  inserted = undefined
  events.length = 0
  revoked.length = 0
  t.mock.method(Date, 'now', () => observedAt)
  const { reclaimLostRuns } = await import('./run-leases')
  await reclaimLostRuns(lost.userId, now)
  assert.ok(observedAt > now.getTime(), 'the heartbeat arrived after the lease snapshot')
  assert.equal(transactions, 0)
  assert.equal(inserted, undefined)
  assert.deepEqual(events, [])
  assert.deepEqual(revoked, [])
})
