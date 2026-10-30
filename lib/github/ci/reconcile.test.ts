import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Pool } from 'pg'
import { ciFollowUp, reconcileCi } from './reconcile'
import { summarize } from './snapshot'
import { publicationPrNumber } from './register'

const snapshot = { checks: [{ id: '1', name: 'build', status: 'completed', conclusion: 'success' }], statuses: [] }
const fingerprint = (() => { const r = summarize(snapshot); if (r.kind !== 'complete') throw Error('fixture'); return r.fingerprint })()
const base = { userId: 'owner', issueId: 'issue', remoteKey: 'v2/github.com/acme/repo', prNumber: 3, originRunId: 'run', scopeVersion: 1, head: 'a'.repeat(40), fingerprint, firstSeenAt: new Date(1), installationId: 4, repositoryId: 5, branch: 'mikka/test-1', pullRequest: { url: 'https://github.com/acme/repo/pull/3', state: 'open' }, content: {}, currentScopeVersion: 1, botId: null, agentId: 'agent', generation: 0, watchId: 'watch' }
function harness(rows: typeof base[]) {
  const events: string[] = []
  const pool = { async query(sql: string, args: unknown[] = []) {
    if (sql.includes('SELECT o.*,gi.')) { const row = rows[0]; return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } }
    if (sql.includes('UPDATE github_ci_observations')) { events.push(args[4] === 'delivery_unavailable' ? 'backoff' : 'postpone'); return { rows: [], rowCount: 1 } }
    throw Error(`unexpected pool SQL: ${sql}`)
  }, async connect() { return { async query(sql: string, args: unknown[] = []) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) { events.push(sql); return { rows: [], rowCount: 0 } }
    if (sql.includes('SELECT o."userId",o."issueId"')) { const row = rows[0]; return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } }
    if (sql.startsWith('SELECT id FROM issues')) return { rows: [{ id: args[0] }], rowCount: 1 }
    if (sql.includes('FOR UPDATE OF o SKIP LOCKED')) { const row = rows.shift(); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } }
    if (sql.startsWith('SELECT 1 FROM agent_runs')) return { rows: [], rowCount: 0 }
    if (sql.includes('github_ci_resumes')) {
      if (sql.startsWith('UPDATE')) { events.push(`bind:${String(args[5])}`); return { rows: [], rowCount: 1 } }
      if (sql.startsWith('SELECT')) return { rows: [], rowCount: 0 }
      events.push('reserve'); return { rows: [{}], rowCount: 1 }
    }
    if (sql.includes('UPDATE github_ci_observations')) { events.push(sql.includes("'delivery_unavailable'") ? 'backoff' : `observation:${String(args[5])}:${String(args[8])}`); return { rows: [], rowCount: 1 } }
    throw Error(`unexpected SQL: ${sql}`)
  }, release() {} } } } as unknown as Pool
  return { pool, events }
}

test('complete stable snapshot queues within transaction once; failure is backed off and does not starve another row', async () => {
  const { pool, events } = harness([{ ...base }, { ...base, issueId: 'other' }])
  const deliveries: string[] = []
  const result = await reconcileCi({ pool, deadline: Date.now() + 30_000, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot }), deliver: async (_tx, _userId, input) => { deliveries.push(input.issueId); if (input.issueId === 'issue') throw Error('failure') } })
  assert.deepEqual(deliveries, ['issue', 'other'])
  assert.equal(result.failed, 1)
  assert.equal(result.queued, 1)
  assert.ok(events.indexOf('ROLLBACK') < events.indexOf('backoff'))
  assert.ok(events.includes(`observation:${fingerprint}:null`))
})

test('pending never queues and changed head requires a new stability observation', async () => {
  const { pool, events } = harness([{ ...base }, { ...base, issueId: 'other' }])
  let calls = 0
  const result = await reconcileCi({ pool, deadline: Date.now() + 30_000, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, now: () => 200_000, read: async () => ++calls === 1 ? { head: base.head, open: true, snapshot: { checks: [{ ...snapshot.checks[0], status: 'in_progress', conclusion: null }], statuses: [] } } : { head: 'b'.repeat(40), open: true, snapshot }, deliver: async () => { throw Error('must not queue') } })
  assert.equal(result.pending, 2)
  assert.equal(result.queued, 0)
  assert.equal(events.includes('ROLLBACK'), false)
})

test('bounded result contains parseable JSON despite hostile check names', () => {
  const message = ciFollowUp('a'.repeat(40), 'failure', Array(100).fill('\u0000"\\'.repeat(300)))
  assert.ok(message.length <= 4000)
  const data = JSON.parse(message.split('\n')[1])
  assert.ok(data.omittedChecks > 0)
  assert.ok(data.failedChecks.length > 0)
})

test('publication receipts cannot watch another repository or noncanonical URL', () => {
  assert.equal(publicationPrNumber(base.remoteKey, base.pullRequest.url), 3)
  for (const url of ['https://github.com/acme/other/pull/3', 'https://github.com/acme/repo/pull/3?x=1', 'https://evil.example/acme/repo/pull/3']) assert.equal(publicationPrNumber(base.remoteKey, url), null)
})

test('budget: a reserved resume is bound to its queued run; a resumed head or a capped task never queues', async () => {
  {
    const { pool, events } = harness([{ ...base }])
    const result = await reconcileCi({ pool, deadline: Date.now() + 30_000, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot }), deliver: async () => ({ runId: 'queued-run' }) })
    assert.equal(result.queued, 1)
    assert.ok(events.indexOf('reserve') < events.indexOf('bind:queued-run'))
  }
  for (const outcome of ['duplicate', 'capped'] as const) {
    const { pool, events } = harness([{ ...base }])
    const reserved: unknown[] = []
    const result = await reconcileCi({ pool, deadline: Date.now() + 30_000, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, now: () => 200_000, read: async () => ({ head: base.head, open: true, snapshot }),
      reserve: async (_tx, key) => { reserved.push(key); return outcome }, deliver: async () => { throw Error('must not queue') } })
    assert.deepEqual(reserved, [{ userId: 'owner', issueId: 'issue', remoteKey: base.remoteKey, prNumber: 3, head: base.head }])
    assert.equal(result.queued, 0)
    assert.equal(result[outcome === 'duplicate' ? 'deduped' : 'capped'], 1)
    assert.ok(events.includes(`observation:${fingerprint}:${outcome === 'capped' ? 'resume_cap_reached' : 'null'}`))
    assert.ok(events.includes('COMMIT'))
  }
})
