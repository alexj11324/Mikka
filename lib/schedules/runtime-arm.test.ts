import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// Which committed schedule writes re-arm the schedules due timer (#1212).
let armed = 0
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../due-timer.ts', { armDueTimerSoon: (kind: string) => { assert.equal(kind, 'schedules'); armed++ } })
stub('../coordinator/wake.ts', { coordinatorEnabled: () => true, wakeCoordinator: async () => {} })
stub('../db/index.ts', { pool: { query: async () => ({ rows: [{ workspaceId: 'w' }] }) }, withDatabaseClient: async () => null })
stub('../workspace-db.ts', { workspacePool: {} })
stub('../issue-access.ts', { issueForUser: async () => null })
stub('../credentials/chat-guard.ts', { assertCredentialSafeChat: async () => {} })
let failed = 0
stub('./store.ts', { nextScheduleDue: async () => null, ScheduleStore: class { async command() { return { ok: true } } async fail() { failed++ } } })
let runtime: typeof import('./runtime')
before(async () => { runtime = await import('./runtime') })
beforeEach(() => { armed = 0; failed = 0 })

for (const action of ['create', 'update', 'resume'] as const) test(`${action} can move the next due time earlier, so it arms the timer after it commits`, async () => {
  await runtime.executeScheduleCommand('owner', null, 'event', { action } as never)
  assert.equal(armed, 1)
})

for (const action of ['list', 'history', 'pause', 'cancel'] as const) test(`${action} adds no due work and arms nothing`, async () => {
  await runtime.executeScheduleCommand('owner', null, 'event', { action } as never)
  assert.equal(armed, 0)
})

test('a failed scheduled read is retried 30 s later, earlier than the lease the timer sleeps to, so it arms', async () => {
  await runtime.failScheduledRead({ id: 'o', lease_token: 't' }, new Error('scheduledReadFailed'))
  assert.equal(failed, 1)
  assert.equal(armed, 1)
})
