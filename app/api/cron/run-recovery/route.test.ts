import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let calls = 0
let fail = false
const secret = 'isolated-recovery-cron-fixture'
mock.module(new URL('../../../../lib/run-leases.ts', import.meta.url).href, { namedExports: {
  sweepExpiredRunLeases: async () => { calls++; if (fail) throw new Error('private-database-error'); return { owners: 3, failed: 1 } },
} })
let reconciled = 0
mock.module(new URL('../../../../lib/computer/reconcile.ts', import.meta.url).href, { namedExports: {
  reconcileCloudMachines: async () => { reconciled++; return 2 },
} })
const expireReviews = mock.fn(async () => ({ closed: 2, pending: 1 }))
mock.module(new URL('../../../../lib/coding-workspace/review-sessions.ts', import.meta.url).href, { namedExports: { expireReviewSessions: expireReviews } })
let judged = 0
mock.module(new URL('../../../../lib/run-outcome-judge.ts', import.meta.url).href, { namedExports: {
  judgePendingOutcomes: async () => { judged++; return 4 },
} })
let ended = 0
mock.module(new URL('../../../../lib/cloud-computer/thread-lifecycle-due.ts', import.meta.url).href, { namedExports: {
  reconcileDueThreadMachines: async () => { ended++; return { reconciled: 5, pending: 0 } },
} })
let retried = 0
mock.module(new URL('../../../../lib/cloud-computer/workspace-teardown.ts', import.meta.url).href, { namedExports: {
  retrySandboxKills: async () => { retried++; return { killed: 1, pending: 1 } },
} })
mock.module(new URL('../../../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: {}, db: {} } })
let swept: number[] = []
let taskSweeps = 0
mock.module(new URL('../../../../lib/factory/watchdog.ts', import.meta.url).href, { namedExports: {
  sweepFactoryWatchdog: async () => { taskSweeps++; return { scanned: 3, recovered: 1, blocked: 1, deferred: 1, failed: 0 } },
} })
mock.module(new URL('../../../../lib/group-conversations-route.ts', import.meta.url).href, { namedExports: {
  resumePendingGroupTurns: async (deadline: number) => { swept.push(deadline); return { groups: 1 } },
} })
let nextDue: number | null = null, armed = 0
mock.module(new URL('../../../../lib/run-recovery-due.ts', import.meta.url).href, { namedExports: { runRecoveryNextDue: async () => nextDue } })
mock.module(new URL('../../../../lib/due-timer.ts', import.meta.url).href, { namedExports: { armDueTimer: async (kind: string) => { assert.equal(kind, 'run-recovery'); armed++ } } })
const later: (() => unknown)[] = []
mock.module('next/server', { namedExports: { after: (work: () => unknown) => { later.push(work) } } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { process.env.CRON_SECRET = secret; calls = 0; fail = false; nextDue = null; armed = 0 })
const call = (token: string | null = secret) => GET(new Request('http://127.0.0.1/mikka/api/cron/run-recovery', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}))

test('independent recovery requires the existing cron bearer before scanning owners', async () => {
  for (const token of [null, 'incorrect']) assert.equal((await call(token)).status, 401)
  delete process.env.CRON_SECRET
  assert.equal((await call()).status, 503)
  assert.equal(calls, 0)
  assert.equal(taskSweeps, 0)
  assert.equal(expireReviews.mock.callCount(), 0)
})

test('recovery returns bounded counts and no private database error or cached result', async () => {
  const response = await call()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  // Stale Bot computers are reconciled, ended runs judged (R-52), closed tasks' sandboxes ended and deleted workspaces' unfinished kills retried, in the same pass.
  assert.deepEqual(await response.json(), { owners: 3, failed: 1, machines: 2, outcomes: 4, reviewSessions: { closed: 2, pending: 1 }, taskMachines: { reconciled: 5, pending: 0 }, sandboxKills: { killed: 1, pending: 1 }, tasks: { scanned: 3, recovered: 1, blocked: 1, deferred: 1, failed: 0 } })
  assert.equal(taskSweeps, 1)
  assert.equal(reconciled, 1)
  assert.equal(expireReviews.mock.callCount(), 1)
  assert.equal(judged, 1)
  assert.equal(ended, 1)
  assert.equal(retried, 1)
  // Queued group turns are resumed after the answer, within the route's 300 s.
  assert.equal(later.length, 1)
  await later.pop()!()
  assert.equal(swept.length, 1)
  assert.ok(swept[0] > Date.now() + 200_000 && swept[0] <= Date.now() + 220_000)
  swept = []
  fail = true
  const failed = await call()
  assert.equal(failed.status, 502)
  assert.doesNotMatch(await failed.text(), /private-database-error/)
})

test('lost runs are reclaimed by this sweep only, not by the task-run poll or each heartbeat', async () => {
  const { readFile } = await import('node:fs/promises')
  for (const file of ['../../../actions/task-runs.ts', '../../../v1/devices/[deviceId]/heartbeat/route.ts']) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), 'utf8'), /reclaimLostRuns/, file)
  }
})

test('the slow sweep re-arms the run-recovery due timer when work is due later, recovering a lost start', async () => {
  nextDue = Date.now() + 90_000
  assert.equal((await call()).status, 200)
  assert.equal(armed, 1)
  later.length = 0
})

test('with nothing due the sweep starts no timer, and refused callers arm nothing', async () => {
  assert.equal((await call()).status, 200)
  assert.equal(armed, 0)
  nextDue = Date.now()
  assert.equal((await call('incorrect')).status, 401)
  assert.equal(armed, 0)
  later.length = 0
})
