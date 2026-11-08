import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// The single safety-net sweep (#1371): it runs only the jobs the one check says have work due.
const secret = 'isolated-reconcile-cron-fixture'
let due = { wakes: false, schedules: false, recovery: false, deletions: false, audit: false, pushReceipts: false, workspaceEphemera: false }
const ran: string[] = []
let wakesThrow = false
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../../../../lib/db/index.ts', { pool: {} })
stub('../../../../lib/factory/runtime.ts', { factoryLifecycleEnabled: () => true })
stub('../../../../lib/reconcile-due.ts', { reconcileDue: async () => { ran.push('check'); return due } })
stub('../../../../lib/coordinator/wake.ts', { retryCoordinatorWakes: async () => { ran.push('wakes'); if (wakesThrow) throw new Error('private database text'); return { due: 1 } } })
stub('../../../../lib/schedules/runtime.ts', { sweepSchedules: async () => { ran.push('schedules'); return { executed: 1 } } })
stub('../../../../lib/run-recovery.ts', { recoverRuns: async (groupTurns: (work: () => Promise<unknown>) => unknown) => { ran.push('recovery'); groupTurns(async () => {}); return { owners: 1 } } })
stub('../../../../lib/account/deletion-jobs.ts', { sweepAccountDeletions: async () => { ran.push('deletions'); return { scanned: 1, completed: 1, pending: 0 } } })
stub('../../../../lib/chat-attachments/store.ts', { cleanupChatFiles: async () => { ran.push('files'); return { retired: 0 } } })
stub('../../../../lib/workspace-db.ts', { workspacePool: {} })
stub('../../../../lib/audit/delivery.ts', { deliverWorkspaceAudits: async () => { ran.push('delivery'); return { delivered: 1, failed: 0 } } })
stub('../../../../lib/audit/retention.ts', { sweepAuditRetention: async () => { ran.push('retention'); return { scanned: 1, deleted: 0, pending: 0 } } })
stub('../../../../lib/mobile-push-delivery.ts', { recoverPhonePushReceipts: async () => { ran.push('pushReceipts'); return { scanned: 1, pending: 0, failed: 0 } } })
stub('../../../../lib/coding-workspace/retention.ts', { cleanupWorkspaceEphemera: async () => { ran.push('workspaceEphemera'); return { requests: 1, mentions: 1 } } })
stub('../../../../lib/due-timer.ts', { armDueTimer: async (kind: string) => { ran.push(`arm:${kind}`) }, replaceStaleDueTimers: async () => {} })
mock.module('next/server', { namedExports: { after: () => {} } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { process.env.CRON_SECRET = secret; due = { wakes: false, schedules: false, recovery: false, deletions: false, audit: false, pushReceipts: false, workspaceEphemera: false }; ran.length = 0; wakesThrow = false })
const call = (token: string | null = secret) => GET(new Request('http://127.0.0.1/mikka/api/cron/reconcile', { headers: token ? { authorization: `Bearer ${token}` } : {} }))

test('only the cron bearer can run it', async () => {
  assert.equal((await call(null)).status, 401)
  assert.equal((await call('incorrect')).status, 401)
  assert.deepEqual(ran, [])
})

test('an idle check runs nothing else and arms no timer', async () => {
  assert.equal((await call()).status, 200)
  assert.deepEqual(ran, ['check'])
})

test('each job with lost work runs, and its due timer is re-armed', async () => {
  due = { wakes: true, schedules: false, recovery: true, deletions: false, audit: false, pushReceipts: false, workspaceEphemera: false }
  assert.equal((await call()).status, 200)
  assert.deepEqual(ran, ['check', 'wakes', 'recovery', 'arm:run-recovery'])
  ran.length = 0
  due = { wakes: false, schedules: true, recovery: false, deletions: false, audit: false, pushReceipts: false, workspaceEphemera: false }
  await call()
  assert.deepEqual(ran, ['check', 'schedules', 'arm:schedules'])
  ran.length = 0
  due = { wakes: false, schedules: false, recovery: false, deletions: true, audit: false, pushReceipts: false, workspaceEphemera: false }
  await call()
  assert.deepEqual(ran, ['check', 'deletions', 'files', 'arm:account-deletions'])
  ran.length = 0
  due = { wakes: false, schedules: false, recovery: false, deletions: false, audit: true, pushReceipts: false, workspaceEphemera: false }
  await call()
  assert.deepEqual(ran, ['check', 'delivery', 'retention', 'arm:audit-retention'])
  ran.length = 0
  due = { wakes: false, schedules: false, recovery: false, deletions: false, audit: false, pushReceipts: true, workspaceEphemera: false }
  await call()
  assert.deepEqual(ran, ['check', 'pushReceipts'])
  ran.length = 0
  due = { wakes: false, schedules: false, recovery: false, deletions: false, audit: false, pushReceipts: false, workspaceEphemera: true }
  await call()
  assert.deepEqual(ran, ['check', 'workspaceEphemera'])
})

test('a failure answers a bounded error without its text', async () => {
  due = { wakes: true, schedules: false, recovery: false, deletions: false, audit: false, pushReceipts: false, workspaceEphemera: false }
  wakesThrow = true
  const response = await call()
  assert.equal(response.status, 502)
  assert.doesNotMatch(await response.text(), /private/)
})
